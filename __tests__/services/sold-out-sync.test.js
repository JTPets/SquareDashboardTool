/**
 * Tests for BACKLOG-64: sold_out flag sync and health checks
 *
 * Covers:
 *   - syncVariation stores sold_out from location_overrides
 *   - Health check: sold_out_with_stock (sold_out=true but quantity > 0)
 *   - Health check: available_but_empty (sold_out=false/null but quantity = 0, tracked)
 *   - Health check ignores items with track_inventory = false
 */

// ============================================================================
// syncVariation — sold_out stored from location_overrides
// ============================================================================

describe('syncVariation stores sold_out from location_overrides', () => {
    let db;
    let syncVariation;

    beforeEach(() => {
        jest.resetModules();

        jest.mock('../../utils/database');
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        }));
        jest.mock('../../services/square/square-client', () => ({
            getMerchantToken: jest.fn().mockResolvedValue('test-token'),
            makeSquareRequest: jest.fn(),
            sleep: jest.fn().mockResolvedValue()
        }));
        jest.mock('../../services/square/square-vendors', () => ({
            ensureVendorsExist: jest.fn().mockResolvedValue(),
            syncVariationVendors: jest.fn().mockResolvedValue(0)
        }));
        jest.mock('../../config/constants', () => ({
            SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
            SYNC: { BATCH_DELAY_MS: 0 }
        }));

        db = require('../../utils/database');
        syncVariation = require('../../services/square/square-catalog-sync').syncVariation;
    });

    const baseVariation = {
        type: 'ITEM_VARIATION',
        id: 'VAR_SOLD',
        present_at_all_locations: true,
        item_variation_data: {
            item_id: 'ITEM_SOLD',
            name: 'Regular',
            sku: 'SKU-001',
            price_money: { amount: 999, currency: 'CAD' },
            pricing_type: 'FIXED_PRICING',
            track_inventory: true,
            location_overrides: []
        }
    };

    it('stores sold_out=true when location override has sold_out=true', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                location_overrides: [
                    { location_id: 'LOC_A', inventory_alert_threshold: 3, sold_out: true },
                    { location_id: 'LOC_B', inventory_alert_threshold: 5, sold_out: false }
                ]
            }
        };

        await syncVariation(variation, 42);

        const locationCalls = db.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_location_settings')
        );
        expect(locationCalls).toHaveLength(2);

        // First call: LOC_A with sold_out=true
        const paramsA = locationCalls[0][1];
        expect(paramsA[0]).toBe('VAR_SOLD');       // variation_id
        expect(paramsA[1]).toBe('LOC_A');           // location_id
        expect(paramsA[4]).toBe(true);              // sold_out

        // Second call: LOC_B with sold_out=false
        const paramsB = locationCalls[1][1];
        expect(paramsB[1]).toBe('LOC_B');
        expect(paramsB[4]).toBe(false);             // sold_out
    });

    it('stores sold_out=false when location override has no sold_out field', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                location_overrides: [
                    { location_id: 'LOC_C', inventory_alert_threshold: 2 }
                ]
            }
        };

        await syncVariation(variation, 42);

        const locationCalls = db.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_location_settings')
        );
        expect(locationCalls).toHaveLength(1);
        expect(locationCalls[0][1][4]).toBe(false); // sold_out defaults to false
    });

    it('includes sold_out in the SQL column list', async () => {
        const variation = {
            ...baseVariation,
            item_variation_data: {
                ...baseVariation.item_variation_data,
                location_overrides: [
                    { location_id: 'LOC_D', sold_out: true }
                ]
            }
        };

        await syncVariation(variation, 42);

        const locationCall = db.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_location_settings')
        );
        expect(locationCall).toBeDefined();
        expect(locationCall[0]).toContain('sold_out');
        expect(locationCall[0]).toContain('EXCLUDED.sold_out');
    });
});

// ============================================================================
// catalog-health-service — sold_out health checks
// ============================================================================

