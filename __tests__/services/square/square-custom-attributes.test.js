/**
 * Tests for square-custom-attributes.js
 *
 * Covers: listCustomAttributeDefinitions, upsertCustomAttributeDefinition,
 * updateCustomAttributeValues, batchUpdateCustomAttributeValues,
 * initializeCustomAttributes, pushCasePackToSquare, pushBrandsToSquare,
 * pushExpiryDatesToSquare, deleteCustomAttributeDefinition
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => logger);
jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn()
}));
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue(),
    generateIdempotencyKey: jest.fn().mockReturnValue('test-idem-key')
}));
jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
    SYNC: { CATALOG_BATCH_SIZE: 100, INTER_BATCH_DELAY_MS: 200 }
}));
jest.mock('../../../services/square/with-location-repair', () => ({
    withLocationRepair: jest.fn().mockImplementation(async ({ fn }) => ({
        result: await fn(),
        repairedCount: 0
    }))
}));

const {
    listCustomAttributeDefinitions,
    upsertCustomAttributeDefinition,
    updateCustomAttributeValues,
    batchUpdateCustomAttributeValues,
    initializeCustomAttributes,
    pushCasePackToSquare,
    pushBrandsToSquare,
    pushExpiryDatesToSquare,
    deleteCustomAttributeDefinition
} = require('../../../services/square/square-custom-attributes');

const db = require('../../../utils/database');
const { getMerchantToken, makeSquareRequest, sleep, generateIdempotencyKey } = require('../../../services/square/square-client');
const { withLocationRepair } = require('../../../services/square/with-location-repair');

const merchantId = 1;

beforeEach(() => {
    jest.resetAllMocks();
    // Restore default mock implementations after resetAllMocks wipes them
    getMerchantToken.mockResolvedValue('test-token');
    generateIdempotencyKey.mockReturnValue('test-idem-key');
    sleep.mockResolvedValue();
    withLocationRepair.mockImplementation(async ({ fn }) => ({
        result: await fn(),
        repairedCount: 0
    }));
});

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeDefinitionObject(key, overrides = {}) {
    return {
        id: overrides.id || `DEF-${key}`,
        type: 'CUSTOM_ATTRIBUTE_DEFINITION',
        version: overrides.version || 1,
        custom_attribute_definition_data: {
            key,
            name: overrides.name || key,
            description: overrides.description || '',
            type: overrides.attrType || 'STRING',
            allowed_object_types: overrides.allowed_object_types || ['ITEM_VARIATION'],
            seller_visibility: 'SELLER_VISIBILITY_READ_WRITE_VALUES',
            app_visibility: 'APP_VISIBILITY_READ_WRITE_VALUES',
            source_application: overrides.source_application || null
        }
    };
}

function makeCatalogObject(id, type, overrides = {}) {
    const obj = {
        id,
        type,
        version: overrides.version || 1,
        custom_attribute_values: overrides.custom_attribute_values || {}
    };
    if (type === 'ITEM') {
        obj.item_data = overrides.item_data || { name: 'Test Item' };
    } else if (type === 'ITEM_VARIATION') {
        obj.item_variation_data = overrides.item_variation_data || { name: 'Test Variation', item_id: 'PARENT-ITEM' };
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'present_at_all_locations')) {
        obj.present_at_all_locations = overrides.present_at_all_locations;
    }
    if (overrides.present_at_location_ids) {
        obj.present_at_location_ids = overrides.present_at_location_ids;
    }
    return obj;
}

// ===========================================================================
// listCustomAttributeDefinitions
// ===========================================================================

describe('listCustomAttributeDefinitions', () => {
    test('returns parsed definitions from single page', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                makeDefinitionObject('case_pack_quantity', { attrType: 'NUMBER' }),
                makeDefinitionObject('brand', { attrType: 'STRING' })
            ],
            cursor: null
        });

        const defs = await listCustomAttributeDefinitions({ merchantId });

        expect(defs).toHaveLength(2);
        expect(defs[0].key).toBe('case_pack_quantity');
        expect(defs[0].type).toBe('NUMBER');
        expect(defs[1].key).toBe('brand');
        expect(getMerchantToken).toHaveBeenCalledWith(merchantId);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/list?types=CUSTOM_ATTRIBUTE_DEFINITION',
            expect.objectContaining({ accessToken: 'test-token' })
        );
    });

    test('paginates through multiple pages', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [makeDefinitionObject('key1')],
                cursor: 'page2'
            })
            .mockResolvedValueOnce({
                objects: [makeDefinitionObject('key2')],
                cursor: null
            });

        const defs = await listCustomAttributeDefinitions({ merchantId });

        expect(defs).toHaveLength(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            expect.stringContaining('cursor=page2'),
            expect.any(Object)
        );
    });

    test('filters out non-CUSTOM_ATTRIBUTE_DEFINITION objects', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                makeDefinitionObject('valid_key'),
                { id: 'OTHER-1', type: 'ITEM', item_data: {} }
            ],
            cursor: null
        });

        const defs = await listCustomAttributeDefinitions({ merchantId });
        expect(defs).toHaveLength(1);
        expect(defs[0].key).toBe('valid_key');
    });

    test('returns empty array when no objects', async () => {
        makeSquareRequest.mockResolvedValueOnce({ objects: null, cursor: null });

        const defs = await listCustomAttributeDefinitions({ merchantId });
        expect(defs).toHaveLength(0);
    });

    test('handles pagination with cursor until null', async () => {
        // The MAX_PAGINATION_ITERATIONS is destructured at import time so we can't
        // dynamically change it. Instead verify normal pagination termination.
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [makeDefinitionObject('k1')], cursor: 'c2' })
            .mockResolvedValueOnce({ objects: [makeDefinitionObject('k2')], cursor: null });

        const defs = await listCustomAttributeDefinitions({ merchantId });

        expect(defs).toHaveLength(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('propagates API errors', async () => {
        makeSquareRequest.mockRejectedValueOnce(new Error('Square API down'));

        await expect(listCustomAttributeDefinitions({ merchantId }))
            .rejects.toThrow('Square API down');
    });
});

// ===========================================================================
// upsertCustomAttributeDefinition
// ===========================================================================

describe('upsertCustomAttributeDefinition', () => {
    test('creates a STRING type definition with temp ID', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'NEW-ID', version: 1 },
            id_mappings: [{ client_object_id: '#brand', object_id: 'NEW-ID' }]
        });

        const result = await upsertCustomAttributeDefinition(
            { key: 'brand', name: 'Brand', type: 'STRING', allowed_object_types: ['ITEM'] },
            { merchantId }
        );

        expect(result.success).toBe(true);
        expect(result.definition.id).toBe('NEW-ID');

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.object.id).toBe('#brand');
        expect(body.object.custom_attribute_definition_data.type).toBe('STRING');
        expect(body.object.custom_attribute_definition_data.key).toBe('brand');
        expect(body.idempotency_key).toBe('test-idem-key');
        // No number_config for STRING
        expect(body.object.custom_attribute_definition_data.number_config).toBeUndefined();
    });

    test('creates a NUMBER type definition with precision', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'NUM-ID', version: 1 },
            id_mappings: []
        });

        await upsertCustomAttributeDefinition(
            { key: 'case_pack_quantity', name: 'Case Pack', type: 'NUMBER', precision: 0 },
            { merchantId }
        );

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.object.custom_attribute_definition_data.number_config).toEqual({ precision: 0 });
    });

    test('creates a SELECTION type definition with selections', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'SEL-ID', version: 1 },
            id_mappings: []
        });

        await upsertCustomAttributeDefinition(
            {
                key: 'color',
                name: 'Color',
                type: 'SELECTION',
                selections: [{ name: 'Red' }, { name: 'Blue', uid: 'blue-uid' }],
                max_selections: 2
            },
            { merchantId }
        );

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        const selConfig = body.object.custom_attribute_definition_data.selection_config;
        expect(selConfig.allowed_selections).toHaveLength(2);
        expect(selConfig.allowed_selections[0]).toEqual({ uid: 'sel-0', name: 'Red' });
        expect(selConfig.allowed_selections[1]).toEqual({ uid: 'blue-uid', name: 'Blue' });
        expect(selConfig.max_allowed_selections).toBe(2);
    });

    test('uses existing ID and version when updating', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'EXISTING-ID', version: 3 },
            id_mappings: []
        });

        await upsertCustomAttributeDefinition(
            { key: 'brand', name: 'Brand', id: 'EXISTING-ID', version: 2 },
            { merchantId }
        );

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.object.id).toBe('EXISTING-ID');
        expect(body.object.version).toBe(2);
    });

    test('defaults to STRING type and ITEM_VARIATION when not specified', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            catalog_object: { id: 'DEF-ID', version: 1 },
            id_mappings: []
        });

        await upsertCustomAttributeDefinition(
            { key: 'my_attr', name: 'My Attr' },
            { merchantId }
        );

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.object.custom_attribute_definition_data.type).toBe('STRING');
        expect(body.object.custom_attribute_definition_data.allowed_object_types).toEqual(['ITEM_VARIATION']);
    });

    test('propagates errors from Square API', async () => {
        makeSquareRequest.mockRejectedValueOnce(new Error('Conflict'));

        await expect(upsertCustomAttributeDefinition(
            { key: 'bad', name: 'Bad' },
            { merchantId }
        )).rejects.toThrow('Conflict');
    });
});

// ===========================================================================
// updateCustomAttributeValues
// ===========================================================================

describe('updateCustomAttributeValues', () => {
    test('retrieves current object, merges custom attributes, and upserts', async () => {
        const existingObj = makeCatalogObject('VAR-1', 'ITEM_VARIATION', {
            version: 5,
            custom_attribute_values: { existing_attr: { string_value: 'old' } }
        });
        makeSquareRequest
            .mockResolvedValueOnce({ object: existingObj }) // retrieve
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR-1', version: 6 } }); // upsert

        const result = await updateCustomAttributeValues(
            'VAR-1',
            { brand: { string_value: 'Acme' } },
            { merchantId }
        );

        expect(result.success).toBe(true);

        // Check retrieve call
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/object/VAR-1?include_related_objects=false',
            expect.objectContaining({ accessToken: 'test-token' })
        );

        // Check upsert call has merged attributes
        const body = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(body.object.custom_attribute_values).toEqual({
            existing_attr: { string_value: 'old' },
            brand: { string_value: 'Acme' }
        });
        expect(body.object.version).toBe(5);
        expect(body.object.type).toBe('ITEM_VARIATION');
        expect(body.object.item_variation_data).toBeDefined();
    });

    test('handles ITEM type objects', async () => {
        const existingObj = makeCatalogObject('ITEM-1', 'ITEM', { version: 3 });
        makeSquareRequest
            .mockResolvedValueOnce({ object: existingObj })
            .mockResolvedValueOnce({ catalog_object: { id: 'ITEM-1', version: 4 } });

        await updateCustomAttributeValues(
            'ITEM-1',
            { brand: { string_value: 'PetCo' } },
            { merchantId }
        );

        const body = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(body.object.type).toBe('ITEM');
        expect(body.object.item_data).toBeDefined();
        expect(body.object.item_variation_data).toBeUndefined();
    });

    test('throws when merchantId is not provided', async () => {
        await expect(updateCustomAttributeValues('VAR-1', {}, {}))
            .rejects.toThrow('merchantId is required');
    });

    test('throws when catalog object not found', async () => {
        makeSquareRequest.mockResolvedValueOnce({ object: null });

        await expect(updateCustomAttributeValues('MISSING-1', {}, { merchantId }))
            .rejects.toThrow('Catalog object not found: MISSING-1');
    });

    test('overwrites existing attribute values with new ones', async () => {
        const existingObj = makeCatalogObject('VAR-2', 'ITEM_VARIATION', {
            version: 1,
            custom_attribute_values: { brand: { string_value: 'OldBrand' } }
        });
        makeSquareRequest
            .mockResolvedValueOnce({ object: existingObj })
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR-2', version: 2 } });

        await updateCustomAttributeValues(
            'VAR-2',
            { brand: { string_value: 'NewBrand' } },
            { merchantId }
        );

        const body = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(body.object.custom_attribute_values.brand.string_value).toBe('NewBrand');
    });
});

// ===========================================================================
// updateCustomAttributeValues — withLocationRepair integration
// ===========================================================================

describe('updateCustomAttributeValues — withLocationRepair', () => {
    test('INVALID_VALUE/item_id error triggers repair and retry', async () => {
        const existingObj = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 5 });
        makeSquareRequest
            .mockResolvedValueOnce({ object: existingObj })
            .mockRejectedValueOnce(new Error('INVALID_VALUE: item_id invalid'))
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR-1', version: 6 } });

        withLocationRepair.mockImplementationOnce(async ({ fn }) => {
            try { await fn(); } catch (_) { /* repair */ }
            const result = await fn();
            return { result, repairedCount: 1 };
        });

        const result = await updateCustomAttributeValues(
            'VAR-1',
            { brand: { string_value: 'Acme' } },
            { merchantId }
        );

        expect(withLocationRepair).toHaveBeenCalledWith(expect.objectContaining({
            merchantId,
            accessToken: 'test-token',
            variationIds: ['VAR-1'],
            fn: expect.any(Function)
        }));
        expect(result.success).toBe(true);
        expect(result.catalog_object.version).toBe(6);
    });

    test('repair succeeds — upsert retries and returns result', async () => {
        const existingObj = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 5 });
        makeSquareRequest.mockResolvedValueOnce({ object: existingObj });

        withLocationRepair.mockImplementationOnce(async () => ({
            result: { catalog_object: { id: 'VAR-1', version: 6 } },
            repairedCount: 1
        }));

        const result = await updateCustomAttributeValues(
            'VAR-1',
            { brand: { string_value: 'Acme' } },
            { merchantId }
        );

        expect(result.success).toBe(true);
        expect(result.catalog_object).toEqual({ id: 'VAR-1', version: 6 });
    });
});

