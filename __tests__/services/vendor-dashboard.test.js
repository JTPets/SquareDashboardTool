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
            expect(computeStatus({ oos_count: 3, reorder_count: 0, pending_po_value: 0, minimum_order_amount: 0 }))
                .toBe('has_oos');
        });

        test('has_oos takes priority over other conditions', () => {
            expect(computeStatus({ oos_count: 1, reorder_count: 5, pending_po_value: 100, minimum_order_amount: 50000 }))
                .toBe('has_oos');
        });

        test('returns below_min when reorder_count > 0, pending PO exists but below minimum', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 5, pending_po_value: 2000, minimum_order_amount: 50000 }))
                .toBe('below_min');
        });

        test('returns ready when reorder_count > 0, pending PO meets minimum', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 5, pending_po_value: 60000, minimum_order_amount: 50000 }))
                .toBe('ready');
        });

        test('returns ready when pending PO equals minimum exactly', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 3, pending_po_value: 50000, minimum_order_amount: 50000 }))
                .toBe('ready');
        });

        test('returns needs_order when reorder_count > 0 but no pending PO and no minimum', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 5, pending_po_value: 0, minimum_order_amount: 0 }))
                .toBe('needs_order');
        });

        test('returns needs_order when reorder_count > 0, no pending PO, has minimum', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 3, pending_po_value: 0, minimum_order_amount: 50000 }))
                .toBe('needs_order');
        });

        test('returns ok when no issues', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 0, pending_po_value: 0, minimum_order_amount: 0 }))
                .toBe('ok');
        });

        test('returns ok when no reorder items even with pending PO', () => {
            expect(computeStatus({ oos_count: 0, reorder_count: 0, pending_po_value: 5000, minimum_order_amount: 50000 }))
                .toBe('ok');
        });

        test('handles string values (from DB rows)', () => {
            expect(computeStatus({ oos_count: '2', reorder_count: '0', pending_po_value: '0', minimum_order_amount: '0' }))
                .toBe('has_oos');
        });

        test('handles null/undefined values', () => {
            expect(computeStatus({ oos_count: null, reorder_count: null, pending_po_value: null, minimum_order_amount: null }))
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

        test('returns vendors with computed status', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    {
                        id: 'V1', name: 'Test Vendor', schedule_type: 'fixed',
                        order_day: 'Tuesday', receive_day: 'Thursday',
                        lead_time_days: 2, minimum_order_amount: 50000,
                        payment_method: 'Invoice', payment_terms: 'Net 14',
                        contact_email: 'test@vendor.com', order_method: 'Email',
                        notes: 'Test notes', default_supply_days: 45,
                        total_items: 87, oos_count: 0, reorder_count: 3,
                        pending_po_value: 60000, last_ordered_at: '2026-02-07'
                    }
                ]
            });

            const result = await getVendorDashboard(merchantId);

            expect(result).toHaveLength(1);
            expect(result[0].status).toBe('ready');
            expect(result[0].name).toBe('Test Vendor');
            expect(result[0].total_items).toBe(87);
            expect(result[0].pending_po_value).toBe(60000);
        });

        test('loads merchant settings for reorder threshold', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getVendorDashboard(merchantId);

            expect(db.getMerchantSettings).toHaveBeenCalledWith(merchantId);
        });

        test('passes reorder threshold to query', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await getVendorDashboard(merchantId);

            // supply_days (45) + safety_days (7) = 52
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[1]).toContain(52); // reorderThreshold
            expect(queryCall[1]).toContain(merchantId);
        });

        test('handles empty vendor list', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getVendorDashboard(merchantId);

            expect(result).toEqual([]);
        });

        test('uses environment defaults when merchant settings missing', async () => {
            db.getMerchantSettings.mockResolvedValue({});
            db.query.mockResolvedValueOnce({ rows: [] });

            await getVendorDashboard(merchantId);

            // 45 (default) + 7 (default) = 52
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[1]).toContain(52);
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

        test('below_min requires both pending PO and minimum to be > 0', () => {
            // Has reorder, has pending PO, but no minimum set → needs_order
            expect(computeStatus({ oos_count: 0, reorder_count: 5, pending_po_value: 2000, minimum_order_amount: 0 }))
                .toBe('needs_order');
        });

        test('zero reorder count with OOS still returns has_oos', () => {
            expect(computeStatus({ oos_count: 1, reorder_count: 0, pending_po_value: 0, minimum_order_amount: 0 }))
                .toBe('has_oos');
        });

        test('large values handled correctly', () => {
            expect(computeStatus({
                oos_count: 0, reorder_count: 500,
                pending_po_value: 10000000, minimum_order_amount: 5000000
            })).toBe('ready');
        });
    });
});
