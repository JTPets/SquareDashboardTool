/**
 * Merchant Settings Routes Test Suite
 *
 * Tests for merchant settings get/update/defaults.
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
    updateMerchantSettings: jest.fn(),
    DEFAULT_MERCHANT_SETTINGS: {
        default_supply_days: 45,
        reorder_safety_days: 7,
        daily_count_target: 50,
    },
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    requireWriteAccess: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const { getMerchantSettings, updateMerchantSettings, DEFAULT_MERCHANT_SETTINGS } = require('../../services/merchant');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/settings'));
    return app;
}

describe('Settings Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/settings/merchant', () => {
        it('should return merchant settings', async () => {
            const mockSettings = {
                default_supply_days: 30,
                reorder_safety_days: 5,
                daily_count_target: 100,
            };
            getMerchantSettings.mockResolvedValueOnce(mockSettings);

            const res = await request(app)
                .get('/api/settings/merchant')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.settings).toEqual(mockSettings);
            expect(res.body.merchantId).toBe(1);
            expect(getMerchantSettings).toHaveBeenCalledWith(1);
        });
    });

    describe('PUT /api/settings/merchant', () => {
        it('should update merchant settings', async () => {
            const updated = { default_supply_days: 60, reorder_safety_days: 10 };
            updateMerchantSettings.mockResolvedValueOnce(updated);

            const res = await request(app)
                .put('/api/settings/merchant')
                .send({ default_supply_days: 60, reorder_safety_days: 10 })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.settings).toEqual(updated);
            expect(res.body.message).toContain('saved');
        });

        it('should reject negative numeric fields', async () => {
            const res = await request(app)
                .put('/api/settings/merchant')
                .send({ reorder_safety_days: -5 })
                .expect(400);

            // Validator or route logic catches invalid values
            expect(res.body.error).toBeDefined();
        });

        it('should reject non-numeric values for numeric fields', async () => {
            const res = await request(app)
                .put('/api/settings/merchant')
                .send({ default_supply_days: 'abc' })
                .expect(400);

            // Validator or route logic catches invalid values
            expect(res.body.error).toBeDefined();
        });

        it('should coerce boolean fields', async () => {
            updateMerchantSettings.mockResolvedValueOnce({ cycle_count_email_enabled: true });

            await request(app)
                .put('/api/settings/merchant')
                .send({ cycle_count_email_enabled: 1 })
                .expect(200);

            const calledWith = updateMerchantSettings.mock.calls[0][1];
            expect(calledWith.cycle_count_email_enabled).toBe(true);
        });
    });

    describe('GET /api/settings/merchant/defaults', () => {
        it('should return default settings', async () => {
            const res = await request(app)
                .get('/api/settings/merchant/defaults')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.defaults).toEqual(DEFAULT_MERCHANT_SETTINGS);
        });
    });
});
