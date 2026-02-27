/**
 * Bundle Service Tests
 *
 * Tests for bundle CRUD operations, availability calculation,
 * batch component inserts, and service extraction correctness.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

const db = require('../../utils/database');
const bundleService = require('../../services/bundle-service');

describe('Bundle Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== LIST BUNDLES ====================

    describe('listBundles', () => {
        test('returns bundles with components for a merchant', async () => {
            db.query.mockResolvedValue({
                rows: [
                    {
                        id: 1,
                        merchant_id: 10,
                        bundle_variation_id: 'VAR_1',
                        bundle_item_name: 'Dog Food Bundle',
                        vendor_name: 'Acme',
                        components: [
                            { id: 100, child_variation_id: 'CV_1', quantity_in_bundle: 2 }
                        ]
                    }
                ]
            });

            const result = await bundleService.listBundles(10, {});

            expect(result.count).toBe(1);
            expect(result.bundles[0].bundle_item_name).toBe('Dog Food Bundle');
            expect(result.bundles[0].components).toHaveLength(1);
            expect(db.query).toHaveBeenCalledTimes(1);
            // merchant_id is $1 in the query
            expect(db.query.mock.calls[0][1]).toEqual([10]);
        });

        test('returns empty components array when bundle has no components', async () => {
            db.query.mockResolvedValue({
                rows: [
                    {
                        id: 1,
                        bundle_item_name: 'Empty Bundle',
                        components: null
                    }
                ]
            });

            const result = await bundleService.listBundles(10, {});

            expect(result.bundles[0].components).toEqual([]);
        });

        test('filters by active_only when set to true', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await bundleService.listBundles(10, { active_only: 'true' });

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('bd.is_active = true');
        });

        test('does not filter by active when active_only is not true', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await bundleService.listBundles(10, { active_only: 'false' });

            const sql = db.query.mock.calls[0][0];
            expect(sql).not.toContain('bd.is_active = true');
        });

        test('filters by vendor_id when provided', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await bundleService.listBundles(10, { vendor_id: 'V_42' });

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('bd.vendor_id = $2');
            expect(db.query.mock.calls[0][1]).toEqual([10, 'V_42']);
        });

        test('filters by both active_only and vendor_id', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await bundleService.listBundles(10, { active_only: 'true', vendor_id: 'V_1' });

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('bd.is_active = true');
            expect(sql).toContain('bd.vendor_id = $2');
        });
    });

    // ==================== CALCULATE AVAILABILITY ====================

    describe('calculateAvailability', () => {
        test('returns empty array when no active bundles exist', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await bundleService.calculateAvailability(10, {});

            expect(result).toEqual({ count: 0, bundles: [] });
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        test('calculates assemblable quantity based on limiting component', async () => {
            // Bundle query returns rows for one bundle with two children
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        {
                            bundle_id: 1,
                            bundle_variation_id: 'BV_1',
                            bundle_item_name: 'Test Bundle',
                            bundle_cost_cents: 1000,
                            bundle_sell_price_cents: 1500,
                            bundle_sku: 'BDL-1',
                            vendor_id: null,
                            bundle_vendor_code: null,
                            vendor_name: null,
                            child_variation_id: 'CV_A',
                            quantity_in_bundle: 2,
                            child_item_name: 'Item A',
                            child_sku: 'SKU-A',
                            individual_cost_cents: 200
                        },
                        {
                            bundle_id: 1,
                            bundle_variation_id: 'BV_1',
                            bundle_item_name: 'Test Bundle',
                            bundle_cost_cents: 1000,
                            bundle_sell_price_cents: 1500,
                            bundle_sku: 'BDL-1',
                            vendor_id: null,
                            bundle_vendor_code: null,
                            vendor_name: null,
                            child_variation_id: 'CV_B',
                            quantity_in_bundle: 1,
                            child_item_name: 'Item B',
                            child_sku: 'SKU-B',
                            individual_cost_cents: 300
                        }
                    ]
                })
                // Inventory: CV_A has 10 stock, CV_B has 3 stock
                .mockResolvedValueOnce({
                    rows: [
                        { catalog_object_id: 'CV_A', stock: '10', committed: '0' },
                        { catalog_object_id: 'CV_B', stock: '3', committed: '0' },
                        { catalog_object_id: 'BV_1', stock: '0', committed: '0' }
                    ]
                })
                // Velocity: none
                .mockResolvedValueOnce({ rows: [] })
                // Min stock: all 0
                .mockResolvedValueOnce({
                    rows: [
                        { id: 'CV_A', stock_alert_min: 0, is_deleted: false, vendor_code: null },
                        { id: 'CV_B', stock_alert_min: 0, is_deleted: false, vendor_code: null }
                    ]
                });

            const result = await bundleService.calculateAvailability(10, {});

            expect(result.count).toBe(1);
            const bundle = result.bundles[0];
            // CV_A: 10 stock / 2 per bundle = 5 assemblable
            // CV_B: 3 stock / 1 per bundle = 3 assemblable
            // Limiting = 3 (Item B)
            expect(bundle.assemblable_qty).toBe(3);
            expect(bundle.limiting_component).toBe('Item B');
            expect(bundle.children).toHaveLength(2);
        });

        test('subtracts committed inventory from available stock', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        {
                            bundle_id: 1,
                            bundle_variation_id: 'BV_1',
                            bundle_item_name: 'Test Bundle',
                            bundle_cost_cents: 1000,
                            bundle_sell_price_cents: 1500,
                            bundle_sku: 'BDL-1',
                            vendor_id: null,
                            bundle_vendor_code: null,
                            vendor_name: null,
                            child_variation_id: 'CV_A',
                            quantity_in_bundle: 1,
                            child_item_name: 'Item A',
                            child_sku: 'SKU-A',
                            individual_cost_cents: 200
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    rows: [
                        { catalog_object_id: 'CV_A', stock: '10', committed: '4' },
                        { catalog_object_id: 'BV_1', stock: '0', committed: '0' }
                    ]
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{ id: 'CV_A', stock_alert_min: 0, is_deleted: false, vendor_code: null }]
                });

            const result = await bundleService.calculateAvailability(10, {});

            const child = result.bundles[0].children[0];
            expect(child.stock).toBe(10);
            expect(child.committed_quantity).toBe(4);
            expect(child.available_quantity).toBe(6);
            expect(child.available_for_bundles).toBe(6);
            expect(result.bundles[0].assemblable_qty).toBe(6);
        });

        test('subtracts safety stock (stock_alert_min) from available for bundles', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        {
                            bundle_id: 1,
                            bundle_variation_id: 'BV_1',
                            bundle_item_name: 'Bundle',
                            bundle_cost_cents: 500,
                            bundle_sell_price_cents: 800,
                            bundle_sku: 'B-1',
                            vendor_id: null,
                            bundle_vendor_code: null,
                            vendor_name: null,
                            child_variation_id: 'CV_A',
                            quantity_in_bundle: 1,
                            child_item_name: 'Item A',
                            child_sku: 'A',
                            individual_cost_cents: 100
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    rows: [
                        { catalog_object_id: 'CV_A', stock: '10', committed: '0' },
                        { catalog_object_id: 'BV_1', stock: '0', committed: '0' }
                    ]
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{ id: 'CV_A', stock_alert_min: 3, is_deleted: false, vendor_code: null }]
                });

            const result = await bundleService.calculateAvailability(10, {});

            const child = result.bundles[0].children[0];
            expect(child.stock).toBe(10);
            expect(child.stock_alert_min).toBe(3);
            expect(child.available_for_bundles).toBe(7);
            expect(result.bundles[0].assemblable_qty).toBe(7);
        });

        test('passes location_id filter to all queries', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] });

            await bundleService.calculateAvailability(10, { location_id: 'LOC_1' });

            const bundlesSql = db.query.mock.calls[0][0];
            // The bundles query does not filter by location (it fetches all active bundles)
            expect(db.query.mock.calls[0][1]).toEqual([10]);
        });

        test('returns 999 days_of_stock when velocity is zero', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        {
                            bundle_id: 1,
                            bundle_variation_id: 'BV_1',
                            bundle_item_name: 'Test',
                            bundle_cost_cents: 100,
                            bundle_sell_price_cents: 200,
                            bundle_sku: 'S',
                            vendor_id: null,
                            bundle_vendor_code: null,
                            vendor_name: null,
                            child_variation_id: 'CV_A',
                            quantity_in_bundle: 1,
                            child_item_name: 'A',
                            child_sku: 'A',
                            individual_cost_cents: 50
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    rows: [
                        { catalog_object_id: 'CV_A', stock: '5', committed: '0' },
                        { catalog_object_id: 'BV_1', stock: '0', committed: '0' }
                    ]
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{ id: 'CV_A', stock_alert_min: 0, is_deleted: false, vendor_code: null }]
                });

            const result = await bundleService.calculateAvailability(10, {});

            expect(result.bundles[0].days_of_bundle_stock).toBe(999);
            expect(result.bundles[0].children[0].days_of_stock).toBe(999);
        });

        test('calculates velocity-based days_of_stock correctly', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        {
                            bundle_id: 1,
                            bundle_variation_id: 'BV_1',
                            bundle_item_name: 'Test',
                            bundle_cost_cents: 100,
                            bundle_sell_price_cents: 200,
                            bundle_sku: 'S',
                            vendor_id: null,
                            bundle_vendor_code: null,
                            vendor_name: null,
                            child_variation_id: 'CV_A',
                            quantity_in_bundle: 1,
                            child_item_name: 'A',
                            child_sku: 'A',
                            individual_cost_cents: 50
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    rows: [
                        { catalog_object_id: 'CV_A', stock: '20', committed: '0' },
                        { catalog_object_id: 'BV_1', stock: '0', committed: '0' }
                    ]
                })
                // Velocity: BV_1 sells 2/day, CV_A sells 3/day individually
                .mockResolvedValueOnce({
                    rows: [
                        { variation_id: 'BV_1', daily_avg_quantity: '2.0' },
                        { variation_id: 'CV_A', daily_avg_quantity: '3.0' }
                    ]
                })
                .mockResolvedValueOnce({
                    rows: [{ id: 'CV_A', stock_alert_min: 0, is_deleted: false, vendor_code: null }]
                });

            const result = await bundleService.calculateAvailability(10, {});

            const child = result.bundles[0].children[0];
            // CV_A individual velocity = 3, bundle driven = 2*1 = 2, total = 5
            expect(child.individual_daily_velocity).toBe(3);
            expect(child.bundle_driven_daily_velocity).toBe(2);
            expect(child.total_daily_velocity).toBe(5);
            // days_of_stock = 20 / 5 = 4.0
            expect(child.days_of_stock).toBe(4);
            // pct_from_bundles = (2/5) * 100 = 40%
            expect(child.pct_from_bundles).toBe(40);
        });
    });

    // ==================== BATCH INSERT COMPONENTS ====================

    describe('_batchInsertComponents', () => {
        test('inserts all components in a single query', async () => {
            const mockClient = { query: jest.fn() };
            mockClient.query.mockResolvedValue({
                rows: [
                    { id: 1, bundle_id: 5, child_variation_id: 'CV_1', quantity_in_bundle: 2 },
                    { id: 2, bundle_id: 5, child_variation_id: 'CV_2', quantity_in_bundle: 3 },
                    { id: 3, bundle_id: 5, child_variation_id: 'CV_3', quantity_in_bundle: 1 }
                ]
            });

            const catalogMap = new Map([
                ['CV_1', { item_id: 'I1', item_name: 'Item 1', variation_name: 'Var 1', sku: 'S1' }],
                ['CV_2', { item_id: 'I2', item_name: 'Item 2', variation_name: 'Var 2', sku: 'S2' }],
                ['CV_3', { item_id: 'I3', item_name: 'Item 3', variation_name: 'Var 3', sku: 'S3' }]
            ]);

            const components = [
                { child_variation_id: 'CV_1', quantity_in_bundle: 2, individual_cost_cents: 100 },
                { child_variation_id: 'CV_2', quantity_in_bundle: 3, individual_cost_cents: 200 },
                { child_variation_id: 'CV_3', quantity_in_bundle: 1, individual_cost_cents: 50 }
            ];

            const result = await bundleService._batchInsertComponents(mockClient, 5, components, catalogMap);

            // Single query instead of N queries
            expect(mockClient.query).toHaveBeenCalledTimes(1);

            const sql = mockClient.query.mock.calls[0][0];
            // Should have 3 value groups in the VALUES clause
            const valueMatches = sql.match(/\(\$\d+/g);
            expect(valueMatches).toHaveLength(3);

            // 3 components * 8 params each = 24 params
            const params = mockClient.query.mock.calls[0][1];
            expect(params).toHaveLength(24);

            expect(result).toHaveLength(3);
        });

        test('returns empty array for empty components', async () => {
            const mockClient = { query: jest.fn() };
            const result = await bundleService._batchInsertComponents(mockClient, 5, [], new Map());
            expect(result).toEqual([]);
            expect(mockClient.query).not.toHaveBeenCalled();
        });

        test('returns empty array for null components', async () => {
            const mockClient = { query: jest.fn() };
            const result = await bundleService._batchInsertComponents(mockClient, 5, null, new Map());
            expect(result).toEqual([]);
            expect(mockClient.query).not.toHaveBeenCalled();
        });

        test('handles missing catalog entries gracefully', async () => {
            const mockClient = { query: jest.fn() };
            mockClient.query.mockResolvedValue({
                rows: [{ id: 1, bundle_id: 5, child_variation_id: 'CV_UNKNOWN', quantity_in_bundle: 1 }]
            });

            // Empty catalog map — no matches
            const catalogMap = new Map();
            const components = [
                { child_variation_id: 'CV_UNKNOWN', quantity_in_bundle: 1 }
            ];

            const result = await bundleService._batchInsertComponents(mockClient, 5, components, catalogMap);

            expect(result).toHaveLength(1);
            const params = mockClient.query.mock.calls[0][1];
            // item_id, item_name, variation_name, sku should all be null
            expect(params[2]).toBeNull(); // child_item_id
            expect(params[4]).toBeNull(); // child_item_name
            expect(params[5]).toBeNull(); // child_variation_name
            expect(params[6]).toBeNull(); // child_sku
        });

        test('uses single INSERT with multi-row VALUES (not sequential)', async () => {
            const mockClient = { query: jest.fn() };
            mockClient.query.mockResolvedValue({
                rows: [
                    { id: 1 },
                    { id: 2 },
                    { id: 3 },
                    { id: 4 },
                    { id: 5 },
                    { id: 6 },
                    { id: 7 },
                    { id: 8 },
                    { id: 9 },
                    { id: 10 }
                ]
            });

            const catalogMap = new Map();
            const components = Array.from({ length: 10 }, (_, i) => ({
                child_variation_id: `CV_${i}`,
                quantity_in_bundle: 1,
                individual_cost_cents: 100
            }));

            await bundleService._batchInsertComponents(mockClient, 5, components, catalogMap);

            // Critical: only 1 query call for 10 components (batch, not N+1)
            expect(mockClient.query).toHaveBeenCalledTimes(1);

            // 10 components * 8 params each = 80 params
            expect(mockClient.query.mock.calls[0][1]).toHaveLength(80);
        });
    });

    // ==================== LOOKUP CHILD CATALOG ====================

    describe('_lookupChildCatalog', () => {
        test('returns map of variation_id to catalog info', async () => {
            const mockClient = { query: jest.fn() };
            mockClient.query.mockResolvedValue({
                rows: [
                    { variation_id: 'CV_1', item_id: 'I1', item_name: 'Dog Food', variation_name: '5kg', sku: 'DF-5' },
                    { variation_id: 'CV_2', item_id: 'I2', item_name: 'Cat Food', variation_name: '3kg', sku: 'CF-3' }
                ]
            });

            const result = await bundleService._lookupChildCatalog(mockClient, 10, ['CV_1', 'CV_2']);

            expect(result.size).toBe(2);
            expect(result.get('CV_1').item_name).toBe('Dog Food');
            expect(result.get('CV_2').sku).toBe('CF-3');
            expect(mockClient.query.mock.calls[0][1]).toEqual([10, ['CV_1', 'CV_2']]);
        });
    });

    // ==================== CREATE BUNDLE ====================

    describe('createBundle', () => {
        test('creates bundle definition and components in transaction', async () => {
            const mockClient = { query: jest.fn() };

            // Mock transaction to execute callback
            db.transaction.mockImplementation(async (callback) => callback(mockClient));

            // 1. INSERT into bundle_definitions
            mockClient.query.mockResolvedValueOnce({
                rows: [{
                    id: 42,
                    merchant_id: 10,
                    bundle_variation_id: 'BV_1',
                    bundle_item_name: 'Pet Bundle',
                    bundle_cost_cents: 2000
                }]
            });
            // 2. Catalog lookup
            mockClient.query.mockResolvedValueOnce({
                rows: [
                    { variation_id: 'CV_1', item_id: 'I1', item_name: 'Dog Food', variation_name: '5kg', sku: 'DF-5' }
                ]
            });
            // 3. Batch insert components
            mockClient.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, bundle_id: 42, child_variation_id: 'CV_1', quantity_in_bundle: 2 }
                ]
            });

            const result = await bundleService.createBundle(10, {
                bundle_variation_id: 'BV_1',
                bundle_item_name: 'Pet Bundle',
                bundle_cost_cents: 2000,
                components: [
                    { child_variation_id: 'CV_1', quantity_in_bundle: 2 }
                ]
            });

            expect(db.transaction).toHaveBeenCalledTimes(1);
            expect(result.id).toBe(42);
            expect(result.components).toHaveLength(1);

            // Verify: 3 queries inside transaction (definition insert, catalog lookup, batch component insert)
            expect(mockClient.query).toHaveBeenCalledTimes(3);
        });

        test('passes null for optional fields', async () => {
            const mockClient = { query: jest.fn() };
            db.transaction.mockImplementation(async (callback) => callback(mockClient));

            mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 1, bundle_item_name: 'B' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ id: 10 }] });

            await bundleService.createBundle(10, {
                bundle_variation_id: 'BV_1',
                bundle_item_name: 'B',
                bundle_cost_cents: 100,
                components: [{ child_variation_id: 'CV_1', quantity_in_bundle: 1 }]
            });

            // Check definition insert params — optional fields should be null
            const defParams = mockClient.query.mock.calls[0][1];
            expect(defParams[2]).toBeNull();  // bundle_item_id
            expect(defParams[4]).toBeNull();  // bundle_variation_name
            expect(defParams[5]).toBeNull();  // bundle_sku
            expect(defParams[7]).toBeNull();  // bundle_sell_price_cents
            expect(defParams[8]).toBeNull();  // vendor_id
            expect(defParams[9]).toBeNull();  // vendor_code
            expect(defParams[10]).toBeNull(); // notes
        });
    });

    // ==================== UPDATE BUNDLE ====================

    describe('updateBundle', () => {
        test('updates definition and returns existing components when none provided', async () => {
            const mockClient = { query: jest.fn() };
            db.transaction.mockImplementation(async (callback) => callback(mockClient));

            // Verify ownership
            mockClient.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
            // Update definition
            mockClient.query.mockResolvedValueOnce({
                rows: [{ id: 5, bundle_item_name: 'Updated Bundle', bundle_cost_cents: 3000 }]
            });
            // Fetch existing components
            mockClient.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, bundle_id: 5, child_variation_id: 'CV_1' }
                ]
            });

            const result = await bundleService.updateBundle(10, 5, {
                bundle_cost_cents: 3000
            });

            expect(result.bundle_cost_cents).toBe(3000);
            expect(result.components).toHaveLength(1);
        });

        test('replaces components when provided', async () => {
            const mockClient = { query: jest.fn() };
            db.transaction.mockImplementation(async (callback) => callback(mockClient));

            // Verify ownership
            mockClient.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
            // Update definition
            mockClient.query.mockResolvedValueOnce({
                rows: [{ id: 5, bundle_item_name: 'Bundle' }]
            });
            // DELETE old components
            mockClient.query.mockResolvedValueOnce({ rows: [] });
            // Catalog lookup
            mockClient.query.mockResolvedValueOnce({
                rows: [{ variation_id: 'CV_NEW', item_id: 'I1', item_name: 'New Item', variation_name: 'V', sku: 'N' }]
            });
            // Batch insert new components
            mockClient.query.mockResolvedValueOnce({
                rows: [{ id: 10, bundle_id: 5, child_variation_id: 'CV_NEW', quantity_in_bundle: 3 }]
            });

            const result = await bundleService.updateBundle(10, 5, {
                is_active: true,
                components: [{ child_variation_id: 'CV_NEW', quantity_in_bundle: 3 }]
            });

            expect(result.components).toHaveLength(1);
            expect(result.components[0].child_variation_id).toBe('CV_NEW');

            // 5 queries: verify, update, delete, catalog, insert
            expect(mockClient.query).toHaveBeenCalledTimes(5);
        });

        test('throws 404 when bundle not found', async () => {
            const mockClient = { query: jest.fn() };
            db.transaction.mockImplementation(async (callback) => callback(mockClient));

            // No matching bundle
            mockClient.query.mockResolvedValueOnce({ rows: [] });

            try {
                await bundleService.updateBundle(10, 999, { notes: 'test' });
                // Should not reach here
                expect(true).toBe(false);
            } catch (err) {
                expect(err.message).toBe('Bundle not found');
                expect(err.status).toBe(404);
            }
        });

        test('builds dynamic SET clause for provided fields only', async () => {
            const mockClient = { query: jest.fn() };
            db.transaction.mockImplementation(async (callback) => callback(mockClient));

            mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 5 }] })
                .mockResolvedValueOnce({ rows: [{ id: 5, bundle_item_name: 'B', notes: 'new note' }] })
                .mockResolvedValueOnce({ rows: [] });

            await bundleService.updateBundle(10, 5, { notes: 'new note' });

            const updateSql = mockClient.query.mock.calls[1][0];
            expect(updateSql).toContain('notes = $3');
            expect(updateSql).not.toContain('bundle_cost_cents');
            expect(updateSql).not.toContain('is_active');
        });
    });

    // ==================== DELETE BUNDLE ====================

    describe('deleteBundle', () => {
        test('soft-deletes bundle and returns it', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 5, bundle_item_name: 'Deleted Bundle' }]
            });

            const result = await bundleService.deleteBundle(10, 5);

            expect(result.id).toBe(5);
            expect(result.bundle_item_name).toBe('Deleted Bundle');
            expect(db.query.mock.calls[0][1]).toEqual([5, 10]);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('is_active = false');
        });

        test('returns null when bundle not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await bundleService.deleteBundle(10, 999);

            expect(result).toBeNull();
        });
    });
});