// ===========================================================================
// batchUpdateCustomAttributeValues
// ===========================================================================

describe('batchUpdateCustomAttributeValues', () => {
    test('batch retrieves objects and upserts successfully', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        const obj2 = makeCatalogObject('VAR-2', 'ITEM_VARIATION', { version: 2 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1, obj2] }) // batch-retrieve
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }, { id: 'VAR-2' }] }); // batch-upsert

        const updates = [
            { catalogObjectId: 'VAR-1', customAttributeValues: { case_pack_quantity: { number_value: '12' } } },
            { catalogObjectId: 'VAR-2', customAttributeValues: { case_pack_quantity: { number_value: '24' } } }
        ];

        const result = await batchUpdateCustomAttributeValues(updates, { merchantId });

        expect(result.success).toBe(true);
        expect(result.updated).toBe(2);
        expect(result.failed).toBe(0);

        // Check batch-retrieve call
        const retrieveBody = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(retrieveBody.object_ids).toEqual(['VAR-1', 'VAR-2']);

        // Check batch-upsert call
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(upsertBody.batches[0].objects).toHaveLength(2);
    });

    test('handles missing objects gracefully', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] }) // only VAR-1 found
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }] });

        const updates = [
            { catalogObjectId: 'VAR-1', customAttributeValues: { a: { string_value: '1' } } },
            { catalogObjectId: 'MISSING', customAttributeValues: { a: { string_value: '2' } } }
        ];

        const result = await batchUpdateCustomAttributeValues(updates, { merchantId });

        expect(result.updated).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'MISSING', error: 'Object not found' })])
        );
    });

    test('throws when merchantId is not provided', async () => {
        await expect(batchUpdateCustomAttributeValues([], {}))
            .rejects.toThrow('merchantId is required');
    });

    test('skips batch when all objects are missing', async () => {
        makeSquareRequest.mockResolvedValueOnce({ objects: [] });

        const updates = [
            { catalogObjectId: 'MISS-1', customAttributeValues: {} },
            { catalogObjectId: 'MISS-2', customAttributeValues: {} }
        ];

        const result = await batchUpdateCustomAttributeValues(updates, { merchantId });

        expect(result.failed).toBe(2);
        // batch-upsert should not be called
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    test('sleeps between batches of 100', async () => {
        // Build 150 updates to trigger two batches
        const allUpdates = [];
        const allObjects = [];
        for (let i = 0; i < 150; i++) {
            allUpdates.push({
                catalogObjectId: `VAR-${i}`,
                customAttributeValues: { k: { string_value: `v${i}` } }
            });
            allObjects.push(makeCatalogObject(`VAR-${i}`, 'ITEM_VARIATION', { version: 1 }));
        }

        makeSquareRequest
            // Batch 1 retrieve
            .mockResolvedValueOnce({ objects: allObjects.slice(0, 100) })
            // Batch 1 upsert
            .mockResolvedValueOnce({ objects: allObjects.slice(0, 100) })
            // Batch 2 retrieve
            .mockResolvedValueOnce({ objects: allObjects.slice(100) })
            // Batch 2 upsert
            .mockResolvedValueOnce({ objects: allObjects.slice(100) });

        await batchUpdateCustomAttributeValues(allUpdates, { merchantId });

        expect(sleep).toHaveBeenCalledWith(200);
    });

    test('records failure when upsert throws', async () => {
        const varObj = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [varObj] })
            .mockRejectedValueOnce(new Error('Unknown error'));

        const updates = [
            { catalogObjectId: 'VAR-1', customAttributeValues: { x: { string_value: 'y' } } }
        ];

        const result = await batchUpdateCustomAttributeValues(updates, { merchantId });

        // Non-location errors still count as failures but success is derived from failed === 0
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
    });

    test('includes ITEM data field for ITEM-type objects', async () => {
        const itemObj = makeCatalogObject('ITEM-1', 'ITEM', { version: 3 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [itemObj] })  // batch-retrieve
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM-1' }] }); // batch-upsert

        const updates = [
            { catalogObjectId: 'ITEM-1', customAttributeValues: { brand: { string_value: 'X' } } }
        ];

        await batchUpdateCustomAttributeValues(updates, { merchantId });

        // Call 0 = batch-retrieve, Call 1 = batch-upsert
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const obj = upsertBody.batches[0].objects[0];
        expect(obj.item_data).toBeDefined();
        expect(obj.item_variation_data).toBeUndefined();
    });
});

