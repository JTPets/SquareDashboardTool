/**
 * Platform Owner Tests
 *
 * Tests that platform owner bypasses subscription enforcement,
 * OAuth auto-detection of platform owner on first connect,
 * and admin merchants list includes subscription_status.
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

jest.mock('../../services/platform-settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getAllSettings: jest.fn(),
    clearCache: jest.fn(),
}));

jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn(token => `encrypted_${token}`),
    decryptToken: jest.fn(token => token.replace('encrypted_', '')),
}));

jest.mock('../../utils/square-api', () => ({
    initializeCustomAttributes: jest.fn().mockResolvedValue({ definitions: [] }),
}));

jest.mock('square', () => ({
    SquareClient: jest.fn().mockImplementation(() => ({
        oAuth: {
            obtainToken: jest.fn().mockResolvedValue({
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token',
                expiresAt: '2026-09-01T00:00:00Z',
                merchantId: 'SQ_MERCHANT_NEW',
                tokenType: 'bearer'
            })
        },
        merchants: {
            get: jest.fn().mockResolvedValue({
                merchant: {
                    businessName: 'New Pet Store',
                    languageCode: 'en',
                    currency: 'CAD'
                }
            })
        }
    })),
    SquareEnvironment: { Sandbox: 'sandbox', Production: 'production' }
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    logAuthEvent: jest.fn().mockResolvedValue(),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));

jest.mock('../../middleware/merchant', () => ({
    loadMerchantContext: (req, res, next) => next(),
    requireMerchant: (req, res, next) => next(),
    requireMerchantRole: () => (req, res, next) => next(),
    requireValidSubscription: jest.fn((req, res, next) => {
        if (!req.merchantContext) {
            return res.status(403).json({ success: false, code: 'NO_MERCHANT' });
        }
        if (!req.merchantContext.isSubscriptionValid) {
            return res.status(402).json({ success: false, code: 'SUBSCRIPTION_EXPIRED' });
        }
        next();
    }),
}));

jest.mock('../../utils/square-token', () => ({
    refreshMerchantToken: jest.fn(),
}));

const db = require('../../utils/database');
const platformSettings = require('../../services/platform-settings');
const logger = require('../../utils/logger');
const { requireValidSubscription } = require('../../middleware/merchant');

describe('Platform Owner', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== Subscription Enforcement Bypass ====================
    describe('Subscription enforcement bypass', () => {

        // Re-implement the subscription enforcement middleware inline (mirrors server.js)
        function createEnforcementMiddleware() {
            const subscriptionExcludedPaths = [
                '/health', '/auth/', '/square/oauth/', '/webhooks/',
                '/subscriptions/', '/driver/', '/admin/', '/config',
                '/merchants', '/gmc/feed.tsv', '/gmc/local-inventory-feed.tsv'
            ];

            return async (req, res, next) => {
                const apiPath = req.path;
                for (const excluded of subscriptionExcludedPaths) {
                    if (apiPath === excluded || apiPath.startsWith(excluded)) {
                        return next();
                    }
                }
                if (!req.merchantContext) return next();

                // Platform owner bypass
                try {
                    const ownerIdStr = await platformSettings.getSetting('platform_owner_merchant_id');
                    if (ownerIdStr && req.merchantContext.id === parseInt(ownerIdStr, 10)) {
                        return next();
                    }
                } catch (_) {
                    // fall through
                }

                return requireValidSubscription(req, res, next);
            };
        }

        it('should bypass subscription check for platform owner', async () => {
            platformSettings.getSetting.mockResolvedValue('3');

            const middleware = createEnforcementMiddleware();
            const req = {
                path: '/catalog/items',
                merchantContext: {
                    id: 3,
                    isSubscriptionValid: false,  // expired trial
                    subscriptionStatus: 'expired',
                }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const next = jest.fn();

            await middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
            expect(requireValidSubscription).not.toHaveBeenCalled();
        });

        it('should enforce subscription for non-owner merchants', async () => {
            platformSettings.getSetting.mockResolvedValue('3');

            const middleware = createEnforcementMiddleware();
            const req = {
                path: '/catalog/items',
                merchantContext: {
                    id: 5,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'expired',
                }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const next = jest.fn();

            await middleware(req, res, next);

            expect(requireValidSubscription).toHaveBeenCalled();
        });

        it('should bypass even with expired trial_ends_at for platform owner', async () => {
            platformSettings.getSetting.mockResolvedValue('3');

            const middleware = createEnforcementMiddleware();
            const req = {
                path: '/inventory/counts',
                merchantContext: {
                    id: 3,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'trial',
                    trialEndsAt: new Date(Date.now() - 86400000).toISOString(), // yesterday
                }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const next = jest.fn();

            await middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('should fall through to normal check if platform settings fails', async () => {
            platformSettings.getSetting.mockRejectedValue(new Error('DB connection failed'));

            const middleware = createEnforcementMiddleware();
            const req = {
                path: '/catalog/items',
                merchantContext: {
                    id: 3,
                    isSubscriptionValid: true,
                    subscriptionStatus: 'active',
                }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const next = jest.fn();

            await middleware(req, res, next);

            expect(requireValidSubscription).toHaveBeenCalled();
        });

        it('should fall through if platform_owner_merchant_id is not set', async () => {
            platformSettings.getSetting.mockResolvedValue(null);

            const middleware = createEnforcementMiddleware();
            const req = {
                path: '/catalog/items',
                merchantContext: {
                    id: 3,
                    isSubscriptionValid: false,
                    subscriptionStatus: 'expired',
                }
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
            const next = jest.fn();

            await middleware(req, res, next);

            expect(requireValidSubscription).toHaveBeenCalled();
        });
    });

    // ==================== OAuth Platform Owner Auto-Detection ====================
    describe('OAuth platform owner auto-detection', () => {
        let app;

        function createTestApp() {
            const express = require('express');
            const session = require('express-session');
            const testApp = express();
            testApp.use(express.json());
            testApp.use(session({
                secret: 'test-secret',
                resave: false,
                saveUninitialized: true,
            }));
            testApp.use((req, res, next) => {
                req.session.user = { id: 1, email: 'test@test.com', role: 'admin' };
                req.session.activeMerchantId = null;
                req.session.regenerate = (cb) => {
                    req.session.user = { id: 1, email: 'test@test.com', role: 'admin' };
                    cb(null);
                };
                next();
            });
            const oauthRouter = require('../../routes/square-oauth');
            testApp.use('/api/square/oauth', oauthRouter);
            return testApp;
        }

        beforeAll(() => {
            process.env.SQUARE_APPLICATION_ID = 'sq-test-app-id';
            process.env.SQUARE_APPLICATION_SECRET = 'sq-test-app-secret';
            process.env.SQUARE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/square/oauth/callback';
            process.env.SQUARE_ENVIRONMENT = 'sandbox';
        });

        beforeEach(() => {
            jest.clearAllMocks();
            app = createTestApp();
        });

        it('should set platform_owner on first OAuth connect with no existing merchants', async () => {
            const request = require('supertest');

            platformSettings.getSetting
                .mockResolvedValueOnce('180')   // default_trial_days
                .mockResolvedValueOnce(null);    // platform_owner_merchant_id (not set)

            db.query
                // State lookup
                .mockResolvedValueOnce({
                    rows: [{ state: 'valid-state', user_id: 1, redirect_uri: '/dashboard.html', expires_at: new Date(Date.now() + 600000) }]
                })
                // Mark state as used
                .mockResolvedValueOnce({ rows: [] })
                // INSERT merchant (new)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        business_name: 'First Store',
                        trial_ends_at: '2026-09-01T00:00:00Z',
                        is_new_merchant: true
                    }]
                })
                // Check for other merchants (none exist)
                .mockResolvedValueOnce({ rows: [] })
                // UPDATE subscription_status = 'platform_owner'
                .mockResolvedValueOnce({ rows: [] })
                // user_merchants INSERT
                .mockResolvedValueOnce({ rows: [] })
                // logAuthEvent
                .mockResolvedValueOnce({ rows: [] })
                // custom_attributes_initialized_at
                .mockResolvedValue({ rows: [] });

            const res = await request(app)
                .get('/api/square/oauth/callback?code=test-auth-code&state=valid-state')
                .expect(302);

            // Verify setSetting was called with platform_owner_merchant_id
            expect(platformSettings.setSetting).toHaveBeenCalledWith('platform_owner_merchant_id', '1');

            // Verify UPDATE query sets subscription_status = 'platform_owner'
            const updateCall = db.query.mock.calls.find(
                call => typeof call[0] === 'string' && call[0].includes('platform_owner')
            );
            expect(updateCall).toBeTruthy();

            // Verify logger
            expect(logger.info).toHaveBeenCalledWith(
                'First merchant registered as platform owner',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should NOT set platform_owner when merchants already exist', async () => {
            const request = require('supertest');

            platformSettings.getSetting
                .mockResolvedValueOnce('180')   // default_trial_days
                .mockResolvedValueOnce(null);    // platform_owner_merchant_id (not set)

            db.query
                // State lookup
                .mockResolvedValueOnce({
                    rows: [{ state: 'valid-state', user_id: 1, redirect_uri: '/dashboard.html', expires_at: new Date(Date.now() + 600000) }]
                })
                // Mark state as used
                .mockResolvedValueOnce({ rows: [] })
                // INSERT merchant (new)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 4,
                        business_name: 'Second Store',
                        trial_ends_at: '2026-09-01T00:00:00Z',
                        is_new_merchant: true
                    }]
                })
                // Check for other merchants (merchant 3 exists)
                .mockResolvedValueOnce({ rows: [{ id: 3 }] })
                // user_merchants INSERT
                .mockResolvedValueOnce({ rows: [] })
                // logAuthEvent
                .mockResolvedValueOnce({ rows: [] })
                // custom_attributes_initialized_at
                .mockResolvedValue({ rows: [] });

            await request(app)
                .get('/api/square/oauth/callback?code=test-auth-code&state=valid-state')
                .expect(302);

            // Should NOT set platform owner
            expect(platformSettings.setSetting).not.toHaveBeenCalled();

            // Should NOT log platform owner message
            const platformOwnerLogs = logger.info.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('platform owner')
            );
            expect(platformOwnerLogs).toHaveLength(0);
        });

        it('should NOT set platform_owner when one is already configured', async () => {
            const request = require('supertest');

            platformSettings.getSetting
                .mockResolvedValueOnce('180')   // default_trial_days
                .mockResolvedValueOnce('3');     // platform_owner_merchant_id already set

            db.query
                // State lookup
                .mockResolvedValueOnce({
                    rows: [{ state: 'valid-state', user_id: 1, redirect_uri: '/dashboard.html', expires_at: new Date(Date.now() + 600000) }]
                })
                // Mark state as used
                .mockResolvedValueOnce({ rows: [] })
                // INSERT merchant (new)
                .mockResolvedValueOnce({
                    rows: [{
                        id: 5,
                        business_name: 'Third Store',
                        trial_ends_at: '2026-09-01T00:00:00Z',
                        is_new_merchant: true
                    }]
                })
                // user_merchants INSERT
                .mockResolvedValueOnce({ rows: [] })
                // logAuthEvent
                .mockResolvedValueOnce({ rows: [] })
                // custom_attributes_initialized_at
                .mockResolvedValue({ rows: [] });

            await request(app)
                .get('/api/square/oauth/callback?code=test-auth-code&state=valid-state')
                .expect(302);

            // Should NOT call setSetting
            expect(platformSettings.setSetting).not.toHaveBeenCalled();
        });
    });

    // ==================== Admin Merchants List ====================
    describe('Admin merchants list includes subscription_status', () => {
        it('should return subscription_status in merchant list', async () => {
            const express = require('express');
            const request = require('supertest');
            const session = require('express-session');

            const testApp = express();
            testApp.use(express.json());
            testApp.use(session({
                secret: 'test-secret',
                resave: false,
                saveUninitialized: true,
            }));
            testApp.use((req, res, next) => {
                req.session.user = { id: 1, email: 'admin@test.com', role: 'admin' };
                next();
            });

            const adminRoutes = require('../../routes/admin');
            testApp.use('/api/admin', adminRoutes);

            // Mock DB query for merchants list
            db.query.mockResolvedValueOnce({
                rows: [
                    {
                        id: 3,
                        business_name: 'JT Pets',
                        square_merchant_id: 'SQ_123',
                        subscription_status: 'platform_owner',
                        trial_ends_at: null,
                        subscription_ends_at: null,
                        is_active: true,
                        created_at: '2026-01-01',
                        updated_at: '2026-03-01'
                    },
                    {
                        id: 4,
                        business_name: 'Other Store',
                        square_merchant_id: 'SQ_456',
                        subscription_status: 'trial',
                        trial_ends_at: '2026-09-01',
                        subscription_ends_at: null,
                        is_active: true,
                        created_at: '2026-02-01',
                        updated_at: '2026-03-01'
                    }
                ]
            });

            const res = await request(testApp)
                .get('/api/admin/merchants')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.merchants).toHaveLength(2);
            expect(res.body.merchants[0].subscription_status).toBe('platform_owner');
            expect(res.body.merchants[1].subscription_status).toBe('trial');
        });
    });

    // ==================== loadMerchantContext platform_owner status ====================
    describe('loadMerchantContext recognizes platform_owner', () => {
        // Test the subscription status logic in isolation (mirrors loadMerchantContext)
        function checkSubscriptionValid(subscriptionStatus, trialEndsAt) {
            if (subscriptionStatus === 'platform_owner') {
                return true;
            } else if (subscriptionStatus === 'expired' || subscriptionStatus === 'suspended') {
                return false;
            } else if (subscriptionStatus === 'trial' && trialEndsAt) {
                return new Date(trialEndsAt) > new Date();
            }
            return true;
        }

        it('should mark platform_owner as always valid', () => {
            expect(checkSubscriptionValid('platform_owner', null)).toBe(true);
        });

        it('should mark platform_owner as valid even with past trial_ends_at', () => {
            const pastDate = new Date(Date.now() - 86400000).toISOString();
            expect(checkSubscriptionValid('platform_owner', pastDate)).toBe(true);
        });

        it('should still mark expired as invalid', () => {
            expect(checkSubscriptionValid('expired', null)).toBe(false);
        });

        it('should still mark active trial as valid', () => {
            const futureDate = new Date(Date.now() + 86400000).toISOString();
            expect(checkSubscriptionValid('trial', futureDate)).toBe(true);
        });

        it('should still mark expired trial as invalid', () => {
            const pastDate = new Date(Date.now() - 86400000).toISOString();
            expect(checkSubscriptionValid('trial', pastDate)).toBe(false);
        });
    });
});
