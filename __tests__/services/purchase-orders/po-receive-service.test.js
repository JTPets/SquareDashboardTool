jest.mock('../../../utils/database', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const { receiveItems } = require('../../../services/purchase-orders/po-receive-service');

beforeEach(() => jest.clearAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock transaction whose client responds in the expected receive sequence:
 *   1. N × UPDATE received_quantity (one per item)
 *   2. SELECT vendor_id FROM purchase_orders
 *   3. SELECT cost diffs (poi LEFT JOIN variation_vendors)
 *   4. [optional] N × INSERT INTO variation_vendors (one per changed diff)
 *   5. SELECT COUNT total/received
 *   6. UPDATE purchase_orders status
 */
function mockTransaction({ itemCount = 1, vendorId = 'V1', costDiffs = [], allReceived = true } = {}) {
    db.transaction.mockImplementation(async (fn) => {
        const client = { query: jest.fn() };
        for (let i = 0; i < itemCount; i++) client.query.mockResolvedValueOnce({ rows: [] });
        client.query.mockResolvedValueOnce({ rows: [{ vendor_id: vendorId }] });
        client.query.mockResolvedValueOnce({ rows: costDiffs });
        for (const d of costDiffs) {
            if (d.unit_cost_cents !== d.current_vendor_cost) client.query.mockResolvedValueOnce({ rows: [] });
        }
        const total = String(itemCount);
        client.query.mockResolvedValueOnce({ rows: [{ total, received: allReceived ? total : '0' }] });
        client.query.mockResolvedValueOnce({ rows: [] });
        return fn(client);
    });
    return db.transaction;
}

function mockPoCheck(status = 'SUBMITTED') {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, status }] });
}
function mockPoCheckNotFound() {
    db.query.mockResolvedValueOnce({ rows: [] });
}
function mockExpiryFlag(rowCount = 0) {
    db.query.mockResolvedValueOnce({ rowCount });
}
function mockFinalSelect(extraFields = {}) {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'RECEIVED', ...extraFields }] });
}

const twoItems = [{ id: 1, received_quantity: 10 }, { id: 2, received_quantity: 5 }];
const oneItem  = [{ id: 1, received_quantity: 10 }];

// ─── receiveItems — guard checks ─────────────────────────────────────────────

describe('receiveItems — guard checks', () => {
    test('throws 404 when PO not found', async () => {
        mockPoCheckNotFound();
        await expect(receiveItems(10, 1, oneItem)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('throws 400 when PO is DRAFT (not SUBMITTED)', async () => {
        mockPoCheck('DRAFT');
        await expect(receiveItems(10, 1, oneItem)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('throws 400 when PO is already RECEIVED', async () => {
        mockPoCheck('RECEIVED');
        await expect(receiveItems(10, 1, oneItem)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('error message includes current status for non-SUBMITTED PO', async () => {
        mockPoCheck('PARTIAL');
        await expect(receiveItems(10, 1, oneItem)).rejects.toMatchObject({
            message: expect.stringContaining('PARTIAL')
        });
    });

    test('passes merchant_id to ownership check query', async () => {
        mockPoCheckNotFound();
        await expect(receiveItems(42, 99, oneItem)).rejects.toBeDefined();
        expect(db.query.mock.calls[0][1]).toContain(42);
        expect(db.query.mock.calls[0][1]).toContain(99);
    });
});

// ─── Full receive (all items → RECEIVED) ─────────────────────────────────────

describe('receiveItems — full receive → RECEIVED', () => {
    test('returns updated PO with RECEIVED status', async () => {
        mockPoCheck();
        mockTransaction({ itemCount: 2, allReceived: true });
        mockExpiryFlag();
        mockFinalSelect({ status: 'RECEIVED' });

        const result = await receiveItems(10, '1', twoItems);
        expect(result.status).toBe('RECEIVED');
    });

    test('writes UPDATE RECEIVED with actual_delivery_date', async () => {
        mockPoCheck();
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })  // update received qty
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: [] })  // cost diffs (empty)
                .mockResolvedValueOnce({ rows: [{ total: '1', received: '1' }] })
                .mockResolvedValueOnce({ rows: [] }); // status update
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect();

        await receiveItems(10, 1, oneItem);

        const statusUpdate = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes("status = 'RECEIVED'")
        );
        expect(statusUpdate).toBeDefined();
        expect(statusUpdate[0]).toContain('actual_delivery_date');
    });
});

// ─── Partial receive (some items → PARTIAL) ──────────────────────────────────

describe('receiveItems — partial receive → PARTIAL', () => {
    test('sets PARTIAL status when not all items received', async () => {
        mockPoCheck();
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })  // update qty item 1
                .mockResolvedValueOnce({ rows: [] })  // update qty item 2
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: [] })  // cost diffs (empty)
                .mockResolvedValueOnce({ rows: [{ total: '2', received: '1' }] }) // only 1 of 2 received
                .mockResolvedValueOnce({ rows: [] }); // status update
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect({ status: 'PARTIAL' });

        const result = await receiveItems(10, 1, twoItems);
        expect(result.status).toBe('PARTIAL');

        const statusUpdate = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes("status = 'PARTIAL'")
        );
        expect(statusUpdate).toBeDefined();
    });

    test('PARTIAL update does NOT set actual_delivery_date', async () => {
        mockPoCheck();
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ total: '1', received: '0' }] })
                .mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect({ status: 'PARTIAL' });

        await receiveItems(10, 1, oneItem);

        const partialUpdate = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes("status = 'PARTIAL'")
        );
        expect(partialUpdate[0]).not.toContain('actual_delivery_date');
    });
});

// ─── Vendor cost sync ─────────────────────────────────────────────────────────

