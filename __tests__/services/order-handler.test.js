/**
 * Tests for Order Webhook Handler
 *
 * Covers P0-API-1 through P0-API-4 optimizations:
 * - P0-API-1: Using complete webhook order data instead of fetching from API
 * - P0-API-2: Incremental velocity updates
 * - P0-API-3: Fulfillment handler optimization
 * - P0-API-4: Debounced committed inventory sync
 */

// Mock dependencies BEFORE requiring the module
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

const mockSyncCommittedInventory = jest.fn().mockResolvedValue({ synced: true });
const mockUpdateSalesVelocityFromOrder = jest.fn().mockResolvedValue({ updated: 3, skipped: 0, periods: [91, 182, 365] });

jest.mock('../../utils/square-api', () => ({
    syncCommittedInventory: mockSyncCommittedInventory,
    updateSalesVelocityFromOrder: mockUpdateSalesVelocityFromOrder
}));

jest.mock('../../utils/delivery-api', () => ({
    getSettings: jest.fn().mockResolvedValue({ auto_ingest_ready_orders: true }),
    ingestSquareOrder: jest.fn().mockResolvedValue({ id: 'delivery-123', customer_name: 'Test Customer' }),
    handleSquareOrderUpdate: jest.fn().mockResolvedValue({})
}));

jest.mock('../../utils/loyalty-service', () => ({
    processOrderForLoyalty: jest.fn().mockResolvedValue({ processed: true, purchasesRecorded: [], customerId: 'cust-123' }),
    detectRewardRedemptionFromOrder: jest.fn().mockResolvedValue({ detected: false }),
    processOrderRefundsForLoyalty: jest.fn().mockResolvedValue({ processed: false }),
    getSquareAccessToken: jest.fn().mockResolvedValue('test-access-token'),
    createRewardDiscount: jest.fn().mockResolvedValue({})
}));

const mockOrdersGet = jest.fn();
const mockGetSquareClientForMerchant = jest.fn().mockResolvedValue({
    orders: { get: mockOrdersGet }
});

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: mockGetSquareClientForMerchant
}));

jest.mock('../../config/constants', () => ({
    FEATURE_FLAGS: {
        USE_NEW_LOYALTY_SERVICE: false
    }
}));

// Now require the module after mocks are set up
const OrderHandler = require('../../services/webhook-handlers/order-handler');