// ===========================================================================
// batchUpdateCustomAttributeValues — withLocationRepair integration
// ===========================================================================

describe('batchUpdateCustomAttributeValues — withLocationRepair integration', () => {
    test('wraps batch-upsert with withLocationRepair using batch variationIds', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        const obj2 = makeCatalogObject('VAR-2', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1, obj2] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }, { id: 'VAR-2' }] });

        const updates = [
            { catalogObjectId: 'VAR-1', customAttributeValues: { x: { string_value: 'y' } } },
            { catalogObjectId: 'VAR-2', customAttributeValues: { x: { string_value: 'z' } } }
        ];

        const result = await batchUpdateCustomAttributeValues(updates, { merchantId });

        expect(withLocationRepair).toHaveBeenCalledTimes(1);
        expect(withLocationRepair).toHaveBeenCalledWith(expect.objectContaining({
            merchantId,
            accessToken: 'test-token',
            variationIds: ['VAR-1', 'VAR-2'],
            fn: expect.any(Function)
        }));
        expect(result.updated).toBe(2);
        expect(result.repairedParents).toBe(0);
    });

    test('repair succeeded → repairedParents increments by repairedCount', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }] });

        withLocationRepair.mockImplementationOnce(async ({ fn }) => {
            await fn();
            return { result: { objects: [{ id: 'VAR-1' }] }, repairedCount: 1 };
        });

        const result = await batchUpdateCustomAttributeValues(
            [{ catalogObjectId: 'VAR-1', customAttributeValues: { x: { string_value: 'y' } } }],
            { merchantId }
        );

        expect(result.repairedParents).toBe(1);
        expect(result.updated).toBe(1);
        expect(result.successVariations).toEqual(['VAR-1']);
        expect(result.failedVariations).toEqual([]);
    });

    test('repair failed (manual-review error) → variations go to failedVariations', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        const obj2 = makeCatalogObject('VAR-2', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest.mockResolvedValueOnce({ objects: [obj1, obj2] });

        const manualReviewErr = new Error(
            'Location mismatch repair failed after 1 attempt for parent ITEM1 at location LOC1 — manual review required'
        );
        manualReviewErr.repairAttempted = true;
        withLocationRepair.mockRejectedValueOnce(manualReviewErr);

        const result = await batchUpdateCustomAttributeValues([
            { catalogObjectId: 'VAR-1', customAttributeValues: { x: { string_value: 'y' } } },
            { catalogObjectId: 'VAR-2', customAttributeValues: { x: { string_value: 'z' } } }
        ], { merchantId });

        expect(result.updated).toBe(0);
        expect(result.successVariations).toEqual([]);
        const failedIds = result.failedVariations.map(f => f.variationId).sort();
        expect(failedIds).toEqual(['VAR-1', 'VAR-2']);
        expect(result.failedVariations.every(f => f.error === manualReviewErr.message)).toBe(true);
        expect(result.repairedParents).toBe(0);
    });

    test('accumulates repairedParents across multiple batches', async () => {
        // Build 150 updates → 2 batches
        const allUpdates = [];
        const batch1Objs = [];
        const batch2Objs = [];
        for (let i = 0; i < 150; i++) {
            allUpdates.push({
                catalogObjectId: `VAR-${i}`,
                customAttributeValues: { k: { string_value: `v${i}` } }
            });
            const obj = makeCatalogObject(`VAR-${i}`, 'ITEM_VARIATION', { version: 1 });
            if (i < 100) batch1Objs.push(obj); else batch2Objs.push(obj);
        }

        makeSquareRequest
            .mockResolvedValueOnce({ objects: batch1Objs })  // batch 1 retrieve
            .mockResolvedValueOnce({ objects: batch1Objs })  // batch 1 upsert (via fn)
            .mockResolvedValueOnce({ objects: batch2Objs })  // batch 2 retrieve
            .mockResolvedValueOnce({ objects: batch2Objs }); // batch 2 upsert (via fn)

        withLocationRepair
            .mockImplementationOnce(async ({ fn }) => ({ result: await fn(), repairedCount: 2 }))
            .mockImplementationOnce(async ({ fn }) => ({ result: await fn(), repairedCount: 3 }));

        const result = await batchUpdateCustomAttributeValues(allUpdates, { merchantId });

        expect(result.repairedParents).toBe(5);
        expect(result.updated).toBe(150);
    });
});

