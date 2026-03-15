/**
 * Tests for LoyaltyHandler (services/webhook-handlers/loyalty-handler.js)
 *
 * Covers all public methods and private method behavior tested through
 * public entry points:
 * - handleLoyaltyEventCreated (+ _processLoyaltyEventWithOrder, _processRedemptionEvent, _processLoyaltyEventReverseLookup)
 * - handleLoyaltyAccountUpdated / handleLoyaltyAccountCreated (+ _handleLoyaltyAccountChange)
 * - handleLoyaltyProgramUpdated
 * - handleGiftCardCustomerLinked
 */

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};
jest.mock('../../../utils/logger', () => logger);

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../../services/loyalty-admin', () => ({
    isOrderAlreadyProcessedForLoyalty: jest.fn(),
    runLoyaltyCatchup: jest.fn(),
    detectRewardRedemptionFromOrder: jest.fn()
}));

jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn()
}));

const mockSquareClientInstance = {
    initialize: jest.fn(),
    getLoyaltyAccount: jest.fn(),
    getOrder: jest.fn()
};

jest.mock('../../../services/loyalty-admin/square-api-client', () => ({
    SquareApiClient: jest.fn().mockImplementation(() => mockSquareClientInstance)
}));

const db = require('../../../utils/database');
const loyaltyService = require('../../../services/loyalty-admin');
const { processLoyaltyOrder } = require('../../../services/loyalty-admin/order-intake');
const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');
const LoyaltyHandler = require('../../../services/webhook-handlers/loyalty-handler');

let handler;

beforeEach(() => {
    jest.clearAllMocks();
    handler = new LoyaltyHandler();
    // Reset default mock implementations
    mockSquareClientInstance.initialize.mockResolvedValue();
    mockSquareClientInstance.getLoyaltyAccount.mockResolvedValue({ customer_id: 'cust_1' });
    mockSquareClientInstance.getOrder.mockResolvedValue({
        id: 'order_1',
        state: 'COMPLETED',
        discounts: []
    });
});

// ─── handleLoyaltyEventCreated ───────────────────────────────────────────────

describe('handleLoyaltyEventCreated', () => {
    const baseContext = (overrides = {}) => ({
        merchantId: 42,
        data: {
            loyalty_event: {
                id: 'evt_1',
                type: 'ACCUMULATE_POINTS',
                loyalty_account_id: 'la_1',
                accumulate_points: { order_id: 'order_1' }
            }
        },
        ...overrides
    });

    test('returns early when WEBHOOK_ORDER_SYNC is false', async () => {
        const origVal = process.env.WEBHOOK_ORDER_SYNC;
        process.env.WEBHOOK_ORDER_SYNC = 'false';
        try {
            const result = await handler.handleLoyaltyEventCreated(baseContext());
            expect(result).toEqual({ handled: true });
            expect(loyaltyService.isOrderAlreadyProcessedForLoyalty).not.toHaveBeenCalled();
        } finally {
            if (origVal === undefined) delete process.env.WEBHOOK_ORDER_SYNC;
            else process.env.WEBHOOK_ORDER_SYNC = origVal;
        }
    });

    test('returns error when no merchantId', async () => {
        const result = await handler.handleLoyaltyEventCreated(baseContext({ merchantId: null }));
        expect(result.error).toBe('Merchant not found');
        expect(logger.warn).toHaveBeenCalledWith(
            'Cannot process loyalty event - merchant not found for webhook'
        );
    });

    test('returns when no loyaltyEvent in data', async () => {
        const result = await handler.handleLoyaltyEventCreated({
            merchantId: 42,
            data: { someOtherKey: true }
        });
        expect(result).toEqual({ handled: true });
        expect(logger.warn).toHaveBeenCalledWith(
            'Loyalty event webhook missing loyalty_event in payload',
            expect.objectContaining({ merchantId: 42 })
        );
    });

    test('extracts orderId from accumulate_points.order_id', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(true);
        const result = await handler.handleLoyaltyEventCreated(baseContext());
        expect(loyaltyService.isOrderAlreadyProcessedForLoyalty).toHaveBeenCalledWith('order_1', 42);
        expect(result.loyaltyEventSkipped).toEqual(expect.objectContaining({ orderId: 'order_1' }));
    });

    test('extracts orderId from redeem_reward.order_id', async () => {
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({
            detected: false
        });
        const ctx = baseContext({
            data: {
                loyalty_event: {
                    id: 'evt_2',
                    type: 'REDEEM_REWARD',
                    loyalty_account_id: 'la_1',
                    redeem_reward: { order_id: 'order_2' }
                }
            }
        });
        await handler.handleLoyaltyEventCreated(ctx);
        // Should go to _processRedemptionEvent which calls getOrder with order_2
        expect(mockSquareClientInstance.getOrder).toHaveBeenCalledWith('order_2');
    });

    test('extracts orderId from loyaltyEvent.order_id (fallback)', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(true);
        const ctx = baseContext({
            data: {
                loyalty_event: {
                    id: 'evt_3',
                    type: 'ACCUMULATE_POINTS',
                    loyalty_account_id: 'la_1',
                    order_id: 'order_fallback'
                }
            }
        });
        await handler.handleLoyaltyEventCreated(ctx);
        expect(loyaltyService.isOrderAlreadyProcessedForLoyalty).toHaveBeenCalledWith('order_fallback', 42);
    });

    test('skips when no loyaltyAccountId', async () => {
        const ctx = baseContext({
            data: {
                loyalty_event: {
                    id: 'evt_4',
                    type: 'ACCUMULATE_POINTS',
                    accumulate_points: { order_id: 'order_1' }
                    // no loyalty_account_id
                }
            }
        });
        const result = await handler.handleLoyaltyEventCreated(ctx);
        expect(result.loyaltyEventSkipped).toEqual({ reason: 'no_loyalty_account_id' });
    });

    test('calls _processLoyaltyEventReverseLookup when only loyaltyAccountId (no orderId)', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
        const ctx = baseContext({
            data: {
                loyalty_event: {
                    id: 'evt_5',
                    type: 'ACCUMULATE_POINTS',
                    loyalty_account_id: 'la_1'
                    // no accumulate_points, no order_id
                }
            }
        });
        await handler.handleLoyaltyEventCreated(ctx);
        expect(SquareApiClient).toHaveBeenCalledWith(42);
        expect(mockSquareClientInstance.getLoyaltyAccount).toHaveBeenCalledWith('la_1');
    });
});

