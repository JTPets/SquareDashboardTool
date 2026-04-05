'use strict';

/**
 * Session Service — login and logout.
 * Extracted from routes/auth.js.
 * Security: session fixation prevention, account lockout, anti-enumeration.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { verifyPassword } = require('../../utils/password');
const { logAuthEvent } = require('../../middleware/auth');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

function authError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Authenticate a user and regenerate session to prevent session fixation.
 * SECURITY: Generic error message prevents email enumeration.
 * SECURITY: session.regenerate() called before setting session data.
 * @param {string} email - Raw email (normalized internally)
 * @param {string} password - Plaintext password
 * @param {Object} req - Express request (session access required)
 * @param {{ ipAddress: string, userAgent: string }} context
 * @returns {{ user: Object }} Session user payload on success
 * @throws {Error} statusCode 401 on auth failure, 500 on session error
 */
async function loginUser(email, password, req, { ipAddress, userAgent }) {
    const normalizedEmail = email.toLowerCase().trim();

    const userResult = await db.query(
        'SELECT * FROM users WHERE email = $1',
        [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
        await logAuthEvent(db, {
            email: normalizedEmail,
            eventType: 'login_failed',
            ipAddress,
            userAgent,
            details: { reason: 'user_not_found' }
        });
        // Generic error — prevents email enumeration
        throw authError('Invalid email or password', 401);
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
        await logAuthEvent(db, {
            userId: user.id,
            email: normalizedEmail,
            eventType: 'login_failed',
            ipAddress,
            userAgent,
            details: { reason: 'account_inactive' }
        });
        throw authError('This account has been deactivated', 401);
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
        throw authError(`Account is locked. Try again in ${remainingMinutes} minutes.`, 401);
    }

    const passwordValid = await verifyPassword(password, user.password_hash);

    if (!passwordValid) {
        const newFailedAttempts = (user.failed_login_attempts || 0) + 1;
        let lockUntil = null;

        if (newFailedAttempts >= MAX_FAILED_ATTEMPTS) {
            lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
            logger.warn('Account locked due to failed attempts', {
                userId: user.id,
                email: normalizedEmail,
                attempts: newFailedAttempts
            });
        }

        await db.query(
            'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
            [newFailedAttempts, lockUntil, user.id]
        );

        await logAuthEvent(db, {
            userId: user.id,
            email: normalizedEmail,
            eventType: lockUntil ? 'account_locked' : 'login_failed',
            ipAddress,
            userAgent,
            details: { reason: 'invalid_password', attempts: newFailedAttempts }
        });

        if (lockUntil) {
            throw authError(`Too many failed attempts. Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.`, 401);
        }
        // Generic error — prevents email enumeration
        throw authError('Invalid email or password', 401);
    }

    await db.query(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
    );

    // SECURITY: Regenerate session ID to prevent session fixation attacks.
    // Session data must be set AFTER regeneration.
    try {
        await new Promise((resolve, reject) => {
            req.session.regenerate((err) => err ? reject(err) : resolve());
        });
    } catch (err) {
        logger.error('Session regeneration failed', { error: err.message, stack: err.stack, userId: user.id });
        throw authError('Login failed. Please try again.', 500);
    }

    req.session.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
    };

    try {
        await new Promise((resolve, reject) => {
            req.session.save((err) => err ? reject(err) : resolve());
        });
    } catch (err) {
        logger.error('Session save failed', { error: err.message, stack: err.stack, userId: user.id });
        throw authError('Login failed. Please try again.', 500);
    }

    await logAuthEvent(db, {
        userId: user.id,
        email: user.email,
        eventType: 'login_success',
        ipAddress,
        userAgent
    });

    logger.info('User logged in', { userId: user.id, email: user.email });

    return {
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
        }
    };
}

/**
 * Destroy user session and log the event.
 * @param {Object} req - Express request
 * @param {{ ipAddress: string, userAgent: string }} context
 */
async function logoutUser(req, { ipAddress, userAgent }) {
    const user = req.session?.user;

    if (user) {
        await logAuthEvent(db, {
            userId: user.id,
            merchantId: req.session?.activeMerchantId,
            email: user.email,
            eventType: 'logout',
            ipAddress,
            userAgent
        });
        logger.info('User logged out', { userId: user.id, email: user.email });
    }

    return new Promise((resolve) => {
        req.session.destroy((err) => {
            if (err) {
                logger.error('Session destroy error', { error: err.message, stack: err.stack });
            }
            resolve();
        });
    });
}

module.exports = { loginUser, logoutUser };
