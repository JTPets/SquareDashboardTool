/**
 * Tests for subscription-create-service
 *
 * Covers the three payment paths:
 *   1. Discounted first-payment (promo with partial discount)
 *   2. 100%-free promo (finalPrice === 0)
 *   3. Full Square-managed subscription (no promo)
 *
 * Also covers: invalid promo, feature activation, user account creation.
 */

jest.mock('../../../utils/database');
jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../../utils/subscription-handler');
jest.mock('../../../services/square', () => ({
    makeSquareRequest: jest.fn(),
    generateIdempotencyKey: jest.fn(key => `idem-${key}`)
}));
jest.mock('../../../services/subscriptions/promo-validation', () => ({
    validatePromoCode: jest.fn()
}));
jest.mock('../../../services/subscriptions/subscription-bridge', () => ({
    activateMerchantSubscription: jest.fn()
}));
jest.mock('../../../utils/square-subscriptions', () => ({
    createSubscription: jest.fn()
}));
jest.mock('../../../utils/password', () => ({
    hashPassword: jest.fn().mockResolvedValue('hashed-password'),
    generateRandomPassword: jest.fn().mockReturnValue('random-pass')
}));
jest.mock('../../../utils/hash-utils', () => ({
    hashResetToken: jest.fn().mockReturnValue('hashed-token')
}));
jest.mock('crypto', () => ({
    randomBytes: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('setup-token-abc') })
}));

const { createSubscription } = require('../../../services/subscriptions/subscription-create-service');
const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const subscriptionHandler = require('../../../utils/subscription-handler');
const squareApi = require('../../../services/square');
const { validatePromoCode } = require('../../../services/subscriptions/promo-validation');
const subscriptionBridge = require('../../../services/subscriptions/subscription-bridge');
const squareSubscriptions = require('../../../utils/square-subscriptions');

const MERCHANT_ID = 42;
const BASE_PARAMS = {
    email: 'test@example.com',
    businessName: 'Test Shop',
    plan: 'monthly',
    sourceId: 'sq-nonce-abc',
    promoCode: null,
    termsAcceptedAt: '2026-01-01T00:00:00Z'
};

const MOCK_PLAN = {
    plan_key: 'monthly',
    name: 'Monthly Plan',
    price_cents: 999,
    square_plan_id: 'sq-plan-123'
};

const MOCK_SUBSCRIBER = {
    id: 10,
    email: 'test@example.com',
    subscription_plan: 'monthly',
    subscription_status: 'trial',
    trial_end_date: '2026-02-01'
};

const MOCK_SQUARE_SUBSCRIPTION = { id: 'sq-sub-999' };

function setupSquareMocks() {
    squareApi.makeSquareRequest
        .mockResolvedValueOnce({ customer: { id: 'sq-cust-1' } })          // create customer
        .mockResolvedValueOnce({ card: { id: 'sq-card-1', card_brand: 'VISA', last_4: '4242' } }); // create card
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.SQUARE_LOCATION_ID = 'sq-loc-1';

    subscriptionHandler.getPlans.mockResolvedValue([MOCK_PLAN]);
    subscriptionHandler.createSubscriber.mockResolvedValue(MOCK_SUBSCRIBER);
    subscriptionHandler.logEvent.mockResolvedValue();
    subscriptionHandler.recordPayment.mockResolvedValue();

    validatePromoCode.mockResolvedValue({ valid: false });
    subscriptionBridge.activateMerchantSubscription.mockResolvedValue();
    squareSubscriptions.createSubscription.mockResolvedValue(MOCK_SQUARE_SUBSCRIPTION);

    // Default: no existing user
    db.query.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// Full Square-managed subscription (no promo)
// ---------------------------------------------------------------------------
describe('full subscription path (no promo)', () => {
    it('creates customer, card, and Square subscription', async () => {
        setupSquareMocks();

        const result = await createSubscription(MERCHANT_ID, BASE_PARAMS);

        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith('/v2/customers', expect.any(Object));
        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith('/v2/cards', expect.any(Object));
        expect(squareSubscriptions.createSubscription).toHaveBeenCalledWith(expect.objectContaining({
            customerId: 'sq-cust-1',
            cardId: 'sq-card-1',
            planVariationId: 'sq-plan-123',
            locationId: 'sq-loc-1'
        }));
        expect(result.subscriber).toEqual(MOCK_SUBSCRIBER);
        expect(result.payment).toBeNull();
    });

    it('activates merchant features after subscription creation', async () => {
        setupSquareMocks();

        await createSubscription(MERCHANT_ID, BASE_PARAMS);

        expect(subscriptionBridge.activateMerchantSubscription).toHaveBeenCalledWith(
            MOCK_SUBSCRIBER.id, MERCHANT_ID
        );
        expect(subscriptionHandler.logEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'subscription.created',
            merchantId: MERCHANT_ID,
            subscriberId: MOCK_SUBSCRIBER.id
        }));
    });

    it('throws SUBSCRIPTION_FAILED if Square subscription call fails', async () => {
        setupSquareMocks();
        squareSubscriptions.createSubscription.mockRejectedValue(new Error('Square error'));

        await expect(createSubscription(MERCHANT_ID, BASE_PARAMS))
            .rejects.toMatchObject({ code: 'SUBSCRIPTION_FAILED', statusCode: 400 });
    });

    it('returns passwordSetupToken for new user', async () => {
        setupSquareMocks();
        // no existing user → INSERT path
        db.query
            .mockResolvedValueOnce({ rows: [] })       // UPDATE subscribers (square_subscription_id)
            .mockResolvedValueOnce({ rows: [] })       // SELECT users (no existing user)
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT users
            .mockResolvedValueOnce({ rows: [] })       // INSERT password_reset_tokens
            .mockResolvedValueOnce({ rows: [] });      // UPDATE subscribers user_id

        const result = await createSubscription(MERCHANT_ID, BASE_PARAMS);
        expect(result.passwordSetupToken).toBe('setup-token-abc');
    });
});