// ─── _processLoyaltyEventWithOrder (via handleLoyaltyEventCreated) ───────────

describe('_processLoyaltyEventWithOrder (non-REDEEM)', () => {
    const accumulateContext = (overrides = {}) => ({
        merchantId: 42,
        data: {
            loyalty_event: {
                id: 'evt_1',
                type: 'ACCUMULATE_POINTS',
                loyalty_account_id: 'la_1',
                accumulate_points: { order_id: 'order_1' }
            }
        },
        ...overrides
    });

    test('skips if order already processed', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(true);
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(result.loyaltyEventSkipped).toEqual({
            orderId: 'order_1',
            reason: 'already_processed',
            eventType: 'ACCUMULATE_POINTS'
        });
        expect(SquareApiClient).not.toHaveBeenCalled();
    });

    test('returns silently when SquareApiClient init fails', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.initialize.mockRejectedValue(new Error('Auth failed'));
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to initialize Square client for loyalty webhook',
            expect.objectContaining({ error: 'Auth failed' })
        );
        expect(result.loyaltyEventRecovery).toBeUndefined();
    });

    test('returns silently when getLoyaltyAccount fails', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.getLoyaltyAccount.mockRejectedValue(new Error('Account not found'));
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to fetch loyalty account',
            expect.objectContaining({ action: 'LOYALTY_ACCOUNT_FETCH_FAILED' })
        );
    });

    test('returns when no customerId on loyalty account', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.getLoyaltyAccount.mockResolvedValue({ customer_id: null });
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(mockSquareClientInstance.getOrder).not.toHaveBeenCalled();
    });

    test('returns when getOrder fails', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.getOrder.mockRejectedValue(new Error('Order API error'));
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to fetch order for loyalty processing',
            expect.objectContaining({ action: 'ORDER_FETCH_FAILED', orderId: 'order_1' })
        );
    });

    test('returns when order state is not COMPLETED', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.getOrder.mockResolvedValue({ id: 'order_1', state: 'OPEN' });
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(processLoyaltyOrder).not.toHaveBeenCalled();
    });

    test('returns when order is null', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.getOrder.mockResolvedValue(null);
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(processLoyaltyOrder).not.toHaveBeenCalled();
    });

    test('calls processLoyaltyOrder and populates result on success', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        mockSquareClientInstance.getOrder.mockResolvedValue({
            id: 'order_1',
            state: 'COMPLETED'
        });
        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: false,
            purchaseEvents: [{ id: 1 }, { id: 2 }]
        });
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(processLoyaltyOrder).toHaveBeenCalledWith({
            order: { id: 'order_1', state: 'COMPLETED' },
            merchantId: 42,
            squareCustomerId: 'cust_1',
            source: 'webhook',
            customerSource: 'loyalty_api'
        });
        expect(result.loyaltyEventRecovery).toEqual({
            orderId: 'order_1',
            customerId: 'cust_1',
            purchasesRecorded: 2
        });
    });

    test('does not populate result when intake says already processed', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: true,
            purchaseEvents: []
        });
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(result.loyaltyEventRecovery).toBeUndefined();
    });

    test('does not populate result when no purchase events', async () => {
        loyaltyService.isOrderAlreadyProcessedForLoyalty.mockResolvedValue(false);
        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: false,
            purchaseEvents: []
        });
        const result = await handler.handleLoyaltyEventCreated(accumulateContext());
        expect(result.loyaltyEventRecovery).toBeUndefined();
    });
});

