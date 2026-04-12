/**
 * Tests for square-inventory.js
 *
 * Covers syncInventory, getSquareInventoryCount, setSquareInventoryCount,
 * setSquareInventoryAlertThreshold, syncCommittedInventory, cleanupInventory.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
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
    SYNC: { BATCH_DELAY_MS: 0, INTER_BATCH_DELAY_MS: 0 },
    CACHE: { INVOICES_SCOPE_TTL_MS: 3600000 },
    RETRY: { MAX_ATTEMPTS: 3, BASE_DELAY_MS: 1000, MAX_DELAY_MS: 30000 }
}));
jest.mock('../../../services/square/square-diagnostics', () => ({
    enableItemAtAllLocations: jest.fn().mockResolvedValue({ success: true, itemId: 'ITEM1', itemName: 'Test Item' })
}));
jest.mock('../../../services/square/inventory-receive-sync', () => ({
    syncReceiveAdjustments: jest.fn().mockResolvedValue(0)
}));

const {
    syncInventory,
    getSquareInventoryCount,
    setSquareInventoryCount,
    setSquareInventoryAlertThreshold,
    syncCommittedInventory,
    cleanupInventory
} = require('../../../services/square/square-inventory');

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const {
    getMerchantToken,
    makeSquareRequest,
    sleep,
    generateIdempotencyKey
} = require('../../../services/square/square-client');
const { enableItemAtAllLocations } = require('../../../services/square/square-diagnostics');

const merchantId = 1;

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// syncInventory
// ---------------------------------------------------------------------------
describe('syncInventory', () => {
    function setupLocationsAndVariations(locationIds, variationIds) {
        db.query
            .mockResolvedValueOnce({ rows: locationIds.map(id => ({ id })) })   // locations
            .mockResolvedValueOnce({ rows: variationIds.map(id => ({ id })) }); // variations
    }

    test('fetches token, queries locations/variations, batches requests and upserts counts', async () => {
        setupLocationsAndVariations(['LOC1'], ['VAR1', 'VAR2']);
        makeSquareRequest.mockResolvedValueOnce({
            counts: [
                { catalog_object_id: 'VAR1', location_id: 'LOC1', state: 'IN_STOCK', quantity: '10' },
                { catalog_object_id: 'VAR2', location_id: 'LOC1', state: 'IN_STOCK', quantity: '5' }
            ]
        });
        // upsert queries
        db.query.mockResolvedValue({ rows: [] });

        const result = await syncInventory(merchantId);

        expect(result).toBe(2);
        expect(getMerchantToken).toHaveBeenCalledWith(merchantId);
        // locations query + variations query + 2 upserts = 4
        expect(db.query).toHaveBeenCalledTimes(4);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/inventory/counts/batch-retrieve',
            expect.objectContaining({ method: 'POST' })
        );
        expect(sleep).toHaveBeenCalledWith(0);
    });

    test('returns 0 when no active locations', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no locations

        const result = await syncInventory(merchantId);

        expect(result).toBe(0);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('returns 0 when no variations', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] }) // locations
            .mockResolvedValueOnce({ rows: [] });               // no variations

        const result = await syncInventory(merchantId);

        expect(result).toBe(0);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('processes multiple batches of 100', async () => {
        // Create 150 variations to force 2 batches
        const variationIds = Array.from({ length: 150 }, (_, i) => `VAR${i}`);
        setupLocationsAndVariations(['LOC1'], variationIds);

        makeSquareRequest
            .mockResolvedValueOnce({ counts: [{ catalog_object_id: 'VAR0', location_id: 'LOC1', state: 'IN_STOCK', quantity: '1' }] })
            .mockResolvedValueOnce({ counts: [{ catalog_object_id: 'VAR100', location_id: 'LOC1', state: 'IN_STOCK', quantity: '2' }] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await syncInventory(merchantId);

        expect(result).toBe(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        // First batch should have 100 IDs
        const firstCall = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(firstCall.catalog_object_ids).toHaveLength(100);
        // Second batch should have 50 IDs
        const secondCall = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(secondCall.catalog_object_ids).toHaveLength(50);
    });

    test('continues processing when a batch errors', async () => {
        const variationIds = Array.from({ length: 150 }, (_, i) => `VAR${i}`);
        setupLocationsAndVariations(['LOC1'], variationIds);

        makeSquareRequest
            .mockRejectedValueOnce(new Error('API rate limit'))
            .mockResolvedValueOnce({ counts: [{ catalog_object_id: 'VAR100', location_id: 'LOC1', state: 'IN_STOCK', quantity: '3' }] });
        db.query.mockResolvedValue({ rows: [] });

        const result = await syncInventory(merchantId);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(
            'Inventory sync batch failed',
            expect.objectContaining({ batch: 1 })
        );
    });

    test('handles counts with RESERVED_FOR_SALE state', async () => {
        setupLocationsAndVariations(['LOC1'], ['VAR1']);
        makeSquareRequest.mockResolvedValueOnce({
            counts: [
                { catalog_object_id: 'VAR1', location_id: 'LOC1', state: 'RESERVED_FOR_SALE', quantity: '2' }
            ]
        });
        db.query.mockResolvedValue({ rows: [] });

        const result = await syncInventory(merchantId);

        expect(result).toBe(1);
        // Verify state is passed to upsert
        const upsertCall = db.query.mock.calls[2]; // 3rd call is first upsert
        expect(upsertCall[1]).toEqual(['VAR1', 'LOC1', 'RESERVED_FOR_SALE', 2, merchantId]);
    });

    test('parses non-numeric quantity as 0', async () => {
        setupLocationsAndVariations(['LOC1'], ['VAR1']);
        makeSquareRequest.mockResolvedValueOnce({
            counts: [
                { catalog_object_id: 'VAR1', location_id: 'LOC1', state: 'IN_STOCK', quantity: 'NONE' }
            ]
        });
        db.query.mockResolvedValue({ rows: [] });

        await syncInventory(merchantId);

        const upsertCall = db.query.mock.calls[2];
        expect(upsertCall[1][3]).toBe(0); // quantity
    });

    test('throws when getMerchantToken fails', async () => {
        getMerchantToken.mockRejectedValueOnce(new Error('No token'));

        await expect(syncInventory(merchantId)).rejects.toThrow('No token');
    });
});

// ---------------------------------------------------------------------------
// getSquareInventoryCount
// ---------------------------------------------------------------------------
describe('getSquareInventoryCount', () => {
    test('fetches count from Square and returns quantity', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            counts: [
                { catalog_object_id: 'VAR1', location_id: 'LOC1', state: 'IN_STOCK', quantity: '42' }
            ]
        });

        const qty = await getSquareInventoryCount('VAR1', 'LOC1', merchantId);

        expect(qty).toBe(42);
        expect(getMerchantToken).toHaveBeenCalledWith(merchantId);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/inventory/counts/batch-retrieve',
            expect.objectContaining({
                method: 'POST',
                accessToken: 'test-token'
            })
        );
    });

    test('returns 0 when no matching count found', async () => {
        makeSquareRequest.mockResolvedValueOnce({ counts: [] });

        const qty = await getSquareInventoryCount('VAR1', 'LOC1', merchantId);

        expect(qty).toBe(0);
    });

    test('returns 0 when counts array is missing', async () => {
        makeSquareRequest.mockResolvedValueOnce({});

        const qty = await getSquareInventoryCount('VAR1', 'LOC1', merchantId);

        expect(qty).toBe(0);
    });

    test('throws when merchantId is not provided', async () => {
        await expect(getSquareInventoryCount('VAR1', 'LOC1', undefined))
            .rejects.toThrow('merchantId is required');
    });

    test('throws on Square API error', async () => {
        makeSquareRequest.mockRejectedValueOnce(new Error('Square API down'));

        await expect(getSquareInventoryCount('VAR1', 'LOC1', merchantId))
            .rejects.toThrow('Square API down');
    });

    test('ignores counts for other locations or states', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            counts: [
                { catalog_object_id: 'VAR1', location_id: 'LOC_OTHER', state: 'IN_STOCK', quantity: '10' },
                { catalog_object_id: 'VAR1', location_id: 'LOC1', state: 'RESERVED_FOR_SALE', quantity: '5' }
            ]
        });

        const qty = await getSquareInventoryCount('VAR1', 'LOC1', merchantId);

        expect(qty).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// setSquareInventoryCount
// ---------------------------------------------------------------------------
describe('setSquareInventoryCount', () => {
    test('creates physical count change with correct body', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            changes: [{ type: 'PHYSICAL_COUNT' }],
            counts: [{ quantity: '15' }]
        });

        const result = await setSquareInventoryCount('VAR1', 'LOC1', 15, 'Test adjustment', merchantId);

        expect(result.success).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(getMerchantToken).toHaveBeenCalledWith(merchantId);
        expect(generateIdempotencyKey).toHaveBeenCalledWith('cycle-count-VAR1-LOC1');

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.idempotency_key).toBe('test-idem-key');
        expect(body.changes[0].type).toBe('PHYSICAL_COUNT');
        expect(body.changes[0].physical_count.quantity).toBe('15'); // string
        expect(body.changes[0].physical_count.catalog_object_id).toBe('VAR1');
        expect(body.changes[0].physical_count.location_id).toBe('LOC1');
        expect(body.changes[0].physical_count.state).toBe('IN_STOCK');
    });

    test('converts quantity to string', async () => {
        makeSquareRequest.mockResolvedValueOnce({ changes: [], counts: [] });

        await setSquareInventoryCount('VAR1', 'LOC1', 0, 'Zero out', merchantId);

        const body = JSON.parse(makeSquareRequest.mock.calls[0][1].body);
        expect(body.changes[0].physical_count.quantity).toBe('0');
        expect(typeof body.changes[0].physical_count.quantity).toBe('string');
    });

    test('throws when merchantId is not provided', async () => {
        await expect(setSquareInventoryCount('VAR1', 'LOC1', 5, 'test', undefined))
            .rejects.toThrow('merchantId is required');
    });

    test('throws on Square API error', async () => {
        makeSquareRequest.mockRejectedValueOnce(new Error('Forbidden'));

        await expect(setSquareInventoryCount('VAR1', 'LOC1', 5, 'test', merchantId))
            .rejects.toThrow('Forbidden');
    });

    test('uses default reason when not provided', async () => {
        makeSquareRequest.mockResolvedValueOnce({ changes: [], counts: [] });

        // Call without reason (uses default)
        await setSquareInventoryCount('VAR1', 'LOC1', 10, undefined, merchantId);

        expect(logger.info).toHaveBeenCalledWith(
            'Setting Square inventory count',
            expect.objectContaining({ quantity: 10 })
        );
    });
});

// ---------------------------------------------------------------------------
// setSquareInventoryAlertThreshold
// ---------------------------------------------------------------------------
describe('setSquareInventoryAlertThreshold', () => {
    const baseCatalogObject = {
        object: {
            type: 'ITEM_VARIATION',
            id: 'VAR1',
            version: 100,
            item_variation_data: {
                location_overrides: []
            }
        }
    };

    test('retrieves catalog object and sets LOW_QUANTITY alert', async () => {
        makeSquareRequest
            .mockResolvedValueOnce(baseCatalogObject) // retrieve
            .mockResolvedValueOnce({ catalog_object: { version: 101 } }); // update

        const result = await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId });

        expect(result.success).toBe(true);
        expect(getMerchantToken).toHaveBeenCalledWith(merchantId);

        // Verify the update body
        const updateBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        expect(updateBody.object.version).toBe(100);
        const overrides = updateBody.object.item_variation_data.location_overrides;
        expect(overrides).toHaveLength(1);
        expect(overrides[0]).toEqual({
            location_id: 'LOC1',
            inventory_alert_type: 'LOW_QUANTITY',
            inventory_alert_threshold: 5
        });
    });

    test('sets NONE alert type when threshold is null', async () => {
        makeSquareRequest
            .mockResolvedValueOnce(baseCatalogObject)
            .mockResolvedValueOnce({ catalog_object: { version: 101 } });

        await setSquareInventoryAlertThreshold('VAR1', 'LOC1', null, { merchantId });

        const updateBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const overrides = updateBody.object.item_variation_data.location_overrides;
        expect(overrides[0].inventory_alert_type).toBe('NONE');
        expect(overrides[0]).not.toHaveProperty('inventory_alert_threshold');
    });

    test('sets NONE alert type when threshold is 0', async () => {
        makeSquareRequest
            .mockResolvedValueOnce(baseCatalogObject)
            .mockResolvedValueOnce({ catalog_object: { version: 101 } });

        await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 0, { merchantId });

        const updateBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const overrides = updateBody.object.item_variation_data.location_overrides;
        expect(overrides[0].inventory_alert_type).toBe('NONE');
    });

    test('preserves existing overrides for other locations', async () => {
        const objectWithOverrides = {
            object: {
                type: 'ITEM_VARIATION',
                id: 'VAR1',
                version: 100,
                item_variation_data: {
                    location_overrides: [
                        { location_id: 'LOC_OTHER', inventory_alert_type: 'LOW_QUANTITY', inventory_alert_threshold: 10 }
                    ]
                }
            }
        };
        makeSquareRequest
            .mockResolvedValueOnce(objectWithOverrides)
            .mockResolvedValueOnce({ catalog_object: { version: 101 } });

        await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 3, { merchantId });

        const updateBody = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const overrides = updateBody.object.item_variation_data.location_overrides;
        expect(overrides).toHaveLength(2);
        expect(overrides.find(o => o.location_id === 'LOC_OTHER')).toEqual({
            location_id: 'LOC_OTHER',
            inventory_alert_type: 'LOW_QUANTITY',
            inventory_alert_threshold: 10
        });
        expect(overrides.find(o => o.location_id === 'LOC1').inventory_alert_threshold).toBe(3);
    });

    test('retries on VERSION_MISMATCH up to 3 times then succeeds', async () => {
        const versionError = new Error('VERSION_MISMATCH: object has been modified');

        makeSquareRequest
            .mockResolvedValueOnce(baseCatalogObject) // attempt 1 retrieve
            .mockRejectedValueOnce(versionError)      // attempt 1 update fails
            .mockResolvedValueOnce({ ...baseCatalogObject, object: { ...baseCatalogObject.object, version: 101 } }) // attempt 2 retrieve
            .mockResolvedValueOnce({ catalog_object: { version: 102 } }); // attempt 2 update succeeds

        const result = await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId });

        expect(result.success).toBe(true);
        expect(makeSquareRequest).toHaveBeenCalledTimes(4);
        expect(logger.warn).toHaveBeenCalledWith(
            'VERSION_MISMATCH on inventory alert update, retrying with fresh version',
            expect.objectContaining({ attempt: 1 })
        );
    });

    test('throws after 3 VERSION_MISMATCH retries exhausted', async () => {
        const versionError = new Error('VERSION_MISMATCH: object has been modified');

        makeSquareRequest
            .mockResolvedValueOnce(baseCatalogObject).mockRejectedValueOnce(versionError) // attempt 1
            .mockResolvedValueOnce(baseCatalogObject).mockRejectedValueOnce(versionError) // attempt 2
            .mockResolvedValueOnce(baseCatalogObject).mockRejectedValueOnce(versionError); // attempt 3

        await expect(setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId }))
            .rejects.toThrow('VERSION_MISMATCH');
    });

    test('throws immediately on non-VERSION_MISMATCH error', async () => {
        makeSquareRequest
            .mockResolvedValueOnce(baseCatalogObject)
            .mockRejectedValueOnce(new Error('UNAUTHORIZED'));

        await expect(setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId }))
            .rejects.toThrow('UNAUTHORIZED');

        // Should not retry — only 2 calls (retrieve + failed update)
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('throws when catalog object not found', async () => {
        makeSquareRequest.mockResolvedValueOnce({ object: null });

        await expect(setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId }))
            .rejects.toThrow('Catalog object not found');
    });

    test('throws when object is not ITEM_VARIATION', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            object: { type: 'ITEM', id: 'VAR1', version: 1, item_variation_data: {} }
        });

        await expect(setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId }))
            .rejects.toThrow('Object is not a variation');
    });

    test('throws when merchantId is not provided', async () => {
        await expect(setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, {}))
            .rejects.toThrow('merchantId is required');
    });

    test('auto-heals ITEM_NOT_AT_LOCATION via structured error and retries successfully', async () => {
        const locationError = new Error('Some Square error');
        locationError.squareErrors = [
            { code: 'INVALID_VALUE', field: 'item_id', detail: 'mismatch' }
        ];
        const baseWithItemId = {
            object: {
                type: 'ITEM_VARIATION',
                id: 'VAR1',
                version: 100,
                item_variation_data: { location_overrides: [], item_id: 'ITEM1' }
            }
        };

        makeSquareRequest
            .mockResolvedValueOnce(baseWithItemId)                              // attempt 1: retrieve
            .mockRejectedValueOnce(locationError)                               // attempt 1: update fails
            .mockResolvedValueOnce(baseWithItemId)                              // attempt 2: retrieve (post-heal)
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 101 } }); // attempt 2: success

        const result = await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId });

        expect(result.success).toBe(true);
        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', merchantId);
    });

    test('auto-heals ITEM_NOT_AT_LOCATION via message fallback and retries successfully', async () => {
        const locationError = new Error('VAR1 is enabled at unit L1 but object ITEM1 of type ITEM is not at this location');
        const baseWithItemId = {
            object: {
                type: 'ITEM_VARIATION',
                id: 'VAR1',
                version: 100,
                item_variation_data: { location_overrides: [], item_id: 'ITEM1' }
            }
        };

        makeSquareRequest
            .mockResolvedValueOnce(baseWithItemId)
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce(baseWithItemId)
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 101 } });

        const result = await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId });

        expect(result.success).toBe(true);
        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', merchantId);
    });

    test('falls back to DB query for item_id when variation data lacks it', async () => {
        const locationError = new Error('Some Square error');
        locationError.squareErrors = [
            { code: 'INVALID_VALUE', field: 'item_id', detail: 'mismatch' }
        ];
        // baseCatalogObject has no item_id in item_variation_data
        const baseWithItemId = {
            object: {
                type: 'ITEM_VARIATION',
                id: 'VAR1',
                version: 100,
                item_variation_data: { location_overrides: [] }
            }
        };

        makeSquareRequest
            .mockResolvedValueOnce(baseWithItemId)
            .mockRejectedValueOnce(locationError)
            .mockResolvedValueOnce(baseWithItemId)
            .mockResolvedValueOnce({ catalog_object: { id: 'VAR1', version: 101 } });

        db.query.mockResolvedValueOnce({ rows: [{ item_id: 'ITEM1' }] });

        const result = await setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId });

        expect(result.success).toBe(true);
        expect(db.query).toHaveBeenCalledWith(
            'SELECT item_id FROM variations WHERE id = $1 AND merchant_id = $2',
            ['VAR1', merchantId]
        );
        expect(enableItemAtAllLocations).toHaveBeenCalledWith('ITEM1', merchantId);
    });

    test('throws original error when retry fails after auto-heal', async () => {
        const locationError = new Error('Some Square error');
        locationError.squareErrors = [
            { code: 'INVALID_VALUE', field: 'item_id', detail: 'mismatch' }
        ];
        const baseWithItemId = {
            object: {
                type: 'ITEM_VARIATION',
                id: 'VAR1',
                version: 100,
                item_variation_data: { location_overrides: [], item_id: 'ITEM1' }
            }
        };

        makeSquareRequest
            .mockResolvedValueOnce(baseWithItemId)   // attempt 1: retrieve
            .mockRejectedValueOnce(locationError)    // attempt 1: update fails
            .mockResolvedValueOnce(baseWithItemId)   // attempt 2: retrieve
            .mockRejectedValueOnce(locationError);   // attempt 2: update fails again

        await expect(
            setSquareInventoryAlertThreshold('VAR1', 'LOC1', 5, { merchantId })
        ).rejects.toThrow('Some Square error');

        expect(enableItemAtAllLocations).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// syncCommittedInventory
// ---------------------------------------------------------------------------
describe('syncCommittedInventory', () => {
    // Helpers to build mock data
    const makeInvoice = (id, status, locationId = 'LOC1', orderId = null) => ({
        id,
        status,
        location_id: locationId,
        order_id: orderId
    });

    const makeFullInvoice = (id, orderId, status = 'UNPAID') => ({
        invoice: {
            id,
            order_id: orderId,
            status,
            location_id: 'LOC1',
            primary_recipient: { customer_id: 'CUST1' },
            payment_requests: [{ due_date: '2026-04-01', computed_amount_money: { amount: 5000, currency: 'CAD' } }],
            created_at: '2026-03-01T00:00:00Z'
        }
    });

    const makeOrder = (orderId, lineItems, locationId = 'LOC1') => ({
        order: {
            id: orderId,
            location_id: locationId,
            line_items: lineItems
        }
    });

    const makeLineItem = (variationId, quantity, name = 'Test Item') => ({
        catalog_object_id: variationId,
        quantity: String(quantity),
        name
    });

    // Standard db.query mock setup for happy path
    function setupDbForCommittedInventory({
        locations = [{ id: 'LOC1' }],
        beforeCount = 0,
        afterCount = 1,
        deleteResult = { rowCount: 0, rows: [] },
        orphanRows = [],
        staleStatusCount = 0
    } = {}) {
        db.query
            .mockResolvedValueOnce({ rows: locations })                        // locations
            .mockResolvedValueOnce({ rows: [{ cnt: beforeCount }] })           // count before
            .mockResolvedValueOnce(deleteResult)                               // stale delete
            .mockResolvedValueOnce({ rows: [{ cnt: afterCount }] })            // count after (skipping — will be later)
        ;
        // The orphan query and count-after query come after transaction calls,
        // so we push them as generic resolves
    }

    // Helper to set up transaction mock that captures client calls
    function setupTransaction() {
        const clientQueries = [];
        db.transaction.mockImplementation(async (fn) => {
            const mockClient = {
                query: jest.fn().mockImplementation(async (sql, params) => {
                    clientQueries.push({ sql, params });
                    // Return known variations for the variation lookup query
                    if (sql && sql.includes('SELECT id FROM variations WHERE id = ANY')) {
                        return { rows: (params[0] || []).map(id => ({ id })) };
                    }
                    return { rows: [], rowCount: 0 };
                }),
                release: jest.fn()
            };
            return fn(mockClient);
        });
        return clientQueries;
    }

    test('requires merchantId', async () => {
        await expect(syncCommittedInventory(undefined))
            .rejects.toThrow('merchantId is required');
    });

    test('returns skipped when no active locations', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no locations

        const result = await syncCommittedInventory(merchantId);

        expect(result.skipped).toBe(true);
        expect(result.reason).toMatch(/No active locations/);
    });

    test('handles INSUFFICIENT_SCOPES and caches for 1 hour', async () => {
        // Use a unique merchantId so cache does not pollute other tests
        const scopeMerchantId = 9999;

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })   // locations
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });      // count before

        makeSquareRequest.mockRejectedValueOnce(new Error('INSUFFICIENT_SCOPES: INVOICES_READ'));

        const result = await syncCommittedInventory(scopeMerchantId);

        expect(result.skipped).toBe(true);
        expect(result.reason).toMatch(/INVOICES_READ scope not authorized/);

        // Second call should be cached — no additional db.query or makeSquareRequest calls
        const result2 = await syncCommittedInventory(scopeMerchantId);
        expect(result2.skipped).toBe(true);
        expect(result2.reason).toMatch(/cached/);
        // Should not call makeSquareRequest again
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    test('happy path: fetches invoices, processes line items, rebuilds RESERVED_FOR_SALE', async () => {
        const clientQueries = setupTransaction();

        // DB queries in order
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })        // locations
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })            // count before
        ;

        // Invoice search returns one UNPAID invoice
        makeSquareRequest
            .mockResolvedValueOnce({
                invoices: [makeInvoice('INV1', 'UNPAID', 'LOC1')],
                cursor: null
            });

        // Stale delete (no open IDs to exclude from delete)
        db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // delete stale

        // Fetch individual invoice detail
        makeSquareRequest.mockResolvedValueOnce(makeFullInvoice('INV1', 'ORD1'));

        // Fetch order
        makeSquareRequest.mockResolvedValueOnce(
            makeOrder('ORD1', [makeLineItem('VAR1', 3)])
        );

        // After transaction, orphan query + count after + stale status check
        db.query
            .mockResolvedValueOnce({ rows: [] })                  // orphan check
            .mockResolvedValueOnce({ rows: [{ cnt: 1 }] });       // count after

        const result = await syncCommittedInventory(merchantId);

        expect(result.invoices_fetched).toBe(1);
        expect(result.open_invoices).toBe(1);
        expect(result.invoices_processed).toBe(1);
        expect(result.invoice_errors).toBe(0);

        // Verify transaction was called for the RESERVED_FOR_SALE rebuild
        expect(db.transaction).toHaveBeenCalled();

        // Verify makeSquareRequest was called for invoice search, invoice detail, and order
        expect(makeSquareRequest).toHaveBeenCalledTimes(3);
    });

    test('classifies invoices by status and only processes open ones', async () => {
        setupTransaction();

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

        // Return mix of statuses
        makeSquareRequest.mockResolvedValueOnce({
            invoices: [
                makeInvoice('INV1', 'UNPAID', 'LOC1'),
                makeInvoice('INV2', 'PAID', 'LOC1'),
                makeInvoice('INV3', 'DRAFT', 'LOC1'),
                makeInvoice('INV4', 'CANCELED', 'LOC1')
            ],
            cursor: null
        });

        // Delete stale
        db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

        // Only INV1 and INV3 are open — 2 invoice detail + 2 order fetches
        makeSquareRequest
            .mockResolvedValueOnce(makeFullInvoice('INV1', 'ORD1'))
            .mockResolvedValueOnce(makeOrder('ORD1', [makeLineItem('VAR1', 2)]))
            .mockResolvedValueOnce(makeFullInvoice('INV3', 'ORD3'))
            .mockResolvedValueOnce(makeOrder('ORD3', [makeLineItem('VAR2', 1)]));

        db.query
            .mockResolvedValueOnce({ rows: [] })              // orphans
            .mockResolvedValueOnce({ rows: [{ cnt: 2 }] });   // count after

        const result = await syncCommittedInventory(merchantId);

        expect(result.invoices_fetched).toBe(4);
        expect(result.open_invoices).toBe(2);
        expect(result.status_counts).toEqual({ UNPAID: 1, PAID: 1, DRAFT: 1, CANCELED: 1 });
    });

    test('deletes all committed_inventory when no open invoices', async () => {
        setupTransaction();

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 3 }] }); // 3 existing rows

        // No open invoices
        makeSquareRequest.mockResolvedValueOnce({
            invoices: [makeInvoice('INV1', 'PAID', 'LOC1')],
            cursor: null
        });

        // Delete ALL committed_inventory (no open invoice IDs)
        db.query.mockResolvedValueOnce({
            rowCount: 3,
            rows: [
                { square_invoice_id: 'INV_OLD1', invoice_status: 'PAID' },
                { square_invoice_id: 'INV_OLD2', invoice_status: 'PAID' },
                { square_invoice_id: 'INV_OLD3', invoice_status: 'CANCELED' }
            ]
        });

        db.query
            .mockResolvedValueOnce({ rows: [] })              // orphans
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });   // count after

        const result = await syncCommittedInventory(merchantId);

        expect(result.rows_deleted).toBe(3);
        expect(result.deleted_invoice_ids).toEqual(
            expect.arrayContaining(['INV_OLD1', 'INV_OLD2', 'INV_OLD3'])
        );
    });

    test('handles pagination of invoices', async () => {
        setupTransaction();

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

        // Page 1
        makeSquareRequest.mockResolvedValueOnce({
            invoices: [makeInvoice('INV1', 'UNPAID', 'LOC1')],
            cursor: 'page2'
        });
        // Page 2
        makeSquareRequest.mockResolvedValueOnce({
            invoices: [makeInvoice('INV2', 'DRAFT', 'LOC1')],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // delete stale

        makeSquareRequest
            .mockResolvedValueOnce(makeFullInvoice('INV1', 'ORD1'))
            .mockResolvedValueOnce(makeOrder('ORD1', [makeLineItem('VAR1', 1)]))
            .mockResolvedValueOnce(makeFullInvoice('INV2', 'ORD2'))
            .mockResolvedValueOnce(makeOrder('ORD2', [makeLineItem('VAR2', 2)]));

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ cnt: 2 }] });

        const result = await syncCommittedInventory(merchantId);

        expect(result.invoices_fetched).toBe(2);
        expect(result.open_invoices).toBe(2);
        expect(sleep).toHaveBeenCalled(); // delay between pages
    });

    test('continues processing when individual invoice fetch fails', async () => {
        setupTransaction();

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

        makeSquareRequest.mockResolvedValueOnce({
            invoices: [
                makeInvoice('INV1', 'UNPAID', 'LOC1'),
                makeInvoice('INV2', 'UNPAID', 'LOC1')
            ],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // delete stale

        // INV1 fails, INV2 succeeds
        makeSquareRequest
            .mockRejectedValueOnce(new Error('Not found'))  // INV1 detail fails
            .mockResolvedValueOnce(makeFullInvoice('INV2', 'ORD2'))
            .mockResolvedValueOnce(makeOrder('ORD2', [makeLineItem('VAR1', 5)]));

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ cnt: 1 }] });

        const result = await syncCommittedInventory(merchantId);

        expect(result.invoices_processed).toBe(1);
        expect(result.invoice_errors).toBe(1);
    });

    test('skips line items without catalog_object_id or with zero quantity', async () => {
        const clientQueries = setupTransaction();

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

        makeSquareRequest.mockResolvedValueOnce({
            invoices: [makeInvoice('INV1', 'UNPAID', 'LOC1')],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

        makeSquareRequest.mockResolvedValueOnce(makeFullInvoice('INV1', 'ORD1'));
        makeSquareRequest.mockResolvedValueOnce(
            makeOrder('ORD1', [
                { catalog_object_id: null, quantity: '5', name: 'Custom Item' },    // no variation ID
                { catalog_object_id: 'VAR1', quantity: '0', name: 'Zero Qty' },     // zero quantity
                makeLineItem('VAR2', 3)                                              // valid
            ])
        );

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ cnt: 1 }] });

        const result = await syncCommittedInventory(merchantId);

        expect(result.invoices_processed).toBe(1);
        // Only VAR2 should have been inserted — verify via transaction client queries
        const insertQueries = clientQueries.filter(q => q.sql && q.sql.includes('INSERT INTO committed_inventory'));
        expect(insertQueries).toHaveLength(1);
        expect(insertQueries[0].params).toEqual(
            expect.arrayContaining(['VAR2'])
        );
    });

    test('skips invoice without order_id', async () => {
        setupTransaction();

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'LOC1' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

        makeSquareRequest.mockResolvedValueOnce({
            invoices: [makeInvoice('INV1', 'UNPAID', 'LOC1')],
            cursor: null
        });

        db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

        // Invoice detail has no order_id
        makeSquareRequest.mockResolvedValueOnce({
            invoice: { id: 'INV1', status: 'UNPAID', location_id: 'LOC1' }
        });

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

        const result = await syncCommittedInventory(merchantId);

        // Invoice was fetched but not processed (no order_id)
        expect(result.invoices_processed).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// cleanupInventory
// ---------------------------------------------------------------------------
describe('cleanupInventory', () => {
    test('can be called without error', () => {
        // cleanupInventory clears the interval timer
        expect(() => cleanupInventory()).not.toThrow();
    });
});
