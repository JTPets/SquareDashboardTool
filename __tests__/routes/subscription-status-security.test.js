/**
 * Tests for CRIT-1: GET /api/subscriptions/status security hardening
 * Verifies rate limiting and minimal response (no sensitive fields leaked).
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

jest.mock('../../services/subscription-bridge', () => ({
    linkSubscriberToMerchant: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const subscriptionHandler = require('../../utils/subscription-handler');

function createApp() {
    const app = express();
    app.use(express.json());
    const router = require('../../routes/subscriptions');
    app.use('/api', router);
    return app;
}

describe('CRIT-1: GET /api/subscriptions/status security', () => {
    let app;

    beforeAll(() => {
        app = createApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('response stripping', () => {
        test('returns only active and planName for active subscription', async () => {
            subscriptionHandler.checkSubscriptionStatus.mockResolvedValue({
                isValid: true,
                status: 'active',
                planName: 'starter',
                message: 'Subscription active',
            });

            const res = await request(app)
                .get('/api/subscriptions/status')
                .query({ email: 'test@example.com' })
                .expect(200);

            expect(Object.keys(res.body)).toEqual(['active', 'planName']);
            expect(res.body.active).toBe(true);
            expect(res.body.planName).toBe('starter');
        });

        test('returns only active and planName for trial subscription', async () => {
            subscriptionHandler.checkSubscriptionStatus.mockResolvedValue({
                isValid: true,
                status: 'trial',
                planName: 'pro',
                daysLeft: 10,
                message: 'Trial active - 10 days remaining',
            });

            const res = await request(app)
                .get('/api/subscriptions/status')
                .query({ email: 'trial@example.com' })
                .expect(200);

            expect(Object.keys(res.body)).toEqual(['active', 'planName']);
            expect(res.body.active).toBe(true);
            expect(res.body.planName).toBe('pro');
        });

        test('returns only active and planName for not_found', async () => {
            subscriptionHandler.checkSubscriptionStatus.mockResolvedValue({
                isValid: false,
                status: 'not_found',
                planName: null,
                message: 'No subscription found',
            });

            const res = await request(app)
                .get('/api/subscriptions/status')
                .query({ email: 'nobody@example.com' })
                .expect(200);

            expect(Object.keys(res.body)).toEqual(['active', 'planName']);
            expect(res.body.active).toBe(false);
            expect(res.body.planName).toBeNull();
        });

        test('does not leak sensitive fields', async () => {
            subscriptionHandler.checkSubscriptionStatus.mockResolvedValue({
                isValid: true,
                status: 'active',
                planName: 'starter',
                daysLeft: 5,
                message: 'Subscription active',
            });

            const res = await request(app)
                .get('/api/subscriptions/status')
                .query({ email: 'test@example.com' })
                .expect(200);

            const sensitiveFields = [
                'email', 'status', 'message', 'daysLeft',
                'trialEndDate', 'subscriptionEndDate', 'squareSubscriptionId',
                'cardBrand', 'cardLastFour', 'priceCents',
            ];
            for (const field of sensitiveFields) {
                expect(res.body).not.toHaveProperty(field);
            }
        });
    });

    describe('rate limiting', () => {
        test('rate limiter is applied to GET /subscriptions/status', () => {
            const router = require('../../routes/subscriptions');
            const route = router.stack.find(layer =>
                layer.route && layer.route.path === '/subscriptions/status' && layer.route.methods.get
            );
            expect(route).toBeDefined();

            const limiters = route.route.stack.filter(s => typeof s.handle.resetKey === 'function');
            expect(limiters.length).toBe(1);
        });

        test('rate limiter is the FIRST middleware on GET /subscriptions/status', () => {
            const router = require('../../routes/subscriptions');
            const route = router.stack.find(layer =>
                layer.route && layer.route.path === '/subscriptions/status' && layer.route.methods.get
            );
            const firstHandler = route.route.stack[0].handle;
            expect(typeof firstHandler.resetKey).toBe('function');
        });
    });
});
