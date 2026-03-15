jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    logAuthEvent: jest.fn().mockResolvedValue(),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
    loadMerchantContext: (req, res, next) => next(),
    getSquareClientForMerchant: jest.fn(),
    requireMerchantRole: () => (req, res, next) => next(),
}));
jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));
jest.mock('square', () => ({
    SquareClient: jest.fn(),
    SquareEnvironment: { Sandbox: 'sandbox', Production: 'production' },
}));
jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn(() => 'encrypted_token'),
    decryptToken: jest.fn(() => 'decrypted_token'),
}));
jest.mock('../../services/square', () => ({
    initializeCustomAttributes: jest.fn().mockResolvedValue({ definitions: [] }),
}));
jest.mock('../../services/platform-settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
}));
jest.mock('../../utils/square-token', () => ({
    refreshMerchantToken: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const db = require('../../utils/database');
const { SquareClient } = require('square');
const { refreshMerchantToken } = require('../../utils/square-token');

function buildApp(sessionOverrides = {}) {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = {
            user: { id: 1, role: 'admin' },
            regenerate: jest.fn((cb) => cb(null)),
            save: jest.fn((cb) => cb(null)),
            ...sessionOverrides,
        };
        req.merchantContext = { id: 10, square_merchant_id: 'sq-merchant-1' };
        next();
    });
    const routes = require('../../routes/square-oauth');
    a.use('/api/square/oauth', routes);
    return a;
}

function buildUnauthApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = {
            regenerate: jest.fn((cb) => cb(null)),
            save: jest.fn((cb) => cb(null)),
        };
        next();
    });
    const routes = require('../../routes/square-oauth');
    a.use('/api/square/oauth', routes);
    return a;
}

function buildNonAdminApp() {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = {
            user: { id: 2, role: 'user' },
            regenerate: jest.fn((cb) => cb(null)),
            save: jest.fn((cb) => cb(null)),
        };
        req.merchantContext = { id: 10, square_merchant_id: 'sq-merchant-1' };
        next();
    });
    const routes = require('../../routes/square-oauth');
    a.use('/api/square/oauth', routes);
    return a;
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.SQUARE_APPLICATION_ID = 'test-app-id';
    process.env.SQUARE_APPLICATION_SECRET = 'test-secret';
    process.env.SQUARE_OAUTH_REDIRECT_URI = 'http://localhost/callback';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
});

afterEach(() => {
    delete process.env.SQUARE_APPLICATION_ID;
    delete process.env.SQUARE_APPLICATION_SECRET;
    delete process.env.SQUARE_OAUTH_REDIRECT_URI;
    delete process.env.SQUARE_ENVIRONMENT;
});

