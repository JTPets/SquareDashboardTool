/**
 * Authentication Routes
 * Handles login, logout, user management
 */

const express = require('express');
const router = express.Router();
const { hashPassword, generateRandomPassword } = require('../utils/password');
const { requireAuth, requireAdmin, logAuthEvent, getClientIp } = require('../middleware/auth');
const { configureLoginRateLimit, configurePasswordResetRateLimit } = require('../middleware/security');
const asyncHandler = require('../middleware/async-handler');
const { sendSuccess, sendError } = require('../utils/response-helper');
const validators = require('../middleware/validators/auth');
const sessionService = require('../services/auth/session-service');
const passwordService = require('../services/auth/password-service');
const db = require('../utils/database');
const logger = require('../utils/logger');

// Apply rate limiting to sensitive routes
const loginRateLimit = configureLoginRateLimit();
const passwordResetRateLimit = configurePasswordResetRateLimit();

/**
 * POST /api/auth/login
 * Authenticate user with email and password
 */
router.post('/login', loginRateLimit, validators.login, asyncHandler(async (req, res) => {
    try {
        const result = await sessionService.loginUser(req.body.email, req.body.password, req, {
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent']
        });
        sendSuccess(res, result);
    } catch (err) {
        sendError(res, err.message, err.statusCode || 500);
    }
}));

/**
 * POST /api/auth/logout
 * Destroy user session
 */
router.post('/logout', asyncHandler(async (req, res) => {
    await sessionService.logoutUser(req, {
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent']
    });
    res.clearCookie('sid');
    sendSuccess(res, {});
}));

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', (req, res) => {
    if (!req.session?.user) {
        return sendError(res, 'Not authenticated', 401);
    }

    sendSuccess(res, {
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
    try {
        await passwordService.changePassword(req.session.user.id, currentPassword, newPassword, {
            merchantId: req.session.activeMerchantId,
            email: req.session.user.email,
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent']
        });
        sendSuccess(res, { message: 'Password changed successfully' });
    } catch (err) {
        sendError(res, err.message, err.statusCode || 500);
    }
}));

// ==================== ADMIN ROUTES ====================

/**
 * GET /api/auth/users
 * List users scoped to the admin's active merchant (S-6: multi-tenant isolation)
 */
router.get('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const merchantId = req.session.activeMerchantId;

    if (!merchantId) {
        return sendError(res, 'No active merchant selected', 403);
    }

    // Only return users who belong to the same merchant as the admin
    const result = await db.query(`
        SELECT u.id, u.email, u.name, u.role, u.is_active, u.last_login, u.created_at, um.role as merchant_role
        FROM users u
        JOIN user_merchants um ON um.user_id = u.id
        WHERE um.merchant_id = $1
        ORDER BY u.created_at DESC
    `, [merchantId]);

    sendSuccess(res, { users: result.rows });
}));

/**
 * POST /api/auth/users
 * Create new user (admin only) — scoped to admin's active merchant
 */
router.post('/users', requireAuth, requireAdmin, validators.createUser, asyncHandler(async (req, res) => {
    const { email, name, role, password } = req.body;
    const merchantId = req.session.activeMerchantId;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    if (!merchantId) {
        return sendError(res, 'No active merchant selected', 403);
    }

    // Email validated and normalized by middleware
    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existingUser = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
        return sendError(res, 'A user with this email already exists', 400);
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

    // Create user and link to admin's merchant in a transaction
    const newUser = await db.transaction(async (client) => {
        const result = await client.query(`
            INSERT INTO users (email, password_hash, name, role)
            VALUES ($1, $2, $3, $4)
            RETURNING id, email, name, role, created_at
        `, [normalizedEmail, passwordHash, name || null, userRole]);

        const user = result.rows[0];

        // Link new user to the admin's active merchant
        await client.query(
            'INSERT INTO user_merchants (user_id, merchant_id, role) VALUES ($1, $2, $3)',
            [user.id, merchantId, userRole]
        );

        return user;
    });

    await logAuthEvent(db, {
        userId: newUser.id,
        merchantId,
        email: newUser.email,
        eventType: 'user_created',
        ipAddress,
        userAgent,
        details: { createdBy: req.session.user.email, role: userRole, merchantId }
    });

    logger.info('User created', {
        newUserId: newUser.id,
        email: newUser.email,
        createdBy: req.session.user.id,
        merchantId
    });

    const response = { user: newUser };

    // Include generated password in response (one-time display)
    if (generatedPassword) {
        response.generatedPassword = generatedPassword;
        response.message = 'User created with generated password. Make sure to share it securely.';
    }

    sendSuccess(res, response);
}));

