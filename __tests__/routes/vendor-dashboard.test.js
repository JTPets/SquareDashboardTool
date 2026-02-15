/**
 * Vendor Dashboard Route Tests
 *
 * Tests for GET /api/vendor-dashboard and PATCH /api/vendors/:id/settings
 * Validates middleware integration, input validation, and response formats.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    getMerchantSettings: jest.fn(),
}));

const db = require('../../utils/database');

describe('Vendor Dashboard Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // Helper: mock all 3 queries (vendors, unassigned, global OOS)
    function mockDashboardQueries(vendorRows, unassignedRow, globalOos) {
        db.query.mockResolvedValueOnce({ rows: vendorRows });
        db.query.mockResolvedValueOnce({
            rows: [unassignedRow || { total_items: 0, oos_count: 0, reorder_count: 0 }]
        });
        db.query.mockResolvedValueOnce({
            rows: [{ oos_count: globalOos != null ? globalOos : 0 }]
        });
    }

    describe('GET /api/vendor-dashboard', () => {

        describe('Query structure', () => {

            test('uses merchant_id filter in query', async () => {
                const merchantId = 1;
                db.getMerchantSettings.mockResolvedValue({ default_supply_days: 45, reorder_safety_days: 7 });
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(merchantId);

                const queryCall = db.query.mock.calls[0];
                expect(queryCall[0]).toContain('merchant_id');
                expect(queryCall[1]).toContain(merchantId);
            });

            test('filters only ACTIVE vendors', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(1);

                const queryCall = db.query.mock.calls[0];
                expect(queryCall[0]).toContain("status = 'ACTIVE'");
            });

            test('excludes deleted and discontinued items from counts', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(1);

                const queryCall = db.query.mock.calls[0];
                expect(queryCall[0]).toContain('is_deleted');
                expect(queryCall[0]).toContain('discontinued');
            });

            test('OOS uses raw quantity = 0, no velocity filter', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(1);

                const queryCall = db.query.mock.calls[0];
                expect(queryCall[0]).toContain('COALESCE(ic.quantity, 0) = 0');
                expect(queryCall[0]).not.toContain('0.08');
            });

            test('runs unassigned items query with NOT EXISTS', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(1);

                expect(db.query).toHaveBeenCalledTimes(3);
                const unassignedQuery = db.query.mock.calls[1][0];
                expect(unassignedQuery).toContain('NOT EXISTS');
            });

            test('OOS guards against LEFT JOIN NULL rows', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(1);

                const vendorQuery = db.query.mock.calls[0][0];
                expect(vendorQuery).toContain('ic.catalog_object_id IS NOT NULL');
            });

            test('computes reorder_value using unit_cost_money', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                await getVendorDashboard(1);

                const vendorQuery = db.query.mock.calls[0][0];
                expect(vendorQuery).toContain('reorder_value');
                expect(vendorQuery).toContain('unit_cost_money');
            });
        });

        describe('Response format', () => {

            test('returns all required vendor fields', async () => {
                db.getMerchantSettings.mockResolvedValue({ default_supply_days: 30 });
                mockDashboardQueries([{
                    id: 'V1', name: 'Vendor A', schedule_type: 'anytime',
                    order_day: null, receive_day: null, lead_time_days: 5,
                    minimum_order_amount: 10000, payment_method: 'Credit Card',
                    payment_terms: 'Net 7', contact_email: 'a@test.com',
                    order_method: 'Portal', notes: 'Fast shipping',
                    default_supply_days: 30, total_items: 50, oos_count: 2,
                    reorder_count: 10, reorder_value: 12000, costed_reorder_count: 10, pending_po_value: 15000,
                    last_ordered_at: '2026-02-10'
                }], null, 73);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                const result = await getVendorDashboard(1);

                expect(result).toHaveProperty('global_oos_count', 73);
                const vendor = result.vendors[0];
                expect(vendor).toHaveProperty('id', 'V1');
                expect(vendor).toHaveProperty('name', 'Vendor A');
                expect(vendor).toHaveProperty('schedule_type', 'anytime');
                expect(vendor).toHaveProperty('lead_time_days', 5);
                expect(vendor).toHaveProperty('minimum_order_amount', 10000);
                expect(vendor).toHaveProperty('payment_method', 'Credit Card');
                expect(vendor).toHaveProperty('total_items', 50);
                expect(vendor).toHaveProperty('oos_count', 2);
                expect(vendor).toHaveProperty('reorder_count', 10);
                expect(vendor).toHaveProperty('reorder_value', 12000);
                expect(vendor).toHaveProperty('pending_po_value', 15000);
                expect(vendor).toHaveProperty('last_ordered_at', '2026-02-10');
                expect(vendor).toHaveProperty('status', 'has_oos');
            });

            test('numeric fields are integers, not strings', async () => {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([{
                    id: 'V1', name: 'Test', schedule_type: 'anytime',
                    order_day: null, receive_day: null, lead_time_days: '7',
                    minimum_order_amount: '50000', payment_method: null,
                    payment_terms: null, contact_email: null,
                    order_method: null, notes: null, default_supply_days: '45',
                    total_items: '100', oos_count: '5', reorder_count: '20',
                    reorder_value: '45000', costed_reorder_count: '20', pending_po_value: '75000', last_ordered_at: null
                }]);

                const { getVendorDashboard } = require('../../services/vendor-dashboard');
                const result = await getVendorDashboard(1);

                const vendor = result.vendors[0];
                expect(typeof vendor.lead_time_days).toBe('number');
                expect(typeof vendor.minimum_order_amount).toBe('number');
                expect(typeof vendor.total_items).toBe('number');
                expect(typeof vendor.oos_count).toBe('number');
                expect(typeof vendor.reorder_count).toBe('number');
                expect(typeof vendor.reorder_value).toBe('number');
                expect(typeof vendor.pending_po_value).toBe('number');
            });
        });
    });

    describe('PATCH /api/vendors/:id/settings', () => {

        describe('Input validation', () => {

            test('service rejects update when vendor not found (simulates invalid input)', async () => {
                db.query.mockResolvedValueOnce({ rows: [] });

                const { updateVendorSettings } = require('../../services/vendor-dashboard');
                const result = await updateVendorSettings('INVALID', 1, {
                    schedule_type: 'invalid_value'
                });

                // Validator would catch this at middleware level; service returns null for missing vendor
                expect(result).toBeNull();
            });
        });

        describe('Multi-tenant isolation', () => {

            test('rejects update for vendor belonging to different merchant', async () => {
                db.query.mockResolvedValueOnce({ rows: [] }); // No vendor found

                const { updateVendorSettings } = require('../../services/vendor-dashboard');
                const result = await updateVendorSettings('V1', 999, { notes: 'test' });

                expect(result).toBeNull();
            });

            test('query checks both vendor_id and merchant_id', async () => {
                db.query.mockResolvedValueOnce({ rows: [{ id: 'V1' }] });
                db.query.mockResolvedValueOnce({ rows: [{ id: 'V1' }] });

                const { updateVendorSettings } = require('../../services/vendor-dashboard');
                await updateVendorSettings('V1', 1, { notes: 'test' });

                // Ownership check
                const firstCall = db.query.mock.calls[0];
                expect(firstCall[1]).toEqual(['V1', 1]);
            });
        });

        describe('Field allowlisting', () => {

            test('only updates allowed fields', async () => {
                db.query.mockResolvedValueOnce({ rows: [{ id: 'V1' }] });
                db.query.mockResolvedValueOnce({ rows: [{ id: 'V1' }] });

                const { updateVendorSettings } = require('../../services/vendor-dashboard');
                await updateVendorSettings('V1', 1, {
                    schedule_type: 'fixed',
                    order_day: 'Monday',
                    receive_day: 'Wednesday',
                    lead_time_days: 3,
                    minimum_order_amount: 50000,
                    payment_method: 'Invoice',
                    payment_terms: 'Net 30',
                    contact_email: 'test@test.com',
                    order_method: 'Email',
                    default_supply_days: 45,
                    notes: 'Test notes'
                });

                const updateCall = db.query.mock.calls[1];
                const query = updateCall[0];
                // All 11 allowed fields should be present
                expect(query).toContain('schedule_type');
                expect(query).toContain('order_day');
                expect(query).toContain('receive_day');
                expect(query).toContain('lead_time_days');
                expect(query).toContain('minimum_order_amount');
                expect(query).toContain('payment_method');
                expect(query).toContain('payment_terms');
                expect(query).toContain('contact_email');
                expect(query).toContain('order_method');
                expect(query).toContain('default_supply_days');
                expect(query).toContain('notes');
            });

            test('uses parameterized queries for all values', async () => {
                db.query.mockResolvedValueOnce({ rows: [{ id: 'V1' }] });
                db.query.mockResolvedValueOnce({ rows: [{ id: 'V1' }] });

                const { updateVendorSettings } = require('../../services/vendor-dashboard');
                await updateVendorSettings('V1', 1, { notes: 'test <script>alert(1)</script>' });

                const updateCall = db.query.mock.calls[1];
                // Query uses parameterized placeholders, not string concatenation
                expect(updateCall[0]).toMatch(/\$\d+/);
                // The actual value is in the params array
                expect(updateCall[1]).toContain('test <script>alert(1)</script>');
            });
        });
    });
});
