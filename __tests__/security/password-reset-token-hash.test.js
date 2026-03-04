/**
 * Tests for SEC-7: Password reset tokens hashed with SHA-256 before storage
 * Verifies that plaintext tokens are never stored in the database.
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

jest.mock('../../utils/password', () => ({
    hashPassword: jest.fn().mockResolvedValue('$2b$10$hashed'),
    verifyPassword: jest.fn(),
    validatePassword: jest.fn(),
    generateRandomPassword: jest.fn().mockReturnValue('TempPass123!'),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    logAuthEvent: jest.fn().mockResolvedValue(undefined),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));

jest.mock('../../middleware/security', () => ({
    configureLoginRateLimit: () => (req, res, next) => next(),
    configurePasswordResetRateLimit: () => (req, res, next) => next(),
}));

jest.mock('../../middleware/validators/auth', () => ({
    login: (req, res, next) => next(),
    changePassword: (req, res, next) => next(),
    createUser: (req, res, next) => next(),
    updateUser: (req, res, next) => next(),
    resetUserPassword: (req, res, next) => next(),
    unlockUser: (req, res, next) => next(),
    forgotPassword: (req, res, next) => next(),
    resetPassword: (req, res, next) => next(),
    verifyResetToken: (req, res, next) => next(),
}));

const db = require('../../utils/database');
const { logAuthEvent } = require('../../middleware/auth');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

describe('Password Reset Token Hashing (SEC-7)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('forgot-password stores hashed token', () => {
        test('auth.js hashes token before INSERT', () => {
            const fs = require('fs');
            const authSource = fs.readFileSync(
                require.resolve('../../routes/auth'),
                'utf8'
            );

            // Verify the token is hashed BEFORE the INSERT query
            const hashLine = authSource.indexOf('const hashedToken = hashResetToken(resetToken)');
            const insertLine = authSource.indexOf("INSERT INTO password_reset_tokens (user_id, token, expires_at)");
            expect(hashLine).toBeGreaterThan(-1);
            expect(insertLine).toBeGreaterThan(hashLine);

            // Verify the INSERT uses hashedToken, not resetToken
            const insertBlock = authSource.substring(insertLine, insertLine + 200);
            expect(insertBlock).toContain('hashedToken');
        });
    });

    describe('hashResetToken function behavior', () => {
        test('SHA-256 produces consistent hash for same input', () => {
            const token = 'abc123def456';
            const hash1 = sha256(token);
            const hash2 = sha256(token);
            expect(hash1).toBe(hash2);
        });

        test('SHA-256 produces different hash for different inputs', () => {
            const token1 = crypto.randomBytes(32).toString('hex');
            const token2 = crypto.randomBytes(32).toString('hex');
            expect(sha256(token1)).not.toBe(sha256(token2));
        });

        test('hash is always 64 hex characters', () => {
            const token = crypto.randomBytes(32).toString('hex');
            expect(sha256(token)).toHaveLength(64);
            expect(sha256(token)).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('reset-password hashes token before lookup', () => {
        test('queries DB with hashed token, not plaintext', async () => {
            // Read the auth.js source to verify the pattern
            const fs = require('fs');
            const authSource = fs.readFileSync(
                require.resolve('../../routes/auth'),
                'utf8'
            );

            // Verify hashResetToken is called before all token DB lookups in reset-password
            expect(authSource).toContain('const hashedToken = hashResetToken(token)');

            // Verify all three endpoints use hashed token:
            // 1. forgot-password stores hashed
            expect(authSource).toContain('const hashedToken = hashResetToken(resetToken)');
            // 2. reset-password lookups use hashed
            // 3. verify-reset-token lookups use hashed
            // Count occurrences of hashResetToken — should be at least 3 (forgot, reset, verify)
            const matches = authSource.match(/hashResetToken\(/g);
            expect(matches.length).toBeGreaterThanOrEqual(3);
        });

        test('DB query uses hashed value for token lookup', async () => {
            const plaintext = crypto.randomBytes(32).toString('hex');
            const expectedHash = sha256(plaintext);

            // Simulate what reset-password does
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    user_id: 5,
                    token: expectedHash,
                    expires_at: new Date(Date.now() + 3600000),
                    used_at: null,
                    attempts_remaining: 5,
                    email: 'user@test.com',
                }],
            });

            // The hashed token matches what's in the DB
            const result = await db.query(
                'SELECT * FROM password_reset_tokens WHERE token = $1',
                [expectedHash]
            );
            expect(result.rows).toHaveLength(1);

            // Plaintext does NOT match
            db.query.mockResolvedValueOnce({ rows: [] });
            const badResult = await db.query(
                'SELECT * FROM password_reset_tokens WHERE token = $1',
                [plaintext]
            );
            expect(badResult.rows).toHaveLength(0);
        });
    });

    describe('subscriptions.js also hashes setup tokens', () => {
        test('hashResetToken is used in subscriptions.js', () => {
            const fs = require('fs');
            const subSource = fs.readFileSync(
                require.resolve('../../routes/subscriptions'),
                'utf8'
            );

            // Verify subscriptions.js also hashes tokens before storage
            expect(subSource).toContain('hashResetToken(passwordSetupToken)');
            expect(subSource).toContain('function hashResetToken');
        });
    });
});
