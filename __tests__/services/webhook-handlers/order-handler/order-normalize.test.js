/**
 * Tests for order-normalize module (Square order normalization and fetching)
 *
 * @module __tests__/services/webhook-handlers/order-handler/order-normalize
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../../utils/logger', () => logger);

const mockSquareClient = { orders: { get: jest.fn() } };
jest.mock('../../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient)
}));

const { getSquareClientForMerchant } = require('../../../../middleware/merchant');
const { normalizeSquareOrder, fetchFullOrder } = require('../../../../services/webhook-handlers/order-handler/order-normalize');

describe('order-normalize', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('normalizeSquareOrder', () => {
        it('returns null/undefined input as-is', () => {
            expect(normalizeSquareOrder(null)).toBeNull();
            expect(normalizeSquareOrder(undefined)).toBeUndefined();
        });

        it('adds snake_case aliases for top-level fields', () => {
            const order = {
                lineItems: [{ name: 'Item A' }],
                customerId: 'CUST_1',
                locationId: 'LOC_1',
                totalMoney: { amount: 1000n, currency: 'CAD' },
                createdAt: '2026-03-15T00:00:00Z'
            };

            const result = normalizeSquareOrder(order);

            expect(result.line_items).toBe(order.lineItems);
            expect(result.customer_id).toBe('CUST_1');
            expect(result.location_id).toBe('LOC_1');
            expect(result.total_money).toBe(order.totalMoney);
            expect(result.created_at).toBe('2026-03-15T00:00:00Z');
        });

        it('does NOT overwrite existing snake_case fields', () => {
            const order = {
                customerId: 'CAMEL_ID',
                customer_id: 'SNAKE_ID',
                lineItems: [{ name: 'A' }],
                line_items: [{ name: 'B' }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.customer_id).toBe('SNAKE_ID');
            expect(result.line_items).toEqual([{ name: 'B' }]);
        });

        it('normalizes discount fields (catalogObjectId, appliedMoney, amountMoney)', () => {
            const order = {
                discounts: [{
                    catalogObjectId: 'DISC_1',
                    appliedMoney: { amount: 500n, currency: 'CAD' },
                    amountMoney: { amount: 500n, currency: 'CAD' }
                }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.discounts[0].catalog_object_id).toBe('DISC_1');
            expect(result.discounts[0].applied_money).toBe(order.discounts[0].appliedMoney);
            expect(result.discounts[0].amount_money).toBe(order.discounts[0].amountMoney);
        });

        it('normalizes line item fields', () => {
            const order = {
                lineItems: [{
                    catalogObjectId: 'VAR_1',
                    totalMoney: { amount: 2000n, currency: 'CAD' },
                    basePriceMoney: { amount: 1000n, currency: 'CAD' },
                    variationName: 'Large'
                }]
            };

            const result = normalizeSquareOrder(order);
            const item = result.line_items[0];

            expect(item.catalog_object_id).toBe('VAR_1');
            expect(item.total_money).toBe(order.lineItems[0].totalMoney);
            expect(item.base_price_money).toBe(order.lineItems[0].basePriceMoney);
            expect(item.variation_name).toBe('Large');
        });

        it('normalizes tender fields (customerId)', () => {
            const order = {
                tenders: [{ customerId: 'CUST_2', type: 'CARD' }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.tenders[0].customer_id).toBe('CUST_2');
        });

        it('normalizes fulfillment fields (pickupDetails, recipient fields)', () => {
            const order = {
                fulfillments: [{
                    pickupDetails: {
                        recipient: {
                            phoneNumber: '555-1234',
                            emailAddress: 'test@example.com',
                            displayName: 'Jane Doe'
                        }
                    }
                }]
            };

            const result = normalizeSquareOrder(order);
            const f = result.fulfillments[0];

            expect(f.pickup_details).toBe(order.fulfillments[0].pickupDetails);
            expect(f.pickup_details.recipient.phone_number).toBe('555-1234');
            expect(f.pickup_details.recipient.email_address).toBe('test@example.com');
            expect(f.pickup_details.recipient.display_name).toBe('Jane Doe');
        });

        it('handles order with no discounts/tenders/fulfillments', () => {
            const order = { id: 'ORDER_1', state: 'COMPLETED' };

            const result = normalizeSquareOrder(order);

            expect(result).toEqual({ id: 'ORDER_1', state: 'COMPLETED' });
        });
    });

    describe('fetchFullOrder', () => {
        it('fetches and normalizes order from Square', async () => {
            const squareOrder = {
                id: 'ORDER_1',
                customerId: 'CUST_1',
                lineItems: [{ catalogObjectId: 'VAR_1' }]
            };
            mockSquareClient.orders.get.mockResolvedValue({ order: squareOrder });

            const result = await fetchFullOrder('ORDER_1', 1);

            expect(getSquareClientForMerchant).toHaveBeenCalledWith(1);
            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'ORDER_1' });
            expect(result.customer_id).toBe('CUST_1');
            expect(result.line_items[0].catalog_object_id).toBe('VAR_1');
        });

        it('returns null when order response has no order', async () => {
            mockSquareClient.orders.get.mockResolvedValue({});

            const result = await fetchFullOrder('ORDER_1', 1);

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                'Order fetch returned no order',
                expect.objectContaining({ orderId: 'ORDER_1' })
            );
        });

        it('returns null when Square API throws error', async () => {
            mockSquareClient.orders.get.mockRejectedValue(new Error('UNAUTHORIZED'));

            const result = await fetchFullOrder('ORDER_1', 1);

            expect(result).toBeNull();
        });

        it('logs error on fetch failure', async () => {
            mockSquareClient.orders.get.mockRejectedValue(new Error('UNAUTHORIZED'));

            await fetchFullOrder('ORDER_1', 1);

            expect(logger.error).toHaveBeenCalledWith(
                'Failed to fetch order from Square API',
                expect.objectContaining({
                    orderId: 'ORDER_1',
                    merchantId: 1,
                    error: 'UNAUTHORIZED'
                })
            );
        });
    });
});
