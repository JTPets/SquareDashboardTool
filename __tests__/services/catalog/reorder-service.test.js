/**
 * Reorder Service Unit Tests
 *
 * Tests for services/catalog/reorder-service.js — boundary conditions:
 * - No qualifying items (empty result set)
 * - Zero velocity items
 * - Missing vendor data
 * - Reorder point edge cases
 * - Priority assignment logic
 * - Bundle analysis edge cases
 * - Other vendor items error handling
 */

'use strict';

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../services/merchant', () => ({
    getMerchantSettings: jest.fn(),
}));

jest.mock('../../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../../../services/bundle-calculator', () => ({
    calculateOrderOptions: jest.fn().mockReturnValue([]),
}));

jest.mock('../../../services/catalog/reorder-math', () => ({
    calculateReorderQuantity: jest.fn(),
}));

const db = require('../../../utils/database');
const { getMerchantSettings } = require('../../../services/merchant');
const { calculateReorderQuantity } = require('../../../services/catalog/reorder-math');
const {
    getReorderSuggestions,
    buildMainQuery,
    processSuggestionRows,
    sortSuggestions
} = require('../../../services/catalog/reorder-service');

// Default merchant settings
const DEFAULT_SETTINGS = {
    default_supply_days: 45,
    reorder_safety_days: 7,
    reorder_priority_urgent_days: 0,
    reorder_priority_high_days: 7,
    reorder_priority_medium_days: 14,
    reorder_priority_low_days: 30
};

function makeRow(overrides = {}) {
    return {
        variation_id: 'var_1',
        item_name: 'Dog Food',
        variation_name: '15kg',
        sku: 'SKU001',
        images: null,
        item_images: null,
        category_name: 'Food',
        location_id: 'loc_1',
        location_name: 'Main Store',
        current_stock: '10',
        committed_quantity: '0',
        available_quantity: '10',
        daily_avg_quantity: '2.0',
        weekly_avg_quantity: '14',
        weekly_avg_91d: '14',
        weekly_avg_182d: '12',
        weekly_avg_365d: '10',
        expiration_date: null,
        does_not_expire: true,
        days_until_expiry: null,
        vendor_name: 'Acme',
        vendor_code: 'ACM',
        current_vendor_id: 'v1',
        unit_cost_cents: '2500',
        primary_vendor_id: 'v1',
        primary_vendor_name: 'Acme',
        primary_vendor_cost: '2500',
        pending_po_quantity: '0',
        case_pack_quantity: '1',
        reorder_multiple: '1',
        retail_price_cents: '5000',
        stock_alert_min: '0',
        stock_alert_max: null,
        preferred_stock_level: null,
        lead_time_days: '0',
        default_supply_days: null,
        days_until_stockout: '5.0',
        base_suggested_qty: '104',
        below_minimum: false,
        variation_age_days: '90',
        ...overrides
    };
}

// ============================================================================
// processSuggestionRows — boundary conditions
// ============================================================================

