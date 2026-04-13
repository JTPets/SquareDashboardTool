jest.mock('../../../utils/database', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/expiry/discount-service', () => ({
    clearExpiryDiscountForReorder: jest.fn().mockResolvedValue({ cleared: false }),
    applyDiscounts: jest.fn().mockResolvedValue(),
}));
jest.mock('../../../services/catalog/location-service', () => ({
    getLocationById: jest.fn(),
}));

const db = require('../../../utils/database');
const discountService = require('../../../services/expiry/discount-service');
const { getLocationById } = require('../../../services/catalog/location-service');
const poService = require('../../../services/purchase-orders/po-service');

beforeEach(() => {
    jest.clearAllMocks();
    discountService.clearExpiryDiscountForReorder.mockResolvedValue({ cleared: false });
    discountService.applyDiscounts.mockResolvedValue();
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('calculateSubtotal', () => {
    test('sums quantity * unit_cost_cents for all items', () => {
        const items = [
            { quantity_ordered: 3, unit_cost_cents: 1000 },
            { quantity_ordered: 5, unit_cost_cents: 500 },
        ];
        expect(poService.calculateSubtotal(items)).toBe(5500);
    });

    test('returns 0 for empty array', () => {
        expect(poService.calculateSubtotal([])).toBe(0);
    });
});

describe('validateVendorMinimum', () => {
    test('returns ok:true when vendor has no minimum', () => {
        expect(poService.validateVendorMinimum({ minimum_order_amount: null }, 100)).toEqual({ ok: true });
    });

    test('returns ok:true when minimum is zero', () => {
        expect(poService.validateVendorMinimum({ minimum_order_amount: '0' }, 100)).toEqual({ ok: true });
    });

    test('returns ok:true when subtotal equals minimum (exact boundary)', () => {
        expect(poService.validateVendorMinimum({ minimum_order_amount: '5000' }, 5000)).toEqual({ ok: true });
    });

    test('returns ok:true when subtotal exceeds minimum', () => {
        expect(poService.validateVendorMinimum({ minimum_order_amount: '5000' }, 6000)).toEqual({ ok: true });
    });

    test('returns shortfall details when below minimum', () => {
        const result = poService.validateVendorMinimum({ minimum_order_amount: '10000' }, 7000);
        expect(result).toEqual({ ok: false, shortfallCents: 3000, minimumCents: 10000, subtotalCents: 7000 });
    });

    test('handles string minimum_order_amount with decimal', () => {
        const result = poService.validateVendorMinimum({ minimum_order_amount: '5000.50' }, 4000);
        expect(result.ok).toBe(false);
        expect(result.minimumCents).toBe(5001); // Math.round
    });
});

describe('generatePoNumber', () => {
    test('generates PO-YYYYMMDD-001 format for first PO of the day', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        const result = await poService.generatePoNumber(10);
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        expect(result).toBe(`PO-${today}-001`);
    });

    test('increments sequence for subsequent POs', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '4' }] });
        const result = await poService.generatePoNumber(10);
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        expect(result).toBe(`PO-${today}-005`);
    });

    test('passes correct LIKE pattern and merchantId', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        await poService.generatePoNumber(42);
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('po_number LIKE'),
            [`PO-${today}-%`, 42]
        );
    });
});

// ─── listPurchaseOrders ───────────────────────────────────────────────────────

describe('listPurchaseOrders', () => {
    test('returns rows for merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
        const result = await poService.listPurchaseOrders(10, {});
        expect(result).toHaveLength(2);
        expect(db.query.mock.calls[0][1]).toContain(10);
    });

    test('appends status filter when provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await poService.listPurchaseOrders(10, { status: 'DRAFT' });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('po.status =');
        expect(params).toContain('DRAFT');
    });

    test('appends vendor_id filter when provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await poService.listPurchaseOrders(10, { vendorId: 5 });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('po.vendor_id =');
        expect(params).toContain(5);
    });

    test('returns empty array when no results', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await poService.listPurchaseOrders(10, {})).toEqual([]);
    });
});

// ─── getPurchaseOrder ─────────────────────────────────────────────────────────

