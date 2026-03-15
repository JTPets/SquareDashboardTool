/**
 * Cart Activity Service Tests
 *
 * Tests for DRAFT order (shopping cart) tracking, conversion, abandonment, and cleanup.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

const db = require('../../../utils/database');
const cartService = require('../../../services/cart/cart-activity-service');

describe('Cart Activity Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== extractCartData ====================
    describe('extractCartData', () => {
        test('extracts data from camelCase order', () => {
            const order = {
                id: 'ORDER1',
                customerId: 'CUST1',
                totalMoney: { amount: 5000n, currency: 'CAD' },
                lineItems: [
                    { name: 'Dog Food', quantity: '2', variationName: 'Small', basePriceMoney: { amount: 2500 } },
                ],
                locationId: 'LOC1',
                source: { name: 'Square Online' },
                fulfillments: [{
                    type: 'SHIPMENT',
                    shipmentDetails: { recipient: { phoneNumber: '+14165551234' } },
                }],
            };

            const result = cartService.extractCartData(order);
            expect(result.squareOrderId).toBe('ORDER1');
            expect(result.squareCustomerId).toBe('CUST1');
            expect(result.customerIdHash).toBeTruthy();
            expect(result.phoneLast4).toBe('1234');
            expect(result.cartTotalCents).toBe(5000);
            expect(result.itemCount).toBe(1);
            expect(result.sourceName).toBe('Square Online');
            expect(result.fulfillmentType).toBe('SHIPMENT');
        });

        test('extracts data from snake_case order', () => {
            const order = {
                id: 'ORDER2',
                customer_id: 'CUST2',
                total_money: { amount: 3000 },
                line_items: [
                    { name: 'Cat Food', quantity: '1', variation_name: 'Large', base_price_money: { amount: 3000 } },
                ],
                location_id: 'LOC2',
                source: { name: 'Online Store' },
                fulfillments: [{
                    type: 'DELIVERY',
                    delivery_details: { recipient: { phone_number: '+14169998888' } },
                }],
            };

            const result = cartService.extractCartData(order);
            expect(result.squareCustomerId).toBe('CUST2');
            expect(result.phoneLast4).toBe('8888');
            expect(result.cartTotalCents).toBe(3000);
        });

        test('handles missing fulfillments', () => {
            const order = {
                id: 'ORDER3',
                customerId: 'CUST3',
                totalMoney: { amount: 1000 },
                lineItems: [],
                source: {},
            };

            const result = cartService.extractCartData(order);
            expect(result.phoneLast4).toBeNull();
            expect(result.fulfillmentType).toBeNull();
        });

        test('handles BigInt money amounts', () => {
            const order = {
                id: 'ORDER4',
                totalMoney: { amount: 9999n },
                lineItems: [],
                source: {},
            };

            const result = cartService.extractCartData(order);
            expect(result.cartTotalCents).toBe(9999);
        });

        test('returns null phoneLast4 for short phone number', () => {
            const order = {
                id: 'O',
                lineItems: [],
                source: {},
                fulfillments: [{ type: 'SHIPMENT', shipmentDetails: { recipient: { phoneNumber: '12' } } }],
            };
            const result = cartService.extractCartData(order);
            expect(result.phoneLast4).toBeNull();
        });

        test('strips non-digits from phone before extracting last 4', () => {
            const order = {
                id: 'O',
                lineItems: [],
                source: {},
                fulfillments: [{ type: 'DELIVERY', deliveryDetails: { recipient: { phoneNumber: '(416) 555-1234' } } }],
            };
            const result = cartService.extractCartData(order);
            expect(result.phoneLast4).toBe('1234');
        });

        test('returns Unknown for missing source name', () => {
            const order = { id: 'O', lineItems: [], source: {} };
            const result = cartService.extractCartData(order);
            expect(result.sourceName).toBe('Unknown');
        });
    });

    // ==================== createFromDraftOrder ====================
    describe('createFromDraftOrder', () => {
        test('skips orders with no line items', async () => {
            const result = await cartService.createFromDraftOrder({ id: 'O', lineItems: [] }, 1);
            expect(result).toBeNull();
            expect(db.query).not.toHaveBeenCalled();
        });

        test('skips anonymous carts (no customer identifier)', async () => {
            const order = {
                id: 'O',
                lineItems: [{ name: 'Item', quantity: '1' }],
                totalMoney: { amount: 100 },
                source: {},
            };
            const result = await cartService.createFromDraftOrder(order, 1);
            expect(result).toBeNull();
        });

        test('creates cart record for identified customer', async () => {
            const order = {
                id: 'ORDER1',
                customerId: 'CUST1',
                lineItems: [{ name: 'Dog Food', quantity: '1', variationName: 'Sm', basePriceMoney: { amount: 2500 } }],
                totalMoney: { amount: 2500 },
                locationId: 'LOC1',
                source: { name: 'Online' },
            };

            db.query.mockResolvedValue({
                rows: [{ id: 1, status: 'pending', square_order_id: 'ORDER1' }],
            });

            const result = await cartService.createFromDraftOrder(order, 1);
            expect(result).toBeTruthy();
            expect(result.status).toBe('pending');
            expect(db.query).toHaveBeenCalledTimes(1);
            expect(db.query.mock.calls[0][1][0]).toBe(1); // merchantId
        });

        test('creates cart for customer with phone only', async () => {
            const order = {
                id: 'ORDER2',
                lineItems: [{ name: 'Cat Food', quantity: '1' }],
                totalMoney: { amount: 1500 },
                source: {},
                fulfillments: [{ type: 'DELIVERY', deliveryDetails: { recipient: { phoneNumber: '4165551234' } } }],
            };

            db.query.mockResolvedValue({ rows: [{ id: 2, status: 'pending' }] });
            const result = await cartService.createFromDraftOrder(order, 1);
            expect(result).toBeTruthy();
        });

        test('throws on DB error', async () => {
            const order = {
                id: 'ORDER3',
                customerId: 'C1',
                lineItems: [{ name: 'X', quantity: '1' }],
                totalMoney: { amount: 100 },
                source: {},
            };

            db.query.mockRejectedValue(new Error('DB error'));
            await expect(cartService.createFromDraftOrder(order, 1)).rejects.toThrow('DB error');
        });
    });

    // ==================== markConverted ====================
    describe('markConverted', () => {
        test('updates pending cart to converted', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, status: 'converted', created_at: new Date('2026-01-01'), converted_at: new Date('2026-01-02') }],
            });

            const result = await cartService.markConverted('ORDER1', 1);
            expect(result.status).toBe('converted');
        });

        test('returns null if no pending cart found', async () => {
            db.query.mockResolvedValue({ rows: [] });
            const result = await cartService.markConverted('MISSING', 1);
            expect(result).toBeNull();
        });

        test('returns null on DB error (graceful)', async () => {
            db.query.mockRejectedValue(new Error('DB error'));
            const result = await cartService.markConverted('ORDER1', 1);
            expect(result).toBeNull();
        });
    });

    // ==================== markCanceled ====================
    describe('markCanceled', () => {
        test('updates pending cart to canceled', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, status: 'canceled' }],
            });
            const result = await cartService.markCanceled('ORDER1', 1);
            expect(result.status).toBe('canceled');
        });

        test('returns null if no pending cart', async () => {
            db.query.mockResolvedValue({ rows: [] });
            const result = await cartService.markCanceled('MISSING', 1);
            expect(result).toBeNull();
        });

        test('returns null on error', async () => {
            db.query.mockRejectedValue(new Error('fail'));
            const result = await cartService.markCanceled('O', 1);
            expect(result).toBeNull();
        });
    });

    // ==================== markAbandoned ====================
    describe('markAbandoned', () => {
        test('throws if merchantId is missing', async () => {
            await expect(cartService.markAbandoned(null)).rejects.toThrow('merchantId is required');
        });

        test('marks old pending carts as abandoned', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1 }, { id: 2 }],
            });

            const count = await cartService.markAbandoned(1, 7);
            expect(count).toBe(2);
            expect(db.query.mock.calls[0][1]).toEqual([1, 7]);
        });

        test('returns 0 when no carts to abandon', async () => {
            db.query.mockResolvedValue({ rows: [] });
            const count = await cartService.markAbandoned(1);
            expect(count).toBe(0);
        });

        test('uses default 7-day threshold', async () => {
            db.query.mockResolvedValue({ rows: [] });
            await cartService.markAbandoned(1);
            expect(db.query.mock.calls[0][1]).toEqual([1, 7]);
        });
    });

    // ==================== purgeOld ====================
    describe('purgeOld', () => {
        test('throws if merchantId is missing', async () => {
            await expect(cartService.purgeOld(null)).rejects.toThrow('merchantId is required');
        });

        test('deletes old records and returns count', async () => {
            db.query.mockResolvedValue({ rowCount: 5 });
            const count = await cartService.purgeOld(1, 30);
            expect(count).toBe(5);
        });

        test('uses default 30-day threshold', async () => {
            db.query.mockResolvedValue({ rowCount: 0 });
            await cartService.purgeOld(1);
            expect(db.query.mock.calls[0][1]).toEqual([1, 30]);
        });
    });

    // ==================== getList ====================
    describe('getList', () => {
        test('returns paginated carts with total count', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ total: '10' }] })
                .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

            const result = await cartService.getList(1, { limit: 2, offset: 0 });
            expect(result.total).toBe(10);
            expect(result.carts).toHaveLength(2);
        });

        test('applies status filter', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ total: '3' }] })
                .mockResolvedValueOnce({ rows: [] });

            await cartService.getList(1, { status: 'pending' });
            expect(db.query.mock.calls[0][0]).toContain('status = $2');
        });

        test('applies date range filters', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ total: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            await cartService.getList(1, { startDate: '2026-01-01', endDate: '2026-01-31' });
            expect(db.query.mock.calls[0][0]).toContain('created_at >= $2');
            expect(db.query.mock.calls[0][0]).toContain('created_at <= $3');
        });
    });

    // ==================== getStats ====================
    describe('getStats', () => {
        test('returns computed statistics', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    pending: '5', converted: '10', abandoned: '3', canceled: '2',
                    total_resolved: '15', avg_pending_cart: '2500.5', avg_converted_cart: '3500.0',
                }],
            });

            const stats = await cartService.getStats(1, 7);
            expect(stats.pending).toBe(5);
            expect(stats.converted).toBe(10);
            expect(stats.conversionRate).toBe(67); // 10/15 * 100 = 66.67 → 67
            expect(stats.avgPendingCartCents).toBe(2501);
            expect(stats.avgConvertedCartCents).toBe(3500);
        });

        test('handles zero total_resolved', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    pending: '0', converted: '0', abandoned: '0', canceled: '0',
                    total_resolved: '0', avg_pending_cart: null, avg_converted_cart: null,
                }],
            });

            const stats = await cartService.getStats(1);
            expect(stats.conversionRate).toBe(0);
            expect(stats.avgPendingCartCents).toBe(0);
        });
    });

    // ==================== getBySquareOrderId ====================
    describe('getBySquareOrderId', () => {
        test('returns cart record if found', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 1, square_order_id: 'O1' }] });
            const result = await cartService.getBySquareOrderId('O1', 1);
            expect(result.id).toBe(1);
        });

        test('returns null if not found', async () => {
            db.query.mockResolvedValue({ rows: [] });
            const result = await cartService.getBySquareOrderId('MISSING', 1);
            expect(result).toBeNull();
        });
    });
});