describe('processSuggestionRows', () => {
    const defaultConfig = {
        supplyDaysNum: 45,
        safetyDays: 7,
        priorityConfig: {
            urgentDays: 0,
            highDays: 7,
            mediumDays: 14,
            lowDays: 30
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        calculateReorderQuantity.mockReturnValue(10);
    });

    it('should return empty array for empty rows', () => {
        const result = processSuggestionRows([], defaultConfig);
        expect(result).toEqual([]);
    });

    it('should filter out items above stock_alert_max', () => {
        const row = makeRow({
            current_stock: '50',
            committed_quantity: '0',
            available_quantity: '50',
            stock_alert_max: '40',
            days_until_stockout: '25',
            below_minimum: true
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toEqual([]);
    });

    it('should include out-of-stock items with zero velocity as MEDIUM priority', () => {
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            daily_avg_quantity: '0',
            days_until_stockout: '0',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].priority).toBe('MEDIUM');
        expect(result[0].reorder_reason).toBe('Out of stock - no recent sales');
    });

    it('should include out-of-stock items with velocity as URGENT', () => {
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            daily_avg_quantity: '3.0',
            days_until_stockout: '0'
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].priority).toBe('URGENT');
    });

    it('should filter out items that do not need reorder', () => {
        // Item with plenty of stock, no minimum, stockout far away
        const row = makeRow({
            current_stock: '100',
            committed_quantity: '0',
            available_quantity: '100',
            daily_avg_quantity: '1.0',
            days_until_stockout: '100',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toEqual([]);
    });

    it('should include items below minimum even with high stock', () => {
        const row = makeRow({
            current_stock: '5',
            committed_quantity: '0',
            available_quantity: '5',
            daily_avg_quantity: '0.1',
            days_until_stockout: '50',
            below_minimum: true,
            stock_alert_min: '10'
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].priority).toBe('HIGH');
        expect(result[0].reorder_reason).toContain('Below stock alert threshold');
    });

    it('should filter out items where calculateReorderQuantity returns 0', () => {
        calculateReorderQuantity.mockReturnValue(0);
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            days_until_stockout: '0'
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toEqual([]);
    });

    it('should subtract pending PO and filter out fully covered items', () => {
        calculateReorderQuantity.mockReturnValue(10);
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            days_until_stockout: '0',
            pending_po_quantity: '15'  // more than needed
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toEqual([]);
    });

    it('should calculate gross margin correctly', () => {
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            daily_avg_quantity: '1.0',
            days_until_stockout: '0',
            unit_cost_cents: '3000',
            retail_price_cents: '5000'
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        // margin = ((5000 - 3000) / 5000) * 100 = 40.0
        expect(result[0].gross_margin_percent).toBe(40);
    });

    it('should return null gross margin when cost or retail is 0', () => {
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            days_until_stockout: '0',
            unit_cost_cents: '0',
            retail_price_cents: '5000'
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].gross_margin_percent).toBeNull();
    });

    it('should handle missing vendor data gracefully', () => {
        const row = makeRow({
            current_stock: '0',
            committed_quantity: '0',
            available_quantity: '0',
            days_until_stockout: '0',
            vendor_name: null,
            vendor_code: null,
            current_vendor_id: null,
            unit_cost_cents: null,
            primary_vendor_id: null,
            primary_vendor_name: null,
            primary_vendor_cost: null,
            lead_time_days: null,
            default_supply_days: null
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].vendor_code).toBe('N/A');
        expect(result[0].unit_cost_cents).toBe(0);
        expect(result[0].lead_time_days).toBe(0);
        expect(result[0].vendor_default_supply_days).toBeNull();
    });

    it('should use lead_time_days in reorder threshold calculation', () => {
        // Item with 20 days of stock, lead time 5 days
        // threshold = 45 + 5 + 7 = 57 => 20 < 57 => needs reorder
        const row = makeRow({
            current_stock: '20',
            committed_quantity: '0',
            available_quantity: '20',
            daily_avg_quantity: '1.0',
            days_until_stockout: '20',
            lead_time_days: '5',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        // Verify lead time was passed to calculateReorderQuantity
        expect(calculateReorderQuantity).toHaveBeenCalledWith(
            expect.objectContaining({ leadTimeDays: 5 })
        );
    });

    it('should use committed quantity to calculate available', () => {
        // on_hand=20, committed=15, available=5
        const row = makeRow({
            current_stock: '20',
            committed_quantity: '15',
            available_quantity: '5',
            daily_avg_quantity: '1.0',
            days_until_stockout: '5.0',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].current_stock).toBe(20);
        expect(result[0].committed_quantity).toBe(15);
        expect(result[0].available_quantity).toBe(5);
    });

    it('should assign LOW priority for days_until_stockout between mediumDays and lowDays', () => {
        // days_until_stockout = 20, which is < lowDays(30) but >= mediumDays(14)
        const row = makeRow({
            current_stock: '20',
            committed_quantity: '0',
            available_quantity: '20',
            daily_avg_quantity: '1.0',
            days_until_stockout: '20',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].priority).toBe('LOW');
    });

    it('should assign MEDIUM priority for days_until_stockout between highDays and mediumDays', () => {
        // days_until_stockout = 10, which is < mediumDays(14) but >= highDays(7)
        const row = makeRow({
            current_stock: '10',
            committed_quantity: '0',
            available_quantity: '10',
            daily_avg_quantity: '1.0',
            days_until_stockout: '10',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].priority).toBe('MEDIUM');
    });

    it('should assign HIGH priority for days_until_stockout < highDays', () => {
        // days_until_stockout = 5, which is < highDays(7)
        const row = makeRow({
            current_stock: '5',
            committed_quantity: '0',
            available_quantity: '5',
            daily_avg_quantity: '1.0',
            days_until_stockout: '5',
            below_minimum: false
        });
        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].priority).toBe('HIGH');
    });
});

