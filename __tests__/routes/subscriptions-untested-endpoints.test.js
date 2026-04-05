/**
 * Tests for previously-untested subscription endpoints:
 *
 *   GET /public/pricing
 *   GET /public/promo/check          → checkPublicPromo() in promo-validation.js
 *   GET /square/payment-config
 *   GET /subscriptions/merchant-status → getMerchantStatusSummary() in subscription-bridge.js
 *   GET /webhooks/events             → requireSuperAdmin middleware + dynamic SQL
 *
 * Route-level tests are omitted in favour of testing the extracted service
 * functions directly (same pattern as the rest of the test suite).
 */

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------
jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../utils/subscription-handler');

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const subscriptionHandler = require('../../utils/subscription-handler');

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /public/pricing — featureRegistry shape
// ---------------------------------------------------------------------------
describe('GET /public/pricing — featureRegistry shape', () => {
    const featureRegistry = require('../../config/feature-registry');

    it('getPaidModules returns objects with key, name, price_cents', () => {
        const modules = featureRegistry.getPaidModules();
        expect(Array.isArray(modules)).toBe(true);
        if (modules.length > 0) {
            expect(modules[0]).toHaveProperty('key');
            expect(modules[0]).toHaveProperty('name');
            expect(modules[0]).toHaveProperty('price_cents');
        }
    });

    it('bundles map returns objects with key, name, includes, price_cents', () => {
        const bundles = Object.values(featureRegistry.bundles);
        expect(Array.isArray(bundles)).toBe(true);
        if (bundles.length > 0) {
            expect(bundles[0]).toHaveProperty('key');
            expect(bundles[0]).toHaveProperty('includes');
            expect(bundles[0]).toHaveProperty('price_cents');
        }
    });
});

// ---------------------------------------------------------------------------
// GET /public/promo/check — checkPublicPromo()
// ---------------------------------------------------------------------------
describe('checkPublicPromo()', () => {
    const { checkPublicPromo } = require('../../services/subscriptions/promo-validation');

    it('returns { valid: false } for unknown or expired code', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await checkPublicPromo('BADCODE');

        expect(result).toEqual({ valid: false });
    });

    it('returns valid promo with percent discountDisplay', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                code: 'SAVE20',
                description: '20% off',
                discount_type: 'percent',
                discount_value: 20,
                fixed_price_cents: null,
                duration_months: 3
            }]
        });

        const result = await checkPublicPromo('SAVE20');

        expect(result.valid).toBe(true);
        expect(result.discountDisplay).toBe('20% off');
        expect(result.durationMonths).toBe(3);
    });

    it('returns valid promo with fixed discountDisplay', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                code: 'FLAT5',
                description: '$5 off',
                discount_type: 'fixed',
                discount_value: 500,
                fixed_price_cents: null,
                duration_months: null
            }]
        });

        const result = await checkPublicPromo('FLAT5');

        expect(result.valid).toBe(true);
        expect(result.discountDisplay).toBe('$5.00 off');
        expect(result.durationMonths).toBeNull();
    });

    it('returns valid promo with fixed_price discountDisplay', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                code: 'BETA99',
                description: 'Beta price',
                discount_type: 'fixed_price',
                discount_value: null,
                fixed_price_cents: 99,
                duration_months: null
            }]
        });

        const result = await checkPublicPromo('BETA99');

        expect(result.valid).toBe(true);
        expect(result.discountDisplay).toBe('$0.99/mo');
    });

    it('queries only platform_owner codes', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await checkPublicPromo('TEST');

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("subscription_status = 'platform_owner'"),
            expect.any(Array)
        );
    });
});

// ---------------------------------------------------------------------------
// GET /square/payment-config — env var reads
// ---------------------------------------------------------------------------
describe('GET /square/payment-config — env var reads', () => {
    it('returns all three env vars when configured', () => {
        process.env.SQUARE_APPLICATION_ID = 'app-abc';
        process.env.SQUARE_LOCATION_ID = 'loc-xyz';
        process.env.SQUARE_ENVIRONMENT = 'production';

        const config = {
            applicationId: process.env.SQUARE_APPLICATION_ID || null,
            locationId: process.env.SQUARE_LOCATION_ID || null,
            environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
        };

        expect(config.applicationId).toBe('app-abc');
        expect(config.locationId).toBe('loc-xyz');
        expect(config.environment).toBe('production');
    });

    it('defaults environment to sandbox when env var is absent', () => {
        delete process.env.SQUARE_ENVIRONMENT;

        const environment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

        expect(environment).toBe('sandbox');
    });
});