// ===========================================================================
// batchUpdateCustomAttributeValues — structured per-variation failures
// ===========================================================================

describe('batchUpdateCustomAttributeValues — structured failures', () => {
    test('populates successVariations and failedVariations on partial failure', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });

        // Only VAR-1 returned (VAR-MISSING not found in Square)
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }] });

        const updates = [
            { catalogObjectId: 'VAR-1', customAttributeValues: { a: { string_value: '1' } } },
            { catalogObjectId: 'VAR-MISSING', customAttributeValues: { a: { string_value: '2' } } }
        ];

        const result = await batchUpdateCustomAttributeValues(updates, { merchantId });

        expect(result.successVariations).toEqual(['VAR-1']);
        expect(result.failedVariations).toEqual([
            { variationId: 'VAR-MISSING', error: 'Object not found' }
        ]);
    });

    test('populates failedVariations when upsert fails with non-location error', async () => {
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] })
            .mockRejectedValueOnce(new Error('Unknown Square error'));

        const result = await batchUpdateCustomAttributeValues(
            [{ catalogObjectId: 'VAR-1', customAttributeValues: { a: { string_value: '1' } } }],
            { merchantId }
        );

        expect(result.failed).toBe(1);
        expect(result.failedVariations).toEqual([
            { variationId: 'VAR-1', error: 'Unknown Square error' }
        ]);
        expect(result.successVariations).toEqual([]);
    });

    test('failedVariations does not double-count a not-found variation when batch also fails', async () => {
        // One not-found + upsert of the rest fails → failedVariations should only list each variation once.
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });

        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] })
            .mockRejectedValueOnce(new Error('Boom'));

        const result = await batchUpdateCustomAttributeValues([
            { catalogObjectId: 'VAR-1', customAttributeValues: { a: { string_value: '1' } } },
            { catalogObjectId: 'VAR-MISSING', customAttributeValues: { a: { string_value: '2' } } }
        ], { merchantId });

        const ids = result.failedVariations.map(f => f.variationId).sort();
        expect(ids).toEqual(['VAR-1', 'VAR-MISSING']);
    });
});

