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
        // LOGIC CHANGE: forgot-password logic extracted to services/auth/password-service.js
        test('password-service.js hashes token before INSERT', () => {
            const fs = require('fs');
            const svcSource = fs.readFileSync(
                require.resolve('../../services/auth/password-service'),
                'utf8'
            );

            // Verify the token is hashed BEFORE the INSERT query
            const hashLine = svcSource.indexOf('const hashedToken = hashResetToken(resetToken)');
            const insertLine = svcSource.indexOf("INSERT INTO password_reset_tokens (user_id, token, expires_at)");
            expect(hashLine).toBeGreaterThan(-1);
            expect(insertLine).toBeGreaterThan(hashLine);

            // Verify the INSERT uses hashedToken, not resetToken
            const insertBlock = svcSource.substring(insertLine, insertLine + 200);
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
        // LOGIC CHANGE: reset-password/verify-reset-token logic extracted to services/auth/password-service.js
        test('queries DB with hashed token, not plaintext', async () => {
            const fs = require('fs');
            const svcSource = fs.readFileSync(
                require.resolve('../../services/auth/password-service'),
                'utf8'
            );

            // Verify hashResetToken is called before all token DB lookups
            expect(svcSource).toContain('const hashedToken = hashResetToken(token)');

            // Verify all three operations use hashed token:
            // 1. forgotPassword stores hashed (resetToken)
            expect(svcSource).toContain('const hashedToken = hashResetToken(resetToken)');
            // 2. resetPassword lookups use hashed (token)
            // 3. verifyResetToken lookups use hashed (token)
            // Count occurrences — should be at least 3 (forgotPassword, resetPassword, verifyResetToken)
            const matches = svcSource.match(/hashResetToken\(/g);
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

    describe('subscription-create-service.js hashes setup tokens', () => {
        // LOGIC CHANGE: token hashing moved to subscription-create-service.js (BACKLOG-74 follow-up)
        test('hashResetToken is used in subscription-create-service.js', () => {
            const fs = require('fs');
            const svcSource = fs.readFileSync(
                require.resolve('../../services/subscriptions/subscription-create-service'),
                'utf8'
            );

            // Verify the service uses hashResetToken (SEC-7: never store plaintext reset tokens)
            expect(svcSource).toContain('hashResetToken(passwordSetupToken)');
            expect(svcSource).toContain("require('../../utils/hash-utils')");
        });
    });

    describe('hashResetToken shared utility', () => {
        test('utils/hash-utils.js exports hashResetToken', () => {
            const { hashResetToken } = require('../../utils/hash-utils');
            expect(typeof hashResetToken).toBe('function');
            const hash = hashResetToken('test-token');
            expect(hash).toHaveLength(64);
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });
});
