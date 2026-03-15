/**
 * Tests for services/square/square-catalog-sync.js
 *
 * Covers syncCatalog (full sync with deletion detection),
 * deltaSyncCatalog (incremental sync), and syncVariation (single variation upsert).
 */

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue()
}));

jest.mock('../../../services/square/square-vendors', () => ({
    ensureVendorsExist: jest.fn().mockResolvedValue()
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
    SYNC: { BATCH_DELAY_MS: 0 }
}));

const { getMerchantToken, makeSquareRequest, sleep } = require('../../../services/square/square-client');
const { ensureVendorsExist } = require('../../../services/square/square-vendors');
const { syncCatalog, deltaSyncCatalog, syncVariation } = require('../../../services/square/square-catalog-sync');

// ─── Test fixtures ───────────────────────────────────────────────────────────

const MERCHANT_ID = 42;

function buildCatalogListResponse({ items = [], images = [], categories = [], relatedObjects = [], cursor = null } = {}) {
    const objects = [
        ...categories.map(c => ({
            type: 'CATEGORY',
            id: c.id,
            category_data: { name: c.name }
        })),
        ...images.map(img => ({
            type: 'IMAGE',
            id: img.id,
            image_data: { name: img.name, url: img.url, caption: img.caption || null }
        })),
        ...items.map(item => ({
            type: 'ITEM',
            id: item.id,
            present_at_all_locations: true,
            item_data: {
                name: item.name,
                description: item.description || null,
                category_id: item.categoryId || null,
                categories: item.categoryId ? [{ id: item.categoryId }] : [],
                ecom_visibility: item.ecomVisibility || 'UNINDEXED',
                variations: (item.variations || []).map(v => ({
                    type: 'ITEM_VARIATION',
                    id: v.id,
                    item_variation_data: {
                        item_id: item.id,
                        name: v.name || 'Regular',
                        sku: v.sku || null,
                        upc: v.upc || null,
                        price_money: v.price ? { amount: v.price, currency: 'CAD' } : undefined,
                        pricing_type: 'FIXED_PRICING',
                        track_inventory: v.trackInventory ?? true,
                        location_overrides: v.locationOverrides || [],
                        vendor_information: v.vendorInfo || undefined
                    }
                }))
            }
        }))
    ];
    return { objects, related_objects: relatedObjects, cursor };
}

function buildMinimalItem(id, name, variations) {
    return {
        id,
        name,
        variations: variations.map(v => ({
            id: v.id,
            name: v.name || 'Regular',
            sku: v.sku || null,
            trackInventory: true
        }))
    };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();

    // Default: db.query returns contextual defaults
    // Most queries return empty rows, but COUNT queries need rows[0].cnt
    db.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
            return { rows: [{ cnt: '0' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });

    // Restore default transaction mock (some tests override it)
    db.transaction.mockImplementation(async (fn) => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        return fn(mockClient);
    });

    // Default: makeSquareRequest returns empty catalog (no cursor = single page)
    makeSquareRequest.mockResolvedValue({ objects: [], related_objects: [] });
});

// ═════════════════════════════════════════════════════════════════════════════
// syncCatalog
// ═════════════════════════════════════════════════════════════════════════════

