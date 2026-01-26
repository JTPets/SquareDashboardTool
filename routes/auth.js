/**
 * Authentication Routes
 * Handles login, logout, user management
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { hashPassword, verifyPassword, validatePassword, generateRandomPassword } = require('../utils/password');
const { requireAuth, requireAdmin, logAuthEvent, getClientIp } = require('../middleware/auth');
const { configureLoginRateLimit, configurePasswordResetRateLimit } = require('../middleware/security');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/auth');

// Apply rate limiting to sensitive routes
const loginRateLimit = configureLoginRateLimit();
const passwordResetRateLimit = configurePasswordResetRateLimit();

// Account lockout settings
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

/**
 * POST /api/auth/login
 * Authenticate user with email and password
 */
router.post('/login', loginRateLimit, validators.login, asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Email is already normalized by validator
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const userResult = await db.query(
        'SELECT * FROM users WHERE email = $1',
        [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
        // Log failed attempt (user not found)
        await logAuthEvent(db, {
            email: normalizedEmail,
            eventType: 'login_failed',
            ipAddress,
            userAgent,
            details: { reason: 'user_not_found' }
        });

        // Use generic error to prevent email enumeration
        return res.status(401).json({
            success: false,
            error: 'Invalid email or password'
        });
    }

    const user = userResult.rows[0];

    // Check if account is active
    if (!user.is_active) {
        await logAuthEvent(db, {
            userId: user.id,
            email: normalizedEmail,
            eventType: 'login_failed',
            ipAddress,
            userAgent,
            details: { reason: 'account_inactive' }
        });

        return res.status(401).json({
            success: false,
            error: 'This account has been deactivated'
        });
    }

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);

        return res.status(401).json({
            success: false,
            error: `Account is locked. Try again in ${remainingMinutes} minutes.`
        });
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.password_hash);

    if (!passwordValid) {
        // Increment failed attempts
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
            return res.status(401).json({
                success: false,
                error: `Too many failed attempts. Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.`
            });
        }

        return res.status(401).json({
            success: false,
            error: 'Invalid email or password'
        });
    }

    // Login successful - reset failed attempts and update last login
    await db.query(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
    );

    // SECURITY: Regenerate session ID to prevent session fixation attacks
    // This ensures any pre-existing session ID cannot be used by an attacker
    req.session.regenerate(async (err) => {
        if (err) {
            logger.error('Session regeneration failed', { error: err.message, stack: err.stack, userId: user.id });
            return res.status(500).json({
                success: false,
                error: 'Login failed. Please try again.'
            });
        }

        // Create session with user data after regeneration
        req.session.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
        };

        // Save session to ensure it's persisted before responding
        req.session.save(async (saveErr) => {
            if (saveErr) {
                logger.error('Session save failed', { error: saveErr.message, stack: saveErr.stack, userId: user.id });
                return res.status(500).json({
                    success: false,
                    error: 'Login failed. Please try again.'
                });
            }

            await logAuthEvent(db, {
                userId: user.id,
                email: user.email,
                eventType: 'login_success',
                ipAddress,
                userAgent
            });

            logger.info('User logged in', { userId: user.id, email: user.email });

            res.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role
                }
            });
        });
    });
}));

/**
 * POST /api/auth/logout
 * Destroy user session
 */
router.post('/logout', asyncHandler(async (req, res) => {
    const user = req.session?.user;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    if (user) {
        await logAuthEvent(db, {
            userId: user.id,
            email: user.email,
            eventType: 'logout',
            ipAddress,
            userAgent
        });

        logger.info('User logged out', { userId: user.id, email: user.email });
    }

    req.session.destroy((err) => {
        if (err) {
            logger.error('Session destroy error', { error: err.message, stack: err.stack });
        }
        res.clearCookie('sid');
        res.json({ success: true });
    });
}));

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({
            success: false,
            authenticated: false
        });
    }

    res.json({
        success: true,
        authenticated: true,
        user: req.session.user
    });
});

/**
 * POST /api/auth/change-password
 * Change current user's password
 */
router.post('/change-password', requireAuth, validators.changePassword, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.user.id;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Password strength validated by middleware

    // Get current password hash
    const userResult = await db.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
    );

    if (userResult.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'User not found'
        });
    }

    // Verify current password
    const currentPasswordValid = await verifyPassword(currentPassword, userResult.rows[0].password_hash);
    if (!currentPasswordValid) {
        return res.status(401).json({
            success: false,
            error: 'Current password is incorrect'
        });
    }

    // Hash new password and update
    const newPasswordHash = await hashPassword(newPassword);
    await db.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newPasswordHash, userId]
    );

    await logAuthEvent(db, {
        userId,
        email: req.session.user.email,
        eventType: 'password_change',
        ipAddress,
        userAgent
    });

    logger.info('Password changed', { userId });

    res.json({ success: true, message: 'Password changed successfully' });
}));

// ==================== ADMIN ROUTES ====================

