/**
 * Merchant Management Routes Test Suite
 *
 * Tests for merchant listing, switching, context, and configuration.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../services/merchant', () => ({
    getMerchantSettings: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
    getUserMerchants: jest.fn(),
    switchActiveMerchant: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const { getMerchantSettings } = require('../../services/merchant');
const { getUserMerchants, switchActiveMerchant } = require('../../middleware/merchant');

function createTestApp(opts = {}) {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.session.activeMerchantId = opts.activeMerchantId || 1;
        req.merchantContext = opts.merchantContext !== undefined
            ? opts.merchantContext
            : { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/merchants'));
    return app;
}

describe('Merchant Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/merchants', () => {
        it('should list merchants for current user', async () => {
            const mockMerchants = [
                { id: 1, business_name: 'Store A' },
                { id: 2, business_name: 'Store B' },
            ];
            getUserMerchants.mockResolvedValueOnce(mockMerchants);

            const res = await request(app)
                .get('/api/merchants')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.merchants).toEqual(mockMerchants);
            expect(res.body.activeMerchantId).toBe(1);
            expect(getUserMerchants).toHaveBeenCalledWith(1);
        });
    });

    describe('POST /api/merchants/switch', () => {
        it('should switch active merchant', async () => {
            switchActiveMerchant.mockResolvedValueOnce(true);

            const res = await request(app)
                .post('/api/merchants/switch')
                .send({ merchantId: 2 })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(switchActiveMerchant).toHaveBeenCalled();
        });

        it('should reject missing merchantId', async () => {
            const res = await request(app)
                .post('/api/merchants/switch')
                .send({})
                .expect(400);

            // Validator catches this before route logic
            expect(res.body.error || res.body.errors).toBeDefined();
        });

        it('should return 403 when user lacks access', async () => {
            switchActiveMerchant.mockResolvedValueOnce(false);

            const res = await request(app)
                .post('/api/merchants/switch')
                .send({ merchantId: 999 })
                .expect(403);

            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('do not have access');
        });
    });

    describe('GET /api/merchants/context', () => {
        it('should return merchant context', async () => {
            const res = await request(app)
                .get('/api/merchants/context')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.hasMerchant).toBe(true);
            expect(res.body.merchant.business_name).toBe('Test Store');
            expect(res.body.connectUrl).toBe('/api/square/oauth/connect');
        });

        it('should handle no merchant context', async () => {
            const noMerchantApp = createTestApp({ merchantContext: null });

            const res = await request(noMerchantApp)
                .get('/api/merchants/context')
                .expect(200);

            expect(res.body.hasMerchant).toBe(false);
            expect(res.body.merchant).toBeNull();
        });
    });

    describe('GET /api/config', () => {
        it('should return frontend config with merchant settings', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // Square connection check
            getMerchantSettings.mockResolvedValueOnce({
                default_supply_days: 30,
                reorder_safety_days: 5,
                reorder_priority_urgent_days: 0,
                reorder_priority_high_days: 7,
                reorder_priority_medium_days: 14,
                reorder_priority_low_days: 30,
            });

            const res = await request(app)
                .get('/api/config')
                .expect(200);

            expect(res.body.defaultSupplyDays).toBe(30);
            expect(res.body.reorderSafetyDays).toBe(5);
            expect(res.body.square_connected).toBe(true);
            expect(res.body.usingMerchantSettings).toBe(true);
            expect(res.body.reorderPriorityThresholds).toBeDefined();
        });

        it('should fall back to env vars when no merchant settings', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // No locations
            getMerchantSettings.mockResolvedValueOnce(null);

            const res = await request(app)
                .get('/api/config')
                .expect(200);

            expect(res.body.square_connected).toBe(false);
            expect(res.body.usingMerchantSettings).toBe(false);
            expect(res.body.defaultSupplyDays).toBeDefined();
        });

        it('should handle Square connection check failure gracefully', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));
            getMerchantSettings.mockResolvedValueOnce(null);

            const res = await request(app)
                .get('/api/config')
                .expect(200);

            expect(res.body.square_connected).toBe(false);
        });
    });
});