// ─── _processRedemptionEvent (via REDEEM_REWARD events) ──────────────────────

describe('_processRedemptionEvent (via REDEEM_REWARD)', () => {
    const redeemContext = () => ({
        merchantId: 42,
        data: {
            loyalty_event: {
                id: 'evt_redeem',
                type: 'REDEEM_REWARD',
                loyalty_account_id: 'la_1',
                redeem_reward: { order_id: 'order_r1' }
            }
        }
    });

    test('returns silently when SquareApiClient init fails', async () => {
        mockSquareClientInstance.initialize.mockRejectedValue(new Error('Init boom'));
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to initialize Square client for redemption event',
            expect.objectContaining({ error: 'Init boom' })
        );
        expect(loyaltyService.detectRewardRedemptionFromOrder).not.toHaveBeenCalled();
    });

    test('returns silently when getOrder fails', async () => {
        mockSquareClientInstance.getOrder.mockRejectedValue(new Error('Order fetch boom'));
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to fetch order for redemption processing',
            expect.objectContaining({ action: 'ORDER_FETCH_FAILED', orderId: 'order_r1' })
        );
    });

    test('returns when order not found (null)', async () => {
        mockSquareClientInstance.getOrder.mockResolvedValue(null);
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(logger.warn).toHaveBeenCalledWith(
            'Order not found for REDEEM_REWARD event',
            expect.objectContaining({ orderId: 'order_r1' })
        );
        expect(loyaltyService.detectRewardRedemptionFromOrder).not.toHaveBeenCalled();
    });

    test('populates result with redemptions when detected', async () => {
        const order = { id: 'order_r1', state: 'COMPLETED', discounts: [] };
        mockSquareClientInstance.getOrder.mockResolvedValue(order);
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({
            detected: true,
            redemptions: [
                { rewardId: 'rw_1', offerName: 'Free Treat' },
                { rewardId: 'rw_2', offerName: 'Free Kibble' }
            ]
        });
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(result.loyaltyRedemptions).toEqual([
            { orderId: 'order_r1', rewardId: 'rw_1', offerName: 'Free Treat', source: 'REDEEM_REWARD_WEBHOOK' },
            { orderId: 'order_r1', rewardId: 'rw_2', offerName: 'Free Kibble', source: 'REDEEM_REWARD_WEBHOOK' }
        ]);
        expect(logger.info).toHaveBeenCalledWith(
            'Reward redemption processed via REDEEM_REWARD webhook',
            expect.objectContaining({ rewardId: 'rw_1' })
        );
        expect(logger.info).toHaveBeenCalledWith(
            'Reward redemption processed via REDEEM_REWARD webhook',
            expect.objectContaining({ rewardId: 'rw_2' })
        );
    });

    test('logs error when catalog discounts match known SqTools rewards but detection failed', async () => {
        const order = {
            id: 'order_r1',
            state: 'COMPLETED',
            discounts: [
                { name: 'Free Item', type: 'FIXED_AMOUNT', catalog_object_id: 'disc_sq1', applied_money: { amount: 500 } }
            ]
        };
        mockSquareClientInstance.getOrder.mockResolvedValue(order);
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({ detected: false });
        db.query.mockResolvedValue({
            rows: [{ id: 10, status: 'earned', square_discount_id: 'disc_sq1', square_pricing_rule_id: null }]
        });
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(logger.error).toHaveBeenCalledWith(
            'REDEEM_REWARD matched SqTools reward but redemption detection failed',
            expect.objectContaining({ orderId: 'order_r1', merchantId: 42 })
        );
        expect(result.loyaltyRedemptionNotFound).toEqual(expect.objectContaining({
            orderId: 'order_r1',
            reason: 'unmatched_catalog_discount'
        }));
    });

    test('logs info when catalog discounts are Square-native (not known to SqTools)', async () => {
        const order = {
            id: 'order_r1',
            state: 'COMPLETED',
            discounts: [
                { name: 'Square Reward', type: 'FIXED_AMOUNT', catalog_object_id: 'disc_native', amount_money: { amount: 300 } }
            ]
        };
        mockSquareClientInstance.getOrder.mockResolvedValue(order);
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({ detected: false });
        db.query.mockResolvedValue({ rows: [] });
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(logger.info).toHaveBeenCalledWith(
            'Square-native loyalty reward redeemed — not tracked by SqTools',
            expect.objectContaining({ orderId: 'order_r1', discountIds: ['disc_native'] })
        );
        expect(result.loyaltyRedemptionNotFound.reason).toBe('unmatched_catalog_discount');
    });

    test('logs info when no catalog discounts at all', async () => {
        const order = {
            id: 'order_r1',
            state: 'COMPLETED',
            discounts: [
                { name: 'Manual 10%', type: 'FIXED_PERCENTAGE' }
            ]
        };
        mockSquareClientInstance.getOrder.mockResolvedValue(order);
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({ detected: false });
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(logger.info).toHaveBeenCalledWith(
            'REDEEM_REWARD event — Square-native or manual discount (no catalog discount IDs)',
            expect.objectContaining({ orderId: 'order_r1' })
        );
        expect(result.loyaltyRedemptionNotFound.reason).toBe('no_catalog_discounts');
    });

    test('handles order with no discounts array', async () => {
        const order = { id: 'order_r1', state: 'COMPLETED' };
        mockSquareClientInstance.getOrder.mockResolvedValue(order);
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({ detected: false });
        const result = await handler.handleLoyaltyEventCreated(redeemContext());
        expect(result.loyaltyRedemptionNotFound.reason).toBe('no_catalog_discounts');
        expect(result.loyaltyRedemptionNotFound.discounts).toEqual([]);
    });

    test('does not check isOrderAlreadyProcessedForLoyalty for REDEEM_REWARD', async () => {
        loyaltyService.detectRewardRedemptionFromOrder.mockResolvedValue({ detected: false });
        mockSquareClientInstance.getOrder.mockResolvedValue({ id: 'order_r1', state: 'COMPLETED' });
        await handler.handleLoyaltyEventCreated(redeemContext());
        expect(loyaltyService.isOrderAlreadyProcessedForLoyalty).not.toHaveBeenCalled();
    });
});