// ===========================================================================
// initializeCustomAttributes
// ===========================================================================

describe('initializeCustomAttributes', () => {
    test('creates new definitions when none exist', async () => {
        // listCustomAttributeDefinitions calls getMerchantToken + makeSquareRequest
        // List call returns empty
        makeSquareRequest.mockResolvedValueOnce({ objects: [], cursor: null });

        // Each upsert call gets getMerchantToken (returns cached), then makeSquareRequest
        // 6 standard definitions
        for (let i = 0; i < 6; i++) {
            makeSquareRequest.mockResolvedValueOnce({
                catalog_object: { id: `NEW-${i}`, version: 1 },
                id_mappings: []
            });
        }

        const result = await initializeCustomAttributes({ merchantId });

        expect(result.success).toBe(true);
        expect(result.definitions).toHaveLength(6);
        expect(result.definitions.every(d => d.status === 'created')).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    test('updates existing definitions with ID and version', async () => {
        // Return existing case_pack_quantity definition from list call
        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeDefinitionObject('case_pack_quantity', { id: 'EXIST-1', version: 5, attrType: 'NUMBER' })],
            cursor: null
        });

        // Upsert calls (6 definitions)
        for (let i = 0; i < 6; i++) {
            makeSquareRequest.mockResolvedValueOnce({
                catalog_object: { id: `RES-${i}`, version: 1 },
                id_mappings: []
            });
        }

        const result = await initializeCustomAttributes({ merchantId });

        expect(result.success).toBe(true);
        // case_pack_quantity should be 'updated', rest 'created'
        const casePackDef = result.definitions.find(d => d.key === 'case_pack_quantity');
        expect(casePackDef.status).toBe('updated');

        // Call 0 = list definitions, Call 1 = upsert for case_pack_quantity
        const firstUpsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(firstUpsertBody.object.id).toBe('EXIST-1');
        expect(firstUpsertBody.object.version).toBe(5);
    });

    test('returns skipped result when no merchantId', async () => {
        const result = await initializeCustomAttributes({});

        expect(result.success).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.error).toContain('merchantId is required');
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('records errors for individual definition failures', async () => {
        // list returns empty
        makeSquareRequest.mockResolvedValueOnce({ objects: [], cursor: null });

        // First upsert fails, rest succeed
        makeSquareRequest.mockRejectedValueOnce(new Error('Definition failed'));
        for (let i = 0; i < 5; i++) {
            makeSquareRequest.mockResolvedValueOnce({
                catalog_object: { id: `OK-${i}`, version: 1 },
                id_mappings: []
            });
        }

        const result = await initializeCustomAttributes({ merchantId });

        // success is set to false when any error occurs
        expect(result.success).toBe(false);
        expect(result.definitions).toHaveLength(5);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].key).toBe('case_pack_quantity'); // first definition
    });
});