// ============================================================================
// sortSuggestions
// ============================================================================

describe('sortSuggestions', () => {
    it('should sort by priority descending', () => {
        const items = [
            { priority: 'LOW', days_until_stockout: 20, daily_avg_quantity: 1 },
            { priority: 'URGENT', days_until_stockout: 0, daily_avg_quantity: 3 },
            { priority: 'HIGH', days_until_stockout: 5, daily_avg_quantity: 2 },
        ];
        sortSuggestions(items);
        expect(items.map(i => i.priority)).toEqual(['URGENT', 'HIGH', 'LOW']);
    });

    it('should sort by days_until_stockout within same priority', () => {
        const items = [
            { priority: 'HIGH', days_until_stockout: 10, daily_avg_quantity: 1 },
            { priority: 'HIGH', days_until_stockout: 3, daily_avg_quantity: 1 },
            { priority: 'HIGH', days_until_stockout: 7, daily_avg_quantity: 1 },
        ];
        sortSuggestions(items);
        expect(items.map(i => i.days_until_stockout)).toEqual([3, 7, 10]);
    });

    it('should sort by velocity descending as tiebreaker', () => {
        const items = [
            { priority: 'HIGH', days_until_stockout: 5, daily_avg_quantity: 1 },
            { priority: 'HIGH', days_until_stockout: 5, daily_avg_quantity: 5 },
            { priority: 'HIGH', days_until_stockout: 5, daily_avg_quantity: 3 },
        ];
        sortSuggestions(items);
        expect(items.map(i => i.daily_avg_quantity)).toEqual([5, 3, 1]);
    });
});

// ============================================================================
// buildMainQuery
// ============================================================================

describe('buildMainQuery', () => {
    it('should include merchant_id as $2', () => {
        const { rows, params } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 42, vendor_id: null, location_id: null
        });
        expect(rows).toContain('v.merchant_id = $2');
        expect(params[1]).toBe(42);
    });

    it('should set $1 to supply_days + safety_days', () => {
        const { params } = buildMainQuery({
            supplyDaysNum: 30, safetyDays: 10, merchantId: 1, vendor_id: null, location_id: null
        });
        expect(params[0]).toBe(40); // 30 + 10
    });

    it('should add vendor_id filter when provided', () => {
        const { rows, params } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: 'v1', location_id: null
        });
        expect(rows).toContain('vv.vendor_id = $3');
        expect(params[2]).toBe('v1');
    });

    it('should add IS NULL filter for vendor_id=none', () => {
        const { rows } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: 'none', location_id: null
        });
        expect(rows).toContain('vv.vendor_id IS NULL');
    });

    it('should add location_id filter when provided', () => {
        const { rows, params } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: null, location_id: 'loc_1'
        });
        expect(rows).toContain('ic.location_id = $3');
        expect(params[2]).toBe('loc_1');
    });
});

// ============================================================================
// getReorderSuggestions — integration-level (with mocked DB)
// ============================================================================