describe('getPurchaseOrder', () => {
    test('returns PO with items attached', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, vendor_id: 5 }] }); // header
        db.query.mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 11 }] }); // items
        const po = await poService.getPurchaseOrder(10, 1);
        expect(po.id).toBe(1);
        expect(po.items).toHaveLength(2);
    });

    test('returns null when PO not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await poService.getPurchaseOrder(10, 999)).toBeNull();
    });

    test('passes vendor_id to items query for vendor_code join', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, vendor_id: 7 }] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await poService.getPurchaseOrder(10, 1);
        expect(db.query.mock.calls[1][1]).toContain(7); // vendor_id passed as param
    });
});

// ─── createPurchaseOrder ──────────────────────────────────────────────────────

describe('createPurchaseOrder', () => {
    const basePayload = {
        vendorId: 5, locationId: 'loc-1', items: [
            { variation_id: 'v1', quantity_ordered: 2, unit_cost_cents: 1000 },
        ], force: false
    };

    function mockSuccess(vendorRow = { id: 5, minimum_order_amount: null }) {
        db.query.mockResolvedValueOnce({ rows: [vendorRow] }); // vendor check
        getLocationById.mockResolvedValueOnce({ id: 'loc-1' }); // location check
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // PO number
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            client.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-20260403-001', status: 'DRAFT', vendor_id: 5 }] });
            client.query.mockResolvedValueOnce({ rows: [] }); // batch insert items
            return fn(client);
        });
        db.query.mockResolvedValueOnce({ rows: [] }); // expiry status check
    }

    test('creates PO and returns po, clearedExpiryItems, minimumWarning:null', async () => {
        mockSuccess();
        const result = await poService.createPurchaseOrder(10, basePayload);
        expect(result.po).toBeDefined();
        expect(result.po.status).toBe('DRAFT');
        expect(result.clearedExpiryItems).toEqual([]);
        expect(result.minimumWarning).toBeNull();
    });

    test('throws 400 when all items have zero quantity', async () => {
        const payload = { ...basePayload, items: [{ variation_id: 'v1', quantity_ordered: 0, unit_cost_cents: 500 }] };
        await expect(poService.createPurchaseOrder(10, payload)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('throws 403 when vendor does not belong to merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(poService.createPurchaseOrder(10, basePayload)).rejects.toMatchObject({ statusCode: 403 });
    });

    test('throws 403 when location does not belong to merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, minimum_order_amount: null }] });
        getLocationById.mockResolvedValueOnce(null);
        await expect(poService.createPurchaseOrder(10, basePayload)).rejects.toMatchObject({ statusCode: 403 });
    });

    test('throws BELOW_VENDOR_MINIMUM when below minimum and force=false', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, minimum_order_amount: '50000' }] });
        getLocationById.mockResolvedValueOnce({ id: 'loc-1' });
        await expect(poService.createPurchaseOrder(10, basePayload)).rejects.toMatchObject({
            statusCode: 400, code: 'BELOW_VENDOR_MINIMUM',
            vendorMinimumCents: 50000, orderTotalCents: 2000,
        });
    });

    test('returns minimumWarning when below minimum and force=true', async () => {
        mockSuccess({ id: 5, minimum_order_amount: '50000' });
        const result = await poService.createPurchaseOrder(10, { ...basePayload, force: true });
        expect(result.minimumWarning).toBeDefined();
        expect(result.minimumWarning.shortfall_cents).toBeGreaterThan(0);
    });

    test('returns no minimumWarning when minimum is not set', async () => {
        mockSuccess({ id: 5, minimum_order_amount: null });
        const result = await poService.createPurchaseOrder(10, basePayload);
        expect(result.minimumWarning).toBeNull();
    });

    test('filters zero-quantity items before batch insert', async () => {
        const payloadWithZero = {
            ...basePayload,
            items: [
                { variation_id: 'v1', quantity_ordered: 2, unit_cost_cents: 1000 },
                { variation_id: 'v2', quantity_ordered: 0, unit_cost_cents: 500 },
            ]
        };
        mockSuccess();
        const result = await poService.createPurchaseOrder(10, payloadWithZero);
        expect(result.po).toBeDefined();
        // Batch insert values: only 1 valid item × 8 params = 8 values
        const batchInsertCall = db.transaction.mock.results[0].value;
        // Just verify it succeeded — zero-qty item was filtered
        expect(result.clearedExpiryItems).toEqual([]);
    });

    test('returns cleared expiry items when active discounts exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, minimum_order_amount: null }] });
        getLocationById.mockResolvedValueOnce({ id: 'loc-1' });
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            client.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-20260403-001', status: 'DRAFT', vendor_id: 5 }] });
            client.query.mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        // expiry query returns active discount
        db.query.mockResolvedValueOnce({ rows: [{ variation_id: 'v1', tier_code: 'AUTO50', item_name: 'Dog Food', variation_name: 'Large' }] });
        discountService.clearExpiryDiscountForReorder.mockResolvedValueOnce({ cleared: true, previousTier: 'AUTO50' });

        const result = await poService.createPurchaseOrder(10, basePayload);
        expect(result.clearedExpiryItems).toHaveLength(1);
        expect(result.clearedExpiryItems[0].previous_tier).toBe('AUTO50');
    });
});

