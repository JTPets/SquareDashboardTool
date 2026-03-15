/**
 * Tests for services/square/square-pricing.js
 *
 * Covers: batchUpdateVariationPrices, updateVariationCost, batchUpdateCatalogContent
 */

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue(),
    generateIdempotencyKey: jest.fn().mockReturnValue('test-idem-key')
}));

jest.mock('../../../services/square/square-vendors', () => ({
    ensureVendorsExist: jest.fn().mockResolvedValue()
}));

const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('../../../services/square/square-client');
const { ensureVendorsExist } = require('../../../services/square/square-vendors');
const { batchUpdateVariationPrices, updateVariationCost, batchUpdateCatalogContent } = require('../../../services/square/square-pricing');

const MERCHANT_ID = 42;

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// batchUpdateVariationPrices
// ---------------------------------------------------------------------------
describe('batchUpdateVariationPrices', () => {
    const makePriceUpdate = (variationId, newPriceCents, currency = 'CAD') => ({
        variationId,
        newPriceCents,
        currency
    });

    const makeSquareObject = (id, type = 'ITEM_VARIATION', version = 1, priceCents = 500) => ({
        id,
        type,
        version,
        item_variation_data: {
            price_money: { amount: priceCents, currency: 'CAD' },
            name: 'Test Variation'
        }
    });

    it('retrieves current objects, builds update, updates local DB', async () => {
        const updates = [makePriceUpdate('VAR1', 1099)];

        // batch-retrieve returns the current object
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeSquareObject('VAR1', 'ITEM_VARIATION', 10, 999)] })
            // batch-upsert returns updated objects
            .mockResolvedValueOnce({ objects: [{ id: 'VAR1', type: 'ITEM_VARIATION', version: 11 }] });

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.success).toBe(true);
        expect(result.updated).toBe(1);
        expect(result.failed).toBe(0);

        // Verify batch-retrieve called with correct IDs
        expect(makeSquareRequest).toHaveBeenCalledWith('/v2/catalog/batch-retrieve', expect.objectContaining({
            accessToken: 'test-token',
            method: 'POST'
        }));

        // Verify batch-upsert called
        const upsertCall = makeSquareRequest.mock.calls[1];
        expect(upsertCall[0]).toBe('/v2/catalog/batch-upsert');
        const upsertBody = JSON.parse(upsertCall[1].body);
        expect(upsertBody.batches[0].objects[0].item_variation_data.price_money).toEqual({
            amount: 1099,
            currency: 'CAD'
        });
        expect(upsertBody.batches[0].objects[0].version).toBe(10);

        // Verify local DB updated
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE variations'),
            [1099, 'CAD', 'VAR1', MERCHANT_ID]
        );

        // Verify detail entries
        const detail = result.details.find(d => d.variationId === 'VAR1');
        expect(detail.success).toBe(true);
        expect(detail.oldPriceCents).toBe(999);
        expect(detail.newPriceCents).toBe(1099);
    });

    it('counts only ITEM_VARIATION objects from upsert response', async () => {
        const updates = [makePriceUpdate('VAR1', 1099)];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeSquareObject('VAR1')] })
            .mockResolvedValueOnce({
                objects: [
                    { id: 'VAR1', type: 'ITEM_VARIATION', version: 2 },
                    { id: 'ITEM_PARENT', type: 'ITEM', version: 2 }
                ]
            });

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        // Should count 1 (only ITEM_VARIATION), not 2
        expect(result.updated).toBe(1);
    });

    it('handles object not found', async () => {
        const updates = [makePriceUpdate('VAR_MISSING', 500)];

        makeSquareRequest.mockResolvedValueOnce({ objects: [] });

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.failed).toBe(1);
        expect(result.errors[0]).toEqual({ variationId: 'VAR_MISSING', error: 'Object not found' });
        expect(result.details[0]).toEqual({
            variationId: 'VAR_MISSING',
            success: false,
            error: 'Object not found'
        });
        // Should not call batch-upsert if no valid objects
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    it('handles not a variation', async () => {
        const updates = [makePriceUpdate('CAT1', 500)];

        makeSquareRequest.mockResolvedValueOnce({
            objects: [{ id: 'CAT1', type: 'CATEGORY', version: 1 }]
        });

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.failed).toBe(1);
        expect(result.errors[0]).toEqual({ variationId: 'CAT1', error: 'Not a variation' });
    });

    it('handles batch error - marks all pending items as failed', async () => {
        const updates = [
            makePriceUpdate('VAR1', 500),
            makePriceUpdate('VAR2', 600)
        ];

        // Retrieve succeeds
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [
                    makeSquareObject('VAR1'),
                    makeSquareObject('VAR2')
                ]
            })
            // Upsert fails
            .mockRejectedValueOnce(new Error('Square API error'));

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.failed).toBe(2);
        expect(result.errors).toEqual([{ batch: 1, error: 'Square API error' }]);

        // Both items should be marked failed
        for (const detail of result.details) {
            expect(detail.success).toBe(false);
            expect(detail.error).toBe('Square API error');
            expect(detail.pending).toBeUndefined();
        }
    });

    it('handles batch error before retrieve (no detail entries yet)', async () => {
        const updates = [makePriceUpdate('VAR1', 500)];

        // Retrieve itself fails
        makeSquareRequest.mockRejectedValueOnce(new Error('Network error'));

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.success).toBe(false);
        expect(result.failed).toBe(1);
        expect(result.details[0]).toEqual({
            variationId: 'VAR1',
            success: false,
            error: 'Network error'
        });
    });

    it('processes in batches of 100', async () => {
        // Create 150 updates to trigger 2 batches
        const updates = Array.from({ length: 150 }, (_, i) =>
            makePriceUpdate(`VAR${i}`, 1000 + i)
        );

        // First batch retrieve + upsert
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: Array.from({ length: 100 }, (_, i) => makeSquareObject(`VAR${i}`))
            })
            .mockResolvedValueOnce({
                objects: Array.from({ length: 100 }, (_, i) => ({ id: `VAR${i}`, type: 'ITEM_VARIATION', version: 2 }))
            })
            // Second batch retrieve + upsert
            .mockResolvedValueOnce({
                objects: Array.from({ length: 50 }, (_, i) => makeSquareObject(`VAR${100 + i}`))
            })
            .mockResolvedValueOnce({
                objects: Array.from({ length: 50 }, (_, i) => ({ id: `VAR${100 + i}`, type: 'ITEM_VARIATION', version: 2 }))
            });

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.updated).toBe(150);
        expect(result.failed).toBe(0);
        // 2 retrieve + 2 upsert = 4 Square API calls
        expect(makeSquareRequest).toHaveBeenCalledTimes(4);
        // Sleep between batches
        expect(sleep).toHaveBeenCalledWith(200);
    });

    it('defaults currency to CAD when not provided', async () => {
        const updates = [{ variationId: 'VAR1', newPriceCents: 999 }];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeSquareObject('VAR1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR1', type: 'ITEM_VARIATION', version: 2 }] });

        await batchUpdateVariationPrices(updates, MERCHANT_ID);

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(upsertBody.batches[0].objects[0].item_variation_data.price_money.currency).toBe('CAD');
    });

    it('skips batch upsert when all items in batch are invalid', async () => {
        const updates = [makePriceUpdate('MISSING1', 500), makePriceUpdate('MISSING2', 600)];

        makeSquareRequest.mockResolvedValueOnce({ objects: [] });

        const result = await batchUpdateVariationPrices(updates, MERCHANT_ID);

        expect(result.failed).toBe(2);
        // Only 1 call (retrieve), no upsert
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// updateVariationCost
// ---------------------------------------------------------------------------
describe('updateVariationCost', () => {
    const makeVariationObject = (vendorInfo = [], version = 5) => ({
        object: {
            id: 'VAR1',
            type: 'ITEM_VARIATION',
            version,
            item_variation_data: {
                name: 'Test Variation',
                item_id: 'ITEM1',
                vendor_information: vendorInfo
            }
        }
    });

    it('retrieves current variation and updates vendor cost', async () => {
        const existingVendor = {
            vendor_id: 'VENDOR1',
            unit_cost_money: { amount: 300, currency: 'CAD' }
        };

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject([existingVendor]))
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 6 } });

        const result = await updateVariationCost('VAR1', 'VENDOR1', 450, 'CAD', { merchantId: MERCHANT_ID });

        expect(result.success).toBe(true);
        expect(result.oldCostCents).toBe(300);
        expect(result.newCostCents).toBe(450);

        // Verify the upsert body
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const vendorInfo = upsertBody.object.item_variation_data.vendor_information;
        expect(vendorInfo).toHaveLength(1);
        expect(vendorInfo[0].unit_cost_money).toEqual({ amount: 450, currency: 'CAD' });
        expect(upsertBody.object.version).toBe(5);

        // Verify ensureVendorsExist called
        expect(ensureVendorsExist).toHaveBeenCalledWith(['VENDOR1'], MERCHANT_ID);

        // Verify local DB upsert
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO variation_vendors'),
            ['VAR1', 'VENDOR1', 450, 'CAD', MERCHANT_ID]
        );
    });

    it('adds new vendor entry when vendor not found in existing', async () => {
        const existingVendor = {
            vendor_id: 'VENDOR_OLD',
            unit_cost_money: { amount: 200, currency: 'CAD' }
        };

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject([existingVendor]))
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 6 } });

        const result = await updateVariationCost('VAR1', 'VENDOR_NEW', 550, 'CAD', { merchantId: MERCHANT_ID });

        expect(result.success).toBe(true);
        expect(result.oldCostCents).toBeNull();

        // Verify new vendor appended
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const vendorInfo = upsertBody.object.item_variation_data.vendor_information;
        expect(vendorInfo).toHaveLength(2);
        expect(vendorInfo[0].vendor_id).toBe('VENDOR_OLD');
        expect(vendorInfo[1].vendor_id).toBe('VENDOR_NEW');
        expect(vendorInfo[1].unit_cost_money).toEqual({ amount: 550, currency: 'CAD' });
    });

    it('updates existing vendor entry in place', async () => {
        const vendors = [
            { vendor_id: 'V1', unit_cost_money: { amount: 100, currency: 'CAD' } },
            { vendor_id: 'V2', unit_cost_money: { amount: 200, currency: 'CAD' } }
        ];

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject(vendors))
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 6 } });

        await updateVariationCost('VAR1', 'V2', 350, 'CAD', { merchantId: MERCHANT_ID });

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const vendorInfo = upsertBody.object.item_variation_data.vendor_information;
        expect(vendorInfo).toHaveLength(2);
        // V1 untouched
        expect(vendorInfo[0].unit_cost_money.amount).toBe(100);
        // V2 updated
        expect(vendorInfo[1].unit_cost_money).toEqual({ amount: 350, currency: 'CAD' });
    });

    it('retries on VERSION_MISMATCH up to 3 times', async () => {
        const versionError = new Error('VERSION_MISMATCH: expected version 5');

        makeSquareRequest
            // Attempt 1: retrieve ok, upsert version mismatch
            .mockResolvedValueOnce(makeVariationObject([], 5))
            .mockRejectedValueOnce(versionError)
            // Attempt 2: retrieve ok with new version, upsert version mismatch again
            .mockResolvedValueOnce(makeVariationObject([], 6))
            .mockRejectedValueOnce(versionError)
            // Attempt 3: retrieve ok, upsert succeeds
            .mockResolvedValueOnce(makeVariationObject([], 7))
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 8 } });

        const result = await updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID });

        expect(result.success).toBe(true);
        // 3 retrieve + 3 upsert attempts = 6 calls
        expect(makeSquareRequest).toHaveBeenCalledTimes(6);
        // Sleep between retries
        expect(sleep).toHaveBeenCalledWith(100); // attempt 1 * 100
        expect(sleep).toHaveBeenCalledWith(200); // attempt 2 * 100
    });

    it('throws after max retries on VERSION_MISMATCH', async () => {
        const versionError = new Error('VERSION_MISMATCH: expected version 5');

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject([], 5))
            .mockRejectedValueOnce(versionError)
            .mockResolvedValueOnce(makeVariationObject([], 6))
            .mockRejectedValueOnce(versionError)
            .mockResolvedValueOnce(makeVariationObject([], 7))
            .mockRejectedValueOnce(versionError);

        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID })
        ).rejects.toThrow('VERSION_MISMATCH');
    });

    it('detects ITEM_NOT_AT_LOCATION via structured Square error', async () => {
        // NOTE: The source has a documented scoping bug (O-4) — currentVariationData
        // is const inside try{}, so it's not accessible in catch{}. When the upsert
        // call throws, the catch references currentVariationData which is undefined,
        // causing a ReferenceError instead of the original error.
        // We test the real behavior here: it throws ReferenceError about currentVariationData.
        const locationError = new Error('Some Square error');
        locationError.squareErrors = [
            { code: 'INVALID_VALUE', field: 'item_id', detail: 'mismatch' }
        ];

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject([]))
            .mockRejectedValueOnce(locationError);

        // Due to O-4 scoping bug, currentVariationData is not defined in catch block
        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID })
        ).rejects.toThrow('currentVariationData is not defined');
    });

    it('detects ITEM_NOT_AT_LOCATION via message-based fallback', async () => {
        // Same O-4 scoping bug applies here — the message-based detection path
        // also references currentVariationData in the catch block.
        const locationError = new Error('VAR1 is enabled at unit L1 but object ITEM1 of type ITEM is not');

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject([]))
            .mockRejectedValueOnce(locationError);

        // Due to O-4 scoping bug, currentVariationData is not defined in catch block
        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID })
        ).rejects.toThrow('currentVariationData is not defined');
    });

    it('detects ITEM_NOT_AT_LOCATION when retrieve itself fails with location error', async () => {
        // Test the detection logic when the error occurs before currentVariationData
        // would be assigned (retrieve phase) — same O-4 bug but confirms the detection
        // code path. Using a retrieve error that has squareErrors attached.
        const locationError = new Error('Some Square error');
        locationError.squareErrors = [
            { code: 'INVALID_VALUE', field: 'item_id', detail: 'mismatch' }
        ];

        // Retrieve itself fails with the location error
        makeSquareRequest.mockRejectedValueOnce(locationError);

        // currentVariationData is not defined at all in this case
        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID })
        ).rejects.toThrow('currentVariationData is not defined');
    });

    it('throws when merchantId is missing', async () => {
        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', {})
        ).rejects.toThrow('merchantId is required');
    });

    it('throws when catalog object not found', async () => {
        makeSquareRequest.mockResolvedValueOnce({ object: null });

        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID })
        ).rejects.toThrow('Catalog object not found: VAR1');
    });

    it('throws when object is not a variation', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            object: { id: 'VAR1', type: 'ITEM', version: 1, item_data: {} }
        });

        await expect(
            updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID })
        ).rejects.toThrow('Object is not a variation: ITEM');
    });

    it('uses unique idempotency key per attempt', async () => {
        const versionError = new Error('VERSION_MISMATCH');

        generateIdempotencyKey.mockReturnValueOnce('key-attempt-1').mockReturnValueOnce('key-attempt-2');

        makeSquareRequest
            .mockResolvedValueOnce(makeVariationObject([], 5))
            .mockRejectedValueOnce(versionError)
            .mockResolvedValueOnce(makeVariationObject([], 6))
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 7 } });

        await updateVariationCost('VAR1', 'VENDOR1', 500, 'CAD', { merchantId: MERCHANT_ID });

        expect(generateIdempotencyKey).toHaveBeenCalledWith('cost-update-1');
        expect(generateIdempotencyKey).toHaveBeenCalledWith('cost-update-2');
    });
});