describe('getReorderSuggestions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getMerchantSettings.mockResolvedValue(DEFAULT_SETTINGS);
        calculateReorderQuantity.mockReturnValue(10);
    });

    function mockQueries(mainRows = []) {
        db.query.mockResolvedValueOnce({ rows: mainRows }); // main query
        db.query.mockResolvedValueOnce({ rows: [] }); // bundle query
    }

    it('should return empty suggestions for no qualifying items', async () => {
        mockQueries([]);
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: {}
        });
        expect(result.count).toBe(0);
        expect(result.suggestions).toEqual([]);
        expect(result.bundle_analysis).toEqual([]);
    });

    it('should return validation error for invalid supply_days', async () => {
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: { supply_days: '0' }
        });
        expect(result.error).toBe('Invalid supply_days parameter');
    });

    it('should return validation error for negative min_cost', async () => {
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: { min_cost: '-5' }
        });
        expect(result.error).toBe('Invalid min_cost parameter');
    });

    it('should use merchant default_supply_days when not in query', async () => {
        mockQueries([]);
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: {}
        });
        expect(result.supply_days).toBe(45);
    });

    it('should use query supply_days over merchant default', async () => {
        mockQueries([]);
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: { supply_days: '30' }
        });
        expect(result.supply_days).toBe(30);
    });

    it('should handle bundle query error gracefully', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // main query
        db.query.mockRejectedValueOnce(new Error('bundle table missing')); // bundle query

        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: {}
        });
        expect(result.bundle_analysis).toEqual([]);
    });

    it('should not include other_vendor_items by default', async () => {
        mockQueries([]);
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: {}
        });
        expect(result.other_vendor_items).toBeUndefined();
    });

    it('should include other_vendor_items when requested with vendor_id', async () => {
        mockQueries([]);
        // other vendor items query
        db.query.mockResolvedValueOnce({
            rows: [{
                variation_id: 'v99', item_name: 'Extra', variation_name: 'V',
                sku: 'EX1', current_stock: '10', committed_quantity: '0',
                available_quantity: '10', stock_alert_min: '0', stock_alert_max: null,
                weekly_avg_91d: '5', days_until_stockout: '50',
                unit_cost_cents: '100', retail_price_cents: '200',
                gross_margin_percent: '50.0', case_pack_quantity: '1',
                vendor_code: 'VC', vendor_name: 'V'
            }]
        });

        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test',
            query: { vendor_id: 'v1', include_other: 'true' }
        });
        expect(result.other_vendor_items).toHaveLength(1);
    });

    it('should not fetch other_vendor_items when vendor_id=none', async () => {
        mockQueries([]);
        const result = await getReorderSuggestions({
            merchantId: 1, businessName: 'Test',
            query: { vendor_id: 'none', include_other: 'true' }
        });
        expect(result.other_vendor_items).toBeUndefined();
    });
});

// ============================================================================
// Cheaper-elsewhere false positive fix
// ============================================================================

describe('is_primary_vendor — equal price vendors', () => {
    const defaultConfig = {
        supplyDaysNum: 45,
        safetyDays: 7,
        priorityConfig: {
            urgentDays: 0,
            highDays: 7,
            mediumDays: 14,
            lowDays: 30
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        calculateReorderQuantity.mockReturnValue(10);
    });

    it('should not flag as secondary vendor when prices are equal', () => {
        // Two vendors with same price — current vendor is not the "primary" by ID
        // but has equal cost, so should NOT trigger cheaper-elsewhere highlight
        const row = makeRow({
            current_vendor_id: 'v2',
            unit_cost_cents: '2307',
            primary_vendor_id: 'v1',
            primary_vendor_name: 'Other Supplier',
            primary_vendor_cost: '2307',
            current_stock: '2',
            available_quantity: '2',
            daily_avg_quantity: '1.0',
            days_until_stockout: '2',
            below_minimum: true,
            stock_alert_min: '5'
        });

        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].is_primary_vendor).toBe(true);
    });

    it('should flag as secondary vendor when another vendor is truly cheaper', () => {
        const row = makeRow({
            current_vendor_id: 'v2',
            unit_cost_cents: '3000',
            primary_vendor_id: 'v1',
            primary_vendor_name: 'Cheaper Supplier',
            primary_vendor_cost: '2307',
            current_stock: '2',
            available_quantity: '2',
            daily_avg_quantity: '1.0',
            days_until_stockout: '2',
            below_minimum: true,
            stock_alert_min: '5'
        });

        const result = processSuggestionRows([row], defaultConfig);
        expect(result).toHaveLength(1);
        expect(result[0].is_primary_vendor).toBe(false);
    });
});

