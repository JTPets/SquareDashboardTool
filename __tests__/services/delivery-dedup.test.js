/**
 * Delivery Order Deduplication Tests (P-10)
 *
 * Tests that concurrent INSERTs for the same square_order_id don't create
 * duplicates, and that the ON CONFLICT path returns the existing row.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn(),
        getCustomerDetails: jest.fn(),
    })),
}));

const db = require('../../utils/database');

// Must require after mocks
const deliveryService = require('../../services/delivery/delivery-service');

const MERCHANT_ID = 1;

describe('Delivery Order Deduplication (P-10)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== createOrder ON CONFLICT ====================

    describe('createOrder — ON CONFLICT behavior', () => {
        test('new Square-linked order uses ON CONFLICT SQL', async () => {
            const mockRow = {
                id: 'uuid-1',
                merchant_id: MERCHANT_ID,
                square_order_id: 'SQ_ORDER_1',
                customer_name: 'John Smith',
                address: '123 Main St',
                status: 'pending',
                _inserted: true,
            };
            db.query.mockResolvedValue({ rows: [mockRow] });

            const result = await deliveryService.createOrder(MERCHANT_ID, {
                squareOrderId: 'SQ_ORDER_1',
                customerName: 'John Smith',
                address: '123 Main St',
            });

            // Verify ON CONFLICT clause is in the SQL
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('ON CONFLICT');
            expect(sql).toContain('square_order_id, merchant_id');
            expect(sql).toContain('DO UPDATE SET');

            // Verify returned row has no internal _inserted flag
            expect(result._inserted).toBeUndefined();
            expect(result.id).toBe('uuid-1');
        });

        test('manual order (no squareOrderId) uses plain INSERT without ON CONFLICT', async () => {
            const mockRow = {
                id: 'uuid-manual',
                merchant_id: MERCHANT_ID,
                square_order_id: null,
                customer_name: 'Manual Customer',
                address: '456 Oak Ave',
                status: 'pending',
                _inserted: true,
            };
            db.query.mockResolvedValue({ rows: [mockRow] });

            await deliveryService.createOrder(MERCHANT_ID, {
                customerName: 'Manual Customer',
                address: '456 Oak Ave',
            });

            const sql = db.query.mock.calls[0][0];
            expect(sql).not.toContain('ON CONFLICT');
            expect(sql).toContain('INSERT INTO delivery_orders');
        });

        test('ON CONFLICT returns existing row when duplicate detected', async () => {
            // xmax != 0 means the row was updated (already existed)
            const existingRow = {
                id: 'uuid-existing',
                merchant_id: MERCHANT_ID,
                square_order_id: 'SQ_ORDER_DUP',
                customer_name: 'Jane Doe',
                address: '789 Elm St',
                status: 'pending',
                _inserted: false, // xmax != 0 → existing row updated
            };
            db.query.mockResolvedValue({ rows: [existingRow] });

            const result = await deliveryService.createOrder(MERCHANT_ID, {
                squareOrderId: 'SQ_ORDER_DUP',
                customerName: 'Jane Doe',
                address: '789 Elm St',
            });

            expect(result.id).toBe('uuid-existing');
            expect(result._inserted).toBeUndefined();
        });

        test('ON CONFLICT preserves better customer_name over Unknown Customer', async () => {
            // Simulate: existing row has a real name, conflict tries to insert "Unknown Customer"
            // The SQL CASE should keep the real name
            db.query.mockResolvedValue({
                rows: [{
                    id: 'uuid-1',
                    merchant_id: MERCHANT_ID,
                    square_order_id: 'SQ_ORDER_1',
                    customer_name: 'Real Name', // preserved
                    address: '123 Main St',
                    _inserted: false,
                }],
            });

            await deliveryService.createOrder(MERCHANT_ID, {
                squareOrderId: 'SQ_ORDER_1',
                customerName: 'Unknown Customer',
                address: '123 Main St',
            });

            // Verify the CASE expression in SQL
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain("WHEN delivery_orders.customer_name = 'Unknown Customer'");
        });

        test('ON CONFLICT uses COALESCE for optional fields', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    id: 'uuid-1',
                    merchant_id: MERCHANT_ID,
                    square_order_id: 'SQ_ORDER_1',
                    customer_name: 'Test',
                    address: '123 Main St',
                    _inserted: false,
                }],
            });

            await deliveryService.createOrder(MERCHANT_ID, {
                squareOrderId: 'SQ_ORDER_1',
                customerName: 'Test',
                address: '123 Main St',
            });

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('COALESCE(EXCLUDED.square_customer_id');
            expect(sql).toContain('COALESCE(EXCLUDED.phone');
            expect(sql).toContain('COALESCE(EXCLUDED.square_order_data');
        });
    });

    // ==================== ingestSquareOrder dedup ====================

    describe('ingestSquareOrder — duplicate handling', () => {
        test('returns existing order when square_order_id already ingested', async () => {
            const existingOrder = {
                id: 'uuid-existing',
                merchant_id: MERCHANT_ID,
                square_order_id: 'SQ_ORDER_1',
                customer_name: 'Jane Doe',
                address: '789 Elm St',
                status: 'pending',
                square_order_data: { lineItems: [{ name: 'Dog Food' }] },
            };

            // First call: getOrderBySquareId returns existing
            db.query.mockResolvedValueOnce({ rows: [existingOrder] });

            const result = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
                id: 'SQ_ORDER_1',
                state: 'OPEN',
                fulfillments: [{
                    type: 'DELIVERY',
                    deliveryDetails: {
                        recipient: {
                            displayName: 'Jane Doe',
                            address: { addressLine1: '789 Elm St', locality: 'Hamilton', postalCode: 'L8P 1A1' },
                        },
                    },
                }],
            });

            expect(result.id).toBe('uuid-existing');
            // Should NOT have called INSERT (only the SELECT)
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        test('different square_order_ids create separate delivery orders', async () => {
            // getOrderBySquareId returns null (not found) for order A
            db.query.mockResolvedValueOnce({ rows: [] });
            // createOrder INSERT for order A
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 'uuid-a',
                    merchant_id: MERCHANT_ID,
                    square_order_id: 'SQ_ORDER_A',
                    customer_name: 'Customer A',
                    address: '100 A St, Hamilton',
                    status: 'pending',
                    _inserted: true,
                }],
            });

            const resultA = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
                id: 'SQ_ORDER_A',
                state: 'OPEN',
                fulfillments: [{
                    type: 'DELIVERY',
                    deliveryDetails: {
                        recipient: {
                            displayName: 'Customer A',
                            address: { addressLine1: '100 A St', locality: 'Hamilton' },
                        },
                    },
                }],
            });

            jest.clearAllMocks();

            // getOrderBySquareId returns null (not found) for order B
            db.query.mockResolvedValueOnce({ rows: [] });
            // createOrder INSERT for order B
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 'uuid-b',
                    merchant_id: MERCHANT_ID,
                    square_order_id: 'SQ_ORDER_B',
                    customer_name: 'Customer B',
                    address: '200 B St, Hamilton',
                    status: 'pending',
                    _inserted: true,
                }],
            });

            const resultB = await deliveryService.ingestSquareOrder(MERCHANT_ID, {
                id: 'SQ_ORDER_B',
                state: 'OPEN',
                fulfillments: [{
                    type: 'DELIVERY',
                    deliveryDetails: {
                        recipient: {
                            displayName: 'Customer B',
                            address: { addressLine1: '200 B St', locality: 'Hamilton' },
                        },
                    },
                }],
            });

            expect(resultA.id).toBe('uuid-a');
            expect(resultB.id).toBe('uuid-b');
            expect(resultA.square_order_id).not.toBe(resultB.square_order_id);
        });

        test('concurrent INSERTs for same square_order_id handled by ON CONFLICT', async () => {
            // Simulate race condition: getOrderBySquareId returns null for both
            // concurrent calls, but the second INSERT hits ON CONFLICT

            // First call: lookup returns empty, insert succeeds (new row)
            db.query
                .mockResolvedValueOnce({ rows: [] }) // getOrderBySquareId
                .mockResolvedValueOnce({              // createOrder INSERT
                    rows: [{
                        id: 'uuid-first',
                        merchant_id: MERCHANT_ID,
                        square_order_id: 'SQ_RACE_ORDER',
                        customer_name: 'Race Customer',
                        address: '999 Race St, Hamilton',
                        status: 'pending',
                        _inserted: true,
                    }],
                });

            const squareOrder = {
                id: 'SQ_RACE_ORDER',
                state: 'OPEN',
                fulfillments: [{
                    type: 'DELIVERY',
                    deliveryDetails: {
                        recipient: {
                            displayName: 'Race Customer',
                            address: { addressLine1: '999 Race St', locality: 'Hamilton' },
                        },
                    },
                }],
            };

            const result1 = await deliveryService.ingestSquareOrder(MERCHANT_ID, squareOrder);

            jest.clearAllMocks();

            // Second call: lookup ALSO returns empty (race window),
            // but createOrder INSERT hits ON CONFLICT → returns existing row
            db.query
                .mockResolvedValueOnce({ rows: [] }) // getOrderBySquareId (race: still empty)
                .mockResolvedValueOnce({              // createOrder ON CONFLICT
                    rows: [{
                        id: 'uuid-first', // Same ID — existing row returned
                        merchant_id: MERCHANT_ID,
                        square_order_id: 'SQ_RACE_ORDER',
                        customer_name: 'Race Customer',
                        address: '999 Race St, Hamilton',
                        status: 'pending',
                        _inserted: false, // ON CONFLICT path
                    }],
                });

            const result2 = await deliveryService.ingestSquareOrder(MERCHANT_ID, squareOrder);

            // Both calls return the same delivery order
            expect(result1.id).toBe('uuid-first');
            expect(result2.id).toBe('uuid-first');
        });
    });

    // ==================== SQL structure validation ====================

    describe('SQL structure', () => {
        test('ON CONFLICT includes partial index WHERE clause', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    id: 'uuid-1',
                    square_order_id: 'SQ_1',
                    _inserted: true,
                }],
            });

            await deliveryService.createOrder(MERCHANT_ID, {
                squareOrderId: 'SQ_1',
                customerName: 'Test',
                address: '123 Main St',
            });

            const sql = db.query.mock.calls[0][0];
            // Must include the WHERE clause to match the partial unique index
            expect(sql).toContain('WHERE square_order_id IS NOT NULL');
        });

        test('RETURNING includes _inserted flag via xmax', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    id: 'uuid-1',
                    square_order_id: 'SQ_1',
                    _inserted: true,
                }],
            });

            await deliveryService.createOrder(MERCHANT_ID, {
                squareOrderId: 'SQ_1',
                customerName: 'Test',
                address: '123 Main St',
            });

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('xmax = 0');
            expect(sql).toContain('_inserted');
        });
    });
});
