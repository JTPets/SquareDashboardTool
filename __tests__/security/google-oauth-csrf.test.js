/**
 * Google OAuth CSRF Protection Test Suite
 *
 * Verifies that the Google OAuth state parameter uses cryptographic
 * randomness, database storage, expiry, and single-use enforcement
 * — matching the Square OAuth CSRF pattern.
 *
 * Tests the fix for CRIT-2: insecure base64-encoded merchantId state.
 */

const crypto = require('crypto');

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: jest.fn().mockImplementation(() => ({
                generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?state=test'),
                getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'at', refresh_token: 'rt' } }),
                setCredentials: jest.fn(),
                on: jest.fn(),
            })),
        },
    },
}), { virtual: true });

const db = require('../../utils/database');

describe('Google OAuth CSRF Protection', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.GOOGLE_CLIENT_ID = 'test-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
        process.env.GOOGLE_REDIRECT_URI = 'http://localhost:5001/api/google/callback';
    });

    afterEach(() => {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        delete process.env.GOOGLE_REDIRECT_URI;
    });

    describe('getAuthUrl - State Generation', () => {

        test('generates cryptographically random state (not base64 merchantId)', async () => {
            const googleAuth = require('../../utils/google-auth');

            db.query.mockResolvedValueOnce({ rows: [] }); // INSERT state

            await googleAuth.getAuthUrl(42, 1);

            // Verify the INSERT was called with a hex state, not base64
            const insertCall = db.query.mock.calls[0];
            const stateParam = insertCall[1][0];

            // Must be 64 hex chars (32 bytes)
            expect(stateParam).toHaveLength(64);
            expect(stateParam).toMatch(/^[a-f0-9]+$/);

            // Must NOT be the old insecure base64 pattern
            const insecureState = Buffer.from(JSON.stringify({ merchantId: 42 })).toString('base64');
            expect(stateParam).not.toBe(insecureState);
        });

        test('stores state with user_id, merchant_id, and expiry', async () => {
            const googleAuth = require('../../utils/google-auth');

            db.query.mockResolvedValueOnce({ rows: [] });

            await googleAuth.getAuthUrl(42, 7);

            const insertCall = db.query.mock.calls[0];
            const sql = insertCall[0];
            const params = insertCall[1];

            expect(sql).toContain('INSERT INTO oauth_states');
            expect(sql).toContain('merchant_id');
            expect(sql).toContain('user_id');
            expect(sql).toContain('expires_at');
            // params: [state, userId, merchantId, redirectUri]
            expect(params[1]).toBe(7);  // user_id
            expect(params[2]).toBe(42); // merchant_id
        });

        test('requires userId parameter', async () => {
            const googleAuth = require('../../utils/google-auth');

            await expect(googleAuth.getAuthUrl(42, null))
                .rejects.toThrow('userId is required');
        });

        test('requires merchantId parameter', async () => {
            const googleAuth = require('../../utils/google-auth');

            await expect(googleAuth.getAuthUrl(null, 1))
                .rejects.toThrow('merchantId is required');
        });

        test('generates unique state for each call', async () => {
            const googleAuth = require('../../utils/google-auth');

            db.query.mockResolvedValue({ rows: [] });

            await googleAuth.getAuthUrl(1, 1);
            await googleAuth.getAuthUrl(1, 1);

            const state1 = db.query.mock.calls[0][1][0];
            const state2 = db.query.mock.calls[1][1][0];

            expect(state1).not.toBe(state2);
        });
    });

    describe('validateAuthState - State Validation', () => {

        test('accepts valid, unexpired, unused state', async () => {
            const googleAuth = require('../../utils/google-auth');

            const state = crypto.randomBytes(32).toString('hex');

            // SELECT returns valid record
            db.query.mockResolvedValueOnce({
                rows: [{
                    state,
                    user_id: 7,
                    merchant_id: 42,
                    redirect_uri: '/gmc-feed.html',
                    expires_at: new Date(Date.now() + 5 * 60 * 1000),
                    used_at: null
                }]
            });
            // UPDATE marks as used
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await googleAuth.validateAuthState(state);

            expect(result.merchantId).toBe(42);
            expect(result.userId).toBe(7);
        });

        test('marks state as used after validation (prevents replay)', async () => {
            const googleAuth = require('../../utils/google-auth');

            const state = crypto.randomBytes(32).toString('hex');

            db.query.mockResolvedValueOnce({
                rows: [{ state, user_id: 1, merchant_id: 1, redirect_uri: '/', expires_at: new Date(), used_at: null }]
            });
            db.query.mockResolvedValueOnce({ rows: [] });

            await googleAuth.validateAuthState(state);

            // Second call should be the UPDATE marking used_at
            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('UPDATE oauth_states SET used_at');
            expect(updateCall[1]).toEqual([state]);
        });

        test('rejects expired state', async () => {
            const googleAuth = require('../../utils/google-auth');

            db.query.mockResolvedValueOnce({ rows: [] }); // expires_at > NOW() fails

            await expect(googleAuth.validateAuthState('expired-state'))
                .rejects.toThrow('invalid, expired, or already used');
        });

        test('rejects already-used state (replay attack)', async () => {
            const googleAuth = require('../../utils/google-auth');

            db.query.mockResolvedValueOnce({ rows: [] }); // used_at IS NULL fails

            await expect(googleAuth.validateAuthState('used-state'))
                .rejects.toThrow('invalid, expired, or already used');
        });

        test('rejects forged state (CSRF attack)', async () => {
            const googleAuth = require('../../utils/google-auth');

            // Attacker forges old-style base64 state
            const forgedState = Buffer.from(JSON.stringify({ merchantId: 42 })).toString('base64');

            db.query.mockResolvedValueOnce({ rows: [] }); // Not in database

            await expect(googleAuth.validateAuthState(forgedState))
                .rejects.toThrow('invalid, expired, or already used');
        });

        test('rejects missing state parameter', async () => {
            const googleAuth = require('../../utils/google-auth');

            await expect(googleAuth.validateAuthState(null))
                .rejects.toThrow('Missing OAuth state parameter');
        });
    });

    describe('Backward Compatibility', () => {

        test('google-sheets.js re-exports google-auth.js', () => {
            const googleSheets = require('../../utils/google-sheets');
            const googleAuth = require('../../utils/google-auth');

            expect(googleSheets.getAuthUrl).toBe(googleAuth.getAuthUrl);
            expect(googleSheets.validateAuthState).toBe(googleAuth.validateAuthState);
            expect(googleSheets.exchangeCodeForTokens).toBe(googleAuth.exchangeCodeForTokens);
            expect(googleSheets.disconnect).toBe(googleAuth.disconnect);
        });

        test('parseAuthState is no longer exported (insecure)', () => {
            const googleAuth = require('../../utils/google-auth');

            expect(googleAuth.parseAuthState).toBeUndefined();
        });
    });

    describe('State Expiry Configuration', () => {

        test('state expires after 10 minutes (matches Square OAuth)', () => {
            const googleAuth = require('../../utils/google-auth');

            expect(googleAuth.STATE_EXPIRY_MINUTES).toBe(10);
        });
    });
});