describe('receiveItems — vendor cost sync', () => {
    test('upserts variation_vendors when PO cost differs from recorded cost', async () => {
        mockPoCheck();
        const costDiffs = [{ variation_id: 'VAR1', unit_cost_cents: 1200, current_vendor_cost: 1000 }];
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: costDiffs })
                .mockResolvedValueOnce({ rows: [] })  // upsert
                .mockResolvedValueOnce({ rows: [{ total: '1', received: '1' }] })
                .mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect();

        await receiveItems(10, 1, oneItem);

        const upsert = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        expect(upsert).toBeDefined();
        expect(upsert[1]).toEqual(['VAR1', 'V1', 1200, 10]);
    });

    test('skips upsert when costs match exactly', async () => {
        mockPoCheck();
        const costDiffs = [{ variation_id: 'VAR1', unit_cost_cents: 1000, current_vendor_cost: 1000 }];
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: costDiffs })
                .mockResolvedValueOnce({ rows: [{ total: '1', received: '1' }] })
                .mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect();

        await receiveItems(10, 1, oneItem);

        const upsert = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        expect(upsert).toBeUndefined();
    });

    test('treats NULL current_vendor_cost as a diff (upserts)', async () => {
        mockPoCheck();
        const costDiffs = [{ variation_id: 'VAR1', unit_cost_cents: 800, current_vendor_cost: null }];
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: costDiffs })
                .mockResolvedValueOnce({ rows: [] })  // upsert
                .mockResolvedValueOnce({ rows: [{ total: '1', received: '1' }] })
                .mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect();

        await receiveItems(10, 1, oneItem);

        const upsert = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        expect(upsert).toBeDefined();
    });

    test('handles multiple items with mixed cost diffs', async () => {
        mockPoCheck();
        const costDiffs = [
            { variation_id: 'VAR1', unit_cost_cents: 1200, current_vendor_cost: 1000 }, // diff
            { variation_id: 'VAR2', unit_cost_cents: 500, current_vendor_cost: 500 },   // same
            { variation_id: 'VAR3', unit_cost_cents: 750, current_vendor_cost: null },  // null → diff
        ];
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] }) // qty 1
                .mockResolvedValueOnce({ rows: [] }) // qty 2
                .mockResolvedValueOnce({ rows: [] }) // qty 3
                .mockResolvedValueOnce({ rows: [{ vendor_id: 'V1' }] })
                .mockResolvedValueOnce({ rows: costDiffs })
                .mockResolvedValueOnce({ rows: [] }) // upsert VAR1
                .mockResolvedValueOnce({ rows: [] }) // upsert VAR3
                .mockResolvedValueOnce({ rows: [{ total: '3', received: '3' }] })
                .mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect();

        await receiveItems(10, 1, [
            { id: 1, received_quantity: 5 },
            { id: 2, received_quantity: 3 },
            { id: 3, received_quantity: 8 },
        ]);

        const upserts = capturedClient.query.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        expect(upserts).toHaveLength(2); // VAR1 and VAR3 only
    });

    test('skips cost sync entirely when PO has no vendor_id', async () => {
        mockPoCheck();
        let capturedClient;
        db.transaction.mockImplementation(async (fn) => {
            const client = { query: jest.fn() };
            capturedClient = client;
            client.query
                .mockResolvedValueOnce({ rows: [] })               // qty update
                .mockResolvedValueOnce({ rows: [{}] })             // vendor_id is undefined
                .mockResolvedValueOnce({ rows: [{ total: '1', received: '1' }] })
                .mockResolvedValueOnce({ rows: [] });
            return fn(client);
        });
        mockExpiryFlag();
        mockFinalSelect();

        await receiveItems(10, 1, oneItem);

        const costDiffQuery = capturedClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('unit_cost_cents')
        );
        expect(costDiffQuery).toBeUndefined();
    });
});

// ─── Expiry flag (EXPIRY-REORDER-AUDIT) ──────────────────────────────────────

describe('receiveItems — expiry flag', () => {
    test('flags items with active expiry discounts for re-audit', async () => {
        mockPoCheck();
        mockTransaction({ itemCount: 1 });
        db.query.mockResolvedValueOnce({ rowCount: 1 }); // flag hit 1 item
        mockFinalSelect();

        await receiveItems(10, '1', [{ id: 1, received_quantity: 10 }]);

        const flagCall = db.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('needs_manual_review')
        );
        expect(flagCall).toBeDefined();
        expect(flagCall[1]).toEqual([[1], '1', 10]); // [itemIds, poId, merchantId]
    });

    test('logs info when items are flagged', async () => {
        mockPoCheck();
        mockTransaction({ itemCount: 1 });
        db.query.mockResolvedValueOnce({ rowCount: 2 });
        mockFinalSelect();

        await receiveItems(10, 1, oneItem);

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Flagged'),
            expect.objectContaining({ flaggedCount: 2 })
        );
    });

    test('succeeds and returns PO even if expiry flag query throws', async () => {
        mockPoCheck();
        mockTransaction({ itemCount: 1 });
        db.query.mockRejectedValueOnce(new Error('DB timeout')); // expiry flag fails
        mockFinalSelect({ status: 'RECEIVED' });

        const result = await receiveItems(10, 1, oneItem);
        expect(result.status).toBe('RECEIVED');
        expect(logger.warn).toHaveBeenCalled();
    });

    test('skips flag query when items array is empty', async () => {
        mockPoCheck();
        mockTransaction({ itemCount: 0 });
        mockFinalSelect();

        await receiveItems(10, 1, []);

        const flagCall = db.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('needs_manual_review')
        );
        expect(flagCall).toBeUndefined();
    });
});
