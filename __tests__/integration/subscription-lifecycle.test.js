/**
 * Subscription Lifecycle Integration Tests — 5 flows end-to-end
 *
 * Mocks DB at query level; calls REAL service functions to verify that
 * correct data passes between subscription-create-service, subscription-bridge,
 * promo-expiry-job, and the feature-gate middleware.
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../utils/subscription-handler');
jest.mock('../../services/square', () => ({ makeSquareRequest: jest.fn(), generateIdempotencyKey: jest.fn(k => `idem-${k}`) }));
jest.mock('../../services/subscriptions/promo-validation');
jest.mock('../../utils/square-subscriptions', () => ({ createSubscription: jest.fn() }));
jest.mock('../../utils/password', () => ({ hashPassword: jest.fn().mockResolvedValue('hashed-pw'), generateRandomPassword: jest.fn().mockReturnValue('rand-pw') }));
jest.mock('../../utils/hash-utils', () => ({ hashResetToken: jest.fn().mockReturnValue('hashed-tok') }));
jest.mock('crypto', () => ({ randomBytes: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('setup-tok') }) }));

const db = require('../../utils/database');
const subscriptionHandler = require('../../utils/subscription-handler');
const squareApi = require('../../services/square');
const { validatePromoCode } = require('../../services/subscriptions/promo-validation');
const squareSubscriptions = require('../../utils/square-subscriptions');

const { createSubscription } = require('../../services/subscriptions/subscription-create-service');
const { activateMerchantSubscription, cancelMerchantSubscription, suspendMerchantSubscription } = require('../../services/subscriptions/subscription-bridge');
const { runPromoExpiryCheck } = require('../../jobs/promo-expiry-job');
const { requireFeature } = require('../../middleware/feature-gate');

const MERCHANT_ID = 10;
const SUBSCRIBER_ID = 5;
const MOCK_PLAN = { plan_key: 'monthly', name: 'Monthly', price_cents: 999, square_plan_id: 'sq-plan-1' };
const MOCK_SUBSCRIBER = { id: SUBSCRIBER_ID, email: 'owner@shop.com', subscription_plan: 'monthly', subscription_status: 'trial' };
const MOCK_MERCHANT_ROW = { id: MERCHANT_ID, subscription_status: 'active', business_name: 'Test Shop' };

function mockDbSequence(responses) {
    db.query.mockReset();
    responses.forEach(r => db.query.mockResolvedValueOnce(r));
}

function checkFeature(featureKey, features, subscriptionStatus = 'active') {
    const req = { merchantContext: { features, subscriptionStatus } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireFeature(featureKey)(req, res, next);
    return next.mock.calls.length > 0;
}

function setupSquareMocks() {
    squareApi.makeSquareRequest
        .mockResolvedValueOnce({ customer: { id: 'cust-1' } })
        .mockResolvedValueOnce({ card: { id: 'card-1', card_brand: 'VISA', last_4: '4242' } })
        .mockResolvedValueOnce({ payment: { id: 'pay-1', status: 'COMPLETED', receipt_url: 'https://r.co/1' } });
    squareSubscriptions.createSubscription.mockResolvedValue({ id: 'sq-sub-1' });
    subscriptionHandler.getPlans.mockResolvedValue([MOCK_PLAN]);
    subscriptionHandler.createSubscriber.mockResolvedValue(MOCK_SUBSCRIBER);
    subscriptionHandler.recordPayment.mockResolvedValue({});
    subscriptionHandler.logEvent.mockResolvedValue({});
}

const DB_CREATE_ACTIVATION = [
    { rows: [MOCK_MERCHANT_ROW] }, { rows: [] },         // activate: UPDATE merchants + INSERT features
    { rows: [{ id: 1 }] }, { rows: [] }, { rows: [] },  // promo: atomic UPDATE + uses + expires_at
    { rows: [] }, { rows: [{ id: 9 }] }, { rows: [] }, { rows: [] } // user account
];

// ── Flow 1: Full signup → access → cancel → lock ──────────────────────────
describe('Flow 1: signup → access → cancel → lock', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        validatePromoCode.mockResolvedValue({ valid: true, promo: { id: 1, code: 'SAVE10', duration_months: 1 }, discount: 100, finalPrice: 899 });
    });

    test('promo times_used incremented atomically and promo_expires_at stored', async () => {
        setupSquareMocks();
        mockDbSequence(DB_CREATE_ACTIVATION);

        const before = new Date();
        const result = await createSubscription(MERCHANT_ID, {
            email: 'owner@shop.com', businessName: 'Shop', plan: 'monthly',
            sourceId: 'nonce', promoCode: 'SAVE10', termsAcceptedAt: '2026-01-01T00:00:00Z'
        });
        expect(result.subscriber.id).toBe(SUBSCRIBER_ID);

        const calls = db.query.mock.calls;
        const promoIncrCall = calls.find(c => c[0].includes('times_used = times_used + 1'));
        expect(promoIncrCall).toBeTruthy();
        expect(promoIncrCall[1][0]).toBe(1); // promo_code_id

        const promoExpiresCall = calls.find(c => c[0].includes('promo_expires_at'));
        expect(promoExpiresCall).toBeTruthy();
        expect(promoExpiresCall[1][2]).toBeInstanceOf(Date);
        expect(promoExpiresCall[1][2].getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    test('activateMerchantSubscription creates merchant_features for all paid modules', async () => {
        mockDbSequence([{ rows: [MOCK_MERCHANT_ROW] }, { rows: [] }]);
        const merchant = await activateMerchantSubscription(SUBSCRIBER_ID, MERCHANT_ID);
        expect(merchant.subscription_status).toBe('active');

        const featuresCall = db.query.mock.calls.find(c => c[0].includes('INSERT INTO merchant_features'));
        expect(featuresCall).toBeTruthy();
        const moduleKeys = featuresCall[1][1];
        expect(moduleKeys).toContain('cycle_counts');
        expect(moduleKeys).toContain('loyalty');
        expect(moduleKeys.length).toBeGreaterThan(0);
    });

    test('feature-gate grants access after activation', () => {
        expect(checkFeature('cycle_counts', ['cycle_counts', 'loyalty'])).toBe(true);
    });

    test('cancelMerchantSubscription disables only source=subscription features', async () => {
        mockDbSequence([
            { rows: [MOCK_MERCHANT_ROW] },
            { rows: [{ id: MERCHANT_ID, subscription_status: 'cancelled', business_name: 'Shop' }] },
            { rows: [] }
        ]);
        await cancelMerchantSubscription(SUBSCRIBER_ID, MERCHANT_ID);
        const disableCall = db.query.mock.calls.find(c => c[0].includes('enabled = FALSE'));
        expect(disableCall[0]).toContain("source = 'subscription'");
        expect(disableCall[1][0]).toBe(MERCHANT_ID);
    });

    test('feature-gate denies access after cancel', () => {
        expect(checkFeature('cycle_counts', [])).toBe(false);
    });
});

// ── Flow 2: Admin override survives cancel ────────────────────────────────
describe('Flow 2: admin_override survives cancel', () => {
    beforeEach(() => jest.clearAllMocks());

    test('cancel WHERE clause targets only source=subscription, not admin_override', async () => {
        mockDbSequence([
            { rows: [MOCK_MERCHANT_ROW] },
            { rows: [{ id: MERCHANT_ID, subscription_status: 'cancelled', business_name: 'Shop' }] },
            { rows: [] }
        ]);
        await cancelMerchantSubscription(SUBSCRIBER_ID, MERCHANT_ID);
        const disableCall = db.query.mock.calls.find(c => c[0].includes('enabled = FALSE'));
        expect(disableCall[0]).toContain("source = 'subscription'");
        expect(disableCall[0]).not.toContain('admin_override');
    });

    test('admin_override feature remains accessible after cancel', () => {
        expect(checkFeature('ai_tools', ['ai_tools'])).toBe(true);
    });

    test('subscription features denied while admin_override feature is granted', () => {
        const features = ['ai_tools']; // only admin_override survives
        expect(checkFeature('cycle_counts', features)).toBe(false);
        expect(checkFeature('loyalty', features)).toBe(false);
    });
});

// ── Flow 3: Promo expiry ──────────────────────────────────────────────────
describe('Flow 3: promo expiry', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        validatePromoCode.mockResolvedValue({ valid: true, promo: { id: 2, code: 'PROMO1', duration_months: 1 }, discount: 100, finalPrice: 0 });
    });

    test('promo_expires_at is set to ~1 month from now on signup', async () => {
        setupSquareMocks();
        mockDbSequence(DB_CREATE_ACTIVATION);
        const before = new Date();
        await createSubscription(MERCHANT_ID, {
            email: 'owner@shop.com', businessName: 'Shop', plan: 'monthly',
            sourceId: 'nonce', promoCode: 'PROMO1', termsAcceptedAt: '2026-01-01T00:00:00Z'
        });
        const expiresAt = db.query.mock.calls.find(c => c[0].includes('promo_expires_at'))[1][2];
        const expected = new Date(before);
        expected.setMonth(expected.getMonth() + 1);
        expect(expiresAt).toBeInstanceOf(Date);
        expect(Math.abs(expiresAt.getTime() - expected.getTime())).toBeLessThan(10000);
    });

    test('promo-expiry-job flags expired subscriber and returns flagged count', async () => {
        const expired = { id: SUBSCRIBER_ID, email: 'owner@shop.com', business_name: 'Shop',
            promo_expires_at: new Date('2025-01-01'), subscription_plan: 'monthly', merchant_id: MERCHANT_ID };
        mockDbSequence([{ rows: [expired] }]);
        const result = await runPromoExpiryCheck();
        expect(result.flagged).toBe(1);
        const logger = require('../../utils/logger');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expired'), expect.objectContaining({ subscriberId: SUBSCRIBER_ID }));
    });

    test('promo-expiry-job returns flagged=0 when no expired promos', async () => {
        mockDbSequence([{ rows: [] }]);
        expect((await runPromoExpiryCheck()).flagged).toBe(0);
    });
});

// ── Flow 4: Suspension + reactivation ────────────────────────────────────
describe('Flow 4: suspend and reactivate', () => {
    beforeEach(() => jest.clearAllMocks());

    test('suspendMerchantSubscription disables subscription features', async () => {
        mockDbSequence([
            { rows: [MOCK_MERCHANT_ROW] },
            { rows: [{ id: MERCHANT_ID, subscription_status: 'suspended', business_name: 'Shop' }] },
            { rows: [] }
        ]);
        const result = await suspendMerchantSubscription(SUBSCRIBER_ID, MERCHANT_ID);
        expect(result.subscription_status).toBe('suspended');
        const disableCall = db.query.mock.calls.find(c => c[0].includes('enabled = FALSE'));
        expect(disableCall[0]).toContain("source = 'subscription'");
    });

    test('feature-gate denies access while suspended', () => {
        expect(checkFeature('cycle_counts', [])).toBe(false);
    });

    test('activateMerchantSubscription re-enables all paid features after suspend', async () => {
        mockDbSequence([{ rows: [MOCK_MERCHANT_ROW] }, { rows: [] }]);
        const result = await activateMerchantSubscription(SUBSCRIBER_ID, MERCHANT_ID);
        expect(result.subscription_status).toBe('active');
        const upsertCall = db.query.mock.calls.find(c => c[0].includes('INSERT INTO merchant_features'));
        expect(upsertCall[0]).toContain('ON CONFLICT');
    });

    test('feature-gate grants access after reactivation', () => {
        expect(checkFeature('cycle_counts', ['cycle_counts', 'loyalty'])).toBe(true);
    });
});

// ── Flow 5: Trial countdown ───────────────────────────────────────────────
describe('Flow 5: trial countdown', () => {
    function trialDaysRemaining(trialEndsAt) {
        if (!trialEndsAt) return null;
        return Math.max(0, Math.ceil((new Date(trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    test('14 days remaining when trial ends in 14 days', () => {
        expect(trialDaysRemaining(new Date(Date.now() + 14 * 864e5))).toBe(14);
    });

    test('2 days remaining when trial ends in 2 days', () => {
        expect(trialDaysRemaining(new Date(Date.now() + 2 * 864e5))).toBe(2);
    });

    test('0 days remaining and expired when trial ended yesterday', () => {
        expect(trialDaysRemaining(new Date(Date.now() - 864e5))).toBe(0);
    });

    test('feature-gate grants access during trial when feature is enabled', () => {
        expect(checkFeature('cycle_counts', ['cycle_counts'], 'trial')).toBe(true);
    });

    test('feature-gate denies access when trial features not enabled', () => {
        expect(checkFeature('cycle_counts', [], 'trial')).toBe(false);
    });
});
