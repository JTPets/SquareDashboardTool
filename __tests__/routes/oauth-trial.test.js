/**
 * OAuth Trial Onboarding Tests
 *
 * Tests that new merchants get trial_ends_at set during OAuth callback,
 * and re-auth of existing merchants does not overwrite trial_ends_at.
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

jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn(token => `encrypted_${token}`),
    decryptToken: jest.fn(token => token.replace('encrypted_', '')),
}));

jest.mock('../../services/platform-settings', () => ({
    getSetting: jest.fn(),
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
                merchantId: 'SQ_MERCHANT_123',
                tokenType: 'bearer'
            })
        },
        merchants: {
            get: jest.fn().mockResolvedValue({
                merchant: {
                    businessName: 'Test Pet Store',
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
}));

jest.mock('../../utils/square-token', () => ({
    refreshMerchantToken: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const platformSettings = require('../../services/platform-settings');
const logger = require('../../utils/logger');

// Build a minimal Express app with the OAuth router
function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: true,
    }));

    // Inject test session user
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'john@jtpets.ca', role: 'admin' };
        req.session.activeMerchantId = null;
        // Mock session.regenerate
        req.session.regenerate = (cb) => {
            req.session.user = { id: 1, email: 'john@jtpets.ca', role: 'admin' };
            cb(null);
        };
        next();
    });

    const oauthRouter = require('../../routes/square-oauth');
    app.use('/api/square/oauth', oauthRouter);
    return app;
}

describe('OAuth Trial Onboarding', () => {
    let app;

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

    describe('New merchant onboarding', () => {
        it('should set trial_ends_at for a new merchant with configured trial days', async () => {
            // Platform setting returns 180 days
            platformSettings.getSetting.mockResolvedValue('180');

            // Valid state record
            db.query
                // State lookup
                .mockResolvedValueOnce({
                    rows: [{ state: 'valid-state', user_id: 1, redirect_uri: '/dashboard.html', expires_at: new Date(Date.now() + 600000) }]
                })
                // Mark state as used
                .mockResolvedValueOnce({ rows: [] })
                // INSERT merchant (new) - xmax=0 means INSERT happened
                .mockResolvedValueOnce({
                    rows: [{
                        id: 2,
                        business_name: 'Test Pet Store',
                        trial_ends_at: '2026-09-01T00:00:00Z',
                        is_new_merchant: true
                    }]
                })
                // user_merchants INSERT
                .mockResolvedValueOnce({ rows: [] })
                // logAuthEvent
                .mockResolvedValueOnce({ rows: [] })
                // custom_attributes_initialized_at UPDATE (async, may not be called before redirect)
                .mockResolvedValue({ rows: [] });

            const res = await request(app)
                .get('/api/square/oauth/callback?code=test-auth-code&state=valid-state')
                .expect(302);

            // Verify the INSERT query included trial_ends_at and subscription_status
            const insertCall = db.query.mock.calls[2];
            expect(insertCall[0]).toContain('subscription_status');
            expect(insertCall[0]).toContain('trial_ends_at');
            expect(insertCall[0]).toContain("INTERVAL '1 day' * $11");

            // trial days param should be 180
            expect(insertCall[1][10]).toBe(180);

            // Verify the logger was called for new merchant
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('New merchant onboarded with 180-day trial'),
                expect.objectContaining({
                    merchantId: 2,
                    trialDays: 180,
                })
            );
        });

        it('should use default 180 days when platform setting is missing', async () => {
            // Platform setting not found, returns default
            platformSettings.getSetting.mockResolvedValue('180');

            db.query
                .mockResolvedValueOnce({
                    rows: [{ state: 'valid-state', user_id: 1, redirect_uri: '/dashboard.html', expires_at: new Date(Date.now() + 600000) }]
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [{
                        id: 3,
                        business_name: 'Another Store',
                        trial_ends_at: '2026-09-01T00:00:00Z',
                        is_new_merchant: true
                    }]
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValue({ rows: [] });

            await request(app)
                .get('/api/square/oauth/callback?code=test-auth-code&state=valid-state')
                .expect(302);

            expect(platformSettings.getSetting).toHaveBeenCalledWith('default_trial_days', '180');
        });
    });

    describe('Re-auth of existing merchant', () => {
        it('should NOT overwrite trial_ends_at on re-auth', async () => {
            platformSettings.getSetting.mockResolvedValue('180');

            db.query
                .mockResolvedValueOnce({
                    rows: [{ state: 'valid-state', user_id: 1, redirect_uri: '/dashboard.html', expires_at: new Date(Date.now() + 600000) }]
                })
                .mockResolvedValueOnce({ rows: [] })
                // ON CONFLICT triggered — existing merchant re-authing
                .mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        business_name: 'JT Pets',
                        trial_ends_at: '2026-06-01T00:00:00Z', // original trial date preserved
                        is_new_merchant: false
                    }]
                })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValue({ rows: [] });

            await request(app)
                .get('/api/square/oauth/callback?code=test-auth-code&state=valid-state')
                .expect(302);

            // Verify the ON CONFLICT SET clause does NOT update trial_ends_at or subscription_status
            const insertCall = db.query.mock.calls[2];
            const afterOnConflict = insertCall[0].split('ON CONFLICT')[1];
            // Extract only the SET...RETURNING portion (the update columns)
            const setClause = afterOnConflict.split('RETURNING')[0];
            expect(setClause).not.toContain('trial_ends_at');
            expect(setClause).not.toContain('subscription_status');

            // Should NOT log "New merchant onboarded" for re-auth
            const newMerchantLogs = logger.info.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('New merchant onboarded')
            );
            expect(newMerchantLogs).toHaveLength(0);
        });
    });
});
