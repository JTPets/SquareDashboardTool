/**
 * Tests for Fix 2: Early dedup for customer identification in payment webhooks
 *
 * Verifies that _processPaymentForLoyalty uses cached customer_id from
 * the orderProcessingCache (Fix 3) to skip the expensive 6-method
 * identification chain.
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

const mockIdentifyFn = jest.fn().mockResolvedValue({
    customerId: 'cust_from_chain',
    method: 'tender.customer_id',
    success: true
});

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
        identifyCustomerFromOrder: mockIdentifyFn,
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
const OrderHandler = require('../../services/webhook-handlers/order-handler');

describe('Fix 2: Early dedup for customer identification', () => {
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

    describe('cached customer_id → skips identification chain', () => {
        it('should use cached customer_id and skip identifyCustomerForOrder', async () => {
            // Cache has customer from order.* webhook (but points not awarded — partial)
            cache.set('order_123:1', {
                customerId: 'cust_cached',
                pointsAwarded: false,
                redemptionChecked: false
            });

            const context = {
                data: { id: 'pay_1', order_id: 'order_123', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'payment.updated' },
                entityId: 'pay_1'
            };

            await handler.handlePaymentUpdated(context);

            // Should NOT call the identification chain
            expect(mockIdentifyFn).not.toHaveBeenCalled();

            // Should pass cached customer_id to processLoyaltyOrder
            expect(processLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    squareCustomerId: 'cust_cached',
                    customerSource: 'cached'
                })
            );

            // Should log debug about using cached customer
            expect(logger.debug).toHaveBeenCalledWith(
                'Payment webhook using cached customer_id',
                expect.objectContaining({
                    customerId: 'cust_cached'
                })
            );
        });
    });

    describe('no cached customer → runs full identification chain', () => {
        it('should run full identification when cache has no customer_id', async () => {
            // Cache entry exists but no customer was identified
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

            await handler.handlePaymentUpdated(context);

            // SHOULD call the identification chain
            expect(mockIdentifyFn).toHaveBeenCalled();

            // Should pass chain result to processLoyaltyOrder
            expect(processLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    squareCustomerId: 'cust_from_chain'
                })
            );
        });
    });

    describe('cache miss → runs full identification chain', () => {
        it('should run full identification when no cache entry exists', async () => {
            // No cache entry at all
            const context = {
                data: { id: 'pay_1', order_id: 'order_999', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'payment.created' },
                entityId: 'pay_1'
            };

            await handler.handlePaymentCreated(context);

            // SHOULD call the identification chain
            expect(mockIdentifyFn).toHaveBeenCalled();

            // Should use chain result
            expect(processLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    squareCustomerId: 'cust_from_chain'
                })
            );
        });
    });
});
