/**
 * Admin Promo Code Routes Test Suite
 *
 * Tests for POST /api/admin/promo-codes
 * — platform-owner promo code creation endpoint.
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

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => {
        if (req.session?.user?.role === 'admin') {
            return next();
        }
        return res.status(403).json({ error: 'Admin access required' });
    },
    logAuthEvent: jest.fn(),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));

jest.mock('../../services/merchant/platform-settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getAllSettings: jest.fn(),
    clearCache: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    testEmail: jest.fn().mockResolvedValue(),
    getProvider: jest.fn().mockReturnValue('smtp'),
    sendCritical: jest.fn().mockResolvedValue(),
    sendAlert: jest.fn().mockResolvedValue(),
    sendHeartbeat: jest.fn().mockResolvedValue(),
    enabled: false,
}));

jest.mock('../../middleware/merchant-access', () => ({
    requireMerchantAccess: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');

function createTestApp(userRole = 'admin') {
    const app = express();
    app.use(express.json());
    app.use(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: true,
    }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'admin@example.com', role: userRole };
        next();
    });
    const adminRoutes = require('../../routes/admin');
    app.use('/api/admin', adminRoutes);
    return app;
}

const PLATFORM_OWNER_ROW = { id: 99 };

const PROMO_ROW = {
    id: 1,
    merchant_id: 99,
    code: 'BETA99',
    description: 'Beta tester promo',
    discount_type: 'fixed_price',
    discount_value: 0,
    fixed_price_cents: 99,
    duration_months: 12,
    max_uses: 10,
    times_used: 0,
    is_active: true,
    created_by: 'admin:1',
    created_at: '2026-03-31T00:00:00Z',
    updated_at: '2026-03-31T00:00:00Z',
};

describe('POST /api/admin/promo-codes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('should create a fixed_price promo code', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_OWNER_ROW] }) // platform_owner lookup
            .mockResolvedValueOnce({ rows: [PROMO_ROW] });          // INSERT

        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({
                code: 'BETA99',
                discount_type: 'fixed_price',
                fixed_price_cents: 99,
                duration_months: 12,
                max_uses: 10,
                description: 'Beta tester promo',
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.promo.code).toBe('BETA99');
        expect(res.body.promo.discount_type).toBe('fixed_price');
    });

    it('should create a percent promo code', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_OWNER_ROW] })
            .mockResolvedValueOnce({
                rows: [{
                    ...PROMO_ROW,
                    code: 'SAVE20',
                    discount_type: 'percent',
                    discount_value: 20,
                    fixed_price_cents: null,
                }]
            });

        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({ code: 'SAVE20', discount_type: 'percent', discount_value: 20 })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.promo.code).toBe('SAVE20');
    });

    it('should return 500 when no platform_owner merchant exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no platform_owner

        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({
                code: 'TEST10',
                discount_type: 'percent',
                discount_value: 10,
            })
            .expect(500);

        expect(res.body.code).toBe('NO_PLATFORM_OWNER');
    });

    it('should return 403 for non-admin users', async () => {
        app = createTestApp('user');

        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({
                code: 'TEST10',
                discount_type: 'percent',
                discount_value: 10,
            })
            .expect(403);

        expect(res.body.error).toBe('Admin access required');
    });

    it('should validate that code is required', async () => {
        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({ discount_type: 'percent', discount_value: 10 })
            .expect(400);

        expect(res.body.error).toBe('Validation failed');
    });

    it('should validate discount_type is one of allowed values', async () => {
        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({ code: 'TEST', discount_type: 'mystery', discount_value: 10 })
            .expect(400);

        expect(res.body.error).toBe('Validation failed');
    });

    it('should validate code format (no spaces or special chars)', async () => {
        const res = await request(app)
            .post('/api/admin/promo-codes')
            .send({ code: 'TEST CODE!', discount_type: 'percent', discount_value: 10 })
            .expect(400);

        expect(res.body.error).toBe('Validation failed');
    });

    it('should store code as UPPERCASE in the database', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_OWNER_ROW] })
            .mockResolvedValueOnce({ rows: [{ ...PROMO_ROW, code: 'LOWERCASE' }] });

        await request(app)
            .post('/api/admin/promo-codes')
            .send({ code: 'lowercase', discount_type: 'percent', discount_value: 10 })
            .expect(200);

        // Confirm the INSERT used UPPER($2) pattern
        const insertCall = db.query.mock.calls[1];
        expect(insertCall[0]).toMatch(/UPPER\(\$2\)/);
    });
});