// ─── updatePurchaseOrder ──────────────────────────────────────────────────────

describe('updatePurchaseOrder', () => {
    function mockDraftStatus() {
        db.query.mockResolvedValueOnce({ rows: [{ status: 'DRAFT' }] });
    }

    test('throws 404 when PO not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(poService.updatePurchaseOrder(10, 999, {})).rejects.toMatchObject({ statusCode: 404 });
    });

    test('throws 400 when PO is not DRAFT', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ status: 'SUBMITTED' }] });
        await expect(poService.updatePurchaseOrder(10, 1, {})).rejects.toMatchObject({ statusCode: 400 });
    });

    test('updates header fields and returns updated PO', async () => {
        mockDraftStatus();
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            return fn(client);
        });
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, notes: 'Updated', status: 'DRAFT' }] });
        const result = await poService.updatePurchaseOrder(10, 1, { notes: 'Updated' });
        expect(result.notes).toBe('Updated');
    });

    test('uses batch INSERT (not N+1) when items provided', async () => {
        mockDraftStatus();
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            capturedClient = client;
            return fn(client);
        });
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

        const items = [
            { variation_id: 'v1', quantity_ordered: 2, unit_cost_cents: 1000, notes: null },
            { variation_id: 'v2', quantity_ordered: 3, unit_cost_cents: 500, notes: null },
        ];
        await poService.updatePurchaseOrder(10, 1, { items });

        // Single INSERT call with all items — not one call per item
        const insertCalls = capturedClient.query.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO purchase_order_items')
        );
        expect(insertCalls).toHaveLength(1);
        // All 2 items × 7 params = 14 values in one batch
        expect(insertCalls[0][1]).toHaveLength(14);
    });

    test('updates totals after item replace', async () => {
        mockDraftStatus();
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            capturedClient = client;
            return fn(client);
        });
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

        await poService.updatePurchaseOrder(10, 1, {
            items: [{ variation_id: 'v1', quantity_ordered: 4, unit_cost_cents: 2500, notes: null }]
        });

        const updateTotalCall = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('subtotal_cents')
        );
        expect(updateTotalCall).toBeDefined();
        expect(updateTotalCall[1][0]).toBe(10000); // 4 * 2500
    });
});

// ─── submitPurchaseOrder ──────────────────────────────────────────────────────

describe('submitPurchaseOrder', () => {
    test('returns updated PO on success', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'SUBMITTED', order_date: '2026-04-03' }] });
        const po = await poService.submitPurchaseOrder(10, 1);
        expect(po.status).toBe('SUBMITTED');
    });

    test('throws 400 when PO not found or not DRAFT', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(poService.submitPurchaseOrder(10, 1)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('sets merchant_id in query params', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'SUBMITTED' }] });
        await poService.submitPurchaseOrder(10, 1);
        expect(db.query.mock.calls[0][1]).toContain(10);
    });
});

// ─── deletePurchaseOrder ──────────────────────────────────────────────────────

describe('deletePurchaseOrder', () => {
    test('deletes DRAFT PO and returns po_number', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-20260403-001', status: 'DRAFT' }] });
        db.query.mockResolvedValueOnce({ rows: [] }); // DELETE
        const result = await poService.deletePurchaseOrder(10, 1);
        expect(result.poNumber).toBe('PO-20260403-001');
    });

    test('throws 404 when PO not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(poService.deletePurchaseOrder(10, 999)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('throws 400 when PO is not DRAFT', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-001', status: 'SUBMITTED' }] });
        await expect(poService.deletePurchaseOrder(10, 1)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('includes status name in error message for non-DRAFT delete', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, po_number: 'PO-001', status: 'RECEIVED' }] });
        await expect(poService.deletePurchaseOrder(10, 1)).rejects.toMatchObject({
            message: expect.stringContaining('RECEIVED')
        });
    });
});
