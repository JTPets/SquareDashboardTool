/**
 * Tests for handler-level velocity dedup in order-handler.js
 *
 * Verifies that duplicate order.updated webhooks for the same COMPLETED order
 * are caught by the completedOrderVelocityCache BEFORE calling the velocity
 * update function. Also covers cross-handler dedup between order.updated
 * and order.fulfillment.updated.
 */

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const mockUpdateVelocity = jest.fn().mockResolvedValue({ updated: 3, skipped: 0, periods: [91, 182, 365] });

jest.mock('../../utils/square-api', () => ({
    updateSalesVelocityFromOrder: mockUpdateVelocity
}));

jest.mock('../../utils/loyalty-service', () => ({
    detectRewardRedemptionFromOrder: jest.fn().mockResolvedValue({ detected: false }),
    matchEarnedRewardByFreeItem: jest.fn().mockResolvedValue(null),
    matchEarnedRewardByDiscountAmount: jest.fn().mockResolvedValue(null),
    processOrderRefundsForLoyalty: jest.fn().mockResolvedValue({ processed: false }),
    isOrderAlreadyProcessedForLoyalty: jest.fn().mockResolvedValue(false),
    getSquareAccessToken: jest.fn().mockResolvedValue('test-token')
}));

jest.mock('../../utils/delivery-api', () => ({
    getSettings: jest.fn().mockResolvedValue({ auto_ingest_ready_orders: false }),
    ingestSquareOrder: jest.fn().mockResolvedValue(null),
    handleSquareOrderUpdate: jest.fn().mockResolvedValue(),
    getOrderBySquareId: jest.fn().mockResolvedValue(null),
    updateOrder: jest.fn().mockResolvedValue()
}));

jest.mock('../../utils/subscription-handler', () => ({
    handleSubscriptionWebhook: jest.fn().mockResolvedValue({ processed: true }),
    logEvent: jest.fn().mockResolvedValue()
}));

const mockSquareClient = {
    orders: {
        get: jest.fn().mockResolvedValue({
            order: {
                id: 'order_dedup_1',
                state: 'COMPLETED',
                customer_id: 'cust_1',
                line_items: [{ catalog_object_id: 'var_1', quantity: '2', total_money: { amount: 2000 } }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }
        })
    }
};

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient),
    loadMerchantContext: jest.fn(),
    requireMerchant: jest.fn()
}));

jest.mock('../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn().mockResolvedValue({
        alreadyProcessed: false,
        purchaseEvents: [{ id: 1 }],
        rewardEarned: false
    })
}));

jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue({}),
        identifyCustomerFromOrder: jest.fn().mockResolvedValue({
            customerId: 'cust_1',
            method: 'order.customer_id',
            success: true
        }),
        getCustomerDetails: jest.fn().mockResolvedValue(null)
    }))
}));

jest.mock('../../services/cart/cart-activity-service', () => ({
    createFromDraftOrder: jest.fn().mockResolvedValue(null),
    markConverted: jest.fn().mockResolvedValue(null),
    markCanceled: jest.fn().mockResolvedValue(null)
}));

jest.mock('../../config/constants', () => ({
    SQUARE: { API_VERSION: '2024-01-01' }
}));

const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');
const OrderHandler = require('../../services/webhook-handlers/order-handler');

