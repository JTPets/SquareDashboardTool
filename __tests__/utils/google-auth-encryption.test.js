/**
 * Tests for SEC-6: Google OAuth token encryption at rest
 * Verifies that tokens are encrypted before storage and decrypted on retrieval
 */

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.com/api/google/callback';

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const mockOAuth2Instance = {
    generateAuthUrl: jest.fn(),
    getToken: jest.fn(),
    setCredentials: jest.fn(),
    on: jest.fn(),
};

jest.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: jest.fn().mockImplementation(() => mockOAuth2Instance),
        },
    },
}), { virtual: true });

const db = require('../../utils/database');
const { encryptToken, decryptToken, isEncryptedToken } = require('../../utils/token-encryption');
const googleAuth = require('../../utils/google-auth');

describe('Google OAuth Token Encryption (SEC-6)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('saveTokens → encrypted storage', () => {
        test('encrypts access_token and refresh_token before INSERT', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            mockOAuth2Instance.getToken.mockResolvedValueOnce({
                tokens: {
                    access_token: 'ya29.test-access-token',
                    refresh_token: '1//test-refresh-token',
                    token_type: 'Bearer',
                    expiry_date: 1709510400000,
                    scope: 'https://www.googleapis.com/auth/content',
                },
            });

            await googleAuth.exchangeCodeForTokens('test-code', 42);

            const [, params] = db.query.mock.calls[0];
            expect(params[0]).toBe(42);
            // access_token should be encrypted
            expect(isEncryptedToken(params[1])).toBe(true);
            expect(params[1]).not.toBe('ya29.test-access-token');
            // refresh_token should be encrypted
            expect(isEncryptedToken(params[2])).toBe(true);
            expect(params[2]).not.toBe('1//test-refresh-token');
            // token_type is not sensitive
            expect(params[3]).toBe('Bearer');
        });

        test('handles null refresh_token gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            mockOAuth2Instance.getToken.mockResolvedValueOnce({
                tokens: {
                    access_token: 'ya29.test-access-token',
                    refresh_token: null,
                    token_type: 'Bearer',
                    expiry_date: 1709510400000,
                    scope: 'content',
                },
            });

            await googleAuth.exchangeCodeForTokens('test-code', 42);

            const [, params] = db.query.mock.calls[0];
            expect(params[2]).toBeNull();
        });
    });

    describe('loadTokens → decrypted retrieval', () => {
        test('decrypts encrypted tokens from database', async () => {
            const encryptedAccess = encryptToken('ya29.real-access-token');
            const encryptedRefresh = encryptToken('1//real-refresh-token');

            db.query.mockResolvedValueOnce({
                rows: [{
                    access_token: encryptedAccess,
                    refresh_token: encryptedRefresh,
                    token_type: 'Bearer',
                    expiry_date: '1709510400000',
                    scope: 'content',
                }],
            });

            const result = await googleAuth.isAuthenticated(42);
            expect(result).toBe(true);
        });

        test('handles legacy plaintext tokens (backward compatibility)', async () => {
            // loadTokens SELECT + fire-and-forget UPDATE for rotation
            db.query.mockResolvedValueOnce({
                rows: [{
                    access_token: 'ya29.legacy-plaintext-token',
                    refresh_token: '1//legacy-refresh',
                    token_type: 'Bearer',
                    expiry_date: '1709510400000',
                    scope: 'content',
                }],
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // rotation UPDATE

            const result = await googleAuth.isAuthenticated(42);
            expect(result).toBe(true);
        });

        test('force-rotates plaintext tokens to encrypted on read', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    access_token: 'ya29.plaintext-access',
                    refresh_token: '1//plaintext-refresh',
                    token_type: 'Bearer',
                    expiry_date: '1709510400000',
                    scope: 'content',
                }],
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // rotation UPDATE

            await googleAuth.isAuthenticated(42);

            // Should have fired an UPDATE to re-encrypt
            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('UPDATE google_oauth_tokens');
            // Params: [merchantId, encryptedAccess, encryptedRefresh]
            expect(updateCall[1][0]).toBe(42);
            expect(isEncryptedToken(updateCall[1][1])).toBe(true);
            expect(isEncryptedToken(updateCall[1][2])).toBe(true);
        });

        test('does not fire rotation UPDATE for already-encrypted tokens', async () => {
            const encryptedAccess = encryptToken('ya29.already-encrypted');
            const encryptedRefresh = encryptToken('1//already-encrypted');

            db.query.mockResolvedValueOnce({
                rows: [{
                    access_token: encryptedAccess,
                    refresh_token: encryptedRefresh,
                    token_type: 'Bearer',
                    expiry_date: '1709510400000',
                    scope: 'content',
                }],
            });

            await googleAuth.isAuthenticated(42);

            // Only 1 query (SELECT), no UPDATE
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        test('returns false for non-existent merchant', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const result = await googleAuth.isAuthenticated(999);
            expect(result).toBe(false);
        });
    });

    describe('roundtrip encryption', () => {
        test('encrypt → store → load → decrypt produces original tokens', async () => {
            const originalAccess = 'ya29.a-long-access-token-value';
            const originalRefresh = '1//0a-long-refresh-token';

            // Save via exchangeCodeForTokens
            db.query.mockResolvedValueOnce({ rows: [] });
            mockOAuth2Instance.getToken.mockResolvedValueOnce({
                tokens: {
                    access_token: originalAccess,
                    refresh_token: originalRefresh,
                    token_type: 'Bearer',
                    expiry_date: 1709510400000,
                    scope: 'content',
                },
            });
            await googleAuth.exchangeCodeForTokens('code', 1);

            // Capture stored encrypted values
            const storedParams = db.query.mock.calls[0][1];
            const storedAccess = storedParams[1];
            const storedRefresh = storedParams[2];

            // Verify stored values are encrypted, not plaintext
            expect(storedAccess).not.toBe(originalAccess);
            expect(storedRefresh).not.toBe(originalRefresh);

            // Verify decryption recovers original values
            expect(decryptToken(storedAccess)).toBe(originalAccess);
            expect(decryptToken(storedRefresh)).toBe(originalRefresh);
        });
    });
});