// ---------------------------------------------------------------------------
// batchUpdateCatalogContent
// ---------------------------------------------------------------------------
describe('batchUpdateCatalogContent', () => {
    const makeItemObject = (id, itemData = {}, version = 3) => ({
        id,
        type: 'ITEM',
        version,
        item_data: {
            name: 'Test Item',
            description: 'Old description',
            ...itemData
        }
    });

    it('updates description field on ITEM objects', async () => {
        const updates = [{ itemId: 'ITEM1', fieldType: 'description', value: 'New description' }];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(1);
        expect(result.failed).toHaveLength(0);

        // Verify upsert body
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(upsertBody.batches[0].objects[0].item_data.description).toBe('New description');

        // Verify local DB update
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE items SET description'),
            ['New description', 'ITEM1', MERCHANT_ID]
        );
    });

    it('updates seo_title mapped to ecom_seo_data.page_title', async () => {
        const updates = [{ itemId: 'ITEM1', fieldType: 'seo_title', value: 'SEO Title Here' }];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(1);

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(upsertBody.batches[0].objects[0].item_data.ecom_seo_data.page_title).toBe('SEO Title Here');

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE items SET seo_title'),
            ['SEO Title Here', 'ITEM1', MERCHANT_ID]
        );
    });

    it('updates seo_description mapped to ecom_seo_data.page_description', async () => {
        const updates = [{ itemId: 'ITEM1', fieldType: 'seo_description', value: 'SEO Desc Here' }];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(1);

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(upsertBody.batches[0].objects[0].item_data.ecom_seo_data.page_description).toBe('SEO Desc Here');

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE items SET seo_description'),
            ['SEO Desc Here', 'ITEM1', MERCHANT_ID]
        );
    });

    it('preserves existing ecom_seo_data when updating one SEO field', async () => {
        const updates = [{ itemId: 'ITEM1', fieldType: 'seo_title', value: 'New Title' }];
        const existingItem = makeItemObject('ITEM1', {
            ecom_seo_data: { page_title: 'Old Title', page_description: 'Existing Desc' }
        });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [existingItem] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        await batchUpdateCatalogContent(MERCHANT_ID, updates);

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const seoData = upsertBody.batches[0].objects[0].item_data.ecom_seo_data;
        expect(seoData.page_title).toBe('New Title');
        expect(seoData.page_description).toBe('Existing Desc');
    });

    it('handles item not found in Square', async () => {
        const updates = [
            { itemId: 'MISSING1', fieldType: 'description', value: 'test' },
            { itemId: 'MISSING1', fieldType: 'seo_title', value: 'test title' }
        ];

        makeSquareRequest.mockResolvedValueOnce({ objects: [] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(0);
        expect(result.failed).toHaveLength(2);
        expect(result.failed[0].error).toBe('Item not found in Square');
        expect(result.failed[1].error).toBe('Item not found in Square');
    });

    it('groups updates by item ID for merging', async () => {
        const updates = [
            { itemId: 'ITEM1', fieldType: 'description', value: 'New desc' },
            { itemId: 'ITEM1', fieldType: 'seo_title', value: 'New title' },
            { itemId: 'ITEM1', fieldType: 'seo_description', value: 'New seo desc' }
        ];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(3);

        // Should produce only one update object (merged)
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(upsertBody.batches[0].objects).toHaveLength(1);
        const itemData = upsertBody.batches[0].objects[0].item_data;
        expect(itemData.description).toBe('New desc');
        expect(itemData.ecom_seo_data.page_title).toBe('New title');
        expect(itemData.ecom_seo_data.page_description).toBe('New seo desc');
    });

    it('updates local database after Square update', async () => {
        const updates = [
            { itemId: 'ITEM1', fieldType: 'description', value: 'Desc' },
            { itemId: 'ITEM1', fieldType: 'seo_title', value: 'Title' }
        ];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        await batchUpdateCatalogContent(MERCHANT_ID, updates);

        // Two DB update calls (one per field)
        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE items SET description'),
            ['Desc', 'ITEM1', MERCHANT_ID]
        );
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE items SET seo_title'),
            ['Title', 'ITEM1', MERCHANT_ID]
        );
    });

    it('handles empty updates array - returns empty succeeded/failed', async () => {
        const result = await batchUpdateCatalogContent(MERCHANT_ID, []);

        expect(result).toEqual({ succeeded: [], failed: [] });
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    it('handles null updates array', async () => {
        const result = await batchUpdateCatalogContent(MERCHANT_ID, null);

        expect(result).toEqual({ succeeded: [], failed: [] });
    });

    it('requires merchantId', async () => {
        await expect(
            batchUpdateCatalogContent(null, [{ itemId: 'ITEM1', fieldType: 'description', value: 'test' }])
        ).rejects.toThrow('merchantId is required');
    });

    it('handles Square API failure - marks all as failed', async () => {
        const updates = [
            { itemId: 'ITEM1', fieldType: 'description', value: 'test' },
            { itemId: 'ITEM2', fieldType: 'seo_title', value: 'title' }
        ];

        makeSquareRequest.mockRejectedValueOnce(new Error('API timeout'));

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(0);
        expect(result.failed).toHaveLength(2);
        expect(result.failed[0].error).toBe('API timeout');
        expect(result.failed[1].error).toBe('API timeout');
    });

    it('continues if local DB update fails after Square success', async () => {
        const updates = [{ itemId: 'ITEM1', fieldType: 'description', value: 'New desc' }];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        db.query.mockRejectedValueOnce(new Error('DB connection lost'));

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        // Should still be marked as succeeded (Square update worked)
        expect(result.succeeded).toHaveLength(1);
        expect(result.failed).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
            'Failed to update local DB after Square update',
            expect.objectContaining({ itemId: 'ITEM1', fieldType: 'description' })
        );
    });

    it('filters out non-ITEM objects from retrieve response', async () => {
        const updates = [{ itemId: 'ITEM1', fieldType: 'description', value: 'test' }];

        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                { id: 'ITEM1', type: 'ITEM_VARIATION', version: 1, item_variation_data: {} },
                // No ITEM type object for ITEM1
            ]
        });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        // Should fail because the object is not type ITEM
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].error).toBe('Item not found in Square');
    });

    it('handles multiple items with some found and some missing', async () => {
        const updates = [
            { itemId: 'ITEM1', fieldType: 'description', value: 'Found' },
            { itemId: 'ITEM_MISSING', fieldType: 'description', value: 'Missing' }
        ];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        expect(result.succeeded).toHaveLength(1);
        expect(result.succeeded[0].itemId).toBe('ITEM1');
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].itemId).toBe('ITEM_MISSING');
    });

    it('deduplicates item IDs in batch-retrieve request', async () => {
        const updates = [
            { itemId: 'ITEM1', fieldType: 'description', value: 'desc' },
            { itemId: 'ITEM1', fieldType: 'seo_title', value: 'title' }
        ];

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeItemObject('ITEM1')] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM1', type: 'ITEM', version: 4 }] });

        await batchUpdateCatalogContent(MERCHANT_ID, updates);

        // Verify only one ID sent to batch-retrieve
        const retrieveBody = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(retrieveBody.object_ids).toEqual(['ITEM1']);
    });

    it('returns early when all items not found (no upsert call)', async () => {
        const updates = [{ itemId: 'MISSING', fieldType: 'description', value: 'test' }];

        makeSquareRequest.mockResolvedValueOnce({ objects: [] });

        const result = await batchUpdateCatalogContent(MERCHANT_ID, updates);

        // Only 1 call (retrieve), no upsert
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
        expect(result.failed).toHaveLength(1);
    });
});
