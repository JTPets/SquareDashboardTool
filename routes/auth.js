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
const { configureLoginRateLimit } = require('../middleware/security');

// Apply login rate limiting to login route
const loginRateLimit = configureLoginRateLimit();

// Account lockout settings
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

/**
 * POST /api/auth/login
 * Authenticate user with email and password
 */
router.post('/login', loginRateLimit, async (req, res) => {
    const { email, password } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required'
            });
        }

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

        // Create session
        req.session.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role
        };

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

    } catch (error) {
        logger.error('Login error', { error: error.message, email });
        res.status(500).json({
            success: false,
            error: 'An error occurred during login'
        });
    }
});

/**
 * POST /api/auth/logout
 * Destroy user session
 */
router.post('/logout', async (req, res) => {
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
            logger.error('Session destroy error', { error: err.message });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

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
router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.user.id;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
        // Validate new password
        const validation = validatePassword(newPassword);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: validation.errors.join('. ')
            });
        }

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

    } catch (error) {
        logger.error('Change password error', { error: error.message, userId });
        res.status(500).json({
            success: false,
            error: 'Failed to change password'
        });
    }
});

// ==================== ADMIN ROUTES ====================

/**
 * GET /api/auth/users
 * List all users (admin only)
 */
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT id, email, name, role, is_active, last_login, created_at
            FROM users
            ORDER BY created_at DESC
        `);

        res.json({
            success: true,
            users: result.rows
        });

    } catch (error) {
        logger.error('List users error', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to list users'
        });
    }
});

/**
 * POST /api/auth/users
 * Create new user (admin only)
 */
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
    const { email, name, role, password } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
        // Validate email
        if (!email || !email.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Valid email is required'
            });
        }

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

        // Validate role
        const validRoles = ['admin', 'user', 'readonly'];
        const userRole = role && validRoles.includes(role) ? role : 'user';

        // Generate or validate password
        let userPassword = password;
        let generatedPassword = null;

        if (!password) {
            // Generate random password
            userPassword = generateRandomPassword();
            generatedPassword = userPassword;
        } else {
            // Validate provided password
            const validation = validatePassword(password);
            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    error: validation.errors.join('. ')
                });
            }
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

    } catch (error) {
        logger.error('Create user error', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to create user'
        });
    }
});

/**
 * PUT /api/auth/users/:id
 * Update user (admin only)
 */
router.put('/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    const { name, role, is_active } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
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

        // Build update query
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (name !== undefined) {
            updates.push(`name = $${paramCount}`);
            values.push(name);
            paramCount++;
        }

        if (role !== undefined) {
            const validRoles = ['admin', 'user', 'readonly'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid role'
                });
            }
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

    } catch (error) {
        logger.error('Update user error', { error: error.message, userId });
        res.status(500).json({
            success: false,
            error: 'Failed to update user'
        });
    }
});

/**
 * POST /api/auth/users/:id/reset-password
 * Reset user password (admin only)
 */
router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    const { newPassword } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
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

        // Generate or validate password
        let password = newPassword;
        let generatedPassword = null;

        if (!newPassword) {
            password = generateRandomPassword();
            generatedPassword = password;
        } else {
            const validation = validatePassword(newPassword);
            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    error: validation.errors.join('. ')
                });
            }
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

    } catch (error) {
        logger.error('Reset password error', { error: error.message, userId });
        res.status(500).json({
            success: false,
            error: 'Failed to reset password'
        });
    }
});

/**
 * POST /api/auth/users/:id/unlock
 * Unlock a locked user account (admin only)
 */
router.post('/users/:id/unlock', requireAuth, requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
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

    } catch (error) {
        logger.error('Unlock account error', { error: error.message, userId });
        res.status(500).json({
            success: false,
            error: 'Failed to unlock account'
        });
    }
});

// ==================== PASSWORD RESET (PUBLIC) ====================

/**
 * POST /api/auth/forgot-password
 * Request a password reset email/token
 */
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const ipAddress = getClientIp(req);

    try {
        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email is required'
            });
        }

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

    } catch (error) {
        logger.error('Forgot password error', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to process password reset request'
        });
    }
});

/**
 * POST /api/auth/reset-password
 * Reset password using a valid token
 */
router.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    try {
        if (!token || !newPassword) {
            return res.status(400).json({
                success: false,
                error: 'Token and new password are required'
            });
        }

        // Validate password
        const validation = validatePassword(newPassword);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: validation.errors.join('. ')
            });
        }

        // Find valid token
        const tokenResult = await db.query(`
            SELECT prt.*, u.email
            FROM password_reset_tokens prt
            JOIN users u ON u.id = prt.user_id
            WHERE prt.token = $1
              AND prt.expires_at > NOW()
              AND prt.used_at IS NULL
        `, [token]);

        if (tokenResult.rows.length === 0) {
            logger.warn('Invalid or expired password reset token', { token: token.substring(0, 10) + '...', ipAddress });
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired reset token. Please request a new password reset.'
            });
        }

        const resetRecord = tokenResult.rows[0];
        const userId = resetRecord.user_id;

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

    } catch (error) {
        logger.error('Reset password error', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to reset password'
        });
    }
});

/**
 * GET /api/auth/verify-reset-token
 * Check if a reset token is valid
 */
router.get('/verify-reset-token', async (req, res) => {
    const { token } = req.query;

    try {
        if (!token) {
            return res.status(400).json({
                success: false,
                valid: false,
                error: 'Token is required'
            });
        }

        const tokenResult = await db.query(`
            SELECT prt.id, prt.expires_at, u.email
            FROM password_reset_tokens prt
            JOIN users u ON u.id = prt.user_id
            WHERE prt.token = $1
              AND prt.expires_at > NOW()
              AND prt.used_at IS NULL
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

    } catch (error) {
        logger.error('Verify reset token error', { error: error.message });
        res.status(500).json({
            success: false,
            valid: false,
            error: 'Failed to verify token'
        });
    }
});

module.exports = router;