// ---------------------------------------------------------------------------
// Discounted payment path (partial promo)
// ---------------------------------------------------------------------------
describe('discounted payment path', () => {
    const PROMO = { id: 5, code: 'SAVE50', discount_type: 'fixed', discount_value: 400 };

    beforeEach(() => {
        validatePromoCode.mockResolvedValue({
            valid: true,
            promo: PROMO,
            discount: 400,
            finalPrice: 599
        });
        setupSquareMocks();
    });

    it('charges discounted amount and schedules Square subscription', async () => {
        squareApi.makeSquareRequest.mockResolvedValueOnce({
            payment: { id: 'sq-pay-1', status: 'COMPLETED', receipt_url: 'https://receipt' }
        });

        const result = await createSubscription(MERCHANT_ID, { ...BASE_PARAMS, promoCode: 'SAVE50' });

        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith('/v2/payments', expect.objectContaining({
            body: expect.stringContaining('"amount":599')
        }));
        expect(result.payment).toMatchObject({ id: 'sq-pay-1', status: 'COMPLETED' });
        expect(subscriptionHandler.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
            amountCents: 599,
            status: 'completed'
        }));
    });

    it('records promo code usage after successful payment', async () => {
        squareApi.makeSquareRequest.mockResolvedValueOnce({
            payment: { id: 'sq-pay-1', status: 'COMPLETED', receipt_url: null }
        });

        await createSubscription(MERCHANT_ID, { ...BASE_PARAMS, promoCode: 'SAVE50' });

        // promo_code_uses insert, promo_codes times_used update, subscribers promo_code_id update
        const queryCalls = db.query.mock.calls.map(c => c[0]);
        expect(queryCalls.some(q => q.includes('promo_code_uses'))).toBe(true);
        expect(queryCalls.some(q => q.includes('times_used = times_used + 1'))).toBe(true);
    });

    it('throws PAYMENT_FAILED if Square payment call fails', async () => {
        squareApi.makeSquareRequest.mockResolvedValueOnce({ errors: [{ detail: 'Card declined' }] });

        await expect(createSubscription(MERCHANT_ID, { ...BASE_PARAMS, promoCode: 'SAVE50' }))
            .rejects.toMatchObject({ code: 'PAYMENT_FAILED', statusCode: 400 });
    });
});