/**
 * GET /api/auth/users
 * List all users (admin only)
 */
router.get('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await db.query(`
        SELECT id, email, name, role, is_active, last_login, created_at
        FROM users
        ORDER BY created_at DESC
    `);

    res.json({
        success: true,
        users: result.rows
    });
}));

/**
 * POST /api/auth/users
 * Create new user (admin only)
 */
router.post('/users', requireAuth, requireAdmin, validators.createUser, asyncHandler(async (req, res) => {
    const { email, name, role, password } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Email validated and normalized by middleware
    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existingUser = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
        return res.status(400).json({
            success: false,
            error: 'A user with this email already exists'
        });
    }

    // Role validated by middleware, default to 'user' if not provided
    const userRole = role || 'user';

    // Generate password if not provided (password strength validated by middleware if provided)
    let userPassword = password;
    let generatedPassword = null;

    if (!password) {
        userPassword = generateRandomPassword();
        generatedPassword = userPassword;
    }

    // Hash password
    const passwordHash = await hashPassword(userPassword);

    // Create user
    const result = await db.query(`
        INSERT INTO users (email, password_hash, name, role)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, name, role, created_at
    `, [normalizedEmail, passwordHash, name || null, userRole]);

    const newUser = result.rows[0];

    await logAuthEvent(db, {
        userId: newUser.id,
        email: newUser.email,
        eventType: 'user_created',
        ipAddress,
        userAgent,
        details: { createdBy: req.session.user.email, role: userRole }
    });

    logger.info('User created', {
        newUserId: newUser.id,
        email: newUser.email,
        createdBy: req.session.user.id
    });

    const response = {
        success: true,
        user: newUser
    };

    // Include generated password in response (one-time display)
    if (generatedPassword) {
        response.generatedPassword = generatedPassword;
        response.message = 'User created with generated password. Make sure to share it securely.';
    }

    res.json(response);
}));

/**
 * PUT /api/auth/users/:id
 * Update user (admin only)
 */
router.put('/users/:id', requireAuth, requireAdmin, validators.updateUser, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id);
    const { name, role, is_active } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Check user exists
    const existingUser = await db.query(
        'SELECT id, email FROM users WHERE id = $1',
        [userId]
    );

    if (existingUser.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'User not found'
        });
    }

    // Prevent deactivating yourself
    if (userId === req.session.user.id && is_active === false) {
        return res.status(400).json({
            success: false,
            error: 'You cannot deactivate your own account'
        });
    }

    // Build update query (role validated by middleware)
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
        updates.push(`name = $${paramCount}`);
        values.push(name);
        paramCount++;
    }

    if (role !== undefined) {
        updates.push(`role = $${paramCount}`);
        values.push(role);
        paramCount++;
    }

    if (is_active !== undefined) {
        updates.push(`is_active = $${paramCount}`);
        values.push(is_active);
        paramCount++;
    }

    if (updates.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No fields to update'
        });
    }

    values.push(userId);
    const result = await db.query(`
        UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramCount}
        RETURNING id, email, name, role, is_active
    `, values);

    await logAuthEvent(db, {
        userId,
        email: existingUser.rows[0].email,
        eventType: is_active === false ? 'user_deactivated' : 'user_updated',
        ipAddress,
        userAgent,
        details: { updatedBy: req.session.user.email, changes: req.body }
    });

    logger.info('User updated', {
        userId,
        updatedBy: req.session.user.id,
        changes: req.body
    });

    res.json({
        success: true,
        user: result.rows[0]
    });
}));

/**
 * POST /api/auth/users/:id/reset-password
 * Reset user password (admin only)
 */
router.post('/users/:id/reset-password', requireAuth, requireAdmin, validators.resetUserPassword, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id);
    const { newPassword } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Check user exists
    const existingUser = await db.query(
        'SELECT id, email FROM users WHERE id = $1',
        [userId]
    );

    if (existingUser.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'User not found'
        });
    }

    // Generate password if not provided (password strength validated by middleware if provided)
    let password = newPassword;
    let generatedPassword = null;

    if (!newPassword) {
        password = generateRandomPassword();
        generatedPassword = password;
    }

    // Hash and update password
    const passwordHash = await hashPassword(password);
    await db.query(
        'UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [passwordHash, userId]
    );

    await logAuthEvent(db, {
        userId,
        email: existingUser.rows[0].email,
        eventType: 'password_change',
        ipAddress,
        userAgent,
        details: { resetBy: req.session.user.email }
    });

    logger.info('Password reset by admin', {
        userId,
        resetBy: req.session.user.id
    });

    const response = {
        success: true,
        message: 'Password has been reset'
    };

    if (generatedPassword) {
        response.generatedPassword = generatedPassword;
        response.message = 'Password reset with generated password. Make sure to share it securely.';
    }

    res.json(response);
}));

/**
 * POST /api/auth/users/:id/unlock
 * Unlock a locked user account (admin only)
 */
router.post('/users/:id/unlock', requireAuth, requireAdmin, validators.unlockUser, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id);
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    const result = await db.query(`
        UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, email
    `, [userId]);

    if (result.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'User not found'
        });
    }

    await logAuthEvent(db, {
        userId,
        email: result.rows[0].email,
        eventType: 'account_unlocked',
        ipAddress,
        userAgent,
        details: { unlockedBy: req.session.user.email }
    });

    logger.info('Account unlocked', {
        userId,
        unlockedBy: req.session.user.id
    });

    res.json({
        success: true,
        message: 'Account unlocked successfully'
    });
}));

// ==================== PASSWORD RESET (PUBLIC) ====================

/**
 * POST /api/auth/forgot-password
 * Request a password reset email/token
 */
router.post('/forgot-password', validators.forgotPassword, asyncHandler(async (req, res) => {
    const { email } = req.body;
    const ipAddress = getClientIp(req);

    // Email validated by middleware
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const userResult = await db.query(
        'SELECT id, email FROM users WHERE email = $1',
        [normalizedEmail]
    );

    // Always return success to prevent email enumeration
    if (userResult.rows.length === 0) {
        logger.info('Password reset requested for non-existent email', { email: normalizedEmail, ipAddress });
        return res.json({
            success: true,
            message: 'If an account exists with this email, you will receive a password reset link.'
        });
    }

    const user = userResult.rows[0];

    // Generate reset token
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Delete any existing tokens for this user
    await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    // Insert new token
    await db.query(`
        INSERT INTO password_reset_tokens (user_id, token, expires_at)
        VALUES ($1, $2, $3)
    `, [user.id, resetToken, tokenExpiry]);

    // Log the event
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

    // In production, you'd send an email here
    // For now, we'll return the token in the response (development mode)
    const isDev = process.env.NODE_ENV !== 'production';

    res.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset link.',
        // Only include token in development for testing
        ...(isDev && { resetToken, resetUrl: `/set-password.html?token=${resetToken}` })
    });
}));

/**
 * POST /api/auth/reset-password
 * Reset password using a valid token
 *
 * Security: Token has limited attempts (default 5) to prevent brute-force.
 * Each request with a valid token decrements attempts_remaining.
 */
router.post('/reset-password', passwordResetRateLimit, validators.resetPassword, asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Token and password validated by middleware

    // Find valid token with attempt limiting
    // COALESCE handles tokens created before migration (NULL attempts_remaining)
    const tokenResult = await db.query(`
        SELECT prt.*, u.email
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = $1
          AND prt.expires_at > NOW()
          AND prt.used_at IS NULL
          AND COALESCE(prt.attempts_remaining, 5) > 0
    `, [token]);

    if (tokenResult.rows.length === 0) {
        // Check if token exists but has exhausted attempts
        const exhaustedCheck = await db.query(`
            SELECT id, attempts_remaining FROM password_reset_tokens
            WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
        `, [token]);

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

        return res.status(400).json({
            success: false,
            error: 'Invalid or expired reset token. Please request a new password reset.'
        });
    }

    const resetRecord = tokenResult.rows[0];
    const userId = resetRecord.user_id;

    // Decrement attempts atomically BEFORE processing
    // This ensures attempt is consumed even if something fails later
    await db.query(`
        UPDATE password_reset_tokens
        SET attempts_remaining = COALESCE(attempts_remaining, 5) - 1
        WHERE id = $1
    `, [resetRecord.id]);

    // Hash new password and update user
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

    // Mark token as used
    await db.query(`
        UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1
    `, [resetRecord.id]);

    // Log the event
    await logAuthEvent(db, {
        userId,
        email: resetRecord.email,
        eventType: 'password_reset_completed',
        ipAddress,
        userAgent
    });

    logger.info('Password reset completed', { userId, email: resetRecord.email });

    res.json({
        success: true,
        message: 'Password has been reset successfully. You can now log in with your new password.'
    });
}));

/**
 * GET /api/auth/verify-reset-token
 * Check if a reset token is valid
 */
router.get('/verify-reset-token', validators.verifyResetToken, asyncHandler(async (req, res) => {
    const { token } = req.query;

    // Token validated by middleware

    // Check token validity including attempt limit
    const tokenResult = await db.query(`
        SELECT prt.id, prt.expires_at, prt.attempts_remaining, u.email
        FROM password_reset_tokens prt
        JOIN users u ON u.id = prt.user_id
        WHERE prt.token = $1
          AND prt.expires_at > NOW()
          AND prt.used_at IS NULL
          AND COALESCE(prt.attempts_remaining, 5) > 0
    `, [token]);

    if (tokenResult.rows.length === 0) {
        return res.json({
            success: true,
            valid: false,
            message: 'Invalid or expired token'
        });
    }

    res.json({
        success: true,
        valid: true,
        email: tokenResult.rows[0].email,
        expiresAt: tokenResult.rows[0].expires_at
    });
}));

module.exports = router;