// ===========================================================================
// pushCasePackToSquare
// ===========================================================================

describe('pushCasePackToSquare', () => {
    test('queries variations and builds batch updates', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 'VAR-1', case_pack_quantity: 12 },
                { id: 'VAR-2', case_pack_quantity: 24 }
            ]
        });

        // Mock batchUpdate internals
        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        const obj2 = makeCatalogObject('VAR-2', 'ITEM_VARIATION', { version: 1 });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1, obj2] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }, { id: 'VAR-2' }] });

        const result = await pushCasePackToSquare({ merchantId });

        expect(result.updated).toBe(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('case_pack_quantity'),
            [merchantId]
        );

        // Verify custom attribute values in the batch upsert
        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const objects = upsertBody.batches[0].objects;
        expect(objects[0].custom_attribute_values.case_pack_quantity.number_value).toBe('12');
        expect(objects[1].custom_attribute_values.case_pack_quantity.number_value).toBe('24');
    });

    test('returns early when no case pack data exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await pushCasePackToSquare({ merchantId });

        expect(result.success).toBe(true);
        expect(result.updated).toBe(0);
        expect(result.message).toContain('No case pack quantities');
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('throws when merchantId is not provided', async () => {
        await expect(pushCasePackToSquare({})).rejects.toThrow('merchantId is required');
    });

    test('propagates database errors', async () => {
        db.query.mockRejectedValueOnce(new Error('DB down'));

        await expect(pushCasePackToSquare({ merchantId })).rejects.toThrow('DB down');
    });
});

