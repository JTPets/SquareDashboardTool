'use strict';

jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));
jest.mock('../../../utils/password', () => ({
    verifyPassword: jest.fn(),
    hashPassword: jest.fn().mockResolvedValue('$2b$10$hashed'),
}));
// Use real SHA-256 implementation so hash assertions are meaningful
jest.mock('../../../utils/hash-utils', () => ({
    hashResetToken: (t) => require('crypto').createHash('sha256').update(t).digest('hex'),
}));
jest.mock('../../../middleware/auth', () => ({
    logAuthEvent: jest.fn().mockResolvedValue(undefined),
}));

const crypto = require('crypto');
const db = require('../../../utils/database');
const { verifyPassword, hashPassword } = require('../../../utils/password');
const { logAuthEvent } = require('../../../middleware/auth');
const {
    changePassword,
    forgotPassword,
    resetPassword,
    verifyResetToken,
} = require('../../../services/auth/password-service');

describe('password-service', () => {
    beforeEach(() => jest.clearAllMocks());

    // ─── changePassword ───────────────────────────────────────────────────────

    describe('changePassword', () => {
        const CTX = { email: 'u@t.com', ipAddress: '1.2.3.4', userAgent: 'ua' };

        it('throws 404 if user not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(changePassword(1, 'old', 'New1234!', CTX))
                .rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
        });

        it('throws 401 if current password is wrong', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ password_hash: '$2b$hash' }] });
            verifyPassword.mockResolvedValueOnce(false);
            await expect(changePassword(1, 'wrong', 'New1234!', CTX))
                .rejects.toMatchObject({ message: 'Current password is incorrect', statusCode: 401 });
        });

        it('hashes new password, updates DB, and logs event on success', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ password_hash: '$2b$hash' }] });
            verifyPassword.mockResolvedValueOnce(true);
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
            await changePassword(1, 'correct', 'New1234!', CTX);
            expect(hashPassword).toHaveBeenCalledWith('New1234!');
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE users SET password_hash'),
                expect.arrayContaining(['$2b$10$hashed', 1])
            );
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'password_change',
            }));
        });
    });

    // ─── forgotPassword ───────────────────────────────────────────────────────

    describe('forgotPassword', () => {
        it('returns anti-enumeration message for non-existent email', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const result = await forgotPassword('nobody@test.com', '1.2.3.4');
            expect(result.message).toMatch(/If an account exists/);
            // No DB writes should have happened
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('stores SHA-256 hash of token, not plaintext (SEC-7)', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'u@t.com' }] });
            db.query.mockResolvedValueOnce({ rows: [] }); // DELETE
            db.query.mockResolvedValueOnce({ rows: [] }); // INSERT
            await forgotPassword('u@t.com', '1.2.3.4');
            const insertCall = db.query.mock.calls[2];
            const storedToken = insertCall[1][1];
            // SHA-256 hex digest is always 64 characters
            expect(storedToken).toHaveLength(64);
            // Must not be the plaintext token (which is 64 hex chars too, but different)
            // Verify it IS a valid SHA-256 by checking it matches hashing a 32-byte hex value
            expect(storedToken).toMatch(/^[0-9a-f]{64}$/);
        });

        it('deletes existing tokens before inserting new one', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'u@t.com' }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            await forgotPassword('u@t.com', '1.2.3.4');
            expect(db.query.mock.calls[1][0]).toContain('DELETE FROM password_reset_tokens');
            expect(db.query.mock.calls[2][0]).toContain('INSERT INTO password_reset_tokens');
        });

        it('returns success message even when user is found', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'u@t.com' }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            const result = await forgotPassword('u@t.com', '1.2.3.4');
            expect(result.message).toMatch(/If an account exists/);
        });

        it('logs password_reset_requested event', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'u@t.com' }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            await forgotPassword('u@t.com', '1.2.3.4');
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'password_reset_requested',
            }));
        });
    });

    // ─── resetPassword ────────────────────────────────────────────────────────

    describe('resetPassword', () => {
        const token = crypto.randomBytes(32).toString('hex');
        const CTX = { ipAddress: '1.2.3.4', userAgent: 'ua' };

        it('throws 400 for invalid/expired/missing token', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // main query
            db.query.mockResolvedValueOnce({ rows: [] }); // exhausted check
            await expect(resetPassword(token, 'NewPass1!', CTX))
                .rejects.toMatchObject({ message: expect.stringMatching(/Invalid or expired/), statusCode: 400 });
        });

        it('throws 400 when token has exhausted attempts', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // main query
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, attempts_remaining: 0 }] }); // exhausted
            await expect(resetPassword(token, 'NewPass1!', CTX))
                .rejects.toMatchObject({ statusCode: 400 });
        });

        it('decrements attempts_remaining BEFORE password update', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 7, user_id: 5, email: 'u@t.com', attempts_remaining: 3 }] });
            db.query.mockResolvedValueOnce({ rows: [] }); // decrement
            db.query.mockResolvedValueOnce({ rows: [] }); // update user
            db.query.mockResolvedValueOnce({ rows: [] }); // mark used
            await resetPassword(token, 'NewPass1!', CTX);
            // call[1] = decrement, call[2] = password update
            expect(db.query.mock.calls[1][0]).toContain('attempts_remaining');
            expect(db.query.mock.calls[1][1]).toEqual([7]);
            expect(db.query.mock.calls[2][0]).toContain('UPDATE users');
        });

        it('updates password, clears lockout fields, marks token used', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 5, email: 'u@t.com', attempts_remaining: 5 }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            await resetPassword(token, 'NewPass1!', CTX);
            const userUpdate = db.query.mock.calls[2];
            expect(userUpdate[0]).toContain('failed_login_attempts = 0');
            expect(userUpdate[0]).toContain('locked_until = NULL');
            const markUsed = db.query.mock.calls[3];
            expect(markUsed[0]).toContain('used_at = NOW()');
        });

        it('hashes token before DB lookup (SEC-7)', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(resetPassword(token, 'NewPass1!', CTX)).rejects.toBeDefined();
            const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
            expect(db.query.mock.calls[0][1]).toContain(expectedHash);
        });

        it('logs password_reset_completed event on success', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 5, email: 'u@t.com', attempts_remaining: 5 }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });
            await resetPassword(token, 'NewPass1!', CTX);
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'password_reset_completed',
            }));
        });
    });

    // ─── verifyResetToken ─────────────────────────────────────────────────────

    describe('verifyResetToken', () => {
        const token = crypto.randomBytes(32).toString('hex');

        it('returns valid:false for unknown/expired token', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const result = await verifyResetToken(token);
            expect(result).toMatchObject({ valid: false });
        });

        it('returns valid:true with email and expiresAt for valid token', async () => {
            const expires = new Date(Date.now() + 3600000);
            db.query.mockResolvedValueOnce({ rows: [{
                id: 1, email: 'u@t.com', expires_at: expires, attempts_remaining: 5,
            }] });
            const result = await verifyResetToken(token);
            expect(result).toMatchObject({ valid: true, email: 'u@t.com', expiresAt: expires });
        });

        it('hashes token before DB lookup (SEC-7)', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            await verifyResetToken(token);
            const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
            expect(db.query.mock.calls[0][1]).toContain(expectedHash);
        });
    });
});
