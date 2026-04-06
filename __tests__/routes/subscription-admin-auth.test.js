/**
 * Auth guard tests for routes/subscriptions/admin.js
 *
 * Verifies that unauthenticated requests to admin subscription endpoints
 * return 401 UNAUTHORIZED (not 403 NO_MERCHANT), confirming requireAuth
 * fires before requirePermission on every route.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../utils/subscription-handler', () => ({}));
jest.mock('../../services/square', () => ({
    makeSquareRequest: jest.fn(),
    generateIdempotencyKey: jest.fn(),
}));
jest.mock('../../services/pricing-service', () => ({
    getAllModulePricing: jest.fn(),
    getPlatformPlanPricing: jest.fn(),
    updateModulePrice: jest.fn(),
    updatePlatformPlanPrice: jest.fn(),
}));
jest.mock('../../utils/square-subscriptions', () => ({
    listPlans: jest.fn(),
    setupSubscriptionPlans: jest.fn(),
}));
jest.mock('../../middleware/require-super-admin', () => (req, res, next) => next());
jest.mock('../../middleware/validators/subscriptions', () => ({
    processRefund: [(req, res, next) => next()],
    listSubscribers: [(req, res, next) => next()],
    updatePricingItem: [(req, res, next) => next()],
}));
// Standard auth mock used across the test suite.
// requireAuth checks session and returns 401 for unauthenticated requests;
// requireAdmin additionally checks role === 'admin'.
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
        next();
    },
    requireAdmin: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
        if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
        next();
    },
    requireWriteAccess: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');

function buildApp({ withSession = false, withMerchantContext = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = withSession ? { user: { id: 1, role: 'admin', email: 'admin@example.com' } } : {};
        if (withMerchantContext) {
            req.merchantContext = {
                id: 99,
                userRole: 'owner',
                subscriptionStatus: 'platform_owner',
            };
        }
        next();
    });
    app.use('/', require('../../routes/subscriptions/admin'));
    app.use((err, req, res, _next) => {
        res.status(err.status || 500).json({ success: false, error: err.message });
    });
    return app;
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Unauthenticated → 401 from requireAuth (not 403 from requirePermission)
// ---------------------------------------------------------------------------

describe('GET /subscriptions/admin/list — auth guard', () => {
    it('returns 401 when no session', async () => {
        const res = await request(buildApp()).get('/subscriptions/admin/list');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('returns 403 when authenticated but no merchant context', async () => {
        // requireAuth passes; requirePermission fires and rejects (no merchantContext)
        const res = await request(buildApp({ withSession: true }))
            .get('/subscriptions/admin/list');
        expect(res.status).toBe(403);
    });
});

describe('GET /subscriptions/admin/plans — auth guard', () => {
    it('returns 401 when no session', async () => {
        const res = await request(buildApp()).get('/subscriptions/admin/plans');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });
});

describe('GET /admin/pricing — auth guard', () => {
    it('returns 401 when no session', async () => {
        const res = await request(buildApp()).get('/admin/pricing');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });
});

describe('PUT /admin/pricing/modules/:key — auth guard', () => {
    it('returns 401 when no session', async () => {
        const res = await request(buildApp())
            .put('/admin/pricing/modules/cycle_counts')
            .send({ price_cents: 999 });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });
});

describe('PUT /admin/pricing/plans/:key — auth guard', () => {
    it('returns 401 when no session', async () => {
        const res = await request(buildApp())
            .put('/admin/pricing/plans/monthly')
            .send({ price_cents: 2999 });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });
});