describe('Handler-level velocity dedup (completedOrderVelocityCache)', () => {
    let handler;
    const velocityCache = OrderHandler._completedOrderVelocityCache;

    const completedOrderData = {
        order_updated: {
            id: 'order_dedup_1',
            state: 'COMPLETED',
            customer_id: 'cust_1',
            line_items: [{ catalog_object_id: 'var_1', quantity: '2', total_money: { amount: 2000 } }],
            location_id: 'loc_1',
            closed_at: new Date().toISOString()
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        velocityCache.clear();
        OrderHandler._orderProcessingCache.clear();
        handler = new OrderHandler();
    });

    afterEach(() => {
        velocityCache.clear();
        OrderHandler._orderProcessingCache.clear();
    });

    it('should call velocity update on first order.updated webhook', async () => {
        const context = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        const result = await handler.handleOrderCreatedOrUpdated(context);

        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);
        expect(result.salesVelocity).toEqual(expect.objectContaining({
            method: 'incremental',
            updated: 3
        }));
        expect(result.salesVelocity.deduplicated).toBeUndefined();
    });

    it('should skip velocity update on second order.updated webhook for same order', async () => {
        const context = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        // First call — processes normally
        await handler.handleOrderCreatedOrUpdated(context);
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);

        jest.clearAllMocks();

        // Second call — should be deduped
        const result = await handler.handleOrderCreatedOrUpdated(context);

        expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
        expect(result.salesVelocity).toEqual(expect.objectContaining({
            method: 'incremental',
            deduplicated: true
        }));
        expect(logger.debug).toHaveBeenCalledWith(
            'Sales velocity dedup — skipping duplicate order webhook',
            expect.objectContaining({
                orderId: 'order_dedup_1',
                merchantId: 1
            })
        );
    });

    it('should skip all 4 subsequent webhooks in a rapid-fire burst', async () => {
        const context = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        // Simulate 5 rapid-fire webhooks (first processes, 4 deduped)
        const results = [];
        for (let i = 0; i < 5; i++) {
            results.push(await handler.handleOrderCreatedOrUpdated(context));
        }

        // Velocity function called exactly ONCE
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);

        // First result has real update
        expect(results[0].salesVelocity.updated).toBe(3);
        expect(results[0].salesVelocity.deduplicated).toBeUndefined();

        // Subsequent results are deduped
        for (let i = 1; i < 5; i++) {
            expect(results[i].salesVelocity.deduplicated).toBe(true);
        }
    });

    it('should process different order IDs independently', async () => {
        const context1 = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        const context2 = {
            data: {
                order_updated: {
                    ...completedOrderData.order_updated,
                    id: 'order_dedup_2'
                }
            },
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_2'
        };

        await handler.handleOrderCreatedOrUpdated(context1);
        await handler.handleOrderCreatedOrUpdated(context2);

        // Both should call velocity update
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(2);
    });

    it('should dedup fulfillment.updated when order.updated already processed', async () => {
        // First: order.updated processes velocity
        const orderContext = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };
        await handler.handleOrderCreatedOrUpdated(orderContext);
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);

        jest.clearAllMocks();

        // Second: fulfillment.updated for same order — should be deduped
        const fulfillmentContext = {
            data: {
                order_id: 'order_dedup_1',
                fulfillment: { uid: 'ful_1', state: 'COMPLETED' }
            },
            merchantId: 1,
            event: { type: 'order.fulfillment.updated' },
            entityId: 'order_dedup_1'
        };
        const result = await handler.handleFulfillmentUpdated(fulfillmentContext);

        // Should NOT call velocity update or fetch order from Square
        expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
        expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        expect(result.salesVelocity).toEqual(expect.objectContaining({
            deduplicated: true,
            fromFulfillment: true
        }));
        expect(logger.debug).toHaveBeenCalledWith(
            'Sales velocity dedup — skipping duplicate fulfillment webhook',
            expect.objectContaining({
                orderId: 'order_dedup_1',
                merchantId: 1
            })
        );
    });

    it('should not log INFO when velocity update returns 0', async () => {
        mockUpdateVelocity.mockResolvedValueOnce({ updated: 0, skipped: 0, reason: 'Already processed (dedup)' });

        const context = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        await handler.handleOrderCreatedOrUpdated(context);

        // Should NOT log "Sales velocity updated incrementally" at INFO
        const velocityInfoCalls = logger.info.mock.calls.filter(
            call => call[0]?.includes?.('Sales velocity updated incrementally')
        );
        expect(velocityInfoCalls).toHaveLength(0);
    });

    it('should not dedup non-COMPLETED orders', async () => {
        const draftContext = {
            data: {
                order_updated: {
                    ...completedOrderData.order_updated,
                    state: 'OPEN'
                }
            },
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        await handler.handleOrderCreatedOrUpdated(draftContext);

        // Velocity update should NOT be called (order not COMPLETED)
        expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
        // Cache should NOT have an entry
        expect(velocityCache.has('order_dedup_1:1')).toBe(false);
    });

    it('should process same order again after cache expires', async () => {
        const context = {
            data: completedOrderData,
            merchantId: 1,
            event: { type: 'order.updated' },
            entityId: 'order_dedup_1'
        };

        // First call
        await handler.handleOrderCreatedOrUpdated(context);
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);

        // Manually expire the cache entry
        velocityCache.cache.set('order_dedup_1:1', {
            value: true,
            expires: Date.now() - 1000
        });

        jest.clearAllMocks();

        // Second call after expiry — should process again
        await handler.handleOrderCreatedOrUpdated(context);
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);
    });
});