describe('catalog health checks — sold_out sync', () => {
    let db;
    let makeSquareRequest;
    let runFullHealthCheck;

    beforeEach(() => {
        jest.resetModules();

        jest.mock('../../utils/database');
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        }));
        jest.mock('../../services/square/square-client', () => ({
            getMerchantToken: jest.fn().mockResolvedValue('test-token'),
            makeSquareRequest: jest.fn(),
        }));
        jest.mock('../../config/constants', () => ({
            SQUARE: { MAX_PAGINATION_ITERATIONS: 100 },
        }));

        db = require('../../utils/database');
        makeSquareRequest = require('../../services/square/square-client').makeSquareRequest;
        runFullHealthCheck = require('../../services/catalog/catalog-health-service').runFullHealthCheck;
    });

    function setupSquareEmpty() {
        makeSquareRequest.mockResolvedValue({ objects: [], cursor: null });
    }

    function setupDbQuery(soldOutRows, availableEmptyRows, openRows = []) {
        let callIndex = 0;
        db.query.mockImplementation((sql) => {
            // sold_out_with_stock query
            if (typeof sql === 'string' && sql.includes('vls.sold_out = true') && sql.includes('ic.quantity > 0')) {
                return Promise.resolve({ rows: soldOutRows });
            }
            // available_but_empty query
            if (typeof sql === 'string' && sql.includes('vls.sold_out = false OR vls.sold_out IS NULL') && sql.includes('v.track_inventory = true')) {
                return Promise.resolve({ rows: availableEmptyRows });
            }
            // Open issues query
            if (typeof sql === 'string' && sql.includes('status = \'mismatch\'') && sql.includes('resolved_at IS NULL')) {
                return Promise.resolve({ rows: openRows });
            }
            // INSERT/UPDATE queries
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
    }

    it('detects sold_out with stock > 0', async () => {
        setupSquareEmpty();
        setupDbQuery(
            [{ variation_id: 'VAR_1', location_id: 'LOC_1', quantity: 5, item_id: 'ITEM_1' }],
            []
        );

        const result = await runFullHealthCheck(3);

        const newSoldOut = result.newIssues.filter(i => i.check_type === 'sold_out_with_stock');
        expect(newSoldOut).toHaveLength(1);
        expect(newSoldOut[0].object_id).toBe('VAR_1');
        expect(newSoldOut[0].severity).toBe('error');
    });

    it('detects available but inventory = 0', async () => {
        setupSquareEmpty();
        setupDbQuery(
            [],
            [{ variation_id: 'VAR_2', location_id: 'LOC_2', item_id: 'ITEM_2' }]
        );

        const result = await runFullHealthCheck(3);

        const newAvailable = result.newIssues.filter(i => i.check_type === 'available_but_empty');
        expect(newAvailable).toHaveLength(1);
        expect(newAvailable[0].object_id).toBe('VAR_2');
        expect(newAvailable[0].severity).toBe('warn');
    });

    it('ignores items with track_inventory = false for available_but_empty', async () => {
        // The SQL query itself filters by track_inventory = true,
        // so if track_inventory=false rows exist in DB they won't be returned
        setupSquareEmpty();
        // Return empty for available_but_empty — simulates track_inventory=false being filtered out
        setupDbQuery([], []);

        const result = await runFullHealthCheck(3);

        const availableIssues = result.newIssues.filter(i => i.check_type === 'available_but_empty');
        expect(availableIssues).toHaveLength(0);
    });

    it('reports no issues when sold_out flags are consistent with inventory', async () => {
        setupSquareEmpty();
        setupDbQuery([], []);

        const result = await runFullHealthCheck(3);

        const soldOutIssues = result.newIssues.filter(
            i => i.check_type === 'sold_out_with_stock' || i.check_type === 'available_but_empty'
        );
        expect(soldOutIssues).toHaveLength(0);
    });

    it('sold_out_with_stock issues have error severity', async () => {
        setupSquareEmpty();
        setupDbQuery(
            [
                { variation_id: 'VAR_A', location_id: 'LOC_1', quantity: 10, item_id: 'ITEM_A' },
                { variation_id: 'VAR_B', location_id: 'LOC_2', quantity: 3, item_id: 'ITEM_B' }
            ],
            []
        );

        const result = await runFullHealthCheck(3);

        const soldOutIssues = result.newIssues.filter(i => i.check_type === 'sold_out_with_stock');
        expect(soldOutIssues).toHaveLength(2);
        soldOutIssues.forEach(issue => {
            expect(issue.severity).toBe('error');
        });
    });

    it('available_but_empty issues have warn severity', async () => {
        setupSquareEmpty();
        setupDbQuery(
            [],
            [
                { variation_id: 'VAR_C', location_id: 'LOC_1', item_id: 'ITEM_C' },
                { variation_id: 'VAR_D', location_id: 'LOC_2', item_id: 'ITEM_D' }
            ]
        );

        const result = await runFullHealthCheck(3);

        const availableIssues = result.newIssues.filter(i => i.check_type === 'available_but_empty');
        expect(availableIssues).toHaveLength(2);
        availableIssues.forEach(issue => {
            expect(issue.severity).toBe('warn');
        });
    });
});
