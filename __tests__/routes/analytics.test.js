/**
 * Analytics Routes Test Suite
 *
 * Tests for:
 * - GET /api/sales-velocity (sales velocity data)
 * - GET /api/reorder-suggestions (reorder suggestion engine)
 *
 * NOTE: reorder-suggestions handler is ~780 lines — flagged in TECHNICAL_DEBT.md
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
    requireWriteAccess: (req, res, next) => next(),
}));

jest.mock('../../services/inventory/auto-min-max-service', () => ({
    generateRecommendations: jest.fn(),
    applyAllRecommendations: jest.fn(),
    getHistory: jest.fn(),
    pinVariation: jest.fn(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(400).json({ error: 'Merchant context required' });
        }
        next();
    },
}));

jest.mock('../../services/merchant', () => ({
    getMerchantSettings: jest.fn(),
}));

jest.mock('../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../../services/bundle-calculator', () => ({
    calculateOrderOptions: jest.fn().mockReturnValue([]),
}));

jest.mock('../../services/catalog/reorder-math', () => ({
    calculateReorderQuantity: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const autoMinMax = require('../../services/inventory/auto-min-max-service');
const { getMerchantSettings } = require('../../services/merchant');
const { calculateReorderQuantity } = require('../../services/catalog/reorder-math');

// ============================================================================
// TEST APP SETUP
// ============================================================================

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) {
            req.session.user = { id: 1, email: 'test@test.com', role: 'admin' };
        }
        if (hasMerchant) {
            req.merchantContext = { id: 1, businessName: 'Test Store' };
        }
        next();
    });
    const analyticsRoutes = require('../../routes/analytics');
    app.use('/api', analyticsRoutes);
    // Error handler
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ============================================================================
// TESTS — GET /api/sales-velocity
// ============================================================================

describe('GET /api/sales-velocity', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('should return velocity data for merchant', async () => {
        const mockRows = [
            {
                variation_id: 'var_1',
                sku: 'SKU001',
                item_name: 'Dog Food',
                variation_name: '15kg',
                category_name: 'Food',
                location_name: 'Main Store',
                daily_avg_quantity: 2.5,
                weekly_avg_quantity: 17.5,
                period_days: 91
            }
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });

        const res = await request(app).get('/api/sales-velocity');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.sales_velocity).toHaveLength(1);
        expect(res.body.sales_velocity[0].sku).toBe('SKU001');
    });

    it('should filter by variation_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await request(app).get('/api/sales-velocity?variation_id=var_123');

        const queryCall = db.query.mock.calls[0];
        expect(queryCall[0]).toContain('sv.variation_id = $2');
        expect(queryCall[1]).toContain('var_123');
    });

    it('should filter by location_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await request(app).get('/api/sales-velocity?location_id=loc_1');

        const queryCall = db.query.mock.calls[0];
        expect(queryCall[0]).toContain('sv.location_id');
        expect(queryCall[1]).toContain('loc_1');
    });

    it('should filter by period_days', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await request(app).get('/api/sales-velocity?period_days=182');

        const queryCall = db.query.mock.calls[0];
        expect(queryCall[0]).toContain('sv.period_days = $');
        expect(queryCall[1]).toContain(182);
    });

    it('should reject invalid period_days', async () => {
        const res = await request(app).get('/api/sales-velocity?period_days=30');

        expect(res.status).toBe(400);
    });

    it('should return 401 without auth', async () => {
        app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/sales-velocity');
        expect(res.status).toBe(401);
    });

    it('should return 400 without merchant context', async () => {
        app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/sales-velocity');
        expect(res.status).toBe(400);
    });

    it('should return empty array when no data', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/sales-velocity');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
        expect(res.body.sales_velocity).toEqual([]);
    });

    it('should always filter by merchant_id in query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await request(app).get('/api/sales-velocity');

        const queryCall = db.query.mock.calls[0];
        expect(queryCall[0]).toContain('sv.merchant_id = $1');
        expect(queryCall[1][0]).toBe(1);
    });
});

// ============================================================================
// TESTS — GET /api/reorder-suggestions
// ============================================================================

describe('GET /api/reorder-suggestions', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
        getMerchantSettings.mockResolvedValue({
            default_supply_days: 45,
            reorder_safety_days: 7,
            reorder_priority_urgent_days: 0,
            reorder_priority_high_days: 7,
            reorder_priority_medium_days: 14,
            reorder_priority_low_days: 30
        });
        calculateReorderQuantity.mockReturnValue(10);
    });

    function mockReorderQuery(rows = []) {
        // Main reorder query
        db.query.mockResolvedValueOnce({ rows });
        // Bundle query
        db.query.mockResolvedValueOnce({ rows: [] });
    }

    it('should return suggestions for items needing reorder', async () => {
        const mockRow = {
            variation_id: 'var_1',
            item_name: 'Dog Food',
            variation_name: '15kg',
            sku: 'SKU001',
            images: null,
            item_images: null,
            category_name: 'Food',
            location_id: 'loc_1',
            location_name: 'Main Store',
            current_stock: '5',
            committed_quantity: '0',
            available_quantity: '5',
            daily_avg_quantity: '2.5',
            weekly_avg_quantity: '17.5',
            weekly_avg_91d: '17.5',
            weekly_avg_182d: '15.0',
            weekly_avg_365d: '12.0',
            expiration_date: null,
            does_not_expire: true,
            days_until_expiry: null,
            vendor_name: 'Acme Pet',
            vendor_code: 'APF',
            current_vendor_id: 'v1',
            unit_cost_cents: '2500',
            primary_vendor_id: 'v1',
            primary_vendor_name: 'Acme Pet',
            primary_vendor_cost: '2500',
            pending_po_quantity: '0',
            case_pack_quantity: '6',
            reorder_multiple: '1',
            retail_price_cents: '4999',
            stock_alert_min: '10',
            stock_alert_max: null,
            preferred_stock_level: null,
            lead_time_days: '3',
            default_supply_days: null,
            days_until_stockout: '2.0',
            base_suggested_qty: '130',
            below_minimum: true,
            variation_age_days: '120'
        };
        mockReorderQuery([mockRow]);

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.supply_days).toBe(45);
        expect(res.body.safety_days).toBe(7);
        expect(res.body.suggestions).toHaveLength(1);
        expect(res.body.suggestions[0].sku).toBe('SKU001');
        expect(res.body.suggestions[0].vendor_name).toBe('Acme Pet');
        expect(res.body.bundle_analysis).toEqual([]);
    });

    it('should use merchant settings for supply_days and safety_days', async () => {
        mockReorderQuery([]);

        await request(app).get('/api/reorder-suggestions');

        // Verify getMerchantSettings was called with merchant id
        expect(getMerchantSettings).toHaveBeenCalledWith(1);
    });

    it('should allow override of supply_days via query param', async () => {
        mockReorderQuery([]);

        const res = await request(app).get('/api/reorder-suggestions?supply_days=30');

        expect(res.status).toBe(200);
        expect(res.body.supply_days).toBe(30);
    });

    it('should reject supply_days outside 1-365', async () => {
        const res = await request(app).get('/api/reorder-suggestions?supply_days=0');
        expect(res.status).toBe(400);
    });

    it('should reject negative min_cost', async () => {
        const res = await request(app).get('/api/reorder-suggestions?min_cost=-5');
        expect(res.status).toBe(400);
    });

    it('should filter by vendor_id', async () => {
        mockReorderQuery([]);

        await request(app).get('/api/reorder-suggestions?vendor_id=v1');

        const mainQuery = db.query.mock.calls[0];
        expect(mainQuery[0]).toContain('vv.vendor_id = $');
        expect(mainQuery[1]).toContain('v1');
    });

    it('should filter for no-vendor items when vendor_id=none', async () => {
        mockReorderQuery([]);

        await request(app).get('/api/reorder-suggestions?vendor_id=none');

        const mainQuery = db.query.mock.calls[0];
        expect(mainQuery[0]).toContain('vv.vendor_id IS NULL');
    });

    it('should filter by location_id', async () => {
        mockReorderQuery([]);

        await request(app).get('/api/reorder-suggestions?location_id=loc_1');

        const mainQuery = db.query.mock.calls[0];
        expect(mainQuery[0]).toContain('ic.location_id = $');
        expect(mainQuery[1]).toContain('loc_1');
    });

    it('should filter suggestions by min_cost', async () => {
        const rows = [
            {
                variation_id: 'var_1', item_name: 'Cheap', variation_name: 'Small',
                sku: 'SKU001', images: null, item_images: null, category_name: 'Food',
                location_id: 'loc_1', location_name: 'Main',
                current_stock: '0', committed_quantity: '0', available_quantity: '0',
                daily_avg_quantity: '1.0', weekly_avg_quantity: '7',
                weekly_avg_91d: '7', weekly_avg_182d: '7', weekly_avg_365d: '7',
                expiration_date: null, does_not_expire: true, days_until_expiry: null,
                vendor_name: 'V', vendor_code: 'VC', current_vendor_id: 'v1',
                unit_cost_cents: '100', primary_vendor_id: 'v1',
                primary_vendor_name: 'V', primary_vendor_cost: '100',
                pending_po_quantity: '0', case_pack_quantity: '1', reorder_multiple: '1',
                retail_price_cents: '200', stock_alert_min: '0', stock_alert_max: null,
                preferred_stock_level: null, lead_time_days: '0', default_supply_days: null,
                days_until_stockout: '0', base_suggested_qty: '45',
                below_minimum: false, variation_age_days: '90'
            }
        ];
        mockReorderQuery(rows);
        calculateReorderQuantity.mockReturnValue(5);

        const res = await request(app).get('/api/reorder-suggestions?min_cost=100');

        expect(res.status).toBe(200);
        // order_cost = 5 * 100 / 100 = 5.00 which is < 100, so filtered out
        expect(res.body.count).toBe(0);
    });

    it('should return 401 without auth', async () => {
        app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/reorder-suggestions');
        expect(res.status).toBe(401);
    });

    it('should return 400 without merchant context', async () => {
        app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/reorder-suggestions');
        expect(res.status).toBe(400);
    });

    it('should exclude items where finalQty is 0', async () => {
        const row = {
            variation_id: 'var_1', item_name: 'Full', variation_name: 'Large',
            sku: 'SKU002', images: null, item_images: null, category_name: 'Food',
            location_id: 'loc_1', location_name: 'Main',
            current_stock: '0', committed_quantity: '0', available_quantity: '0',
            daily_avg_quantity: '1.0', weekly_avg_quantity: '7',
            weekly_avg_91d: '7', weekly_avg_182d: '7', weekly_avg_365d: '7',
            expiration_date: null, does_not_expire: true, days_until_expiry: null,
            vendor_name: 'V', vendor_code: 'VC', current_vendor_id: 'v1',
            unit_cost_cents: '1000', primary_vendor_id: 'v1',
            primary_vendor_name: 'V', primary_vendor_cost: '1000',
            pending_po_quantity: '0', case_pack_quantity: '1', reorder_multiple: '1',
            retail_price_cents: '2000', stock_alert_min: '0', stock_alert_max: null,
            preferred_stock_level: null, lead_time_days: '0', default_supply_days: null,
            days_until_stockout: '0', base_suggested_qty: '45',
            below_minimum: false, variation_age_days: '90'
        };
        mockReorderQuery([row]);
        calculateReorderQuantity.mockReturnValue(0); // Nothing to order

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
    });

    it('should subtract pending PO quantity from suggestion', async () => {
        const row = {
            variation_id: 'var_1', item_name: 'Item', variation_name: 'Var',
            sku: 'SKU003', images: null, item_images: null, category_name: 'Food',
            location_id: 'loc_1', location_name: 'Main',
            current_stock: '5', committed_quantity: '0', available_quantity: '5',
            daily_avg_quantity: '2.0', weekly_avg_quantity: '14',
            weekly_avg_91d: '14', weekly_avg_182d: '14', weekly_avg_365d: '14',
            expiration_date: null, does_not_expire: true, days_until_expiry: null,
            vendor_name: 'V', vendor_code: 'VC', current_vendor_id: 'v1',
            unit_cost_cents: '500', primary_vendor_id: 'v1',
            primary_vendor_name: 'V', primary_vendor_cost: '500',
            pending_po_quantity: '10', case_pack_quantity: '1', reorder_multiple: '1',
            retail_price_cents: '1000', stock_alert_min: '10', stock_alert_max: null,
            preferred_stock_level: null, lead_time_days: '0', default_supply_days: null,
            days_until_stockout: '2.5', base_suggested_qty: '90',
            below_minimum: true, variation_age_days: '60'
        };
        mockReorderQuery([row]);
        calculateReorderQuantity.mockReturnValue(20); // 20 needed

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body.suggestions[0].pending_po_quantity).toBe(10);
        expect(res.body.suggestions[0].final_suggested_qty).toBe(10); // 20 - 10 pending
    });

    it('should skip items fully covered by pending POs', async () => {
        const row = {
            variation_id: 'var_1', item_name: 'Item', variation_name: 'Var',
            sku: 'SKU003', images: null, item_images: null, category_name: 'Food',
            location_id: 'loc_1', location_name: 'Main',
            current_stock: '5', committed_quantity: '0', available_quantity: '5',
            daily_avg_quantity: '2.0', weekly_avg_quantity: '14',
            weekly_avg_91d: '14', weekly_avg_182d: '14', weekly_avg_365d: '14',
            expiration_date: null, does_not_expire: true, days_until_expiry: null,
            vendor_name: 'V', vendor_code: 'VC', current_vendor_id: 'v1',
            unit_cost_cents: '500', primary_vendor_id: 'v1',
            primary_vendor_name: 'V', primary_vendor_cost: '500',
            pending_po_quantity: '30', case_pack_quantity: '1', reorder_multiple: '1',
            retail_price_cents: '1000', stock_alert_min: '10', stock_alert_max: null,
            preferred_stock_level: null, lead_time_days: '0', default_supply_days: null,
            days_until_stockout: '2.5', base_suggested_qty: '90',
            below_minimum: true, variation_age_days: '60'
        };
        mockReorderQuery([row]);
        calculateReorderQuantity.mockReturnValue(20); // 20 needed but 30 pending

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0); // Filtered out — pending covers need
    });

    it('should sort by priority then days_until_stockout', async () => {
        const makeRow = (id, dailyAvg, daysStockout, belowMin) => ({
            variation_id: id, item_name: `Item ${id}`, variation_name: 'Var',
            sku: `SKU_${id}`, images: null, item_images: null, category_name: 'Food',
            location_id: 'loc_1', location_name: 'Main',
            current_stock: daysStockout === 0 ? '0' : '10',
            committed_quantity: '0',
            available_quantity: daysStockout === 0 ? '0' : '10',
            daily_avg_quantity: String(dailyAvg),
            weekly_avg_quantity: String(dailyAvg * 7),
            weekly_avg_91d: String(dailyAvg * 7),
            weekly_avg_182d: '0', weekly_avg_365d: '0',
            expiration_date: null, does_not_expire: true, days_until_expiry: null,
            vendor_name: 'V', vendor_code: 'VC', current_vendor_id: 'v1',
            unit_cost_cents: '1000', primary_vendor_id: 'v1',
            primary_vendor_name: 'V', primary_vendor_cost: '1000',
            pending_po_quantity: '0', case_pack_quantity: '1', reorder_multiple: '1',
            retail_price_cents: '2000', stock_alert_min: belowMin ? '20' : '0',
            stock_alert_max: null, preferred_stock_level: null,
            lead_time_days: '0', default_supply_days: null,
            days_until_stockout: String(daysStockout),
            base_suggested_qty: '45',
            below_minimum: belowMin, variation_age_days: '90'
        });

        mockReorderQuery([
            makeRow('low', 0.5, 20, false),       // LOW priority
            makeRow('urgent', 3, 0, false),        // URGENT (out of stock with sales)
            makeRow('high', 2, 5, true),           // HIGH (below minimum)
        ]);
        calculateReorderQuantity.mockReturnValue(10);

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        const priorities = res.body.suggestions.map(s => s.priority);
        expect(priorities[0]).toBe('URGENT');
        expect(priorities[1]).toBe('HIGH');
        expect(priorities[2]).toBe('LOW');
    });

    it('should include bundle_analysis in response', async () => {
        mockReorderQuery([]);

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('bundle_analysis');
        expect(res.body).toHaveProperty('bundle_affiliations');
    });

    it('should not fail when bundle query errors', async () => {
        // Main query succeeds
        db.query.mockResolvedValueOnce({ rows: [] });
        // Bundle query fails
        db.query.mockRejectedValueOnce(new Error('bundle table missing'));

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body.bundle_analysis).toEqual([]);
    });

    it('should include other_vendor_items when include_other=true', async () => {
        mockReorderQuery([]);
        // Other vendor items query
        db.query.mockResolvedValueOnce({
            rows: [{
                variation_id: 'var_99', item_name: 'Extra', variation_name: 'V',
                sku: 'SKU_EX', current_stock: '50', committed_quantity: '0',
                available_quantity: '50', stock_alert_min: '5', stock_alert_max: null,
                weekly_avg_91d: '10', days_until_stockout: '35',
                unit_cost_cents: '500', retail_price_cents: '1000',
                gross_margin_percent: '50.0', case_pack_quantity: '1',
                vendor_code: 'VC', vendor_name: 'Vendor'
            }]
        });

        const res = await request(app)
            .get('/api/reorder-suggestions?vendor_id=v1&include_other=true');

        expect(res.status).toBe(200);
        expect(res.body.other_vendor_items).toHaveLength(1);
        expect(res.body.other_vendor_items[0].sku).toBe('SKU_EX');
    });

    it('should not include other_vendor_items when include_other not set', async () => {
        mockReorderQuery([]);

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        expect(res.body.other_vendor_items).toBeUndefined();
    });

    it('should always include merchant_id in main query', async () => {
        mockReorderQuery([]);

        await request(app).get('/api/reorder-suggestions');

        const mainQuery = db.query.mock.calls[0];
        expect(mainQuery[0]).toContain('v.merchant_id = $2');
        expect(mainQuery[1]).toContain(1); // merchantId
    });

    it('should calculate gross margin correctly', async () => {
        const row = {
            variation_id: 'var_1', item_name: 'Item', variation_name: 'Var',
            sku: 'SKU_GM', images: null, item_images: null, category_name: 'Food',
            location_id: 'loc_1', location_name: 'Main',
            current_stock: '0', committed_quantity: '0', available_quantity: '0',
            daily_avg_quantity: '1.0', weekly_avg_quantity: '7',
            weekly_avg_91d: '7', weekly_avg_182d: '7', weekly_avg_365d: '7',
            expiration_date: null, does_not_expire: true, days_until_expiry: null,
            vendor_name: 'V', vendor_code: 'VC', current_vendor_id: 'v1',
            unit_cost_cents: '3000', primary_vendor_id: 'v1',
            primary_vendor_name: 'V', primary_vendor_cost: '3000',
            pending_po_quantity: '0', case_pack_quantity: '1', reorder_multiple: '1',
            retail_price_cents: '5000', stock_alert_min: '0', stock_alert_max: null,
            preferred_stock_level: null, lead_time_days: '0', default_supply_days: null,
            days_until_stockout: '0', base_suggested_qty: '45',
            below_minimum: false, variation_age_days: '90'
        };
        mockReorderQuery([row]);
        calculateReorderQuantity.mockReturnValue(10);

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(200);
        // margin = ((5000 - 3000) / 5000) * 100 = 40%
        expect(res.body.suggestions[0].gross_margin_percent).toBe(40);
    });

    it('should handle DB error gracefully', async () => {
        db.query.mockRejectedValueOnce(new Error('connection refused'));

        const res = await request(app).get('/api/reorder-suggestions');

        expect(res.status).toBe(500);
    });
});

// ============================================================================
// TESTS — GET /api/min-max/recommendations
// ============================================================================

describe('GET /api/min-max/recommendations', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('returns recommendations from service', async () => {
        autoMinMax.generateRecommendations.mockResolvedValueOnce([
            { variationId: 'var1', locationId: 'loc1', recommendedMin: 1, rule: 'OVERSTOCKED' }
        ]);

        const res = await request(app).get('/api/min-max/recommendations');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.recommendations).toHaveLength(1);
        expect(autoMinMax.generateRecommendations).toHaveBeenCalledWith(1);
    });

    it('returns empty array when no recommendations', async () => {
        autoMinMax.generateRecommendations.mockResolvedValueOnce([]);

        const res = await request(app).get('/api/min-max/recommendations');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
    });

    it('returns 401 without auth', async () => {
        app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/min-max/recommendations');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/min-max/recommendations');
        expect(res.status).toBe(400);
    });
});

// ============================================================================
// TESTS — POST /api/min-max/apply
// ============================================================================

describe('POST /api/min-max/apply', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('applies valid recommendations', async () => {
        autoMinMax.applyAllRecommendations.mockResolvedValueOnce({ applied: 2, failed: 0, errors: [] });

        const res = await request(app)
            .post('/api/min-max/apply')
            .send({ recommendations: [
                { variationId: 'var1', locationId: 'loc1', newMin: 1 },
                { variationId: 'var2', locationId: 'loc1', newMin: 0 },
            ]});

        expect(res.status).toBe(200);
        expect(res.body.applied).toBe(2);
        expect(autoMinMax.applyAllRecommendations).toHaveBeenCalledWith(1, expect.any(Array));
    });

    it('returns 400 when recommendations array is empty', async () => {
        const res = await request(app)
            .post('/api/min-max/apply')
            .send({ recommendations: [] });

        expect(res.status).toBe(400);
    });

    it('returns 400 when recommendations is missing', async () => {
        const res = await request(app)
            .post('/api/min-max/apply')
            .send({});

        expect(res.status).toBe(400);
    });

    it('returns 400 when newMin is negative', async () => {
        const res = await request(app)
            .post('/api/min-max/apply')
            .send({ recommendations: [{ variationId: 'var1', locationId: 'loc1', newMin: -1 }] });

        expect(res.status).toBe(400);
    });

    it('filters out null-newMin entries and returns 400 if none left', async () => {
        // null newMin entries are supplier-issue warnings — cannot be applied
        const res = await request(app)
            .post('/api/min-max/apply')
            .send({ recommendations: [{ variationId: 'var1', locationId: 'loc1', newMin: null }] });

        expect(res.status).toBe(400);
    });

    it('returns 401 without auth', async () => {
        app = createTestApp({ authenticated: false });
        const res = await request(app).post('/api/min-max/apply').send({ recommendations: [] });
        expect(res.status).toBe(401);
    });
});

// ============================================================================
// TESTS — GET /api/min-max/history
// ============================================================================

describe('GET /api/min-max/history', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('returns paginated audit history', async () => {
        autoMinMax.getHistory.mockResolvedValueOnce({
            items: [{ id: 1, variation_id: 'var1', location_id: 'loc1',
                      previous_min: 2, new_min: 1, rule: 'OVERSTOCKED' }],
            total: 1,
            limit: 50,
            offset: 0,
        });

        const res = await request(app).get('/api/min-max/history');

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.total).toBe(1);
        expect(res.body.limit).toBe(50);
        expect(res.body.offset).toBe(0);
    });

    it('accepts custom limit and offset', async () => {
        autoMinMax.getHistory.mockResolvedValueOnce({
            items: [],
            total: 0,
            limit: 10,
            offset: 20,
        });

        const res = await request(app).get('/api/min-max/history?limit=10&offset=20');

        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(10);
        expect(res.body.offset).toBe(20);
    });

    it('rejects limit > 200', async () => {
        const res = await request(app).get('/api/min-max/history?limit=201');
        expect(res.status).toBe(400);
    });

    it('rejects negative offset', async () => {
        const res = await request(app).get('/api/min-max/history?offset=-1');
        expect(res.status).toBe(400);
    });

    it('returns 401 without auth', async () => {
        app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/min-max/history');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/min-max/history');
        expect(res.status).toBe(400);
    });
});