/**
 * PUT /api/auth/users/:id
 * Update user (admin only) — scoped to admin's active merchant
 */
router.put('/users/:id', requireAuth, requireAdmin, validators.updateUser, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id);
    const { name, role, is_active } = req.body;
    const merchantId = req.session.activeMerchantId;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    if (!merchantId) {
        return sendError(res, 'No active merchant selected', 403);
    }

    // Check user exists AND belongs to admin's merchant
    const existingUser = await db.query(
        'SELECT u.id, u.email FROM users u JOIN user_merchants um ON um.user_id = u.id WHERE u.id = $1 AND um.merchant_id = $2',
        [userId, merchantId]
    );

    if (existingUser.rows.length === 0) {
        return sendError(res, 'User not found', 404);
    }

    // Prevent deactivating yourself
    if (userId === req.session.user.id && is_active === false) {
        return sendError(res, 'You cannot deactivate your own account', 400);
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
        return sendError(res, 'No fields to update', 400);
    }

    values.push(userId);
    const result = await db.query(`
        UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramCount}
        RETURNING id, email, name, role, is_active
    `, values);

    await logAuthEvent(db, {
        userId,
        merchantId,
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

    sendSuccess(res, { user: result.rows[0] });
}));

/**
 * POST /api/auth/users/:id/reset-password
 * Reset user password (admin only) — scoped to admin's active merchant
 */
router.post('/users/:id/reset-password', requireAuth, requireAdmin, validators.resetUserPassword, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id);
    const { newPassword } = req.body;
    const merchantId = req.session.activeMerchantId;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    if (!merchantId) {
        return sendError(res, 'No active merchant selected', 403);
    }

    // Check user exists AND belongs to admin's merchant
    const existingUser = await db.query(
        'SELECT u.id, u.email FROM users u JOIN user_merchants um ON um.user_id = u.id WHERE u.id = $1 AND um.merchant_id = $2',
        [userId, merchantId]
    );

    if (existingUser.rows.length === 0) {
        return sendError(res, 'User not found', 404);
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
        merchantId,
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

    const response = { message: 'Password has been reset' };

    if (generatedPassword) {
        response.generatedPassword = generatedPassword;
        response.message = 'Password reset with generated password. Make sure to share it securely.';
    }

    sendSuccess(res, response);
}));

/**
 * POST /api/auth/users/:id/unlock
 * Unlock a locked user account (admin only) — scoped to admin's active merchant
 */
router.post('/users/:id/unlock', requireAuth, requireAdmin, validators.unlockUser, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id);
    const merchantId = req.session.activeMerchantId;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    if (!merchantId) {
        return sendError(res, 'No active merchant selected', 403);
    }

    // Verify user belongs to admin's merchant before unlocking
    const memberCheck = await db.query(
        'SELECT 1 FROM user_merchants WHERE user_id = $1 AND merchant_id = $2',
        [userId, merchantId]
    );

    if (memberCheck.rows.length === 0) {
        return sendError(res, 'User not found', 404);
    }

    const result = await db.query(`
        UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, email
    `, [userId]);

    if (result.rows.length === 0) {
        return sendError(res, 'User not found', 404);
    }

    await logAuthEvent(db, {
        userId,
        merchantId,
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

    sendSuccess(res, { message: 'Account unlocked successfully' });
}));

// ==================== PASSWORD RESET (PUBLIC) ====================

/**
 * POST /api/auth/forgot-password
 * Request a password reset email/token
 */
router.post('/forgot-password', validators.forgotPassword, asyncHandler(async (req, res) => {
    const result = await passwordService.forgotPassword(req.body.email, getClientIp(req));
    sendSuccess(res, result);
}));

/**
 * POST /api/auth/reset-password
 * Reset password using a valid token
 *
 * Security: Token has limited attempts (default 5) to prevent brute-force.
 * Each request with a valid token decrements attempts_remaining.
 */
router.post('/reset-password', passwordResetRateLimit, validators.resetPassword, asyncHandler(async (req, res) => {
    try {
        await passwordService.resetPassword(req.body.token, req.body.newPassword, {
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent']
        });
        sendSuccess(res, {
            message: 'Password has been reset successfully. You can now log in with your new password.'
        });
    } catch (err) {
        sendError(res, err.message, err.statusCode || 500);
    }
}));

/**
 * GET /api/auth/verify-reset-token
 * Check if a reset token is valid
 */
router.get('/verify-reset-token', validators.verifyResetToken, asyncHandler(async (req, res) => {
    const result = await passwordService.verifyResetToken(req.query.token);
    sendSuccess(res, result);
}));

module.exports = router;