// ============================================================================
// PERF-6: Query optimization tests
// ============================================================================

describe('buildMainQuery — PERF-6 LATERAL JOIN optimization', () => {
    it('should use LATERAL JOIN for sales velocity instead of 3 separate JOINs', () => {
        const { rows } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: null, location_id: null
        });
        // Should contain the LATERAL subquery for sales velocity
        expect(rows).toContain('LEFT JOIN LATERAL');
        expect(rows).toContain('period_days IN (91, 182, 365)');
        // Should NOT contain separate sv91/sv182/sv365 aliases
        expect(rows).not.toContain('sv91.');
        expect(rows).not.toContain('sv182.');
        expect(rows).not.toContain('sv365.');
    });

    it('should use LATERAL JOIN for primary vendor instead of 3 correlated subqueries', () => {
        const { rows } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: null, location_id: null
        });
        // Should contain the primary vendor LATERAL
        expect(rows).toContain('pv.vendor_id as primary_vendor_id');
        expect(rows).toContain('pv.vendor_name as primary_vendor_name');
        expect(rows).toContain('pv.unit_cost_money as primary_vendor_cost');
        // Should NOT contain the old correlated subquery pattern (vv2, vv3, vv4)
        expect(rows).not.toMatch(/\(SELECT vv2\.vendor_id/);
        expect(rows).not.toMatch(/\(SELECT ve2\.name/);
        expect(rows).not.toMatch(/\(SELECT vv4\.unit_cost_money/);
    });

    it('should still include the pending PO correlated subquery', () => {
        const { rows } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: null, location_id: null
        });
        expect(rows).toContain('purchase_order_items poi');
        expect(rows).toContain('pending_po_quantity');
    });

    it('should reference sv alias for velocity in WHERE clause', () => {
        const { rows } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: null, location_id: null
        });
        expect(rows).toContain('sv.daily_avg_quantity > 0');
    });

    it('should select weekly_avg columns from sv LATERAL', () => {
        const { rows } = buildMainQuery({
            supplyDaysNum: 45, safetyDays: 7, merchantId: 1, vendor_id: null, location_id: null
        });
        expect(rows).toContain('sv.weekly_avg_91d');
        expect(rows).toContain('sv.weekly_avg_182d');
        expect(rows).toContain('sv.weekly_avg_365d');
    });
});

describe('getReorderSuggestions — query duration logging', () => {
    const logger = require('../../../utils/logger');

    beforeEach(() => {
        jest.clearAllMocks();
        getMerchantSettings.mockResolvedValue(DEFAULT_SETTINGS);
        calculateReorderQuantity.mockReturnValue(10);
    });

    it('should log queryDurationMs in reorder query results', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // main query
        db.query.mockResolvedValueOnce({ rows: [] }); // bundle query

        await getReorderSuggestions({
            merchantId: 1, businessName: 'Test', query: {}
        });

        const logCall = logger.info.mock.calls.find(
            call => call[0] === 'Reorder query results'
        );
        expect(logCall).toBeDefined();
        expect(logCall[1]).toHaveProperty('queryDurationMs');
        expect(typeof logCall[1].queryDurationMs).toBe('number');
        expect(logCall[1].queryDurationMs).toBeGreaterThanOrEqual(0);
    });
});
