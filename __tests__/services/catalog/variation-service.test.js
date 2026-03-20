/**
 * Tests for services/catalog/variation-service.js
 *
 * Covers: getVariations, getVariationsWithCosts, updateExtendedFields,
 *         updateMinStock, updateCost, bulkUpdateExtendedFields
 */

const db = require('../../../utils/database');

// Mock Square API
jest.mock('../../../services/square', () => ({
    updateCustomAttributeValues: jest.fn(),
    setSquareInventoryAlertThreshold: jest.fn(),
    updateVariationCost: jest.fn()
}));

// Mock merchant service
jest.mock('../../../services/merchant', () => ({
    getMerchantLocaleConfig: jest.fn().mockResolvedValue({ currency: 'CAD' })
}));

// Mock image utils
jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map())
}));

const squareApi = require('../../../services/square');
const { getMerchantLocaleConfig } = require('../../../services/merchant');
const { batchResolveImageUrls } = require('../../../utils/image-utils');

const {
    getVariations,
    getVariationsWithCosts,
    updateExtendedFields,
    updateMinStock,
    updateCost,
    bulkUpdateExtendedFields
} = require('../../../services/catalog/variation-service');

describe('variation-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const merchantId = 1;

    // ==================== getVariations ====================
    describe('getVariations', () => {
        const mockVariationRows = [
            {
                id: 'VAR1', sku: 'SKU-001', name: 'Small Bag', item_name: 'Dog Food',
                category_name: 'Pet Food', item_images: '[{"id":"IMG1"}]',
                cost_cents: 500, primary_vendor_id: 'VEN1', primary_vendor_name: 'Acme'
            },
            {
                id: 'VAR2', sku: 'SKU-002', name: 'Large Bag', item_name: 'Dog Food',
                category_name: 'Pet Food', item_images: '[{"id":"IMG2"}]',
                cost_cents: 1000, primary_vendor_id: 'VEN1', primary_vendor_name: 'Acme'
            }
        ];

        it('returns variations for a merchant with no filters', async () => {
            db.query.mockResolvedValueOnce({ rows: mockVariationRows });

            const result = await getVariations(merchantId);

            expect(result.count).toBe(2);
            expect(result.variations).toHaveLength(2);
            expect(result.variations[0].item_images).toBeUndefined();
            expect(result.variations[0].image_urls).toEqual([]);
            expect(db.query.mock.calls[0][1]).toEqual([merchantId]);
            expect(batchResolveImageUrls).toHaveBeenCalledWith(mockVariationRows, merchantId);
        });

        it('filters by item_id', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationRows[0]] });

            const result = await getVariations(merchantId, { item_id: 'ITEM1' });

            expect(result.count).toBe(1);
            const [query, params] = db.query.mock.calls[0];
            expect(params).toEqual([merchantId, 'ITEM1']);
            expect(query).toContain('v.item_id = $2');
        });

        it('filters by sku with ILIKE', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationRows[0]] });

            const result = await getVariations(merchantId, { sku: 'SKU-001' });

            expect(result.count).toBe(1);
            const [query, params] = db.query.mock.calls[0];
            expect(params).toEqual([merchantId, '%SKU-001%']);
            expect(query).toContain('v.sku ILIKE');
        });

        it('filters by search term across item name, variation name, and sku', async () => {
            db.query.mockResolvedValueOnce({ rows: mockVariationRows });

            await getVariations(merchantId, { search: 'dog' });

            const [query, params] = db.query.mock.calls[0];
            expect(params).toEqual([merchantId, '%dog%']);
            expect(query).toContain('i.name ILIKE');
            expect(query).toContain('v.name ILIKE');
            expect(query).toContain('v.sku ILIKE');
        });

        it('filters by has_cost = true', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationRows[0]] });

            await getVariations(merchantId, { has_cost: 'true' });

            const [query] = db.query.mock.calls[0];
            expect(query).toContain('EXISTS (SELECT 1 FROM variation_vendors');
        });

        it('filters by has_cost = boolean true', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getVariations(merchantId, { has_cost: true });

            const [query] = db.query.mock.calls[0];
            expect(query).toContain('EXISTS (SELECT 1 FROM variation_vendors');
        });

        it('applies limit', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationRows[0]] });

            await getVariations(merchantId, { limit: 10 });

            const [query, params] = db.query.mock.calls[0];
            expect(params).toEqual([merchantId, 10]);
            expect(query).toContain('LIMIT $2');
        });

        it('resolves image URLs via batchResolveImageUrls', async () => {
            const imageMap = new Map();
            imageMap.set(0, ['https://example.com/img1.jpg']);
            imageMap.set(1, ['https://example.com/img2.jpg']);
            batchResolveImageUrls.mockResolvedValueOnce(imageMap);

            db.query.mockResolvedValueOnce({ rows: mockVariationRows });

            const result = await getVariations(merchantId);

            expect(result.variations[0].image_urls).toEqual(['https://example.com/img1.jpg']);
            expect(result.variations[1].image_urls).toEqual(['https://example.com/img2.jpg']);
        });

        it('combines multiple filters', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getVariations(merchantId, { item_id: 'ITEM1', sku: 'SKU', search: 'food', limit: 5 });

            const [query, params] = db.query.mock.calls[0];
            expect(params).toEqual([merchantId, 'ITEM1', '%SKU%', '%food%', 5]);
            expect(query).toContain('v.item_id = $2');
            expect(query).toContain('v.sku ILIKE $3');
            expect(query).toContain('LIMIT $5');
        });

        it('throws when merchantId is missing', async () => {
            await expect(getVariations(null)).rejects.toThrow('merchantId is required');
            await expect(getVariations(undefined)).rejects.toThrow('merchantId is required');
            await expect(getVariations(0)).rejects.toThrow('merchantId is required');
        });
    });

    // ==================== getVariationsWithCosts ====================
    describe('getVariationsWithCosts', () => {
        it('returns variations with margin and profit calculations', async () => {
            const mockRows = [
                {
                    id: 'VAR1', sku: 'SKU-001', item_name: 'Dog Food', variation_name: 'Small',
                    retail_price_cents: 1000, cost_cents: 600, vendor_name: 'Acme', vendor_code: 'AC01',
                    margin_percent: 40.00, profit_cents: 400, images: null, item_images: null
                },
                {
                    id: 'VAR2', sku: 'SKU-002', item_name: 'Cat Food', variation_name: 'Regular',
                    retail_price_cents: 500, cost_cents: null, vendor_name: null, vendor_code: null,
                    margin_percent: null, profit_cents: null, images: null, item_images: null
                }
            ];
            db.query.mockResolvedValueOnce({ rows: mockRows });

            const result = await getVariationsWithCosts(merchantId);

            expect(result.count).toBe(2);
            expect(result.variations[0].margin_percent).toBe(40.00);
            expect(result.variations[0].profit_cents).toBe(400);
            expect(result.variations[1].margin_percent).toBeNull();
            expect(result.variations[1].profit_cents).toBeNull();
            // item_images should be removed from response
            expect(result.variations[0].item_images).toBeUndefined();
        });

        it('queries with correct SQL structure for margin calculation', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getVariationsWithCosts(merchantId);

            const [query, params] = db.query.mock.calls[0];
            expect(params).toEqual([merchantId]);
            expect(query).toContain('margin_percent');
            expect(query).toContain('profit_cents');
            expect(query).toContain('v.price_money - vv.unit_cost_money');
            expect(query).toContain('v.price_money IS NOT NULL');
        });

        it('resolves image URLs', async () => {
            const imageMap = new Map();
            imageMap.set(0, ['https://example.com/img.jpg']);
            batchResolveImageUrls.mockResolvedValueOnce(imageMap);
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 'VAR1', sku: 'SKU-001', item_name: 'Dog Food', variation_name: 'Small',
                    retail_price_cents: 1000, cost_cents: 600, images: null, item_images: null
                }]
            });

            const result = await getVariationsWithCosts(merchantId);

            expect(result.variations[0].image_urls).toEqual(['https://example.com/img.jpg']);
            expect(batchResolveImageUrls).toHaveBeenCalled();
        });

        it('throws when merchantId is missing', async () => {
            await expect(getVariationsWithCosts(null)).rejects.toThrow('merchantId is required');
        });
    });

    // ==================== updateExtendedFields ====================
    describe('updateExtendedFields', () => {
        it('updates valid fields and returns success', async () => {
            // verifyVariationOwnership
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // UPDATE RETURNING
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', shelf_location: 'A3', bin_location: 'B2' }]
            });

            const result = await updateExtendedFields('VAR1', merchantId, {
                shelf_location: 'A3',
                bin_location: 'B2'
            });

            expect(result.success).toBe(true);
            expect(result.variation.shelf_location).toBe('A3');
            expect(result.square_sync).toBeNull();
        });

        it('rejects unknown/disallowed fields', async () => {
            // verifyVariationOwnership
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });

            const result = await updateExtendedFields('VAR1', merchantId, {
                invalid_field: 'bad',
                another_bad: 'nope'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No valid fields');
            expect(result.status).toBe(400);
        });

        it('returns 404 for unknown variation', async () => {
            // verifyVariationOwnership returns empty
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateExtendedFields('NONEXISTENT', merchantId, {
                shelf_location: 'A1'
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Variation not found');
            expect(result.status).toBe(404);
        });

        it('syncs case_pack to Square when value > 0', async () => {
            // verifyVariationOwnership
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            // UPDATE RETURNING
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', case_pack_quantity: 12 }]
            });
            squareApi.updateCustomAttributeValues.mockResolvedValueOnce({ success: true });

            const result = await updateExtendedFields('VAR1', merchantId, {
                case_pack_quantity: 12
            });

            expect(result.success).toBe(true);
            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
                'VAR1',
                { case_pack_quantity: { number_value: '12' } },
                { merchantId }
            );
            expect(result.square_sync).toEqual({ success: true });
        });

        it('does not sync case_pack to Square when null', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', case_pack_quantity: null }]
            });

            const result = await updateExtendedFields('VAR1', merchantId, {
                case_pack_quantity: null
            });

            expect(result.success).toBe(true);
            expect(squareApi.updateCustomAttributeValues).not.toHaveBeenCalled();
            expect(result.square_sync).toBeNull();
        });

        it('does not sync case_pack to Square when 0', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', case_pack_quantity: 0 }]
            });

            const result = await updateExtendedFields('VAR1', merchantId, {
                case_pack_quantity: 0
            });

            expect(result.success).toBe(true);
            expect(squareApi.updateCustomAttributeValues).not.toHaveBeenCalled();
        });

        it('handles Square sync failure gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', case_pack_quantity: 6 }]
            });
            squareApi.updateCustomAttributeValues.mockRejectedValueOnce(new Error('Square API error'));

            const result = await updateExtendedFields('VAR1', merchantId, {
                case_pack_quantity: 6
            });

            // Local update still succeeds
            expect(result.success).toBe(true);
            expect(result.square_sync).toEqual({ success: false, error: 'Square API error' });
        });

        it('filters out disallowed fields while keeping valid ones', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', notes: 'hello' }]
            });

            const result = await updateExtendedFields('VAR1', merchantId, {
                notes: 'hello',
                malicious_field: 'DROP TABLE'
            });

            expect(result.success).toBe(true);
            // Only valid field in the UPDATE
            const [updateQuery, updateParams] = db.query.mock.calls[1];
            expect(updateQuery).toContain('notes = $1');
            expect(updateParams).toContain('hello');
            expect(updateParams).not.toContain('DROP TABLE');
        });

        it('rejects supplier_item_number (BACKLOG-89 — dead column removed)', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1' }] });

            const result = await updateExtendedFields('VAR1', merchantId, {
                supplier_item_number: 'ACME-123'
            });

            // supplier_item_number is no longer in the allowlist, so no valid fields
            expect(result.success).toBe(false);
            expect(result.error).toContain('No valid fields');
        });

        it('throws when merchantId is missing', async () => {
            await expect(updateExtendedFields('VAR1', null, {})).rejects.toThrow('merchantId is required');
        });

        it('throws when variationId is missing', async () => {
            await expect(updateExtendedFields(null, merchantId, {})).rejects.toThrow('variationId is required');
        });
    });

    // ==================== updateMinStock ====================
    describe('updateMinStock', () => {
        const mockVariation = {
            id: 'VAR1', sku: 'SKU-001', name: 'Small Bag',
            item_id: 'ITEM1', track_inventory: true,
            inventory_alert_threshold: 5, item_name: 'Dog Food'
        };

        it('pushes min stock to Square and updates local DB', async () => {
            // Get variation
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            // Inventory location lookup
            db.query.mockResolvedValueOnce({ rows: [{ location_id: 'LOC1' }] });
            // Square push success
            squareApi.setSquareInventoryAlertThreshold.mockResolvedValueOnce({});
            // Local DB update (variation-level)
            db.query.mockResolvedValueOnce({ rows: [] });
            // Location-specific upsert
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateMinStock('VAR1', merchantId, 10);

            expect(result.success).toBe(true);
            expect(result.synced_to_square).toBe(true);
            expect(result.new_value).toBe(10);
            expect(result.previous_value).toBe(5);
            expect(result.location_id).toBe('LOC1');
            expect(squareApi.setSquareInventoryAlertThreshold).toHaveBeenCalledWith(
                'VAR1', 'LOC1', 10, { merchantId }
            );
        });

        it('uses provided locationId directly', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            squareApi.setSquareInventoryAlertThreshold.mockResolvedValueOnce({});
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateMinStock('VAR1', merchantId, 10, 'LOC-EXPLICIT');

            expect(result.success).toBe(true);
            expect(result.location_id).toBe('LOC-EXPLICIT');
            // Should NOT query for inventory or active locations
            expect(db.query).toHaveBeenCalledTimes(3); // variation lookup + 2 updates
        });

        it('falls back to first active location when no inventory location found', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            // Inventory location lookup - empty
            db.query.mockResolvedValueOnce({ rows: [] });
            // Active location fallback
            db.query.mockResolvedValueOnce({ rows: [{ id: 'LOC-FALLBACK' }] });
            squareApi.setSquareInventoryAlertThreshold.mockResolvedValueOnce({});
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateMinStock('VAR1', merchantId, 3);

            expect(result.success).toBe(true);
            expect(result.location_id).toBe('LOC-FALLBACK');
        });

        it('returns error when no active locations found', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] }); // no active locations

            const result = await updateMinStock('VAR1', merchantId, 3);

            expect(result.success).toBe(false);
            expect(result.error).toContain('No active locations');
            expect(result.status).toBe(400);
        });

        it('handles null minStock to disable alerts', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            db.query.mockResolvedValueOnce({ rows: [{ location_id: 'LOC1' }] });
            squareApi.setSquareInventoryAlertThreshold.mockResolvedValueOnce({});
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateMinStock('VAR1', merchantId, null);

            expect(result.success).toBe(true);
            expect(result.new_value).toBeNull();
            // Alert type should be NONE
            const updateCall = db.query.mock.calls[2];
            expect(updateCall[1]).toContain('NONE');
        });

        it('validates non-negative minStock', async () => {
            const result = await updateMinStock('VAR1', merchantId, -5);

            expect(result.success).toBe(false);
            expect(result.error).toContain('non-negative');
            expect(result.status).toBe(400);
        });

        it('validates minStock type', async () => {
            const result = await updateMinStock('VAR1', merchantId, 'abc');

            expect(result.success).toBe(false);
            expect(result.error).toContain('non-negative');
            expect(result.status).toBe(400);
        });

        it('returns 404 for unknown variation', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateMinStock('NONEXISTENT', merchantId, 5);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Variation not found');
            expect(result.status).toBe(404);
        });

        it('handles Square API error', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            db.query.mockResolvedValueOnce({ rows: [{ location_id: 'LOC1' }] });
            squareApi.setSquareInventoryAlertThreshold.mockRejectedValueOnce(
                new Error('Square timeout')
            );

            const result = await updateMinStock('VAR1', merchantId, 10);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to update Square');
            expect(result.error).toContain('Square timeout');
            expect(result.status).toBe(500);
            expect(result.square_error).toBe(true);
        });

        it('throws when merchantId is missing', async () => {
            await expect(updateMinStock('VAR1', null, 10)).rejects.toThrow('merchantId is required');
        });

        it('throws when variationId is missing', async () => {
            await expect(updateMinStock(null, merchantId, 10)).rejects.toThrow('variationId is required');
        });

        it('sets alert type to LOW_QUANTITY when minStock > 0', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariation] });
            db.query.mockResolvedValueOnce({ rows: [{ location_id: 'LOC1' }] });
            squareApi.setSquareInventoryAlertThreshold.mockResolvedValueOnce({});
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });

            await updateMinStock('VAR1', merchantId, 10);

            // The variation-level UPDATE
            const updateCall = db.query.mock.calls[2];
            expect(updateCall[1]).toContain('LOW_QUANTITY');
        });
    });

    // ==================== updateCost ====================
    describe('updateCost', () => {
        const mockVariationWithVendor = {
            id: 'VAR1', sku: 'SKU-001', name: 'Small Bag', item_name: 'Dog Food',
            vendor_id: 'VEN1', current_cost: 500, vendor_name: 'Acme'
        };

        const mockVariationNoVendor = {
            id: 'VAR2', sku: 'SKU-002', name: 'Large Bag', item_name: 'Cat Food',
            vendor_id: null, current_cost: null, vendor_name: null
        };

        it('pushes cost to Square with existing vendor', async () => {
            // Variation lookup
            db.query.mockResolvedValueOnce({ rows: [mockVariationWithVendor] });
            getMerchantLocaleConfig.mockResolvedValueOnce({ currency: 'CAD' });
            squareApi.updateVariationCost.mockResolvedValueOnce({});

            const result = await updateCost('VAR1', merchantId, 750);

            expect(result.success).toBe(true);
            expect(result.synced_to_square).toBe(true);
            expect(result.previous_cost_cents).toBe(500);
            expect(result.new_cost_cents).toBe(750);
            expect(result.vendor_id).toBe('VEN1');
            expect(squareApi.updateVariationCost).toHaveBeenCalledWith(
                'VAR1', 'VEN1', 750, 'CAD', { merchantId }
            );
        });

        it('pushes cost to Square with explicit vendorId', async () => {
            // Vendor ownership check
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VEN2' }] });
            // Variation lookup
            db.query.mockResolvedValueOnce({ rows: [mockVariationNoVendor] });
            getMerchantLocaleConfig.mockResolvedValueOnce({ currency: 'CAD' });
            squareApi.updateVariationCost.mockResolvedValueOnce({});

            const result = await updateCost('VAR2', merchantId, 300, 'VEN2');

            expect(result.success).toBe(true);
            expect(result.vendor_id).toBe('VEN2');
            expect(squareApi.updateVariationCost).toHaveBeenCalledWith(
                'VAR2', 'VEN2', 300, 'CAD', { merchantId }
            );
        });

        it('validates vendor ownership when vendorId is provided', async () => {
            // Vendor ownership check fails
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateCost('VAR1', merchantId, 500, 'STOLEN-VENDOR');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid vendor');
            expect(result.status).toBe(403);
        });

        it('handles no vendor - saves locally only', async () => {
            // Variation lookup - no vendor
            db.query.mockResolvedValueOnce({ rows: [mockVariationNoVendor] });

            const result = await updateCost('VAR2', merchantId, 300);

            expect(result.success).toBe(true);
            expect(result.synced_to_square).toBe(false);
            expect(result.warning).toContain('No vendor associated');
            expect(squareApi.updateVariationCost).not.toHaveBeenCalled();
        });

        it('handles ITEM_NOT_AT_LOCATION Square error', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationWithVendor] });
            getMerchantLocaleConfig.mockResolvedValueOnce({ currency: 'CAD' });
            const squareError = new Error('Not at location');
            squareError.code = 'ITEM_NOT_AT_LOCATION';
            squareError.parentItemId = 'ITEM-PARENT';
            squareApi.updateVariationCost.mockRejectedValueOnce(squareError);

            const result = await updateCost('VAR1', merchantId, 750);

            expect(result.success).toBe(false);
            expect(result.code).toBe('ITEM_NOT_AT_LOCATION');
            expect(result.parent_item_id).toBe('ITEM-PARENT');
            expect(result.status).toBe(422);
            expect(result.square_error).toBe(true);
        });

        it('handles generic Square error', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationWithVendor] });
            getMerchantLocaleConfig.mockResolvedValueOnce({ currency: 'CAD' });
            squareApi.updateVariationCost.mockRejectedValueOnce(new Error('Timeout'));

            const result = await updateCost('VAR1', merchantId, 750);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to update cost in Square');
            expect(result.status).toBe(500);
        });

        it('returns 404 for unknown variation', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateCost('NONEXISTENT', merchantId, 500);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Variation not found');
            expect(result.status).toBe(404);
        });

        it('returns error when cost_cents is null', async () => {
            const result = await updateCost('VAR1', merchantId, null);

            expect(result.success).toBe(false);
            expect(result.error).toContain('cost_cents is required');
            expect(result.status).toBe(400);
        });

        it('returns error when cost_cents is undefined', async () => {
            const result = await updateCost('VAR1', merchantId, undefined);

            expect(result.success).toBe(false);
            expect(result.error).toContain('cost_cents is required');
        });

        it('returns error when cost_cents is negative', async () => {
            const result = await updateCost('VAR1', merchantId, -100);

            expect(result.success).toBe(false);
            expect(result.error).toContain('non-negative');
            expect(result.status).toBe(400);
        });

        it('returns error when cost_cents is not a number', async () => {
            const result = await updateCost('VAR1', merchantId, 'abc');

            expect(result.success).toBe(false);
            expect(result.error).toContain('non-negative');
        });

        it('rounds cost to nearest cent', async () => {
            db.query.mockResolvedValueOnce({ rows: [mockVariationWithVendor] });
            getMerchantLocaleConfig.mockResolvedValueOnce({ currency: 'CAD' });
            squareApi.updateVariationCost.mockResolvedValueOnce({});

            await updateCost('VAR1', merchantId, 499.7);

            expect(squareApi.updateVariationCost).toHaveBeenCalledWith(
                'VAR1', 'VEN1', 500, 'CAD', { merchantId }
            );
        });

        it('throws when merchantId is missing', async () => {
            await expect(updateCost('VAR1', null, 500)).rejects.toThrow('merchantId is required');
        });

        it('throws when variationId is missing', async () => {
            await expect(updateCost(null, merchantId, 500)).rejects.toThrow('variationId is required');
        });
    });

    // ==================== bulkUpdateExtendedFields ====================
    describe('bulkUpdateExtendedFields', () => {
        it('updates multiple variations by SKU', async () => {
            // Batch SKU lookup
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 'VAR1', sku: 'SKU-001' },
                    { id: 'VAR2', sku: 'SKU-002' }
                ]
            });
            // Two UPDATE queries
            db.query.mockResolvedValueOnce({ rowCount: 1 });
            db.query.mockResolvedValueOnce({ rowCount: 1 });

            const updates = [
                { sku: 'SKU-001', shelf_location: 'A1', notes: 'Top shelf' },
                { sku: 'SKU-002', bin_location: 'B3' }
            ];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            expect(result.updated_count).toBe(2);
            expect(result.errors).toHaveLength(0);
        });

        it('filters out disallowed bulk fields', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'VAR1', sku: 'SKU-001' }] });
            db.query.mockResolvedValueOnce({ rowCount: 1 });

            const updates = [
                { sku: 'SKU-001', shelf_location: 'A1', last_cost_cents: 500 }
            ];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            // last_cost_cents is in ALLOWED_EXTENDED_FIELDS but NOT in ALLOWED_BULK_FIELDS
            const [updateQuery] = db.query.mock.calls[1];
            expect(updateQuery).toContain('shelf_location');
            expect(updateQuery).not.toContain('last_cost_cents');
        });

        it('syncs case_pack to Square during bulk update', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', sku: 'SKU-001' }]
            });
            db.query.mockResolvedValueOnce({ rowCount: 1 });
            squareApi.updateCustomAttributeValues.mockResolvedValueOnce({ success: true });

            const updates = [{ sku: 'SKU-001', case_pack_quantity: 24 }];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            expect(result.squarePush.success).toBe(1);
            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
                'VAR1',
                { case_pack_quantity: { number_value: '24' } },
                { merchantId }
            );
        });

        it('does not sync case_pack to Square when null or 0', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 'VAR1', sku: 'SKU-001' },
                    { id: 'VAR2', sku: 'SKU-002' }
                ]
            });
            db.query.mockResolvedValueOnce({ rowCount: 1 });
            db.query.mockResolvedValueOnce({ rowCount: 1 });

            const updates = [
                { sku: 'SKU-001', case_pack_quantity: null },
                { sku: 'SKU-002', case_pack_quantity: 0 }
            ];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            expect(squareApi.updateCustomAttributeValues).not.toHaveBeenCalled();
        });

        it('collects errors for missing SKUs', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const updates = [
                { shelf_location: 'A1' }, // no sku
                { sku: 'SKU-001', shelf_location: 'B2' }
            ];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain('SKU required');
        });

        it('collects Square sync errors without failing the batch', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', sku: 'SKU-001' }]
            });
            db.query.mockResolvedValueOnce({ rowCount: 1 });
            squareApi.updateCustomAttributeValues.mockRejectedValueOnce(
                new Error('Square sync failed')
            );

            const updates = [{ sku: 'SKU-001', case_pack_quantity: 12 }];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            expect(result.updated_count).toBe(1);
            expect(result.squarePush.failed).toBe(1);
            expect(result.squarePush.errors[0].sku).toBe('SKU-001');
        });

        it('returns error when input is not an array', async () => {
            const result = await bulkUpdateExtendedFields(merchantId, 'not-array');

            expect(result.success).toBe(false);
            expect(result.error).toContain('array');
            expect(result.status).toBe(400);
        });

        it('handles empty updates array', async () => {
            const result = await bulkUpdateExtendedFields(merchantId, []);

            expect(result.success).toBe(true);
            expect(result.updated_count).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it('handles DB errors for individual items', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', sku: 'SKU-001' }]
            });
            db.query.mockRejectedValueOnce(new Error('DB constraint violation'));

            const updates = [{ sku: 'SKU-001', shelf_location: 'A1' }];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            expect(result.updated_count).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].sku).toBe('SKU-001');
            expect(result.errors[0].error).toContain('DB constraint');
        });

        it('throws when merchantId is missing', async () => {
            await expect(bulkUpdateExtendedFields(null, [])).rejects.toThrow('merchantId is required');
        });

        it('skips items with no valid bulk fields', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'VAR1', sku: 'SKU-001' }]
            });

            const updates = [
                { sku: 'SKU-001', last_cost_cents: 500 } // not in ALLOWED_BULK_FIELDS
            ];

            const result = await bulkUpdateExtendedFields(merchantId, updates);

            expect(result.success).toBe(true);
            // Only the batch lookup query should have been called, no UPDATE
            expect(db.query).toHaveBeenCalledTimes(1);
            expect(result.updated_count).toBe(0);
        });
    });
});