// ─── _processLoyaltyEventReverseLookup ───────────────────────────────────────

describe('_processLoyaltyEventReverseLookup (via no-orderId events)', () => {
    const reverseLookupContext = () => ({
        merchantId: 42,
        data: {
            loyalty_event: {
                id: 'evt_rl',
                type: 'OTHER_EVENT',
                loyalty_account_id: 'la_rl'
                // no order_id anywhere
            }
        }
    });

    test('initializes SquareApiClient and fetches loyalty account', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
        await handler.handleLoyaltyEventCreated(reverseLookupContext());
        expect(SquareApiClient).toHaveBeenCalledWith(42);
        expect(mockSquareClientInstance.initialize).toHaveBeenCalled();
        expect(mockSquareClientInstance.getLoyaltyAccount).toHaveBeenCalledWith('la_rl');
    });

    test('returns silently when SquareApiClient init fails', async () => {
        mockSquareClientInstance.initialize.mockRejectedValue(new Error('No token'));
        const result = await handler.handleLoyaltyEventCreated(reverseLookupContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to initialize Square client for reverse lookup',
            expect.objectContaining({ error: 'No token' })
        );
        expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
    });

    test('returns silently when getLoyaltyAccount fails', async () => {
        mockSquareClientInstance.getLoyaltyAccount.mockRejectedValue(new Error('Account boom'));
        await handler.handleLoyaltyEventCreated(reverseLookupContext());
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to fetch loyalty account for reverse lookup',
            expect.objectContaining({ action: 'LOYALTY_ACCOUNT_FETCH_FAILED' })
        );
    });

    test('returns when no customerId on loyalty account', async () => {
        mockSquareClientInstance.getLoyaltyAccount.mockResolvedValue({ customer_id: null });
        await handler.handleLoyaltyEventCreated(reverseLookupContext());
        expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
    });

    test('runs catchup with periodDays 1 and populates result when orders found', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 3 });
        const result = await handler.handleLoyaltyEventCreated(reverseLookupContext());
        expect(loyaltyService.runLoyaltyCatchup).toHaveBeenCalledWith({
            merchantId: 42,
            customerIds: ['cust_1'],
            periodDays: 1,
            maxCustomers: 1
        });
        expect(result.loyaltyCatchup).toEqual({
            customerId: 'cust_1',
            ordersNewlyTracked: 3
        });
    });

    test('does not populate result when no new orders tracked', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
        const result = await handler.handleLoyaltyEventCreated(reverseLookupContext());
        expect(result.loyaltyCatchup).toBeUndefined();
    });
});

