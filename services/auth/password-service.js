'use strict';

/**
 * Password Service — change password, forgot/reset flow, token verification.
 * Extracted from routes/auth.js.
 * Security: SHA-256 token hashing (SEC-7), atomic attempt decrement, anti-enumeration.
 */

const crypto = require('crypto');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { hashPassword, verifyPassword } = require('../../utils/password');
const { hashResetToken } = require('../../utils/hash-utils');
const { logAuthEvent } = require('../../middleware/auth');

function authError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Change a user's own password.
 * @param {number} userId
 * @param {string} currentPassword - Plaintext current password to verify
 * @param {string} newPassword - Plaintext new password
 * @param {{ merchantId?: string, email: string, ipAddress: string, userAgent: string }} context
 * @throws {Error} 404 if user not found, 401 if current password wrong
 */
async function changePassword(userId, currentPassword, newPassword, { merchantId, email, ipAddress, userAgent }) {
    const userResult = await db.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
    );

    if (userResult.rows.length === 0) {
        throw authError('User not found', 404);
    }

    const currentPasswordValid = await verifyPassword(currentPassword, userResult.rows[0].password_hash);
    if (!currentPasswordValid) {
        throw authError('Current password is incorrect', 401);
    }

    const newPasswordHash = await hashPassword(newPassword);
    await db.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newPasswordHash, userId]
    );

    await logAuthEvent(db, {
        userId,
        merchantId,
        email,
        eventType: 'password_change',
        ipAddress,
        userAgent
    });

    logger.info('Password changed', { userId });
}

/**
 * Request a password reset token.
 * SECURITY: Always returns success to prevent email enumeration.
 * SECURITY: Plaintext token returned in result; SHA-256 hash stored in DB (SEC-7).
 * @param {string} email - Raw email (normalized internally)
 * @param {string} ipAddress
 * @returns {{ message: string, resetToken?: string, resetUrl?: string }}
 */
async function forgotPassword(email, ipAddress) {
    const normalizedEmail = email.toLowerCase().trim();

    const userResult = await db.query(
        'SELECT id, email FROM users WHERE email = $1',
        [normalizedEmail]
    );

    // Always return success — prevents email enumeration
    if (userResult.rows.length === 0) {
        logger.info('Password reset requested for non-existent email', { email: normalizedEmail, ipAddress });
        return {
            message: 'If an account exists with this email, you will receive a password reset link.'
        };
    }

    const user = userResult.rows[0];

    // Generate reset token — plaintext sent to user, SHA-256 hash stored in DB (SEC-7)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = hashResetToken(resetToken);
    const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
    await db.query(
        'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, hashedToken, tokenExpiry]
    );

    await logAuthEvent(db, {
        userId: user.id,
        email: user.email,
        eventType: 'password_reset_requested',
        ipAddress,
        details: { token_expires: tokenExpiry.toISOString() }
    });

    logger.info('Password reset token generated', {
        userId: user.id,
        email: user.email,
        expiresAt: tokenExpiry.toISOString()
    });

    // S-5: Only expose plaintext token in development for testing
    const isDev = process.env.NODE_ENV === 'development';
    return {
        message: 'If an account exists with this email, you will receive a password reset link.',
        ...(isDev && { resetToken, resetUrl: `/set-password.html?token=${resetToken}` })
    };
}

/**
 * Reset password using a valid token.
 * SECURITY: Atomic attempt decrement BEFORE password update (prevents brute-force
 * even if subsequent steps fail).
 * @param {string} token - Plaintext token from user
 * @param {string} newPassword
 * @param {{ ipAddress: string, userAgent: string }} context
 * @throws {Error} 400 if token invalid, expired, or attempts exhausted
 */
async function resetPassword(token, newPassword, { ipAddress, userAgent }) {
    // Hash incoming token to compare against stored hash (SEC-7)
    const hashedToken = hashResetToken(token);

    // COALESCE handles tokens created before attempts_remaining column migration
    const tokenResult = await db.query(`
        SELECT prt.*, u.email
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = $1
          AND prt.expires_at > NOW()
          AND prt.used_at IS NULL
          AND COALESCE(prt.attempts_remaining, 5) > 0
    `, [hashedToken]);

    if (tokenResult.rows.length === 0) {
        const exhaustedCheck = await db.query(`
            SELECT id, attempts_remaining FROM password_reset_tokens
            WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
        `, [hashedToken]);

        if (exhaustedCheck.rows.length > 0 && exhaustedCheck.rows[0].attempts_remaining <= 0) {
            logger.warn('Password reset token exhausted all attempts', {
                token: token.substring(0, 10) + '...',
                ipAddress
            });
        } else {
            logger.warn('Invalid or expired password reset token', {
                token: token.substring(0, 10) + '...',
                ipAddress
            });
        }

        throw authError('Invalid or expired reset token. Please request a new password reset.', 400);
    }

    const resetRecord = tokenResult.rows[0];
    const userId = resetRecord.user_id;

    // Decrement attempts atomically BEFORE processing to prevent brute-force
    await db.query(
        'UPDATE password_reset_tokens SET attempts_remaining = COALESCE(attempts_remaining, 5) - 1 WHERE id = $1',
        [resetRecord.id]
    );

    const passwordHash = await hashPassword(newPassword);
    await db.query(`
        UPDATE users SET
            password_hash = $1,
            failed_login_attempts = 0,
            locked_until = NULL,
            password_changed_at = NOW(),
            updated_at = NOW()
        WHERE id = $2
    `, [passwordHash, userId]);

    await db.query(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
        [resetRecord.id]
    );

    await logAuthEvent(db, {
        userId,
        email: resetRecord.email,
        eventType: 'password_reset_completed',
        ipAddress,
        userAgent
    });

    logger.info('Password reset completed', { userId, email: resetRecord.email });
}

/**
 * Verify a password reset token is valid (without consuming it).
 * @param {string} token - Plaintext token
 * @returns {{ valid: boolean, email?: string, expiresAt?: Date, message?: string }}
 */
async function verifyResetToken(token) {
    const hashedToken = hashResetToken(token);

    const tokenResult = await db.query(`
        SELECT prt.id, prt.expires_at, prt.attempts_remaining, u.email
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = $1
          AND prt.expires_at > NOW()
          AND prt.used_at IS NULL
          AND COALESCE(prt.attempts_remaining, 5) > 0
    `, [hashedToken]);

    if (tokenResult.rows.length === 0) {
        return { valid: false, message: 'Invalid or expired token' };
    }

    return {
        valid: true,
        email: tokenResult.rows[0].email,
        expiresAt: tokenResult.rows[0].expires_at
    };
}

module.exports = { changePassword, forgotPassword, resetPassword, verifyResetToken };
