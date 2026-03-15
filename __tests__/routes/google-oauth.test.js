/**
 * Google OAuth Routes Test Suite
 *
 * Tests for Google OAuth authentication flow:
 * - Check status, start flow, callback handling, disconnect
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/google-auth', () => ({
    getAuthStatus: jest.fn(),
    getAuthUrl: jest.fn(),
    validateAuthState: jest.fn(),
    exchangeCodeForTokens: jest.fn(),
    disconnect: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const googleAuth = require('../../utils/google-auth');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/google-oauth'));
    return app;
}

describe('Google OAuth Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.PUBLIC_APP_URL;
        app = createTestApp();
    });

    describe('GET /api/google/status', () => {
        it('should return Google OAuth status', async () => {
            const mockStatus = { connected: true, email: 'user@gmail.com' };
            googleAuth.getAuthStatus.mockResolvedValueOnce(mockStatus);

            const res = await request(app)
                .get('/api/google/status')
                .expect(200);

            expect(res.body.connected).toBe(true);
            expect(res.body.email).toBe('user@gmail.com');
            expect(googleAuth.getAuthStatus).toHaveBeenCalledWith(1);
        });
    });

    describe('GET /api/google/auth', () => {
        it('should redirect to Google consent screen', async () => {
            googleAuth.getAuthUrl.mockResolvedValueOnce('https://accounts.google.com/o/oauth2/auth?state=xyz');

            const res = await request(app)
                .get('/api/google/auth')
                .expect(302);

            expect(res.headers.location).toContain('accounts.google.com');
            expect(googleAuth.getAuthUrl).toHaveBeenCalledWith(1, 1);
        });
    });

    describe('GET /api/google/callback', () => {
        it('should handle successful OAuth callback', async () => {
            googleAuth.validateAuthState.mockResolvedValueOnce({ merchantId: 1 });
            googleAuth.exchangeCodeForTokens.mockResolvedValueOnce();

            const res = await request(app)
                .get('/api/google/callback?code=auth_code_123&state=state_xyz')
                .expect(302);

            expect(res.headers.location).toContain('google_connected=true');
            expect(googleAuth.validateAuthState).toHaveBeenCalledWith('state_xyz');
            expect(googleAuth.exchangeCodeForTokens).toHaveBeenCalledWith('auth_code_123', 1);
        });

        it('should redirect with error on OAuth error param', async () => {
            const res = await request(app)
                .get('/api/google/callback?error=access_denied')
                .expect(302);

            expect(res.headers.location).toContain('google_error=access_denied');
        });

        it('should redirect with error on missing code', async () => {
            const res = await request(app)
                .get('/api/google/callback?state=state_xyz')
                .expect(302);

            expect(res.headers.location).toContain('google_error=missing_code_or_state');
        });

        it('should redirect with error on missing state', async () => {
            const res = await request(app)
                .get('/api/google/callback?code=auth_code_123')
                .expect(302);

            expect(res.headers.location).toContain('google_error=missing_code_or_state');
        });

        it('should redirect with error on invalid state', async () => {
            googleAuth.validateAuthState.mockResolvedValueOnce({ merchantId: null });

            const res = await request(app)
                .get('/api/google/callback?code=auth_code_123&state=bad_state')
                .expect(302);

            expect(res.headers.location).toContain('google_error=invalid_state');
        });

        it('should redirect with generic error on exception', async () => {
            googleAuth.validateAuthState.mockRejectedValueOnce(new Error('DB error'));

            const res = await request(app)
                .get('/api/google/callback?code=auth_code_123&state=state_xyz')
                .expect(302);

            expect(res.headers.location).toContain('google_error=oauth_failed');
        });

        it('should use PUBLIC_APP_URL for redirects when set', async () => {
            process.env.PUBLIC_APP_URL = 'https://sqtools.example.com';
            googleAuth.validateAuthState.mockResolvedValueOnce({ merchantId: 1 });
            googleAuth.exchangeCodeForTokens.mockResolvedValueOnce();

            const res = await request(app)
                .get('/api/google/callback?code=auth_code_123&state=state_xyz')
                .expect(302);

            expect(res.headers.location).toContain('https://sqtools.example.com/gmc-feed.html');
        });
    });

    describe('POST /api/google/disconnect', () => {
        it('should disconnect Google account', async () => {
            googleAuth.disconnect.mockResolvedValueOnce();

            const res = await request(app)
                .post('/api/google/disconnect')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('disconnected');
            expect(googleAuth.disconnect).toHaveBeenCalledWith(1);
        });
    });
});