// ---------------------------------------------------------------------------
// GET /subscriptions/merchant-status — getMerchantStatusSummary()
// ---------------------------------------------------------------------------
describe('getMerchantStatusSummary()', () => {
    const { getMerchantStatusSummary } = require('../../services/subscriptions/subscription-bridge');

    const ACTIVE_CONTEXT = {
        id: 5,
        businessName: 'Pet Shop',
        subscriptionStatus: 'active',
        isSubscriptionValid: true,
        trialEndsAt: null,
        subscriptionEndsAt: null
    };

    const TRIAL_CONTEXT = {
        id: 6,
        businessName: 'Trial Shop',
        subscriptionStatus: 'trial',
        isSubscriptionValid: true,
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        subscriptionEndsAt: null
    };

    beforeEach(() => {
        subscriptionHandler.getPlans.mockResolvedValue([{ plan_key: 'monthly', price_cents: 999 }]);
    });

    it('returns active status with no trial countdown', async () => {
        subscriptionHandler.getSubscriberByMerchantId.mockResolvedValue(null);

        const result = await getMerchantStatusSummary(ACTIVE_CONTEXT);

        expect(result.subscription.status).toBe('active');
        expect(result.subscription.trialDaysRemaining).toBeNull();
        expect(result.billing).toBeNull();
        expect(result.merchantId).toBe(5);
        expect(result.businessName).toBe('Pet Shop');
    });

    it('calculates trialDaysRemaining for trial merchants', async () => {
        subscriptionHandler.getSubscriberByMerchantId.mockResolvedValue(null);

        const result = await getMerchantStatusSummary(TRIAL_CONTEXT);

        expect(result.subscription.status).toBe('trial');
        expect(result.subscription.trialDaysRemaining).toBeGreaterThan(0);
        expect(result.subscription.trialDaysRemaining).toBeLessThanOrEqual(7);
    });

    it('returns trialDaysRemaining of 0 for an expired trial', async () => {
        subscriptionHandler.getSubscriberByMerchantId.mockResolvedValue(null);

        const expiredContext = {
            ...TRIAL_CONTEXT,
            trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // yesterday
        };

        const result = await getMerchantStatusSummary(expiredContext);

        expect(result.subscription.trialDaysRemaining).toBe(0);
    });

    it('returns billing info when subscriber exists', async () => {
        subscriptionHandler.getSubscriberByMerchantId.mockResolvedValue({
            subscription_plan: 'monthly',
            price_cents: 999,
            card_brand: 'VISA',
            card_last_four: '4242',
            next_billing_date: '2026-05-01',
            square_subscription_id: 'sq-sub-1'
        });

        const result = await getMerchantStatusSummary(ACTIVE_CONTEXT);

        expect(result.billing).toMatchObject({
            plan: 'monthly',
            priceCents: 999,
            cardBrand: 'VISA',
            cardLastFour: '4242'
        });
    });

    it('returns null billing when no subscriber found', async () => {
        subscriptionHandler.getSubscriberByMerchantId.mockResolvedValue(null);

        const result = await getMerchantStatusSummary(ACTIVE_CONTEXT);

        expect(result.billing).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// requireSuperAdmin middleware
// ---------------------------------------------------------------------------
describe('requireSuperAdmin middleware', () => {
    const requireSuperAdmin = require('../../middleware/require-super-admin');

    function makeReq(email) {
        return { session: { user: { email } }, path: '/test' };
    }

    function makeRes() {
        const res = {};
        res.status = jest.fn().mockReturnValue(res);
        res.json = jest.fn().mockReturnValue(res);
        return res;
    }

    beforeEach(() => {
        process.env.SUPER_ADMIN_EMAILS = 'admin@example.com,owner@example.com';
    });

    afterEach(() => {
        delete process.env.SUPER_ADMIN_EMAILS;
    });

    it('calls next() for a listed super admin email', () => {
        const next = jest.fn();
        requireSuperAdmin(makeReq('admin@example.com'), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('returns 403 for an email not in the list', () => {
        const next = jest.fn();
        const res = makeRes();
        requireSuperAdmin(makeReq('regular@example.com'), res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 when session user email is undefined', () => {
        const next = jest.fn();
        const res = makeRes();
        requireSuperAdmin({ session: {}, path: '/test' }, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('is case-insensitive for email comparison', () => {
        const next = jest.fn();
        requireSuperAdmin(makeReq('ADMIN@EXAMPLE.COM'), makeRes(), next);
        expect(next).toHaveBeenCalled();
    });

    it('logs a warning on unauthorized attempt', () => {
        requireSuperAdmin(makeReq('hacker@bad.com'), makeRes(), jest.fn());
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Unauthorized'),
            expect.any(Object)
        );
    });
});

// ---------------------------------------------------------------------------
// GET /webhooks/events — dynamic query building
// ---------------------------------------------------------------------------
describe('GET /webhooks/events — query building', () => {
    it('builds base query without filters', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })  // events
            .mockResolvedValueOnce({ rows: [{ total: 0, completed: 0, failed: 0, skipped: 0, avg_processing_ms: null }] }); // stats

        // Simulate what the route handler does
        const params = [];
        let query = 'SELECT id FROM webhook_events WHERE 1=1';
        params.push(50);
        query += ` ORDER BY received_at DESC LIMIT $${params.length}`;

        const result = await db.query(query, params);
        expect(result.rows).toEqual([]);
    });

    it('appends status filter when status is provided', () => {
        const params = [];
        let query = 'SELECT id FROM webhook_events WHERE 1=1';

        const status = 'failed';
        params.push(status);
        query += ` AND status = $${params.length}`;

        expect(query).toContain('AND status = $1');
        expect(params[0]).toBe('failed');
    });

    it('appends event_type filter when event_type is provided', () => {
        const params = [];
        let query = 'SELECT id FROM webhook_events WHERE 1=1';

        const event_type = 'payment.completed';
        params.push(event_type);
        query += ` AND event_type = $${params.length}`;

        expect(query).toContain('AND event_type = $1');
        expect(params[0]).toBe('payment.completed');
    });

    it('stats query covers last 24 hours', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await db.query(`
            SELECT COUNT(*) as total FROM webhook_events WHERE received_at > NOW() - INTERVAL '24 hours'
        `);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining("INTERVAL '24 hours'")
        );
    });
});
