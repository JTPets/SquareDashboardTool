/**
 * Vendor Dashboard Service Tests
 *
 * Tests for status computation, vendor dashboard query, and vendor settings updates.
 */

// Mock dependencies before imports
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
const { computeStatus, getVendorDashboard, updateVendorSettings, STATUS_PRIORITY } = require('../../services/vendor-dashboard');

describe('Vendor Dashboard Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== STATUS COMPUTATION ====================

    describe('computeStatus', () => {

        test('returns has_oos when oos_count > 0', () => {
            expect(computeStatus({ oos_count: 3, reorder_count: 0, reorder_value: 0, minimum_order_amount: 0 }))
                .toBe('has_oos');
        });

        test('has_oos takes priority over other conditions', () => {
            expect(computeStatus({ oos_count: 1, reorder_count: 5, reorder_value: 100, minimum_order_amount: 50000 }))
                .toBe('has_oos');
        });

        test('returns below_min when reorder_count > 0, costed, value below minimum', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 5, reorder_value: 2000, costed_reorder_count: 5, minimum_order_amount: 50000 }))
                .toBe('below_min');
        });

        test('returns ready when reorder_count > 0, costed, value meets minimum', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 5, reorder_value: 60000, costed_reorder_count: 5, minimum_order_amount: 50000 }))
                .toBe('ready');
        });

        test('returns ready when reorder value equals minimum exactly', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 3, reorder_value: 50000, costed_reorder_count: 3, minimum_order_amount: 50000 }))
                .toBe('ready');
        });

        test('returns needs_order when reorder_count > 0 and no minimum set', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 5, reorder_value: 0, costed_reorder_count: 0, minimum_order_amount: 0 }))
                .toBe('needs_order');
        });

        test('returns needs_order when no cost data, even with minimum set', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 3, reorder_value: 0, costed_reorder_count: 0, minimum_order_amount: 50000 }))
                .toBe('needs_order');
        });

        test('returns ok when no issues', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 0, reorder_value: 0, minimum_order_amount: 0 }))
                .toBe('ok');
        });

        test('returns ok when no reorder items even with high reorder value', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 0, reorder_value: 5000, minimum_order_amount: 50000 }))
                .toBe('ok');
        });

        test('handles string values (from DB rows)', () => {
            expect(computeStatus({ oos_count: '2', reorder_count: '0', reorder_value: '0', minimum_order_amount: '0' }))
                .toBe('has_oos');
        });

        test('handles null/undefined values', () => {
            expect(computeStatus({ oos_count: null, reorder_count: null, reorder_value: null, minimum_order_amount: null }))
                .toBe('ok');
        });
    });

    // ==================== STATUS PRIORITY ====================

    describe('STATUS_PRIORITY', () => {

        test('has_oos has highest priority (0)', () => {
            expect(STATUS_PRIORITY.has_oos).toBe(0);
        });

        test('ok has lowest priority', () => {
            expect(STATUS_PRIORITY.ok).toBeGreaterThan(STATUS_PRIORITY.has_oos);
            expect(STATUS_PRIORITY.ok).toBeGreaterThan(STATUS_PRIORITY.below_min);
            expect(STATUS_PRIORITY.ok).toBeGreaterThan(STATUS_PRIORITY.ready);
            expect(STATUS_PRIORITY.ok).toBeGreaterThan(STATUS_PRIORITY.needs_order);
        });

        test('priority order is correct', () => {
            const keys = Object.keys(STATUS_PRIORITY).sort((a, b) => STATUS_PRIORITY[a] - STATUS_PRIORITY[b]);
            expect(keys).toEqual(['has_oos', 'below_min', 'ready', 'needs_order', 'ok']);
        });
    });

    // ==================== GET VENDOR DASHBOARD ====================

    describe('getVendorDashboard', () => {
        const merchantId = 1;

        beforeEach(() => {
            db.getMerchantSettings.mockResolvedValue({
                default_supply_days: 45,
                reorder_safety_days: 7
            });
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

        test('returns { vendors, global_oos_count } shape', async () => {
            mockDashboardQueries([{
                id: 'V1', name: 'Test Vendor', schedule_type: 'fixed',
                order_day: 'Tuesday', receive_day: 'Thursday',
                lead_time_days: 2, minimum_order_amount: 50000,
                payment_method: 'Invoice', payment_terms: 'Net 14',
                contact_email: 'test@vendor.com', order_method: 'Email',
                notes: 'Test notes', default_supply_days: 45,
                total_items: 87, oos_count: 0, reorder_count: 3, reorder_value: 60000, costed_reorder_count: 3,
                pending_po_value: 60000, last_ordered_at: '2026-02-07'
            }], null, 73);

            const result = await getVendorDashboard(merchantId);

            expect(result).toHaveProperty('vendors');
            expect(result).toHaveProperty('global_oos_count', 73);
            expect(result.vendors).toHaveLength(1);
            expect(result.vendors[0].status).toBe('ready');
            expect(result.vendors[0].name).toBe('Test Vendor');
            expect(result.vendors[0].total_items).toBe(87);
            expect(result.vendors[0].pending_po_value).toBe(60000);
        });

        test('loads merchant settings for reorder threshold', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            expect(db.getMerchantSettings).toHaveBeenCalledWith(merchantId);
        });

        test('passes supply days and safety days separately to vendor query', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            // Vendor query gets [merchantId, defaultSupplyDays, safetyDays]
            const vendorQueryCall = db.query.mock.calls[0];
            expect(vendorQueryCall[1]).toEqual([merchantId, 45, 7]);

            // Unassigned query gets [merchantId, reorderThreshold] (global)
            const unassignedQueryCall = db.query.mock.calls[1];
            expect(unassignedQueryCall[1]).toContain(52); // 45 + 7
            expect(unassignedQueryCall[1]).toContain(merchantId);
        });

        test('handles empty vendor list with no unassigned items', async () => {
            mockDashboardQueries([]);

            const result = await getVendorDashboard(merchantId);

            expect(result.vendors).toEqual([]);
            expect(result.global_oos_count).toBe(0);
        });

        test('uses environment defaults when merchant settings missing', async () => {
            const origSupply = process.env.DEFAULT_SUPPLY_DAYS;
            const origSafety = process.env.REORDER_SAFETY_DAYS;
            process.env.DEFAULT_SUPPLY_DAYS = '45';
            process.env.REORDER_SAFETY_DAYS = '7';

            try {
                db.getMerchantSettings.mockResolvedValue({});
                mockDashboardQueries([]);

                await getVendorDashboard(merchantId);

                // Vendor query: [merchantId, 45, 7]
                const queryCall = db.query.mock.calls[0];
                expect(queryCall[1]).toEqual([merchantId, 45, 7]);
            } finally {
                if (origSupply === undefined) delete process.env.DEFAULT_SUPPLY_DAYS;
                else process.env.DEFAULT_SUPPLY_DAYS = origSupply;
                if (origSafety === undefined) delete process.env.REORDER_SAFETY_DAYS;
                else process.env.REORDER_SAFETY_DAYS = origSafety;
            }
        });

        test('appends unassigned vendor row when unassigned items exist', async () => {
            mockDashboardQueries(
                [{ id: 'V1', name: 'Real Vendor', schedule_type: 'anytime',
                   order_day: null, receive_day: null, lead_time_days: null,
                   minimum_order_amount: 0, payment_method: null, payment_terms: null,
                   contact_email: null, order_method: null, notes: null,
                   default_supply_days: null, total_items: 10, oos_count: 0,
                   reorder_count: 0, reorder_value: 0, costed_reorder_count: 0, pending_po_value: 0, last_ordered_at: null }],
                { total_items: 25, oos_count: 3, reorder_count: 5 },
                73
            );

            const result = await getVendorDashboard(merchantId);

            expect(result.vendors).toHaveLength(2);
            const unassigned = result.vendors.find(v => v.id === '__unassigned__');
            expect(unassigned).toBeTruthy();
            expect(unassigned.name).toBe('No Vendor Assigned');
            expect(unassigned.total_items).toBe(25);
            expect(unassigned.oos_count).toBe(3);
            expect(unassigned.reorder_count).toBe(5);
            expect(unassigned.status).toBe('has_oos');
        });

        test('does not append unassigned row when no unassigned items', async () => {
            mockDashboardQueries(
                [{ id: 'V1', name: 'Vendor', schedule_type: null,
                   order_day: null, receive_day: null, lead_time_days: null,
                   minimum_order_amount: 0, payment_method: null, payment_terms: null,
                   contact_email: null, order_method: null, notes: null,
                   default_supply_days: null, total_items: 10, oos_count: 0,
                   reorder_count: 0, reorder_value: 0, costed_reorder_count: 0, pending_po_value: 0, last_ordered_at: null }],
                { total_items: 0, oos_count: 0, reorder_count: 0 }
            );

            const result = await getVendorDashboard(merchantId);

            expect(result.vendors).toHaveLength(1);
            expect(result.vendors[0].id).toBe('V1');
        });

        test('unassigned row uses NOT EXISTS to find vendor-less items', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            const unassignedQueryCall = db.query.mock.calls[1];
            expect(unassignedQueryCall[0]).toContain('NOT EXISTS');
            expect(unassignedQueryCall[0]).toContain('variation_vendors');
        });

        test('OOS guard requires ic record to exist (no LEFT JOIN ghosts)', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            const vendorQuery = db.query.mock.calls[0][0];
            expect(vendorQuery).toContain('ic.catalog_object_id IS NOT NULL');
            expect(vendorQuery).toContain('COALESCE(ic.quantity, 0) = 0');
            expect(vendorQuery).not.toContain('0.08');
        });

        test('global OOS query uses INNER JOIN like main dashboard', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            // Third query is the global OOS count
            expect(db.query).toHaveBeenCalledTimes(3);
            const globalQuery = db.query.mock.calls[2][0];
            expect(globalQuery).toContain('COUNT(DISTINCT v.id)');
            expect(globalQuery).toContain("ic.state = 'IN_STOCK'");
            // Uses JOIN (not LEFT JOIN) — check for inventory_counts as driving table
            expect(globalQuery).toContain('FROM inventory_counts ic');
            expect(globalQuery).toContain('JOIN variations v');
        });

        test('reorder count excludes items at/above stock_alert_max', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            const vendorQuery = db.query.mock.calls[0][0];
            expect(vendorQuery).toContain('stock_alert_max');
        });

        test('vendor query uses per-vendor threshold via CROSS JOIN LATERAL', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            const vendorQuery = db.query.mock.calls[0][0];
            // Per-vendor threshold: vendor supply_days + lead_time + safety
            expect(vendorQuery).toContain('CROSS JOIN LATERAL');
            expect(vendorQuery).toContain('ve.default_supply_days');
            expect(vendorQuery).toContain('ve.lead_time_days');
            expect(vendorQuery).toContain('vt.val');
        });

        test('reorder value uses qty × cost formula with case pack rounding', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            const vendorQuery = db.query.mock.calls[0][0];
            // Qty calculation: velocity * threshold, case-pack adjusted
            expect(vendorQuery).toContain('daily_avg_quantity');
            expect(vendorQuery).toContain('case_pack_quantity');
            expect(vendorQuery).toContain('vv.unit_cost_money');
            // Must multiply qty by cost, not just sum cost
            expect(vendorQuery).toContain('* vv.unit_cost_money');
        });

        test('reorder count considers pending PO quantities', async () => {
            mockDashboardQueries([]);

            await getVendorDashboard(merchantId);

            const vendorQuery = db.query.mock.calls[0][0];
            expect(vendorQuery).toContain('purchase_order_items');
            expect(vendorQuery).toContain('quantity_ordered');
        });
    });

    // ==================== UPDATE VENDOR SETTINGS ====================

    describe('updateVendorSettings', () => {
        const merchantId = 1;
        const vendorId = 'V1';

        test('updates vendor settings successfully', async () => {
            // Vendor ownership check
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });
            // Update query
            db.query.mockResolvedValueOnce({
                rows: [{ id: vendorId, schedule_type: 'fixed', order_day: 'Tuesday' }]
            });

            const result = await updateVendorSettings(vendorId, merchantId, {
                schedule_type: 'fixed',
                order_day: 'Tuesday',
                receive_day: 'Thursday'
            });

            expect(result).toBeTruthy();
            expect(result.id).toBe(vendorId);
        });

        test('returns null for non-existent vendor', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await updateVendorSettings('INVALID', merchantId, {
                schedule_type: 'anytime'
            });

            expect(result).toBeNull();
        });

        test('filters out non-allowed fields', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });

            await updateVendorSettings(vendorId, merchantId, {
                schedule_type: 'anytime',
                malicious_field: 'DROP TABLE',
                name: 'Should not update'
            });

            // Only schedule_type should be in the SET clause
            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('schedule_type');
            expect(updateCall[0]).not.toContain('malicious_field');
            expect(updateCall[0]).not.toContain('name');
        });

        test('verifies vendor belongs to merchant', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });

            await updateVendorSettings(vendorId, merchantId, { notes: 'test' });

            // First call is ownership check
            const ownershipCall = db.query.mock.calls[0];
            expect(ownershipCall[0]).toContain('merchant_id = $2');
            expect(ownershipCall[1]).toEqual([vendorId, merchantId]);
        });

        test('returns current vendor when no fields to update', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId, name: 'Test' }] });

            const result = await updateVendorSettings(vendorId, merchantId, {
                invalid_field: 'value'
            });

            expect(result).toBeTruthy();
            // Second call should be SELECT, not UPDATE
            const secondCall = db.query.mock.calls[1];
            expect(secondCall[0]).toContain('SELECT');
        });

        test('updates multiple fields at once', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: vendorId }] });
            db.query.mockResolvedValueOnce({
                rows: [{ id: vendorId, payment_method: 'Invoice', notes: 'Updated' }]
            });

            await updateVendorSettings(vendorId, merchantId, {
                payment_method: 'Invoice',
                payment_terms: 'Net 14',
                notes: 'Updated',
                contact_email: 'new@vendor.com'
            });

            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('payment_method');
            expect(updateCall[0]).toContain('payment_terms');
            expect(updateCall[0]).toContain('notes');
            expect(updateCall[0]).toContain('contact_email');
            expect(updateCall[0]).toContain('updated_at = CURRENT_TIMESTAMP');
        });
    });

    // ==================== VALIDATION EDGE CASES ====================

    describe('Validation edge cases (via computeStatus)', () => {

        test('below_min requires minimum to be > 0', () => {
            // Has reorder, has reorder value, but no minimum set -> needs_order
            expect(computeStatus({ oos_count: 0, reorder_count: 5, reorder_value: 2000, costed_reorder_count: 5, minimum_order_amount: 0 }))
                .toBe('needs_order');
        });

        test('zero reorder count with OOS still returns has_oos', () => {
            expect(computeStatus({ oos_count: 1, reorder_count: 0, reorder_value: 0, costed_reorder_count: 0, minimum_order_amount: 0 }))
                .toBe('has_oos');
        });

        test('large values handled correctly', () => {
            expect(computeStatus({
                oos_count: 0, reorder_count: 500,
                reorder_value: 10000000, costed_reorder_count: 500, minimum_order_amount: 5000000
            })).toBe('ready');
        });
    });
});
