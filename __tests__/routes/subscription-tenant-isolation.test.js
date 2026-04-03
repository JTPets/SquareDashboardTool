/**
 * Tests for CRIT-2/CRIT-4: Subscription tenant isolation
 * Verifies merchant_id scoping on promo codes, payments, events, and plans.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../utils/subscription-handler', () => ({
    checkSubscriptionStatus: jest.fn(),
    getPlans: jest.fn().mockResolvedValue([]),
    getSubscriberByEmail: jest.fn(),
    getSubscriberByMerchantId: jest.fn(),
    createSubscriber: jest.fn(),
    recordPayment: jest.fn(),
    logEvent: jest.fn(),
    getPaymentHistory: jest.fn().mockResolvedValue([]),
    getAllSubscribers: jest.fn().mockResolvedValue([]),
    getSubscriptionStats: jest.fn().mockResolvedValue({}),
    processRefund: jest.fn(),
    cancelSubscription: jest.fn(),
    TRIAL_DAYS: 14,
}));

jest.mock('../../middleware/merchant', () => ({
    loadMerchantContext: (req, res, next) => next(),
    requireMerchant: (req, res, next) => next(),
    getSquareClientForMerchant: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

jest.mock('../../services/subscriptions/subscription-bridge', () => ({
    linkSubscriberToMerchant: jest.fn(),
    activateMerchantSubscription: jest.fn(),
    resolveMerchantId: jest.fn(),
    cancelMerchantSubscription: jest.fn(),
}));

jest.mock('../../services/square', () => ({
    makeSquareRequest: jest.fn(),
    generateIdempotencyKey: jest.fn().mockReturnValue('test-key'),
}));

jest.mock('../../utils/square-subscriptions', () => ({
    createSubscription: jest.fn(),
}));

jest.mock('../../utils/password', () => ({
    hashPassword: jest.fn().mockResolvedValue('hashed'),
    generateRandomPassword: jest.fn().mockReturnValue('temp-pass'),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../utils/database');
const subscriptionHandler = require('../../utils/subscription-handler');

function createApp() {
    const app = express();
    app.use(express.json());
    // Attach merchantContext for authenticated routes
    app.use((req, res, next) => {
        if (req.headers['x-merchant-id']) {
            req.merchantContext = { id: parseInt(req.headers['x-merchant-id']), userRole: 'owner' };
        }
        if (req.headers['x-session-merchant-id']) {
            req.session = { activeMerchantId: parseInt(req.headers['x-session-merchant-id']), user: { email: 'admin@test.com', role: 'admin' } };
        }
        next();
    });
    const router = require('../../routes/subscriptions');
    app.use('/api', router);
    return app;
}

describe('CRIT-2/CRIT-4: Subscription tenant isolation', () => {
    let app;

    beforeAll(() => {
        app = createApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('promo code lookup includes merchant_id filter', () => {
        test('POST /promo/validate scopes promo query to merchant_id', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // promo lookup returns nothing

            await request(app)
                .post('/api/subscriptions/promo/validate')
                .set('x-merchant-id', '3')
                .send({ code: 'BETA100', plan: 'monthly', priceCents: 2999 })
                .expect(200);

            // Verify the SQL includes merchant_id parameter
            expect(db.query).toHaveBeenCalledTimes(1);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('merchant_id = $2');
            expect(params).toContain(3); // merchant_id
            expect(params).toContain('BETA100'); // code
        });

        test('cross-tenant promo code rejected — no merchant context', async () => {
            const res = await request(app)
                .post('/api/subscriptions/promo/validate')
                .send({ code: 'BETA100', plan: 'monthly', priceCents: 2999 })
                .expect(400);

            expect(res.body.error).toContain('Merchant context required');
        });
    });

    describe('subscription creation scopes to correct merchant', () => {
        test('POST /create requires merchant context', async () => {
            const res = await request(app)
                .post('/api/subscriptions/create')
                .send({
                    email: 'test@example.com',
                    businessName: 'Test',
                    plan: 'monthly',
                    sourceId: 'cnon:card-nonce',
                    termsAcceptedAt: new Date().toISOString()
                })
                .expect(400);

            expect(res.body.code).toBe('NO_MERCHANT');
        });

        test('POST /create passes merchantId to getPlans', async () => {
            process.env.SQUARE_LOCATION_ID = 'test-location';
            subscriptionHandler.getSubscriberByEmail.mockResolvedValueOnce(null);
            subscriptionHandler.getPlans.mockResolvedValueOnce([
                { plan_key: 'monthly', price_cents: 2999, square_plan_id: 'plan_123', name: 'Monthly' }
            ]);

            const squareApi = require('../../services/square');
            squareApi.makeSquareRequest.mockResolvedValueOnce({
                customer: { id: 'sq_cust_1' }
            }).mockResolvedValueOnce({
                card: { id: 'sq_card_1', card_brand: 'VISA', last_4: '1234' }
            });

            subscriptionHandler.createSubscriber.mockResolvedValueOnce({
                id: 1, email: 'create@example.com', subscription_plan: 'monthly',
                subscription_status: 'trial', trial_end_date: new Date()
            });

            const squareSubscriptions = require('../../utils/square-subscriptions');
            squareSubscriptions.createSubscription.mockResolvedValueOnce({ id: 'sq_sub_1' });

            db.query.mockResolvedValue({ rows: [] }); // for UPDATE and INSERT queries

            subscriptionHandler.logEvent.mockResolvedValueOnce({});

            const res = await request(app)
                .post('/api/subscriptions/create')
                .set('x-merchant-id', '5')
                .send({
                    email: 'create@example.com',
                    businessName: 'Test',
                    plan: 'monthly',
                    sourceId: 'cnon:card-nonce',
                    termsAcceptedAt: new Date().toISOString()
                });

            expect(subscriptionHandler.getPlans).toHaveBeenCalledWith(5);
        });
    });

    describe('subscription_payments filtered by merchant_id', () => {
        test('getPaymentHistory called with merchantId in refund route', async () => {
            const subscriber = {
                id: 1,
                merchant_id: 3,
                email: 'refund@example.com',
                square_subscription_id: null,
            };
            subscriptionHandler.getSubscriberByEmail.mockResolvedValue(subscriber);
            subscriptionHandler.getPaymentHistory.mockResolvedValue([]);

            const res = await request(app)
                .post('/api/subscriptions/refund')
                .set('x-merchant-id', '3')
                .send({ email: 'refund@example.com', reason: 'test refund' });

            // 400 = no refundable payment; 404 = subscriber not found
            expect([400, 404]).toContain(res.status);
            if (res.status === 400) {
                expect(subscriptionHandler.getPaymentHistory).toHaveBeenCalledWith(1, 3);
            }
        });

        test('processRefund called with merchantId', async () => {
            const subscriber = {
                id: 1,
                merchant_id: 3,
                email: 'refund2@example.com',
                square_subscription_id: null,
            };
            const payment = {
                id: 10,
                status: 'completed',
                refunded_at: null,
                amount_cents: 2999,
                currency: 'CAD',
                square_payment_id: null,
            };
            subscriptionHandler.getSubscriberByEmail.mockResolvedValue(subscriber);
            subscriptionHandler.getPaymentHistory.mockResolvedValue([payment]);
            subscriptionHandler.processRefund.mockResolvedValue(payment);
            subscriptionHandler.cancelSubscription.mockResolvedValue(subscriber);
            subscriptionHandler.logEvent.mockResolvedValue({});

            const res = await request(app)
                .post('/api/subscriptions/refund')
                .set('x-merchant-id', '3')
                .send({ email: 'refund2@example.com', reason: 'test' });

            expect(res.status).toBe(200);
            expect(subscriptionHandler.processRefund).toHaveBeenCalledWith(10, 2999, 'test', 3);
        });
    });

    describe('admin endpoints scoped to merchant', () => {
        test('GET /admin/list passes merchantId to getAllSubscribers', async () => {
            subscriptionHandler.getAllSubscribers.mockResolvedValueOnce([]);
            subscriptionHandler.getSubscriptionStats.mockResolvedValueOnce({});

            await request(app)
                .get('/api/subscriptions/admin/list')
                .set('x-merchant-id', '3')
                .expect(200);

            expect(subscriptionHandler.getAllSubscribers).toHaveBeenCalledWith({ merchantId: 3 });
            expect(subscriptionHandler.getSubscriptionStats).toHaveBeenCalledWith(3);
        });

        test('GET /admin/list requires merchant context', async () => {
            const res = await request(app)
                .get('/api/subscriptions/admin/list')
                .expect(403);

            expect(res.body.code).toBe('NO_MERCHANT');
        });
    });

    describe('plans endpoint scoped to merchant', () => {
        test('GET /plans passes merchantId to getPlans', async () => {
            subscriptionHandler.getPlans.mockResolvedValueOnce([{ plan_key: 'monthly' }]);

            await request(app)
                .get('/api/subscriptions/plans')
                .set('x-merchant-id', '7')
                .expect(200);

            expect(subscriptionHandler.getPlans).toHaveBeenCalledWith(7);
        });

        test('GET /plans requires merchant context', async () => {
            const res = await request(app)
                .get('/api/subscriptions/plans')
                .expect(400);

            expect(res.body.code).toBe('NO_MERCHANT');
        });
    });

    describe('logEvent includes merchantId', () => {
        test('cancel route passes subscriber.merchant_id to logEvent', async () => {
            const subscriber = {
                id: 1,
                merchant_id: 3,
                email: 'test@test.com',
                square_subscription_id: null,
            };
            subscriptionHandler.getSubscriberByEmail.mockResolvedValueOnce(subscriber);
            subscriptionHandler.cancelSubscription.mockResolvedValueOnce(subscriber);
            const subscriptionBridge = require('../../services/subscriptions/subscription-bridge');
            subscriptionBridge.resolveMerchantId.mockResolvedValueOnce(3);
            subscriptionBridge.cancelMerchantSubscription.mockResolvedValueOnce({});
            subscriptionHandler.logEvent.mockResolvedValueOnce({});

            await request(app)
                .post('/api/subscriptions/cancel')
                .set('x-merchant-id', '3')
                .send({ email: 'test@test.com', reason: 'test' })
                .expect(200);

            expect(subscriptionHandler.logEvent).toHaveBeenCalledWith(
                expect.objectContaining({ merchantId: 3 })
            );
        });
    });
});
