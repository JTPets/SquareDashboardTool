/**
 * Admin Routes Test Suite
 *
 * Tests for platform administration endpoints:
 * - Merchant listing with subscription info
 * - Trial extension
 * - Merchant deactivation
 * - Platform settings CRUD
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

jest.mock('../../services/platform-settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getAllSettings: jest.fn(),
    clearCache: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const platformSettings = require('../../services/platform-settings');

function createTestApp(userRole = 'admin') {
    const app = express();
    app.use(express.json());
    app.use(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: true,
    }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'john@jtpets.ca', role: userRole };
        next();
    });
    const adminRoutes = require('../../routes/admin');
    app.use('/api/admin', adminRoutes);
    return app;
}

describe('Admin Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/admin/merchants', () => {
        it('should list all merchants with subscription info', async () => {
            const mockMerchants = [
                {
                    id: 1,
                    business_name: 'JT Pets',
                    square_merchant_id: 'SQ_1',
                    subscription_status: 'active',
                    trial_ends_at: null,
                    subscription_ends_at: null,
                    is_active: true,
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-03-01T00:00:00Z'
                },
                {
                    id: 2,
                    business_name: 'Beta Store',
                    square_merchant_id: 'SQ_2',
                    subscription_status: 'trial',
                    trial_ends_at: '2026-09-01T00:00:00Z',
                    subscription_ends_at: null,
                    is_active: true,
                    created_at: '2026-03-01T00:00:00Z',
                    updated_at: '2026-03-01T00:00:00Z'
                }
            ];

            db.query.mockResolvedValueOnce({ rows: mockMerchants });

            const res = await request(app)
                .get('/api/admin/merchants')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.merchants).toHaveLength(2);
            expect(res.body.merchants[0].business_name).toBe('JT Pets');
            expect(res.body.merchants[1].trial_ends_at).toBe('2026-09-01T00:00:00Z');
        });

        it('should require admin role', async () => {
            const nonAdminApp = createTestApp('user');

            await request(nonAdminApp)
                .get('/api/admin/merchants')
                .expect(403);
        });
    });

    describe('POST /api/admin/merchants/:merchantId/extend-trial', () => {
        it('should extend trial by specified days', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 2,
                    business_name: 'Beta Store',
                    trial_ends_at: '2026-12-01T00:00:00Z',
                    subscription_status: 'trial'
                }]
            });

            const res = await request(app)
                .post('/api/admin/merchants/2/extend-trial')
                .send({ days: 90 })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.merchant.id).toBe(2);

            // Verify the SQL uses days parameter
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[1][0]).toBe(90); // days
            expect(queryCall[1][1]).toBe(2);  // merchantId
        });

        it('should reactivate expired merchant when extending trial', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 2,
                    business_name: 'Expired Store',
                    trial_ends_at: '2026-12-01T00:00:00Z',
                    subscription_status: 'trial'
                }]
            });

            await request(app)
                .post('/api/admin/merchants/2/extend-trial')
                .send({ days: 30 })
                .expect(200);

            // Verify the SQL includes CASE to flip expired/suspended back to trial
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[0]).toContain("WHEN subscription_status IN ('expired', 'suspended')");
        });

        it('should return 404 for nonexistent merchant', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app)
                .post('/api/admin/merchants/999/extend-trial')
                .send({ days: 30 })
                .expect(404);
        });

        it('should reject missing days parameter', async () => {
            await request(app)
                .post('/api/admin/merchants/2/extend-trial')
                .send({})
                .expect(400);
        });

        it('should reject days < 1', async () => {
            await request(app)
                .post('/api/admin/merchants/2/extend-trial')
                .send({ days: 0 })
                .expect(400);
        });

        it('should reject days > 3650', async () => {
            await request(app)
                .post('/api/admin/merchants/2/extend-trial')
                .send({ days: 5000 })
                .expect(400);
        });
    });

    describe('POST /api/admin/merchants/:merchantId/deactivate', () => {
        it('should immediately expire merchant trial', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 2,
                    business_name: 'Beta Store',
                    trial_ends_at: '2026-03-01T00:00:00Z',
                    subscription_status: 'expired'
                }]
            });

            const res = await request(app)
                .post('/api/admin/merchants/2/deactivate')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.merchant.subscription_status).toBe('expired');

            // Verify SQL sets trial_ends_at = NOW() and status = expired
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[0]).toContain('trial_ends_at = NOW()');
            expect(queryCall[0]).toContain("subscription_status = 'expired'");
        });

        it('should return 404 for nonexistent merchant', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app)
                .post('/api/admin/merchants/999/deactivate')
                .expect(404);
        });
    });

    describe('GET /api/admin/settings', () => {
        it('should list all platform settings', async () => {
            const mockSettings = [
                { key: 'default_trial_days', value: '180', updated_at: '2026-03-01T00:00:00Z' }
            ];
            platformSettings.getAllSettings.mockResolvedValueOnce(mockSettings);

            const res = await request(app)
                .get('/api/admin/settings')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.settings).toEqual(mockSettings);
        });
    });

    describe('PUT /api/admin/settings/:key', () => {
        it('should update a platform setting', async () => {
            platformSettings.setSetting.mockResolvedValueOnce();

            const res = await request(app)
                .put('/api/admin/settings/default_trial_days')
                .send({ value: '30' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.setting).toEqual({ key: 'default_trial_days', value: '30' });
            expect(platformSettings.setSetting).toHaveBeenCalledWith('default_trial_days', '30');
        });

        it('should reject missing value', async () => {
            await request(app)
                .put('/api/admin/settings/default_trial_days')
                .send({})
                .expect(400);
        });

        it('should reject invalid key format', async () => {
            await request(app)
                .put('/api/admin/settings/INVALID-KEY!')
                .send({ value: 'test' })
                .expect(400);
        });
    });
});