// ===========================================================================
// pushBrandsToSquare
// ===========================================================================

describe('pushBrandsToSquare', () => {
    test('queries items with brands and builds batch updates', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 'ITEM-1', brand_name: 'Royal Canin' },
                { id: 'ITEM-2', brand_name: 'Orijen' }
            ]
        });

        const obj1 = makeCatalogObject('ITEM-1', 'ITEM', { version: 1 });
        const obj2 = makeCatalogObject('ITEM-2', 'ITEM', { version: 1 });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1, obj2] })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM-1' }, { id: 'ITEM-2' }] });

        const result = await pushBrandsToSquare({ merchantId });

        expect(result.updated).toBe(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('brand_name'),
            [merchantId]
        );

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const objects = upsertBody.batches[0].objects;
        expect(objects[0].custom_attribute_values.brand.string_value).toBe('Royal Canin');
        expect(objects[1].custom_attribute_values.brand.string_value).toBe('Orijen');
    });

    test('returns early when no brand assignments exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await pushBrandsToSquare({ merchantId });

        expect(result.success).toBe(true);
        expect(result.updated).toBe(0);
        expect(result.message).toContain('No brand assignments');
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('throws when merchantId is not provided', async () => {
        await expect(pushBrandsToSquare({})).rejects.toThrow('merchantId is required');
    });
});

// ===========================================================================
// pushExpiryDatesToSquare
// ===========================================================================