// ─── handleLoyaltyAccountUpdated / handleLoyaltyAccountCreated ───────────────

describe.each([
    ['handleLoyaltyAccountUpdated'],
    ['handleLoyaltyAccountCreated']
])('%s', (methodName) => {
    const accountContext = (overrides = {}) => ({
        merchantId: 42,
        data: {
            loyalty_account: {
                id: 'la_acc',
                customer_id: 'cust_acc'
            }
        },
        ...overrides
    });

    test('returns early when no merchantId', async () => {
        const result = await handler[methodName](accountContext({ merchantId: null }));
        expect(result).toEqual({ handled: true });
        expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
    });

    test('returns when no loyalty_account in data', async () => {
        const result = await handler[methodName]({
            merchantId: 42,
            data: { other: true }
        });
        expect(result).toEqual({ handled: true });
        expect(logger.warn).toHaveBeenCalledWith(
            'Loyalty account webhook missing loyalty_account in payload',
            expect.objectContaining({ merchantId: 42 })
        );
    });

    test('returns when no customer_id', async () => {
        const result = await handler[methodName]({
            merchantId: 42,
            data: { loyalty_account: { id: 'la_no_cust' } }
        });
        expect(result).toEqual({ handled: true });
        expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
    });

    test('runs catchup and populates result when orders found', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({
            ordersFound: 5,
            ordersNewlyTracked: 2
        });
        const result = await handler[methodName](accountContext());
        expect(loyaltyService.runLoyaltyCatchup).toHaveBeenCalledWith({
            merchantId: 42,
            customerIds: ['cust_acc'],
            periodDays: 1,
            maxCustomers: 1
        });
        expect(result.loyaltyCatchup).toEqual({
            customerId: 'cust_acc',
            ordersNewlyTracked: 2
        });
    });

    test('does not populate loyaltyCatchup when no new orders', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({
            ordersFound: 0,
            ordersNewlyTracked: 0
        });
        const result = await handler[methodName](accountContext());
        expect(result.loyaltyCatchup).toBeUndefined();
    });
});

// ─── handleLoyaltyProgramUpdated ─────────────────────────────────────────────

describe('handleLoyaltyProgramUpdated', () => {
    test('returns handled and acknowledged', async () => {
        const result = await handler.handleLoyaltyProgramUpdated({ merchantId: 42, data: {} });
        expect(result).toEqual({ handled: true, acknowledged: true });
    });
});

// ─── handleGiftCardCustomerLinked ────────────────────────────────────────────

describe('handleGiftCardCustomerLinked', () => {
    const giftCardContext = (overrides = {}) => ({
        merchantId: 42,
        data: {
            id: 'gc_1',
            customer_id: 'cust_gc'
        },
        ...overrides
    });

    test('returns early when no merchantId', async () => {
        const result = await handler.handleGiftCardCustomerLinked(giftCardContext({ merchantId: null }));
        expect(result).toEqual({ handled: true });
        expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
    });

    test('returns when no customer_id', async () => {
        const result = await handler.handleGiftCardCustomerLinked({
            merchantId: 42,
            data: { id: 'gc_1' }
        });
        expect(result).toEqual({ handled: true });
        expect(loyaltyService.runLoyaltyCatchup).not.toHaveBeenCalled();
    });

    test('runs catchup with periodDays 7', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
        await handler.handleGiftCardCustomerLinked(giftCardContext());
        expect(loyaltyService.runLoyaltyCatchup).toHaveBeenCalledWith({
            merchantId: 42,
            customerIds: ['cust_gc'],
            periodDays: 7,
            maxCustomers: 1
        });
    });

    test('populates result with giftCardId when orders found', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 4 });
        const result = await handler.handleGiftCardCustomerLinked(giftCardContext());
        expect(result.loyaltyCatchup).toEqual({
            customerId: 'cust_gc',
            giftCardId: 'gc_1',
            ordersNewlyTracked: 4
        });
    });

    test('does not populate loyaltyCatchup when no new orders', async () => {
        loyaltyService.runLoyaltyCatchup.mockResolvedValue({ ordersNewlyTracked: 0 });
        const result = await handler.handleGiftCardCustomerLinked(giftCardContext());
        expect(result.loyaltyCatchup).toBeUndefined();
    });
});
