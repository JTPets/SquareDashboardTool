/**
 * Tests for square-diagnostics.js
 *
 * Covers fixLocationMismatches, fixInventoryAlerts, enableItemAtAllLocations.
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => logger);
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn(),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-key')
}));
jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 }
}));

const { fixLocationMismatches, fixInventoryAlerts, enableItemAtAllLocations } = require('../../../services/square/square-diagnostics');
const db = require('../../../utils/database');
const { makeSquareRequest, sleep } = require('../../../services/square/square-client');

const merchantId = 1;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('fixLocationMismatches', () => {
    test('throws when merchantId is missing', async () => {
        await expect(fixLocationMismatches(null)).rejects.toThrow('merchantId is required');
    });

    test('returns empty summary when no items have location restrictions', async () => {
        makeSquareRequest.mockResolvedValue({
            objects: [
                { id: 'ITEM_1', type: 'ITEM', present_at_all_locations: true, item_data: { name: 'Good' } }
            ],
            cursor: null
        });

        const summary = await fixLocationMismatches(merchantId);

        expect(summary.success).toBe(true);
        expect(summary.itemsFixed).toBe(0);
        expect(summary.variationsFixed).toBe(0);
    });

    test('identifies items with location restrictions', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [
                    {
                        id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false,
                        present_at_location_ids: ['LOC_1'], absent_at_location_ids: [],
                        item_data: { name: 'Restricted Item' }
                    },
                    {
                        id: 'VAR_1', type: 'ITEM_VARIATION', present_at_all_locations: true,
                        present_at_location_ids: ['LOC_1'], absent_at_location_ids: [],
                        item_variation_data: { name: 'Restricted Var', sku: 'SKU1', item_id: 'ITEM_1' }
                    }
                ],
                cursor: null
            })
            .mockResolvedValue({ objects: [] }); // batch-upsert calls

        // Mock batch-upsert responses
        makeSquareRequest.mockResolvedValue({ objects: [] });

        const summary = await fixLocationMismatches(merchantId);

        expect(summary.itemsFixed + summary.variationsFixed).toBeGreaterThan(0);
    });

    test('processes ITEMS first (Phase 1) then VARIATIONS (Phase 2)', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                {
                    id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false,
                    item_data: { name: 'Parent' }
                },
                {
                    id: 'VAR_1', type: 'ITEM_VARIATION', present_at_all_locations: false,
                    item_variation_data: { name: 'Child', sku: 'S1', item_id: 'ITEM_1' }
                }
            ],
            cursor: null
        });

        // Two batch-upsert calls: one for items, one for variations
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM_1' }] })
            .mockResolvedValueOnce({ objects: [{ id: 'VAR_1' }] });

        const summary = await fixLocationMismatches(merchantId);

        expect(summary.itemsFixed).toBe(1);
        expect(summary.variationsFixed).toBe(1);

        // Verify ITEM batch was called before VARIATION batch
        const batchCalls = makeSquareRequest.mock.calls.filter(c => c[0] === '/v2/catalog/batch-upsert');
        expect(batchCalls.length).toBe(2);

        const firstBatchBody = JSON.parse(batchCalls[0][1].body);
        expect(firstBatchBody.batches[0].objects[0].type).toBe('ITEM');

        const secondBatchBody = JSON.parse(batchCalls[1][1].body);
        expect(secondBatchBody.batches[0].objects[0].type).toBe('ITEM_VARIATION');
    });

    test('batch upserts with present_at_all_locations=true', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false,
                present_at_location_ids: ['LOC_1'], absent_at_location_ids: ['LOC_2'],
                item_data: { name: 'Test' }, version: 5
            }],
            cursor: null
        });
        makeSquareRequest.mockResolvedValue({ objects: [] });

        await fixLocationMismatches(merchantId);

        const batchCall = makeSquareRequest.mock.calls.find(c => c[0] === '/v2/catalog/batch-upsert');
        const body = JSON.parse(batchCall[1].body);
        const obj = body.batches[0].objects[0];

        expect(obj.present_at_all_locations).toBe(true);
        expect(obj.present_at_location_ids).toEqual([]);
        expect(obj.absent_at_location_ids).toEqual([]);
    });

    test('dedupes by ID', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [
                { id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false, item_data: { name: 'Dup' }, version: 1 },
                { id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false, item_data: { name: 'Dup' }, version: 2 }
            ],
            cursor: null
        });
        makeSquareRequest.mockResolvedValue({ objects: [] });

        const summary = await fixLocationMismatches(merchantId);

        expect(summary.itemsFixed).toBe(1);
    });

    test('handles batch errors (summary.success=false)', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            objects: [{
                id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false,
                item_data: { name: 'Fail' }
            }],
            cursor: null
        });
        makeSquareRequest.mockRejectedValueOnce(new Error('Square 500'));

        const summary = await fixLocationMismatches(merchantId);

        expect(summary.success).toBe(false);
        expect(summary.errors.length).toBeGreaterThan(0);
    });

    test('handles pagination', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [{ id: 'ITEM_1', type: 'ITEM', present_at_all_locations: false, item_data: { name: 'P1' } }],
                cursor: 'page2'
            })
            .mockResolvedValueOnce({
                objects: [{ id: 'ITEM_2', type: 'ITEM', present_at_all_locations: false, item_data: { name: 'P2' } }],
                cursor: null
            })
            .mockResolvedValue({ objects: [] }); // batch-upsert

        const summary = await fixLocationMismatches(merchantId);

        expect(summary.itemsFixed).toBe(2);
    });

    test('breaks at MAX_PAGINATION_ITERATIONS', async () => {
        makeSquareRequest.mockResolvedValue({
            objects: [{ id: 'ITEM_X', type: 'ITEM', present_at_all_locations: false, item_data: { name: 'Loop' } }],
            cursor: 'next'
        });

        // The function should break and still return a summary (not hang)
        const summary = await fixLocationMismatches(merchantId);

        expect(logger.warn).toHaveBeenCalledWith(
            'Pagination loop exceeded max iterations',
            expect.objectContaining({ merchantId })
        );
        // Should still attempt batch-upsert for collected items
        expect(summary).toBeDefined();
    });
});

describe('fixInventoryAlerts', () => {
    test('throws when merchantId is missing', async () => {
        await expect(fixInventoryAlerts(null)).rejects.toThrow('merchantId is required');
    });

    test('returns empty summary when no variations need fixing', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const summary = await fixInventoryAlerts(merchantId);

        expect(summary.success).toBe(true);
        expect(summary.variationsFixed).toBe(0);
        expect(summary.totalFound).toBe(0);
    });

    test('queries local DB for variations with alerts off', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await fixInventoryAlerts(merchantId);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('inventory_alert_type'),
            [merchantId]
        );
    });

    test('batch-retrieves from Square for current versions', async () => {
        db.query.mockResolvedValue({
            rows: [{ id: 'VAR_1', name: 'Widget', sku: 'W1' }]
        });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [{ id: 'VAR_1', version: 10, item_variation_data: { name: 'Widget' } }] })
            .mockResolvedValue({}); // batch-upsert

        await fixInventoryAlerts(merchantId);

        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/batch-retrieve',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('VAR_1')
            })
        );
    });

    test('batch-upserts with inventory_alert_type=LOW_QUANTITY', async () => {
        db.query.mockResolvedValue({
            rows: [{ id: 'VAR_1', name: 'Widget', sku: 'W1' }]
        });
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [{ id: 'VAR_1', version: 10, item_variation_data: { name: 'Widget', price_money: { amount: 100 } } }]
            })
            .mockResolvedValueOnce({ objects: [] }); // batch-upsert

        const summary = await fixInventoryAlerts(merchantId);

        const upsertCall = makeSquareRequest.mock.calls.find(c => c[0] === '/v2/catalog/batch-upsert');
        const body = JSON.parse(upsertCall[1].body);
        const obj = body.batches[0].objects[0];

        expect(obj.item_variation_data.inventory_alert_type).toBe('LOW_QUANTITY');
        expect(obj.item_variation_data.inventory_alert_threshold).toBe(0);
        expect(summary.variationsFixed).toBe(1);
    });

    test('skips variations not found in Square', async () => {
        db.query.mockResolvedValue({
            rows: [
                { id: 'VAR_1', name: 'Found', sku: 'F1' },
                { id: 'VAR_2', name: 'Missing', sku: 'M1' }
            ]
        });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [{ id: 'VAR_1', version: 5, item_variation_data: { name: 'Found' } }] })
            .mockResolvedValueOnce({ objects: [] }); // batch-upsert

        const summary = await fixInventoryAlerts(merchantId);

        const skipped = summary.details.find(d => d.id === 'VAR_2');
        expect(skipped.status).toBe('skipped');
        expect(skipped.error).toBe('Not found in Square');
    });

    test('handles batch errors', async () => {
        db.query.mockResolvedValue({
            rows: [{ id: 'VAR_1', name: 'Widget', sku: 'W1' }]
        });
        makeSquareRequest
            .mockResolvedValueOnce({ objects: [{ id: 'VAR_1', version: 5, item_variation_data: { name: 'Widget' } }] })
            .mockRejectedValueOnce(new Error('Batch failed'));

        const summary = await fixInventoryAlerts(merchantId);

        expect(summary.success).toBe(false);
        expect(summary.errors).toContain('Batch 1 failed: Batch failed');
    });

    test('returns summary with variationsFixed count', async () => {
        db.query.mockResolvedValue({
            rows: [
                { id: 'VAR_1', name: 'A', sku: 'A1' },
                { id: 'VAR_2', name: 'B', sku: 'B1' }
            ]
        });
        makeSquareRequest
            .mockResolvedValueOnce({
                objects: [
                    { id: 'VAR_1', version: 1, item_variation_data: { name: 'A' } },
                    { id: 'VAR_2', version: 2, item_variation_data: { name: 'B' } }
                ]
            })
            .mockResolvedValueOnce({ objects: [] });

        const summary = await fixInventoryAlerts(merchantId);

        expect(summary.variationsFixed).toBe(2);
        expect(summary.totalFound).toBe(2);
        expect(summary.success).toBe(true);
    });
});

describe('enableItemAtAllLocations', () => {
    test('throws when merchantId is missing', async () => {
        await expect(enableItemAtAllLocations('ITEM_1', null)).rejects.toThrow('merchantId is required');
    });

    test('throws when itemId is missing', async () => {
        await expect(enableItemAtAllLocations(null, merchantId)).rejects.toThrow('itemId is required');
    });

    test('throws when item not found in Square', async () => {
        makeSquareRequest.mockResolvedValue({ object: null });

        await expect(enableItemAtAllLocations('ITEM_999', merchantId))
            .rejects.toThrow('Catalog item not found: ITEM_999');
    });

    test('throws when object is not an ITEM type', async () => {
        makeSquareRequest.mockResolvedValue({
            object: { id: 'VAR_1', type: 'ITEM_VARIATION', version: 1 }
        });

        await expect(enableItemAtAllLocations('VAR_1', merchantId))
            .rejects.toThrow('Object is not an ITEM: ITEM_VARIATION');
    });

    // Shared mock helper: retrieve-GET → batch-upsert-POST → verify-GET
    // Automatically merges type: 'ITEM_VARIATION' into each variation so the
    // is_deleted/type filter in the production code passes them through.
    function mockThreeCalls({ retrieveVariations = [], verifyVariations = [] } = {}) {
        const withType = vars => vars.map(v => ({ type: 'ITEM_VARIATION', ...v }));
        makeSquareRequest
            .mockResolvedValueOnce({  // 1: retrieve GET (include_related_objects=true)
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 5,
                    item_data: { name: 'Test Item', variations: withType(retrieveVariations) }
                }
            })
            .mockResolvedValueOnce({  // 2: batch-upsert POST
                objects: [{ id: 'ITEM_1', version: 6 }]
            })
            .mockResolvedValueOnce({  // 3: verify GET (include_related_objects=true)
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,
                    item_data: { name: 'Test Item', variations: withType(verifyVariations) }
                }
            });
    }

    test('sends batch-upsert to /v2/catalog/batch-upsert with item present_at_all_locations=true', async () => {
        mockThreeCalls();

        await enableItemAtAllLocations('ITEM_1', merchantId);

        const upsertCall = makeSquareRequest.mock.calls[1];
        expect(upsertCall[0]).toBe('/v2/catalog/batch-upsert');
        const body = JSON.parse(upsertCall[1].body);
        const itemObj = body.batches[0].objects[0];
        expect(itemObj.type).toBe('ITEM');
        expect(itemObj.present_at_all_locations).toBe(true);
        expect(itemObj.present_at_location_ids).toEqual([]);
        expect(itemObj.absent_at_location_ids).toEqual([]);
        expect(itemObj.version).toBe(5);
    });

    test('strips variations from item_data in the ITEM batch entry to avoid Duplicate object error', async () => {
        mockThreeCalls({
            retrieveVariations: [
                { id: 'VAR_A', version: 3, item_variation_data: { name: 'Small' } }
            ],
            verifyVariations: [
                { id: 'VAR_A', version: 4, present_at_all_locations: true }
            ]
        });

        await enableItemAtAllLocations('ITEM_1', merchantId);

        const body = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const itemEntry = body.batches[0].objects.find(o => o.type === 'ITEM');
        // Variations must NOT appear inline inside item_data — they are
        // separate ITEM_VARIATION entries in the same batch. Including them
        // both ways causes Square to reject with "Duplicate object {id}".
        expect(itemEntry.item_data.variations).toBeUndefined();
    });

    test('includes child variations in the batch upsert with present_at_all_locations=true', async () => {
        mockThreeCalls({
            retrieveVariations: [
                { id: 'VAR_A', version: 3, present_at_all_locations: false,
                  present_at_location_ids: ['LOC_1'], item_variation_data: { name: 'Small' } },
                { id: 'VAR_B', version: 7, present_at_all_locations: false,
                  present_at_location_ids: [],        item_variation_data: { name: 'Large' } }
            ],
            verifyVariations: [
                { id: 'VAR_A', version: 4, present_at_all_locations: true },
                { id: 'VAR_B', version: 8, present_at_all_locations: true }
            ]
        });

        await enableItemAtAllLocations('ITEM_1', merchantId);

        const body = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const objects = body.batches[0].objects;
        expect(objects).toHaveLength(3); // 1 ITEM + 2 ITEM_VARIATIONs

        const varA = objects.find(o => o.id === 'VAR_A');
        expect(varA.type).toBe('ITEM_VARIATION');
        expect(varA.present_at_all_locations).toBe(true);
        expect(varA.present_at_location_ids).toEqual([]);
        expect(varA.absent_at_location_ids).toEqual([]);
        expect(varA.version).toBe(3);

        const varB = objects.find(o => o.id === 'VAR_B');
        expect(varB.type).toBe('ITEM_VARIATION');
        expect(varB.present_at_all_locations).toBe(true);
        expect(varB.version).toBe(7);
    });

    test('issues retrieve GET with include_related_objects=true', async () => {
        mockThreeCalls();

        await enableItemAtAllLocations('ITEM_1', merchantId);

        const retrieveCall = makeSquareRequest.mock.calls[0];
        expect(retrieveCall[0]).toContain('include_related_objects=true');
    });

    test('issues a verification GET with include_related_objects=true after the upsert', async () => {
        mockThreeCalls();

        await enableItemAtAllLocations('ITEM_1', merchantId);

        expect(makeSquareRequest).toHaveBeenCalledTimes(3);
        const verifyCall = makeSquareRequest.mock.calls[2];
        expect(verifyCall[0]).toContain('/v2/catalog/object/ITEM_1');
        expect(verifyCall[0]).toContain('include_related_objects=true');
        expect(verifyCall[1].method).toBeUndefined(); // GET (default)
    });

    test('throws when verification shows item present_at_all_locations is still false', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                object: { id: 'ITEM_1', type: 'ITEM', version: 5, item_data: { name: 'Test Item', variations: [] } }
            })
            .mockResolvedValueOnce({ objects: [] })
            .mockResolvedValueOnce({  // verify GET — item flag not committed
                object: { id: 'ITEM_1', type: 'ITEM', version: 6, present_at_all_locations: false, item_data: { variations: [] } }
            });

        await expect(enableItemAtAllLocations('ITEM_1', merchantId))
            .rejects.toThrow('Verification failed');
    });

    test('throws when any variation still has present_at_all_locations=false after upsert', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 5,
                    item_data: {
                        name: 'Test Item',
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_A', version: 3, item_variation_data: {} },
                            { type: 'ITEM_VARIATION', id: 'VAR_B', version: 4, item_variation_data: {} }
                        ]
                    }
                }
            })
            .mockResolvedValueOnce({ objects: [] })
            .mockResolvedValueOnce({  // verify GET — VAR_B not committed
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,
                    item_data: {
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_A', version: 4, present_at_all_locations: true },
                            { type: 'ITEM_VARIATION', id: 'VAR_B', version: 5, present_at_all_locations: false }
                        ]
                    }
                }
            });

        await expect(enableItemAtAllLocations('ITEM_1', merchantId))
            .rejects.toThrow('Verification failed');
    });

    test('returns success with itemId, itemName, variationCount', async () => {
        mockThreeCalls({
            retrieveVariations: [
                { id: 'VAR_A', version: 3, item_variation_data: {} },
                { id: 'VAR_B', version: 4, item_variation_data: {} }
            ],
            verifyVariations: [
                { id: 'VAR_A', version: 4, present_at_all_locations: true },
                { id: 'VAR_B', version: 5, present_at_all_locations: true }
            ]
        });

        makeSquareRequest.mock.calls; // already set up above
        // Reset and use a simpler mock for the return-value test
        makeSquareRequest.mockReset();
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 5,
                    item_data: { name: 'Dog Food', variations: [{ type: 'ITEM_VARIATION', id: 'VAR_A', version: 3, item_variation_data: {} }] }
                }
            })
            .mockResolvedValueOnce({ objects: [{ id: 'ITEM_1', version: 6 }] })
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,
                    item_data: { name: 'Dog Food', variations: [{ type: 'ITEM_VARIATION', id: 'VAR_A', version: 4, present_at_all_locations: true }] }
                }
            });

        const result = await enableItemAtAllLocations('ITEM_1', merchantId);

        expect(result).toEqual({
            success: true,
            itemId: 'ITEM_1',
            itemName: 'Dog Food',
            variationCount: 1
        });
    });

    test('returns success without batch-upsert when item and all variations are already enabled', async () => {
        // Only the retrieve GET fires — no POST, no verify GET
        makeSquareRequest.mockResolvedValueOnce({
            object: {
                id: 'ITEM_1', type: 'ITEM', version: 6,
                present_at_all_locations: true,
                item_data: {
                    name: 'Already Fixed',
                    variations: [
                        { type: 'ITEM_VARIATION', id: 'VAR_A', version: 4, present_at_all_locations: true },
                        { type: 'ITEM_VARIATION', id: 'VAR_B', version: 5, present_at_all_locations: true }
                    ]
                }
            }
        });

        const result = await enableItemAtAllLocations('ITEM_1', merchantId);

        expect(result.success).toBe(true);
        expect(result.itemName).toBe('Already Fixed');
        expect(result.variationCount).toBe(2);
        // Only the retrieve GET should have fired — no upsert, no verify
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    test('does not skip upsert when item is enabled but a variation is not', async () => {
        mockThreeCalls({
            retrieveVariations: [
                { id: 'VAR_A', version: 4, present_at_all_locations: true },
                { id: 'VAR_B', version: 3, present_at_all_locations: false,
                  present_at_location_ids: ['LOC_1'], item_variation_data: {} }
            ],
            verifyVariations: [
                { id: 'VAR_A', version: 4, present_at_all_locations: true },
                { id: 'VAR_B', version: 4, present_at_all_locations: true }
            ]
        });
        // Override: item IS present_at_all_locations=true in retrieve response
        makeSquareRequest.mockReset();
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,  // item already ok
                    item_data: {
                        name: 'Partial Fix',
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_A', version: 4, present_at_all_locations: true, item_variation_data: {} },
                            { type: 'ITEM_VARIATION', id: 'VAR_B', version: 3, present_at_all_locations: false, item_variation_data: {} }
                        ]
                    }
                }
            })
            .mockResolvedValueOnce({ objects: [] })  // batch upsert
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,
                    item_data: {
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_A', version: 4, present_at_all_locations: true },
                            { type: 'ITEM_VARIATION', id: 'VAR_B', version: 4, present_at_all_locations: true }
                        ]
                    }
                }
            });

        await enableItemAtAllLocations('ITEM_1', merchantId);

        // Must have sent the batch upsert (call 2)
        expect(makeSquareRequest).toHaveBeenCalledTimes(3);
        expect(makeSquareRequest.mock.calls[1][0]).toBe('/v2/catalog/batch-upsert');
    });

    test('excludes variations with is_deleted=true from the batch upsert', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 5,
                    item_data: {
                        name: 'Test Item',
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_ACTIVE', version: 3, is_deleted: false, item_variation_data: {} },
                            { type: 'ITEM_VARIATION', id: 'VAR_DELETED', version: 2, is_deleted: true,  item_variation_data: {} }
                        ]
                    }
                }
            })
            .mockResolvedValueOnce({ objects: [] })  // batch upsert
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,
                    item_data: {
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_ACTIVE',  version: 4, present_at_all_locations: true },
                            { type: 'ITEM_VARIATION', id: 'VAR_DELETED', version: 2, is_deleted: true, present_at_all_locations: false }
                        ]
                    }
                }
            });

        await enableItemAtAllLocations('ITEM_1', merchantId);

        const body = JSON.parse(makeSquareRequest.mock.calls[1][1].body);
        const objects = body.batches[0].objects;
        // Only ITEM + VAR_ACTIVE — deleted variation must not appear
        expect(objects).toHaveLength(2);
        expect(objects.find(o => o.id === 'VAR_DELETED')).toBeUndefined();
        expect(objects.find(o => o.id === 'VAR_ACTIVE')).toBeDefined();
    });

    test('does not count deleted variations as failed during verification', async () => {
        // Square verify response contains a deleted variation with present_at_all_locations=false —
        // this must not trigger a Verification failed error.
        makeSquareRequest
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 5,
                    item_data: {
                        name: 'Test Item',
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_ACTIVE', version: 3, item_variation_data: {} }
                        ]
                    }
                }
            })
            .mockResolvedValueOnce({ objects: [] })
            .mockResolvedValueOnce({
                object: {
                    id: 'ITEM_1', type: 'ITEM', version: 6,
                    present_at_all_locations: true,
                    item_data: {
                        variations: [
                            { type: 'ITEM_VARIATION', id: 'VAR_ACTIVE',  version: 4, present_at_all_locations: true },
                            { type: 'ITEM_VARIATION', id: 'VAR_DELETED', version: 2, is_deleted: true, present_at_all_locations: false }
                        ]
                    }
                }
            });

        // Should resolve without throwing
        await expect(enableItemAtAllLocations('ITEM_1', merchantId)).resolves.toMatchObject({ success: true });
    });

    test('idempotency check ignores deleted variations — skips upsert when only active ones are enabled', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            object: {
                id: 'ITEM_1', type: 'ITEM', version: 6,
                present_at_all_locations: true,
                item_data: {
                    name: 'Test Item',
                    variations: [
                        { type: 'ITEM_VARIATION', id: 'VAR_ACTIVE',  version: 4, present_at_all_locations: true },
                        { type: 'ITEM_VARIATION', id: 'VAR_DELETED', version: 2, is_deleted: true, present_at_all_locations: false }
                    ]
                }
            }
        });

        const result = await enableItemAtAllLocations('ITEM_1', merchantId);

        expect(result.success).toBe(true);
        // Only 1 active variation counted; deleted one excluded
        expect(result.variationCount).toBe(1);
        // No upsert fired
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });
});