describe('OrderHandler', () => {
    let handler;

    beforeEach(() => {
        jest.clearAllMocks();
        handler = new OrderHandler();

        // Default mock for orders.get
        mockOrdersGet.mockResolvedValue({
            order: {
                id: 'order-123',
                state: 'COMPLETED',
                location_id: 'loc-123',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }
                ]
            }
        });
    });

    describe('P0-API-1: Complete Webhook Order Data Usage', () => {
        it('should use complete webhook order data without API fetch', async () => {
            const completeOrder = {
                id: 'order-456',
                state: 'OPEN',
                location_id: 'loc-123',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '3', total_money: { amount: 1500 } }
                ],
                fulfillments: []
            };

            const context = {
                data: { order_created: completeOrder },
                merchantId: 1,
                event: { type: 'order.created' }
            };

            await handler.handleOrderCreatedOrUpdated(context);

            // Should NOT have fetched from API since webhook has complete data
            expect(mockGetSquareClientForMerchant).not.toHaveBeenCalled();
        });

        it('should fetch from API when webhook data is incomplete (no line_items)', async () => {
            const incompleteOrder = {
                id: 'order-789',
                state: 'OPEN'
                // No line_items array
            };

            const context = {
                data: { order_created: incompleteOrder },
                merchantId: 1,
                event: { type: 'order.created' }
            };

            await handler.handleOrderCreatedOrUpdated(context);

            // Should have fetched from API since webhook lacks line_items
            expect(mockGetSquareClientForMerchant).toHaveBeenCalledWith(1);
        });

        it('should fetch from API when webhook has empty line_items', async () => {
            const emptyLineItems = {
                id: 'order-789',
                state: 'OPEN',
                line_items: []
            };

            const context = {
                data: { order_created: emptyLineItems },
                merchantId: 1,
                event: { type: 'order.created' }
            };

            await handler.handleOrderCreatedOrUpdated(context);

            // Should have fetched from API since line_items is empty
            expect(mockGetSquareClientForMerchant).toHaveBeenCalledWith(1);
        });

        it('should handle order_updated event structure', async () => {
            const updatedOrder = {
                id: 'order-999',
                state: 'COMPLETED',
                location_id: 'loc-456',
                line_items: [
                    { catalog_object_id: 'var-2', quantity: '1', total_money: { amount: 500 } }
                ]
            };

            const context = {
                data: { order_updated: updatedOrder },
                merchantId: 1,
                event: { type: 'order.updated' }
            };

            await handler.handleOrderCreatedOrUpdated(context);

            // Should NOT have fetched from API
            expect(mockGetSquareClientForMerchant).not.toHaveBeenCalled();
        });

        it('should skip processing when no order ID is available', async () => {
            const context = {
                data: { some_other_field: 'value' },
                merchantId: 1,
                event: { type: 'order.created' }
            };

            const result = await handler.handleOrderCreatedOrUpdated(context);

            expect(result.skipped).toBe(true);
            expect(result.reason).toBe('No order ID in webhook');
        });
    });

    describe('P0-API-2: Incremental Velocity Updates', () => {
        it('should call updateSalesVelocityFromOrder for COMPLETED orders', async () => {
            const completedOrder = {
                id: 'order-completed-1',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '5', total_money: { amount: 2500 } }
                ]
            };

            const context = {
                data: { order_updated: completedOrder },
                merchantId: 1,
                event: { type: 'order.updated' }
            };

            await handler.handleOrderCreatedOrUpdated(context);

            expect(mockUpdateSalesVelocityFromOrder).toHaveBeenCalledWith(
                completedOrder,
                1
            );
        });

        it('should NOT call velocity update for non-COMPLETED orders', async () => {
            const openOrder = {
                id: 'order-open-1',
                state: 'OPEN',
                location_id: 'loc-123',
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }
                ]
            };

            const context = {
                data: { order_created: openOrder },
                merchantId: 1,
                event: { type: 'order.created' }
            };

            await handler.handleOrderCreatedOrUpdated(context);

            expect(mockUpdateSalesVelocityFromOrder).not.toHaveBeenCalled();
        });

        it('should include velocity result in response for completed orders', async () => {
            const completedOrder = {
                id: 'order-completed-2',
                state: 'COMPLETED',
                location_id: 'loc-123',
                closed_at: new Date().toISOString(),
                line_items: [
                    { catalog_object_id: 'var-1', quantity: '3', total_money: { amount: 1500 } }
                ]
            };

            const context = {
                data: { order_updated: completedOrder },
                merchantId: 1,
                event: { type: 'order.updated' }
            };

            const result = await handler.handleOrderCreatedOrUpdated(context);

            expect(result.salesVelocity).toBeDefined();
            expect(result.salesVelocity.method).toBe('incremental');
            expect(result.salesVelocity.updated).toBe(3);
            expect(result.salesVelocity.periods).toEqual([91, 182, 365]);
        });
    });

    describe('P0-API-3: Fulfillment Handler Optimization', () => {
        it('should fetch order for COMPLETED fulfillment velocity update', async () => {
            mockOrdersGet.mockResolvedValueOnce({
                order: {
                    id: 'order-fulfillment-1',
                    state: 'COMPLETED',
                    location_id: 'loc-123',
                    line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 500 } }]
                }
            });

            const context = {
                data: {
                    order_id: 'order-fulfillment-1',
                    fulfillment: {
                        uid: 'fulfillment-123',
                        state: 'COMPLETED',
                        type: 'DELIVERY'
                    }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            await handler.handleFulfillmentUpdated(context);

            // Should fetch the order (1 API call vs 37 for full sync)
            expect(mockGetSquareClientForMerchant).toHaveBeenCalledWith(1);
        });

        it('should call velocity update for completed fulfillment with completed order', async () => {
            const mockOrder = {
                id: 'order-fulfillment-2',
                state: 'COMPLETED',
                location_id: 'loc-123',
                line_items: [{ catalog_object_id: 'var-1', quantity: '2', total_money: { amount: 1000 } }]
            };

            mockOrdersGet.mockResolvedValueOnce({ order: mockOrder });

            const context = {
                data: {
                    order_id: 'order-fulfillment-2',
                    fulfillment: {
                        uid: 'fulfillment-456',
                        state: 'COMPLETED',
                        type: 'DELIVERY'
                    }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            await handler.handleFulfillmentUpdated(context);

            expect(mockUpdateSalesVelocityFromOrder).toHaveBeenCalledWith(
                mockOrder,
                1
            );
        });

        it('should NOT call velocity update for non-COMPLETED fulfillment states', async () => {
            const context = {
                data: {
                    order_id: 'order-fulfillment-3',
                    fulfillment: {
                        uid: 'fulfillment-789',
                        state: 'PROPOSED',  // Not COMPLETED
                        type: 'DELIVERY'
                    }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            await handler.handleFulfillmentUpdated(context);

            // Should NOT have called velocity update
            expect(mockUpdateSalesVelocityFromOrder).not.toHaveBeenCalled();
        });

        it('should include fromFulfillment flag in velocity result', async () => {
            const mockOrder = {
                id: 'order-fulfillment-4',
                state: 'COMPLETED',
                location_id: 'loc-123',
                line_items: [{ catalog_object_id: 'var-1', quantity: '1', total_money: { amount: 500 } }]
            };

            mockOrdersGet.mockResolvedValueOnce({ order: mockOrder });

            const context = {
                data: {
                    order_id: 'order-fulfillment-4',
                    fulfillment: {
                        uid: 'fulfillment-101',
                        state: 'COMPLETED',
                        type: 'SHIPMENT'
                    }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(context);

            expect(result.salesVelocity).toBeDefined();
            expect(result.salesVelocity.fromFulfillment).toBe(true);
        });
    });

    describe('P0-API-4: Debounced Committed Inventory Sync', () => {
        it('should return committedInventory in result', async () => {
            const order = {
                id: 'order-debounce-1',
                state: 'OPEN',
                location_id: 'loc-123',
                line_items: [{ catalog_object_id: 'var-1', quantity: '1', total_money: { amount: 500 } }]
            };

            const context = {
                data: { order_created: order },
                merchantId: 100,  // Use unique merchantId
                event: { type: 'order.created' }
            };

            const result = await handler.handleOrderCreatedOrUpdated(context);

            // The handler should set committedInventory field
            expect(result.committedInventory).toBeDefined();
        });

        it('should handle fulfillment webhook with debouncing', async () => {
            const context = {
                data: {
                    order_id: 'order-debounce-fulfillment',
                    fulfillment: {
                        uid: 'fulfillment-debounce',
                        state: 'PROPOSED',
                        type: 'DELIVERY'
                    }
                },
                merchantId: 101,  // Use unique merchantId
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(context);

            // The handler should set committedInventory field
            expect(result.committedInventory).toBeDefined();
        });
    });

    describe('Error Handling', () => {
        it('should handle missing merchantId gracefully', async () => {
            const context = {
                data: { order_created: { id: 'order-1' } },
                merchantId: null,
                event: { type: 'order.created' }
            };

            const result = await handler.handleOrderCreatedOrUpdated(context);

            expect(result.error).toBe('Merchant not found');
        });

        it('should handle WEBHOOK_ORDER_SYNC disabled', async () => {
            const originalEnv = process.env.WEBHOOK_ORDER_SYNC;
            process.env.WEBHOOK_ORDER_SYNC = 'false';

            const context = {
                data: { order_created: { id: 'order-1' } },
                merchantId: 1,
                event: { type: 'order.created' }
            };

            const result = await handler.handleOrderCreatedOrUpdated(context);

            expect(result.skipped).toBe(true);

            process.env.WEBHOOK_ORDER_SYNC = originalEnv;
        });

        it('should handle API fetch error gracefully', async () => {
            mockGetSquareClientForMerchant.mockResolvedValueOnce({
                orders: {
                    get: jest.fn().mockRejectedValue(new Error('API Error'))
                }
            });

            const context = {
                data: { order_created: { id: 'order-error-1' } },  // Incomplete - will trigger fetch
                merchantId: 1,
                event: { type: 'order.created' }
            };

            // Should not throw
            const result = await handler.handleOrderCreatedOrUpdated(context);
            expect(result.handled).toBe(true);
        });

        it('should handle fulfillment webhook disabled', async () => {
            const originalEnv = process.env.WEBHOOK_ORDER_SYNC;
            process.env.WEBHOOK_ORDER_SYNC = 'false';

            const context = {
                data: {
                    order_id: 'order-1',
                    fulfillment: { state: 'COMPLETED', type: 'DELIVERY' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(context);

            expect(result.skipped).toBe(true);

            process.env.WEBHOOK_ORDER_SYNC = originalEnv;
        });

        it('should handle missing merchantId in fulfillment', async () => {
            const context = {
                data: {
                    order_id: 'order-1',
                    fulfillment: { state: 'COMPLETED' }
                },
                merchantId: null,
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(context);

            expect(result.error).toBe('Merchant not found');
        });
    });

    describe('Payment Handlers', () => {
        it('should process loyalty for completed payment', async () => {
            mockOrdersGet.mockResolvedValueOnce({
                order: {
                    id: 'order-payment-1',
                    state: 'COMPLETED',
                    line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 500 } }]
                }
            });

            const context = {
                data: {
                    id: 'payment-123',
                    order_id: 'order-payment-1',
                    status: 'COMPLETED'
                },
                merchantId: 1,
                event: { type: 'payment.updated' }
            };

            const result = await handler.handlePaymentUpdated(context);

            expect(result.handled).toBe(true);
        });

        it('should skip non-completed payments', async () => {
            const context = {
                data: {
                    id: 'payment-pending',
                    order_id: 'order-payment-2',
                    status: 'PENDING'
                },
                merchantId: 1,
                event: { type: 'payment.updated' }
            };

            const result = await handler.handlePaymentUpdated(context);

            expect(result.handled).toBe(true);
            expect(result.loyalty).toBeUndefined();
        });

        it('should handle missing merchantId in payment', async () => {
            const context = {
                data: {
                    id: 'payment-123',
                    order_id: 'order-1',
                    status: 'COMPLETED'
                },
                merchantId: null,
                event: { type: 'payment.updated' }
            };

            const result = await handler.handlePaymentUpdated(context);

            expect(result.handled).toBe(true);
        });
    });

    describe('Refund Handlers', () => {
        it('should skip non-completed refunds', async () => {
            const context = {
                data: {
                    id: 'refund-123',
                    order_id: 'order-refund-1',
                    status: 'PENDING'
                },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(context);

            expect(result.handled).toBe(true);
            expect(result.loyaltyRefunds).toBeUndefined();
        });

        it('should handle WEBHOOK_ORDER_SYNC disabled for refunds', async () => {
            const originalEnv = process.env.WEBHOOK_ORDER_SYNC;
            process.env.WEBHOOK_ORDER_SYNC = 'false';

            const context = {
                data: {
                    id: 'refund-123',
                    order_id: 'order-1',
                    status: 'COMPLETED'
                },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(context);

            expect(result.handled).toBe(true);

            process.env.WEBHOOK_ORDER_SYNC = originalEnv;
        });
    });
});