// ---------------------------------------------------------------------------
// 100%-free promo path
// ---------------------------------------------------------------------------
describe('free promo path (100% discount)', () => {
    beforeEach(() => {
        validatePromoCode.mockResolvedValue({
            valid: true,
            promo: { id: 7, code: 'BETA100', discount_type: 'percent', discount_value: 100 },
            discount: 999,
            finalPrice: 0
        });
        setupSquareMocks();
    });

    it('creates Square subscription without charging', async () => {
        await createSubscription(MERCHANT_ID, { ...BASE_PARAMS, promoCode: 'BETA100' });

        expect(squareApi.makeSquareRequest).not.toHaveBeenCalledWith('/v2/payments', expect.any(Object));
        expect(squareSubscriptions.createSubscription).toHaveBeenCalledWith(
            expect.objectContaining({ startDate: expect.any(String) })
        );
    });

    it('logs that no payment was processed', async () => {
        await createSubscription(MERCHANT_ID, { ...BASE_PARAMS, promoCode: 'BETA100' });

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('100% promo discount'),
            expect.any(Object)
        );
    });
});

// ---------------------------------------------------------------------------
// Invalid / missing promo
// ---------------------------------------------------------------------------
describe('invalid promo code', () => {
    it('ignores invalid promo and falls back to full price', async () => {
        validatePromoCode.mockResolvedValue({ valid: false, error: 'Expired code' });
        setupSquareMocks();

        const result = await createSubscription(MERCHANT_ID, { ...BASE_PARAMS, promoCode: 'BAD' });

        // Should go down full subscription path (no payment call, Square manages billing)
        expect(result.payment).toBeNull();
        expect(squareSubscriptions.createSubscription).toHaveBeenCalledWith(
            expect.not.objectContaining({ startDate: expect.any(String) })
        );
    });
});

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------
describe('plan validation', () => {
    it('throws 400 for unknown plan key', async () => {
        subscriptionHandler.getPlans.mockResolvedValue([MOCK_PLAN]);

        await expect(createSubscription(MERCHANT_ID, { ...BASE_PARAMS, plan: 'nonexistent' }))
            .rejects.toMatchObject({ statusCode: 400, message: 'Invalid plan selected' });
    });

    it('throws 500 when plan has no square_plan_id', async () => {
        subscriptionHandler.getPlans.mockResolvedValue([{ ...MOCK_PLAN, square_plan_id: null }]);

        await expect(createSubscription(MERCHANT_ID, BASE_PARAMS))
            .rejects.toMatchObject({ statusCode: 500 });
    });
});

// ---------------------------------------------------------------------------
// Square customer/card creation failures
// ---------------------------------------------------------------------------
describe('Square customer and card creation', () => {
    it('throws CUSTOMER_CREATION_FAILED when Square customer call fails', async () => {
        squareApi.makeSquareRequest.mockResolvedValueOnce({ errors: [{ detail: 'Invalid email' }] });

        await expect(createSubscription(MERCHANT_ID, BASE_PARAMS))
            .rejects.toMatchObject({ code: 'CUSTOMER_CREATION_FAILED', statusCode: 400 });
    });

    it('throws CARD_CREATION_FAILED when Square card call fails', async () => {
        squareApi.makeSquareRequest
            .mockResolvedValueOnce({ customer: { id: 'sq-cust-1' } })
            .mockResolvedValueOnce({ errors: [{ detail: 'Invalid nonce' }] });

        await expect(createSubscription(MERCHANT_ID, BASE_PARAMS))
            .rejects.toMatchObject({ code: 'CARD_CREATION_FAILED', statusCode: 400 });
    });
});

// ---------------------------------------------------------------------------
// Feature activation
// ---------------------------------------------------------------------------
describe('activateMerchantFeatures', () => {
    it('updates square_subscription_id on the subscriber', async () => {
        setupSquareMocks();

        await createSubscription(MERCHANT_ID, BASE_PARAMS);

        const updateCalls = db.query.mock.calls.filter(c =>
            c[0].includes('square_subscription_id') && c[0].includes('UPDATE subscribers')
        );
        expect(updateCalls.length).toBeGreaterThan(0);
        expect(updateCalls[0][1]).toContain('sq-sub-999');
    });

    it('still completes if user account creation throws', async () => {
        setupSquareMocks();
        // Simulate user account error by making db.query throw on INSERT users
        db.query
            .mockResolvedValueOnce({ rows: [] })                // UPDATE subscribers (sq sub id)
            .mockResolvedValueOnce({ rows: [] })                // SELECT users
            .mockRejectedValueOnce(new Error('DB error'));      // INSERT users

        const result = await createSubscription(MERCHANT_ID, BASE_PARAMS);

        // Should still return subscriber even if user account fails
        expect(result.subscriber).toEqual(MOCK_SUBSCRIBER);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to create user account'),
            expect.any(Object)
        );
    });
});