describe('pushExpiryDatesToSquare', () => {
    test('queries variations with expiry data and formats dates as YYYY-MM-DD', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { variation_id: 'VAR-1', expiration_date: new Date('2026-06-15'), does_not_expire: false },
                { variation_id: 'VAR-2', expiration_date: new Date('2026-12-31'), does_not_expire: false }
            ]
        });

        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        const obj2 = makeCatalogObject('VAR-2', 'ITEM_VARIATION', { version: 1 });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1, obj2] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }, { id: 'VAR-2' }] });

        const result = await pushExpiryDatesToSquare({ merchantId });

        expect(result.updated).toBe(2);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('variation_expiration'),
            [merchantId]
        );

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const objects = upsertBody.batches[0].objects;
        expect(objects[0].custom_attribute_values.expiration_date.string_value).toBe('2026-06-15');
        expect(objects[0].custom_attribute_values.does_not_expire.boolean_value).toBe(false);
    });

    test('handles does_not_expire flag', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { variation_id: 'VAR-1', expiration_date: null, does_not_expire: true }
            ]
        });

        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }] });

        const result = await pushExpiryDatesToSquare({ merchantId });

        expect(result.updated).toBe(1);

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const attrs = upsertBody.batches[0].objects[0].custom_attribute_values;
        expect(attrs.does_not_expire.boolean_value).toBe(true);
        expect(attrs.expiration_date).toBeUndefined();
    });

    test('returns early when no expiry data exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await pushExpiryDatesToSquare({ merchantId });

        expect(result.success).toBe(true);
        expect(result.updated).toBe(0);
        expect(result.message).toContain('No expiry dates');
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('filters out updates with empty customAttributeValues', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                // does_not_expire is null/false AND expiration_date is null => empty attributes
                { variation_id: 'VAR-1', expiration_date: null, does_not_expire: null }
            ]
        });

        const result = await pushExpiryDatesToSquare({ merchantId });

        expect(result.success).toBe(true);
        expect(result.updated).toBe(0);
        expect(result.message).toContain('No valid expiry dates');
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('throws when merchantId is not provided', async () => {
        await expect(pushExpiryDatesToSquare({})).rejects.toThrow('merchantId is required');
    });

    test('sets does_not_expire false when expiration_date exists and does_not_expire is false', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { variation_id: 'VAR-1', expiration_date: new Date('2026-09-01'), does_not_expire: false }
            ]
        });

        const obj1 = makeCatalogObject('VAR-1', 'ITEM_VARIATION', { version: 1 });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [obj1] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR-1' }] });

        await pushExpiryDatesToSquare({ merchantId });

        const upsertBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const attrs = upsertBody.batches[0].objects[0].custom_attribute_values;
        expect(attrs.expiration_date.string_value).toBe('2026-09-01');
        expect(attrs.does_not_expire.boolean_value).toBe(false);
    });
});

// ===========================================================================
// deleteCustomAttributeDefinition
// ===========================================================================

describe('deleteCustomAttributeDefinition', () => {
    test('deletes by Square ID directly', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            deleted_object_ids: ['ABC-DEF-123-456']
        });

        const result = await deleteCustomAttributeDefinition('ABC-DEF-123-456', { merchantId });

        expect(result.success).toBe(true);
        expect(result.deleted_object_ids).toEqual(['ABC-DEF-123-456']);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/object/ABC-DEF-123-456',
            expect.objectContaining({ method: 'DELETE', accessToken: 'test-token' })
        );
    });

    test('looks up by key when input is not an ID format', async () => {
        // First call = list definitions to find ID for key
        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeDefinitionObject('brand', { id: 'FOUND-ID-123' })],
            cursor: null
        });
        // Second call = delete by found ID
        makeSquareRequest.mockResolvedValueOnce({
            deleted_object_ids: ['FOUND-ID-123']
        });

        const result = await deleteCustomAttributeDefinition('brand', { merchantId });

        expect(result.success).toBe(true);
        expect(result.deleted_object_ids).toEqual(['FOUND-ID-123']);
        // Should have called list first, then delete
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('throws when key lookup finds no matching definition', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [makeDefinitionObject('other_key')],
            cursor: null
        });

        await expect(deleteCustomAttributeDefinition('nonexistent', { merchantId }))
            .rejects.toThrow('Custom attribute definition not found with key: nonexistent');
    });

    test('returns default deleted_object_ids when response omits them', async () => {
        makeSquareRequest.mockResolvedValueOnce({});

        const result = await deleteCustomAttributeDefinition('SOME-ID-WITH-HYPHENS', { merchantId });

        expect(result.deleted_object_ids).toEqual(['SOME-ID-WITH-HYPHENS']);
    });

    test('propagates API errors', async () => {
        makeSquareRequest.mockRejectedValueOnce(new Error('Not found'));

        await expect(deleteCustomAttributeDefinition('SOME-ID-123', { merchantId }))
            .rejects.toThrow('Not found');
    });
});
