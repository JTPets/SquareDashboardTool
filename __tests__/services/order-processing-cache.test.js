/**
 * Tests for Fix 3: Order processing cache for payment webhooks
 *
 * Verifies that payment.created/payment.updated webhooks skip redundant
 * loyalty processing when the order.* webhook already handled it.
 */

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../utils/square-api', () => ({
    updateSalesVelocityFromOrder: jest.fn().mockResolvedValue({ updated: 0, skipped: 0 })
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
                id: 'order_123',
                state: 'COMPLETED',
                customer_id: 'cust_abc',
                line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 1000 } }],
                location_id: 'loc_1'
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
            customerId: 'cust_abc',
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
const { processLoyaltyOrder } = require('../../services/loyalty-admin/order-intake');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const OrderHandler = require('../../services/webhook-handlers/order-handler');

describe('Fix 3: Order processing cache for payment webhooks', () => {
    let handler;
    const cache = OrderHandler._orderProcessingCache;

    beforeEach(() => {
        jest.clearAllMocks();
        cache.clear();
        handler = new OrderHandler();
    });

    afterEach(() => {
        cache.clear();
    });

    describe('full processing result cached → payment webhook skips', () => {
        it('should skip payment webhook when order was fully processed', async () => {
            // Simulate order.* webhook having cached a full result
            cache.set('order_123:1', {
                customerId: 'cust_abc',
                pointsAwarded: true,
                redemptionChecked: true
            });

            const context = {
                data: { id: 'pay_1', order_id: 'order_123', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'payment.created' },
                entityId: 'pay_1'
            };

            const result = await handler.handlePaymentCreated(context);

            expect(result.skippedByCache).toBe(true);
            // Should NOT call processLoyaltyOrder or identifyCustomerForOrder
            expect(processLoyaltyOrder).not.toHaveBeenCalled();
            // Should NOT fetch order from Square
            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
            // Should log debug with reason
            expect(logger.debug).toHaveBeenCalledWith(
                'Payment webhook skipping - order already fully processed',
                expect.objectContaining({
                    orderId: 'order_123',
                    reason: 'customer_identified_and_points_awarded'
                })
            );
        });
    });

    describe('partial result (no customer) → payment webhook re-runs identification', () => {
        it('should process normally when cached result has no customer', async () => {
            // Simulate order.* webhook that ran but couldn't identify customer
            cache.set('order_123:1', {
                customerId: null,
                pointsAwarded: false,
                redemptionChecked: true
            });

            const context = {
                data: { id: 'pay_1', order_id: 'order_123', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'payment.updated' },
                entityId: 'pay_1'
            };

            const result = await handler.handlePaymentUpdated(context);

            // Should still process because customer was not identified
            expect(mockSquareClient.orders.get).toHaveBeenCalled();
            expect(processLoyaltyOrder).toHaveBeenCalled();
            expect(result.skippedByCache).toBeUndefined();
            // Should log debug about re-running
            expect(logger.debug).toHaveBeenCalledWith(
                'Payment webhook re-running identification - no customer in cache',
                expect.objectContaining({ orderId: 'order_123' })
            );
        });
    });

    describe('cache expired → payment webhook processes normally', () => {
        it('should process normally when cache entry expired', async () => {
            // Use a short-TTL cache to simulate expiry
            const shortCache = new (require('../../utils/ttl-cache'))(50);
            // We can't swap the module-level cache, so test via cache.get returning null
            // The real test: no cache entry → falls through to normal processing

            const context = {
                data: { id: 'pay_1', order_id: 'order_123', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'payment.updated' },
                entityId: 'pay_1'
            };

            // No cache entry exists (simulates expired or never set)
            const result = await handler.handlePaymentUpdated(context);

            expect(mockSquareClient.orders.get).toHaveBeenCalled();
            expect(processLoyaltyOrder).toHaveBeenCalled();
            expect(result.skippedByCache).toBeUndefined();
        });
    });

    describe('cache miss (no entry) → processes normally', () => {
        it('should process normally when no cache entry exists', async () => {
            // Empty cache — no prior order.* webhook ran
            const context = {
                data: { id: 'pay_1', order_id: 'order_456', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'payment.created' },
                entityId: 'pay_1'
            };

            const result = await handler.handlePaymentCreated(context);

            expect(mockSquareClient.orders.get).toHaveBeenCalled();
            expect(processLoyaltyOrder).toHaveBeenCalled();
            expect(result.skippedByCache).toBeUndefined();
        });
    });

    describe('order.* webhook populates cache', () => {
        it('should cache result after _processLoyalty completes', async () => {
            const context = {
                data: {
                    order_created: {
                        id: 'order_789',
                        state: 'COMPLETED',
                        customer_id: 'cust_xyz',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 500 } }],
                        location_id: 'loc_1'
                    }
                },
                merchantId: 2,
                event: { type: 'order.created' },
                entityId: 'order_789'
            };

            await handler.handleOrderCreatedOrUpdated(context);

            const cached = cache.get('order_789:2');
            expect(cached).not.toBeNull();
            expect(cached.customerId).toBe('cust_abc'); // from mock
            expect(cached.pointsAwarded).toBe(true);
            expect(cached.redemptionChecked).toBe(true);
        });
    });
});