describe('syncCatalog', () => {
    it('throws when merchantId is missing', async () => {
        await expect(syncCatalog(null)).rejects.toThrow('merchantId is required');
        await expect(syncCatalog(undefined)).rejects.toThrow('merchantId is required');
        await expect(syncCatalog(0)).rejects.toThrow('merchantId is required');
    });

    it('fetches catalog pages and syncs categories, images, items, variations in order', async () => {
        const response = buildCatalogListResponse({
            categories: [{ id: 'CAT1', name: 'Dog Food' }],
            images: [{ id: 'IMG1', name: 'photo.jpg', url: 'https://img.example.com/1.jpg' }],
            items: [
                buildMinimalItem('ITEM1', 'Kibble', [{ id: 'VAR1', sku: 'KIB-01' }])
            ]
        });
        makeSquareRequest.mockResolvedValue(response);

        const stats = await syncCatalog(MERCHANT_ID);

        expect(getMerchantToken).toHaveBeenCalledWith(MERCHANT_ID);
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
        expect(stats.categories).toBe(1);
        expect(stats.images).toBe(1);
        expect(stats.items).toBe(1);
        expect(stats.variations).toBe(1);
    });

    it('handles paginated responses', async () => {
        const page1 = buildCatalogListResponse({
            items: [buildMinimalItem('ITEM1', 'Food A', [{ id: 'V1' }])],
            cursor: 'page2-cursor'
        });
        const page2 = buildCatalogListResponse({
            items: [buildMinimalItem('ITEM2', 'Food B', [{ id: 'V2' }])]
        });

        makeSquareRequest
            .mockResolvedValueOnce(page1)
            .mockResolvedValueOnce(page2);

        const stats = await syncCatalog(MERCHANT_ID);

        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(stats.items).toBe(2);
        expect(stats.variations).toBe(2);
    });

    it('extracts variations from item_data.variations', async () => {
        const response = buildCatalogListResponse({
            items: [{
                id: 'ITEM1',
                name: 'Multi-Var',
                variations: [
                    { id: 'V1', name: 'Small', sku: 'SM-1' },
                    { id: 'V2', name: 'Large', sku: 'LG-1' }
                ]
            }]
        });
        makeSquareRequest.mockResolvedValue(response);

        const stats = await syncCatalog(MERCHANT_ID);

        expect(stats.variations).toBe(2);
    });

    it('detects deletions — marks items in DB but not in Square as deleted', async () => {
        const response = buildCatalogListResponse({
            items: [buildMinimalItem('ITEM1', 'Existing', [{ id: 'V1' }])]
        });
        makeSquareRequest.mockResolvedValue(response);

        // DB has ITEM1 and ITEM2, but Square only returned ITEM1
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id, name FROM items WHERE is_deleted = FALSE')) {
                return { rows: [{ id: 'ITEM1', name: 'Existing' }, { id: 'ITEM2', name: 'Deleted One' }], rowCount: 2 };
            }
            if (sql.includes('SELECT id, name, sku FROM variations WHERE is_deleted = FALSE')) {
                return { rows: [{ id: 'V1', name: 'V Existing', sku: 'X' }, { id: 'V2', name: 'V Gone', sku: 'Y' }], rowCount: 2 };
            }
            if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
                return { rows: [{ cnt: '0' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        const stats = await syncCatalog(MERCHANT_ID);

        expect(stats.items_deleted).toBe(1);
        expect(stats.variations_deleted).toBe(1);
    });

    it('skips deletion detection when sync returned 0 items', async () => {
        makeSquareRequest.mockResolvedValue({ objects: [], related_objects: [] });

        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id, name FROM items WHERE is_deleted = FALSE')) {
                return { rows: [{ id: 'ITEM1', name: 'A' }], rowCount: 1 };
            }
            if (sql.includes('SELECT id, name, sku FROM variations WHERE is_deleted = FALSE')) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        });

        const stats = await syncCatalog(MERCHANT_ID);

        expect(stats.items_deleted).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('SKIPPING deletion detection: sync returned 0 items'),
            expect.any(Object)
        );
    });

    it('skips deletion detection when more than 50% would be deleted', async () => {
        // Sync returns 3 items, DB has 20 — less than 50%, should skip
        const items = [];
        for (let i = 1; i <= 3; i++) {
            items.push(buildMinimalItem(`ITEM${i}`, `Item ${i}`, [{ id: `V${i}` }]));
        }
        makeSquareRequest.mockResolvedValue(buildCatalogListResponse({ items }));

        const dbRows = [];
        for (let i = 1; i <= 20; i++) {
            dbRows.push({ id: `ITEM${i}`, name: `Item ${i}` });
        }

        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT id, name FROM items WHERE is_deleted = FALSE')) {
                return { rows: dbRows, rowCount: 20 };
            }
            if (sql.includes('SELECT id, name, sku FROM variations WHERE is_deleted = FALSE')) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        });

        const stats = await syncCatalog(MERCHANT_ID);

        expect(stats.items_deleted).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('SKIPPING deletion detection: too many items would be deleted'),
            expect.any(Object)
        );
    });

    it('returns stats object with expected shape', async () => {
        makeSquareRequest.mockResolvedValue(buildCatalogListResponse({}));

        const stats = await syncCatalog(MERCHANT_ID);

        expect(stats).toEqual(expect.objectContaining({
            categories: expect.any(Number),
            images: expect.any(Number),
            items: expect.any(Number),
            variations: expect.any(Number),
            variationVendors: expect.any(Number),
            items_deleted: expect.any(Number),
            variations_deleted: expect.any(Number)
        }));
    });

    it('seeds delta timestamp after full sync', async () => {
        makeSquareRequest.mockResolvedValue(buildCatalogListResponse({}));

        await syncCatalog(MERCHANT_ID);

        // _updateDeltaTimestamp does an INSERT ... ON CONFLICT into sync_history
        const timestampCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('sync_history') && c[0].includes('last_delta_timestamp')
        );
        expect(timestampCall).toBeDefined();
        expect(timestampCall[1][0]).toBe(MERCHANT_ID);
    });

    it('skips variations whose parent item is not in the sync', async () => {
        // Create a variation that references an item NOT in the response
        const response = {
            objects: [
                {
                    type: 'ITEM',
                    id: 'ITEM1',
                    present_at_all_locations: true,
                    item_data: {
                        name: 'Good Item',
                        variations: [
                            {
                                type: 'ITEM_VARIATION',
                                id: 'V_ORPHAN',
                                item_variation_data: {
                                    item_id: 'ITEM_MISSING',
                                    name: 'Orphan',
                                    track_inventory: true
                                }
                            },
                            {
                                type: 'ITEM_VARIATION',
                                id: 'V_GOOD',
                                item_variation_data: {
                                    item_id: 'ITEM1',
                                    name: 'Good Variation',
                                    track_inventory: true
                                }
                            }
                        ]
                    }
                }
            ],
            related_objects: []
        };
        makeSquareRequest.mockResolvedValue(response);

        const stats = await syncCatalog(MERCHANT_ID);

        // V_ORPHAN should be skipped (parent ITEM_MISSING not in itemsMap), V_GOOD should sync
        expect(stats.variations).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            'Skipping variation - parent item not found',
            expect.objectContaining({ variation_id: 'V_ORPHAN' })
        );
    });

    it('respects MAX_PAGINATION_ITERATIONS safety limit', async () => {
        // Always return a cursor to simulate infinite loop
        makeSquareRequest.mockResolvedValue(
            buildCatalogListResponse({ cursor: 'infinite' })
        );

        // Override constant for this test — module already loaded with 50, so
        // the loop will run 50 times then break
        const stats = await syncCatalog(MERCHANT_ID);

        expect(makeSquareRequest).toHaveBeenCalledTimes(50);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Pagination loop exceeded max iterations'),
            expect.any(Object)
        );
        expect(stats).toBeDefined();
    });

    it('processes related_objects for categories', async () => {
        const response = {
            objects: [
                {
                    type: 'ITEM',
                    id: 'ITEM1',
                    present_at_all_locations: true,
                    item_data: {
                        name: 'Item With Related Cat',
                        categories: [{ id: 'REL_CAT1' }],
                        variations: [{
                            type: 'ITEM_VARIATION',
                            id: 'V1',
                            item_variation_data: { item_id: 'ITEM1', name: 'Regular', track_inventory: true }
                        }]
                    }
                }
            ],
            related_objects: [
                {
                    type: 'CATEGORY',
                    id: 'REL_CAT1',
                    category_data: { name: 'Related Category' }
                }
            ]
        };
        makeSquareRequest.mockResolvedValue(response);

        const stats = await syncCatalog(MERCHANT_ID);

        // Related category should be synced
        expect(stats.categories).toBe(1);
        expect(stats.items).toBe(1);
    });

    it('continues syncing when individual item sync fails', async () => {
        const response = buildCatalogListResponse({
            items: [
                buildMinimalItem('ITEM1', 'Good', [{ id: 'V1' }]),
                buildMinimalItem('ITEM2', 'Also Good', [{ id: 'V2' }])
            ]
        });
        makeSquareRequest.mockResolvedValue(response);

        // Fail on first item insert, succeed on second
        let itemInsertCount = 0;
        db.query.mockImplementation((sql) => {
            if (sql.includes('INSERT INTO items')) {
                itemInsertCount++;
                if (itemInsertCount === 1) {
                    throw new Error('DB constraint error');
                }
            }
            return { rows: [], rowCount: 0 };
        });

        const stats = await syncCatalog(MERCHANT_ID);

        // One item failed, one succeeded
        expect(stats.items).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to sync item',
            expect.objectContaining({ id: expect.any(String) })
        );
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// deltaSyncCatalog
// ═════════════════════════════════════════════════════════════════════════════

describe('deltaSyncCatalog', () => {
    it('throws when merchantId is missing', async () => {
        await expect(deltaSyncCatalog(null)).rejects.toThrow('merchantId is required');
    });

    it('falls back to full sync when no prior timestamp exists', async () => {
        // No timestamp row in sync_history
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
        makeSquareRequest.mockResolvedValue({ objects: [], related_objects: [] });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('No previous delta timestamp'),
            expect.any(Object)
        );
        // Full sync was called — it fetches via /v2/catalog/list
        expect(makeSquareRequest).toHaveBeenCalledWith(
            expect.stringContaining('/v2/catalog/list'),
            expect.any(Object)
        );
        expect(stats).toBeDefined();
    });

    it('falls back to full sync when too many changes (>100 objects)', async () => {
        // Return a timestamp so delta sync is attempted
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        // Return 101 objects to trigger fallback
        const manyObjects = Array.from({ length: 101 }, (_, i) => ({
            type: 'ITEM',
            id: `ITEM${i}`,
            item_data: { name: `Item ${i}`, variations: [] }
        }));
        makeSquareRequest
            .mockResolvedValueOnce({ objects: manyObjects, related_objects: [] })
            // Full sync call after fallback
            .mockResolvedValue({ objects: [], related_objects: [] });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('falling back to full sync'),
            expect.objectContaining({ objectCount: 101 })
        );
    });

    it('fetches changed objects using SearchCatalogObjects with begin_time', async () => {
        const lastTimestamp = '2026-03-14T12:00:00Z';
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: lastTimestamp }] };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [
                {
                    type: 'ITEM',
                    id: 'ITEM1',
                    item_data: {
                        name: 'Updated Item',
                        categories: [],
                        variations: [{
                            type: 'ITEM_VARIATION',
                            id: 'V1',
                            item_variation_data: { item_id: 'ITEM1', name: 'Regular', track_inventory: true }
                        }]
                    },
                    present_at_all_locations: true
                }
            ],
            related_objects: [],
            latest_time: '2026-03-14T13:00:00Z'
        });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining(lastTimestamp)
            })
        );
        expect(stats.items).toBe(1);
        expect(stats.deltaSync).toBe(true);
    });

    it('processes deletions (is_deleted objects)', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [
                { type: 'ITEM', id: 'DELETED_ITEM1', is_deleted: true },
                { type: 'ITEM_VARIATION', id: 'DELETED_VAR1', is_deleted: true }
            ],
            related_objects: [],
            latest_time: '2026-03-14T13:00:00Z'
        });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(stats.items_deleted).toBe(1);
        expect(stats.variations_deleted).toBe(1);

        // Verify deletion queries were made
        const deleteItemCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE items SET is_deleted = TRUE') && c[1]?.[0] === 'DELETED_ITEM1'
        );
        expect(deleteItemCall).toBeDefined();

        const deleteVarCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE variations SET is_deleted = TRUE') && c[1]?.[0] === 'DELETED_VAR1'
        );
        expect(deleteVarCall).toBeDefined();
    });

    it('updates delta timestamp after sync', async () => {
        const newTimestamp = '2026-03-14T15:00:00Z';

        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp') && sql.includes('SELECT')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [
                {
                    type: 'CATEGORY',
                    id: 'CAT1',
                    category_data: { name: 'New Cat' }
                }
            ],
            related_objects: [],
            latest_time: newTimestamp
        });

        await deltaSyncCatalog(MERCHANT_ID);

        const timestampCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('sync_history') && c[0].includes('INSERT') && c[1]?.includes(newTimestamp)
        );
        expect(timestampCall).toBeDefined();
    });

    it('handles no changes (totalObjects === 0)', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [],
            related_objects: [],
            latest_time: '2026-03-14T01:00:00Z'
        });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(stats.items).toBe(0);
        expect(stats.variations).toBe(0);
        expect(stats.categories).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(
            'Delta sync: no changes since last sync',
            expect.objectContaining({ merchantId: MERCHANT_ID })
        );
    });

    it('checks DB for parent item when variation parent not in delta batch', async () => {
        db.query.mockImplementation((sql, params) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            // Parent item exists in DB
            if (sql.includes('SELECT id FROM items WHERE id = $1')) {
                return { rows: [{ id: params[0] }] };
            }
            if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
                return { rows: [{ cnt: '0' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [
                {
                    type: 'ITEM_VARIATION',
                    id: 'V_DELTA',
                    item_variation_data: {
                        item_id: 'ITEM_IN_DB',
                        name: 'Delta Var',
                        track_inventory: true
                    }
                }
            ],
            related_objects: [],
            latest_time: '2026-03-14T13:00:00Z'
        });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(stats.variations).toBe(1);
    });

    it('skips variation when parent item not in delta batch and not in DB', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            if (sql.includes('SELECT id FROM items WHERE id = $1')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [
                {
                    type: 'ITEM_VARIATION',
                    id: 'V_ORPHAN',
                    item_variation_data: {
                        item_id: 'ITEM_MISSING',
                        name: 'Orphan Var',
                        track_inventory: true
                    }
                }
            ],
            related_objects: [],
            latest_time: '2026-03-14T13:00:00Z'
        });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(stats.variations).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('skipping variation'),
            expect.objectContaining({ variation_id: 'V_ORPHAN' })
        );
    });

    it('handles deleted nested variations from item_data.variations', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
                return { rows: [{ cnt: '0' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        makeSquareRequest.mockResolvedValue({
            objects: [
                {
                    type: 'ITEM',
                    id: 'ITEM1',
                    present_at_all_locations: true,
                    item_data: {
                        name: 'Item With Deleted Var',
                        categories: [],
                        variations: [
                            {
                                type: 'ITEM_VARIATION',
                                id: 'V_ALIVE',
                                is_deleted: false,
                                item_variation_data: { item_id: 'ITEM1', name: 'Alive', track_inventory: true }
                            },
                            {
                                type: 'ITEM_VARIATION',
                                id: 'V_DEAD',
                                is_deleted: true,
                                item_variation_data: { item_id: 'ITEM1', name: 'Dead', track_inventory: true }
                            }
                        ]
                    }
                }
            ],
            related_objects: [],
            latest_time: '2026-03-14T13:00:00Z'
        });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(stats.items).toBe(1);
        expect(stats.variations).toBe(1); // Only V_ALIVE
        expect(stats.variations_deleted).toBe(1); // V_DEAD
    });

    it('falls back to full sync on unexpected error', async () => {
        db.query.mockImplementation((sql) => {
            if (sql.includes('last_delta_timestamp') && sql.includes('SELECT')) {
                return { rows: [{ last_delta_timestamp: '2026-03-14T00:00:00Z' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        // First call (delta search) fails, second call (full sync list) succeeds
        makeSquareRequest
            .mockRejectedValueOnce(new Error('Square API 500'))
            .mockResolvedValue({ objects: [], related_objects: [] });

        const stats = await deltaSyncCatalog(MERCHANT_ID);

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Delta catalog sync failed'),
            expect.any(Object)
        );
        // Fell back to full sync
        expect(stats).toBeDefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// syncVariation
// ═════════════════════════════════════════════════════════════════════════════

describe('syncVariation', () => {
    const baseVariation = {
        type: 'ITEM_VARIATION',
        id: 'VAR_001',
        present_at_all_locations: true,
        item_variation_data: {
            item_id: 'ITEM_001',
            name: '25lb Bag',
            sku: 'DOG-25LB',
            upc: '123456789',
            price_money: { amount: 4999, currency: 'CAD' },
            pricing_type: 'FIXED_PRICING',
            track_inventory: true,
            location_overrides: [],
            vendor_information: undefined
        }
    };

    it('upserts variation to database', async () => {
        const vendorCount = await syncVariation(baseVariation, MERCHANT_ID);

        expect(vendorCount).toBe(0);

        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variations')
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[1]).toEqual(expect.arrayContaining([
            'VAR_001',     // id
            'ITEM_001',    // item_id
            '25lb Bag',    // name
            'DOG-25LB',    // sku
        ]));
    });

    it('extracts inventory alert settings from location_overrides', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                inventory_alert_type: null,
                inventory_alert_threshold: null,
                location_overrides: [
                    {
                        location_id: 'LOC1',
                        inventory_alert_type: 'LOW_QUANTITY',
                        inventory_alert_threshold: 5
                    },
                    {
                        location_id: 'LOC2',
                        inventory_alert_type: 'NONE'
                    }
                ]
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variations')
        );
        expect(insertCall).toBeDefined();
        // inventory_alert_type should be LOW_QUANTITY from the first override
        const params = insertCall[1];
        // Index 9 = inventory_alert_type, Index 10 = inventory_alert_threshold
        expect(params[9]).toBe('LOW_QUANTITY');
        expect(params[10]).toBe(5);
    });

    it('falls back to first override alert type when no LOW_QUANTITY found', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                inventory_alert_type: null,
                inventory_alert_threshold: null,
                location_overrides: [
                    {
                        location_id: 'LOC1',
                        inventory_alert_type: 'NONE',
                        inventory_alert_threshold: 10
                    }
                ]
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variations')
        );
        const params = insertCall[1];
        expect(params[9]).toBe('NONE');
        expect(params[10]).toBe(10);
    });

    it('syncs vendor information (DELETE + INSERT in transaction) when valid vendor_info present', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                vendor_information: [
                    {
                        vendor_id: 'VENDOR_A',
                        vendor_code: 'VC-001',
                        unit_cost_money: { amount: 2500, currency: 'CAD' }
                    },
                    {
                        vendor_id: 'VENDOR_B',
                        vendor_code: 'VC-002',
                        unit_cost_money: { amount: 3000, currency: 'USD' }
                    }
                ]
            }
        };

        const vendorCount = await syncVariation(variation, MERCHANT_ID);

        expect(vendorCount).toBe(2);
        expect(ensureVendorsExist).toHaveBeenCalledWith(
            ['VENDOR_A', 'VENDOR_B'],
            MERCHANT_ID
        );
        expect(db.transaction).toHaveBeenCalled();
    });

    it('skips vendor entries without vendor_id (cost-only entries)', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                vendor_information: [
                    {
                        vendor_id: 'VENDOR_A',
                        vendor_code: 'VC-001',
                        unit_cost_money: { amount: 2500, currency: 'CAD' }
                    },
                    {
                        // No vendor_id — cost-only entry
                        unit_cost_money: { amount: 1000, currency: 'CAD' }
                    }
                ]
            }
        };

        const vendorCount = await syncVariation(variation, MERCHANT_ID);

        // Only one vendor had a vendor_id
        expect(vendorCount).toBe(1);
        expect(logger.debug).toHaveBeenCalledWith(
            'Vendor info without vendor_id (cost-only entry)',
            expect.objectContaining({ variation_id: 'VAR_001' })
        );
    });

    it('does not delete vendor links when vendor_information is absent', async () => {
        // No vendor_information field at all
        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT COUNT(*) as cnt FROM variation_vendors')) {
                return { rows: [{ cnt: '2' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        const vendorCount = await syncVariation(baseVariation, MERCHANT_ID);

        expect(vendorCount).toBe(0);
        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                variationId: 'VAR_001',
                existingLinksPreserved: true
            })
        );
    });

    it('does not delete vendor links when vendor_information is empty array', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                vendor_information: []
            }
        };

        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT COUNT(*) as cnt FROM variation_vendors')) {
                return { rows: [{ cnt: '1' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        const vendorCount = await syncVariation(variation, MERCHANT_ID);

        expect(vendorCount).toBe(0);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it('does not delete vendor links when vendor_information has no real vendor_id', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                vendor_information: [
                    { unit_cost_money: { amount: 1000, currency: 'CAD' } }
                ]
            }
        };

        db.query.mockImplementation((sql) => {
            if (sql.includes('SELECT COUNT(*) as cnt FROM variation_vendors')) {
                return { rows: [{ cnt: '1' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        await syncVariation(variation, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
    });

    it('syncs custom attribute: case_pack_quantity', async () => {
        const variation = {
            ...baseVariation,
            custom_attribute_values: {
                case_pack_quantity: { number_value: '12' }
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const updateCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('case_pack_quantity = $1')
        );
        expect(updateCall).toBeDefined();
        expect(updateCall[1][0]).toBe(12);
        expect(updateCall[1][1]).toBe('VAR_001');
        expect(updateCall[1][2]).toBe(MERCHANT_ID);
    });

    it('ignores invalid case_pack_quantity values', async () => {
        const variation = {
            ...baseVariation,
            custom_attribute_values: {
                case_pack_quantity: { number_value: '0' }
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const updateCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('case_pack_quantity = $1')
        );
        expect(updateCall).toBeUndefined();
    });

    it('syncs custom attributes: expiration data', async () => {
        const variation = {
            ...baseVariation,
            custom_attribute_values: {
                expiration_date: { string_value: '2026-06-15' },
                does_not_expire: { boolean_value: false },
                expiry_reviewed_at: { string_value: '2026-03-10T10:00:00Z' },
                expiry_reviewed_by: { string_value: 'admin@jtpets.ca' }
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const expiryCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_expiration')
        );
        expect(expiryCall).toBeDefined();
        expect(expiryCall[1]).toEqual([
            'VAR_001',
            '2026-06-15',
            false,
            '2026-03-10T10:00:00Z',
            'admin@jtpets.ca',
            MERCHANT_ID
        ]);
    });

    it('syncs expiration data with does_not_expire = true', async () => {
        const variation = {
            ...baseVariation,
            custom_attribute_values: {
                does_not_expire: { boolean_value: true }
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const expiryCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_expiration')
        );
        expect(expiryCall).toBeDefined();
        expect(expiryCall[1][2]).toBe(true); // does_not_expire
    });

    it('returns vendor count', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                vendor_information: [
                    { vendor_id: 'V1', vendor_code: 'C1' },
                    { vendor_id: 'V2', vendor_code: 'C2' },
                    { vendor_id: 'V3', vendor_code: 'C3' }
                ]
            }
        };

        const vendorCount = await syncVariation(variation, MERCHANT_ID);

        expect(vendorCount).toBe(3);
    });

    it('syncs location_overrides to variation_location_settings', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                location_overrides: [
                    { location_id: 'LOC_A', inventory_alert_threshold: 3 },
                    { location_id: 'LOC_B', inventory_alert_threshold: 7 }
                ]
            }
        };

        await syncVariation(variation, MERCHANT_ID);

        const locationCalls = db.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_location_settings')
        );
        expect(locationCalls).toHaveLength(2);
        expect(locationCalls[0][1]).toContain('LOC_A');
        expect(locationCalls[1][1]).toContain('LOC_B');
    });

    it('handles vendor insert failure gracefully (logs warning, continues)', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                vendor_information: [
                    { vendor_id: 'VENDOR_GOOD', vendor_code: 'G1' },
                    { vendor_id: 'VENDOR_BAD', vendor_code: 'B1' }
                ]
            }
        };

        // Make the transaction's client.query fail on second vendor INSERT
        let vendorInsertCount = 0;
        db.transaction.mockImplementation(async (fn) => {
            const mockClient = {
                query: jest.fn().mockImplementation((sql) => {
                    if (sql.includes('INSERT INTO variation_vendors')) {
                        vendorInsertCount++;
                        if (vendorInsertCount === 2) {
                            throw new Error('FK violation');
                        }
                    }
                    return { rows: [], rowCount: 0 };
                }),
                release: jest.fn()
            };
            return fn(mockClient);
        });

        const vendorCount = await syncVariation(variation, MERCHANT_ID);

        // First vendor succeeded, second failed
        expect(vendorCount).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Skipping variation_vendor'),
            expect.objectContaining({ vendor_id: 'VENDOR_BAD' })
        );
    });

    it('stores custom_attribute_values as JSON in variations table', async () => {
        const customAttrs = {
            case_pack_quantity: { number_value: '6' },
            brand: { string_value: 'Acme' }
        };
        const variation = {
            ...baseVariation,
            custom_attribute_values: customAttrs
        };

        await syncVariation(variation, MERCHANT_ID);

        const insertCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variations')
        );
        // custom_attributes param (index 15) should be JSON stringified
        expect(insertCall[1][15]).toBe(JSON.stringify(customAttrs));
    });
});