describe('Square OAuth Routes', () => {
    describe('GET /connect', () => {
        test('redirects to Square OAuth URL', async () => {
            const app = buildApp();
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

            const res = await request(app).get('/api/square/oauth/connect');

            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('squareupsandbox.com');
        });

        test('returns 401 when not authenticated', async () => {
            const app = buildUnauthApp();

            const res = await request(app).get('/api/square/oauth/connect');

            expect(res.status).toBe(401);
        });

        test('includes application ID in redirect URL', async () => {
            const app = buildApp();
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

            const res = await request(app).get('/api/square/oauth/connect');

            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('test-app-id');
        });
    });

    describe('GET /callback', () => {
        const mockObtainToken = jest.fn();
        const mockGetMerchant = jest.fn();

        beforeEach(() => {
            SquareClient.mockImplementation(() => ({
                oAuth: { obtainToken: mockObtainToken },
                merchants: { get: mockGetMerchant },
            }));

            mockObtainToken.mockResolvedValue({
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token',
                expiresAt: '2026-04-15T00:00:00Z',
                merchantId: 'sq-merchant-1',
            });

            mockGetMerchant.mockResolvedValue({
                merchant: {
                    id: 'sq-merchant-1',
                    businessName: 'Test Store',
                    country: 'CA',
                    currency: 'CAD',
                },
            });
        });

        test('redirects with error when error param present', async () => {
            const app = buildApp();

            const res = await request(app).get('/api/square/oauth/callback?error=access_denied&error_description=User+denied');

            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('error');
        });

        test('redirects when code is missing', async () => {
            const app = buildApp();

            const res = await request(app).get('/api/square/oauth/callback?state=test-state');

            expect(res.status).toBe(302);
        });

        test('redirects when state is missing', async () => {
            const app = buildApp();

            const res = await request(app).get('/api/square/oauth/callback?code=test-code');

            expect(res.status).toBe(302);
        });

        test('redirects when state is expired or invalid', async () => {
            const app = buildApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/square/oauth/callback?code=test-code&state=invalid-state');

            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('error');
        });

        test('creates merchant on successful callback', async () => {
            const app = buildApp();
            // state validation
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, state: 'valid-state' }] });
            // delete used state
            db.query.mockResolvedValueOnce({ rows: [] });
            // upsert merchant
            db.query.mockResolvedValueOnce({ rows: [{ id: 10, square_merchant_id: 'sq-merchant-1', business_name: 'Test Store' }] });
            // user_merchants insert
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
            // additional queries (locations, subscriptions, etc.)
            db.query.mockResolvedValue({ rows: [] });

            const res = await request(app).get('/api/square/oauth/callback?code=test-code&state=valid-state');

            expect(res.status).toBe(302);
            expect(mockObtainToken).toHaveBeenCalled();
        });

        test('exchanges authorization code for tokens', async () => {
            const app = buildApp();
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, state: 'valid-state' }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [{ id: 10, square_merchant_id: 'sq-merchant-1' }] });
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
            db.query.mockResolvedValue({ rows: [] });

            await request(app).get('/api/square/oauth/callback?code=auth-code-123&state=valid-state');

            expect(mockObtainToken).toHaveBeenCalledWith(expect.objectContaining({
                code: 'auth-code-123',
            }));
        });
    });

    describe('POST /revoke', () => {
        test('revokes token successfully', async () => {
            const mockRevokeToken = jest.fn().mockResolvedValue({ success: true });
            SquareClient.mockImplementation(() => ({
                oAuth: { revokeToken: mockRevokeToken },
            }));

            const app = buildApp();
            // fetch merchant token
            db.query.mockResolvedValueOnce({ rows: [{ id: 10, access_token: 'encrypted_token', square_merchant_id: 'sq-merchant-1' }] });
            // deactivate merchant
            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });

            const res = await request(app).post('/api/square/oauth/revoke');

            expect(res.status).toBe(200);
        });

        test('returns 404 when merchant not found', async () => {
            const app = buildApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).post('/api/square/oauth/revoke');

            expect(res.status).toBe(404);
        });

        test('returns 401 when not authenticated', async () => {
            const app = buildUnauthApp();

            const res = await request(app).post('/api/square/oauth/revoke');

            expect(res.status).toBe(401);
        });
    });

    describe('POST /refresh', () => {
        test('refreshes token successfully', async () => {
            refreshMerchantToken.mockResolvedValue({ success: true });
            const app = buildApp();

            const res = await request(app)
                .post('/api/square/oauth/refresh')
                .send({ merchantId: 10 });

            expect(res.status).toBe(200);
            expect(refreshMerchantToken).toHaveBeenCalledWith(10);
        });

        test('returns 403 for non-admin users', async () => {
            const app = buildNonAdminApp();

            const res = await request(app)
                .post('/api/square/oauth/refresh')
                .send({ merchantId: 10 });

            expect(res.status).toBe(403);
        });

        test('returns 400 when merchantId is missing', async () => {
            const app = buildApp();

            const res = await request(app)
                .post('/api/square/oauth/refresh')
                .send({});

            expect(res.status).toBe(400);
        });

        test('handles refresh failure gracefully', async () => {
            refreshMerchantToken.mockRejectedValue(new Error('Token refresh failed'));
            const app = buildApp();

            const res = await request(app)
                .post('/api/square/oauth/refresh')
                .send({ merchantId: 10 });

            expect(res.status).toBe(500);
        });
    });
});
