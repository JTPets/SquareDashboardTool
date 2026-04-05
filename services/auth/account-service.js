'use strict';

/**
 * Account Service — user CRUD and admin operations.
 * Extracted from routes/auth.js.
 * Security: all queries scoped by merchant_id (multi-tenant isolation).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { hashPassword, generateRandomPassword } = require('../../utils/password');
const { logAuthEvent } = require('../../middleware/auth');

function clientError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * List users scoped to a merchant (S-6: multi-tenant isolation).
 * @param {string} merchantId
 * @returns {Promise<Object[]>}
 */
async function listUsers(merchantId) {
    const result = await db.query(`
        SELECT u.id, u.email, u.name, u.role, u.is_active, u.last_login, u.created_at, um.role as merchant_role
        FROM users u
        JOIN user_merchants um ON um.user_id = u.id
        WHERE um.merchant_id = $1
        ORDER BY u.created_at DESC
    `, [merchantId]);
    return result.rows;
}

/**
 * Create a user and link them to a merchant in a transaction.
 * @param {string} merchantId
 * @param {{ email: string, name?: string, role?: string, password?: string }} data
 * @param {{ createdByEmail: string, createdById: number, ipAddress: string, userAgent: string }} context
 * @returns {{ user: Object, generatedPassword: string|null }}
 * @throws {Error} 400 if email already exists
 */
async function createUser(merchantId, { email, name, role, password }, { createdByEmail, createdById, ipAddress, userAgent }) {
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
        throw clientError('A user with this email already exists', 400);
    }

    const userRole = role || 'user';
    let userPassword = password;
    let generatedPassword = null;

    if (!password) {
        userPassword = generateRandomPassword();
        generatedPassword = userPassword;
    }

    const passwordHash = await hashPassword(userPassword);

    const newUser = await db.transaction(async (client) => {
        const result = await client.query(`
            INSERT INTO users (email, password_hash, name, role)
            VALUES ($1, $2, $3, $4)
            RETURNING id, email, name, role, created_at
        `, [normalizedEmail, passwordHash, name || null, userRole]);

        const user = result.rows[0];
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
        details: { createdBy: createdByEmail, role: userRole, merchantId }
    });

    logger.info('User created', { newUserId: newUser.id, email: newUser.email, createdBy: createdById, merchantId });

    return { user: newUser, generatedPassword };
}

/**
 * Update a user's name, role, or active status.
 * @param {string} merchantId
 * @param {number} userId
 * @param {{ name?, role?, is_active? }} updates
 * @param {{ actorId: number, actorEmail: string, ipAddress: string, userAgent: string }} context
 * @returns {Object} Updated user row
 * @throws {Error} 404 if not in merchant, 400 for self-deactivation or no fields
 */
async function updateUser(merchantId, userId, updates, { actorId, actorEmail, ipAddress, userAgent }) {
    const existing = await db.query(
        'SELECT u.id, u.email FROM users u JOIN user_merchants um ON um.user_id = u.id WHERE u.id = $1 AND um.merchant_id = $2',
        [userId, merchantId]
    );
    if (existing.rows.length === 0) throw clientError('User not found', 404);

    const { name, role, is_active } = updates;

    if (userId === actorId && is_active === false) {
        throw clientError('You cannot deactivate your own account', 400);
    }

    const cols = [];
    const values = [];
    let p = 1;
    if (name !== undefined)      { cols.push(`name = $${p++}`);      values.push(name); }
    if (role !== undefined)      { cols.push(`role = $${p++}`);      values.push(role); }
    if (is_active !== undefined) { cols.push(`is_active = $${p++}`); values.push(is_active); }

    if (cols.length === 0) throw clientError('No fields to update', 400);

    values.push(userId);
    const result = await db.query(`
        UPDATE users SET ${cols.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${p}
        RETURNING id, email, name, role, is_active
    `, values);

    await logAuthEvent(db, {
        userId,
        merchantId,
        email: existing.rows[0].email,
        eventType: is_active === false ? 'user_deactivated' : 'user_updated',
        ipAddress,
        userAgent,
        details: { updatedBy: actorEmail, changes: updates }
    });

    logger.info('User updated', { userId, updatedBy: actorId, changes: updates });

    return result.rows[0];
}

/**
 * Admin: reset a user's password and clear lockout.
 * @param {string} merchantId
 * @param {number} userId
 * @param {string|null} newPassword - Plaintext; generated if null
 * @param {{ resetByEmail: string, resetById: number, ipAddress: string, userAgent: string }} context
 * @returns {{ generatedPassword: string|null }}
 * @throws {Error} 404 if user not in merchant
 */
async function adminResetPassword(merchantId, userId, newPassword, { resetByEmail, resetById, ipAddress, userAgent }) {
    const existing = await db.query(
        'SELECT u.id, u.email FROM users u JOIN user_merchants um ON um.user_id = u.id WHERE u.id = $1 AND um.merchant_id = $2',
        [userId, merchantId]
    );
    if (existing.rows.length === 0) throw clientError('User not found', 404);

    let password = newPassword;
    let generatedPassword = null;
    if (!newPassword) {
        password = generateRandomPassword();
        generatedPassword = password;
    }

    const passwordHash = await hashPassword(password);
    await db.query(
        'UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [passwordHash, userId]
    );

    await logAuthEvent(db, {
        userId,
        merchantId,
        email: existing.rows[0].email,
        eventType: 'password_change',
        ipAddress,
        userAgent,
        details: { resetBy: resetByEmail }
    });

    logger.info('Password reset by admin', { userId, resetBy: resetById });

    return { generatedPassword };
}

/**
 * Admin: clear lockout fields for a user.
 * @param {string} merchantId
 * @param {number} userId
 * @param {{ unlockedByEmail: string, unlockedById: number, ipAddress: string, userAgent: string }} context
 * @throws {Error} 404 if user not in merchant or not found in DB
 */
async function unlockUser(merchantId, userId, { unlockedByEmail, unlockedById, ipAddress, userAgent }) {
    const memberCheck = await db.query(
        'SELECT 1 FROM user_merchants WHERE user_id = $1 AND merchant_id = $2',
        [userId, merchantId]
    );
    if (memberCheck.rows.length === 0) throw clientError('User not found', 404);

    const result = await db.query(`
        UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, email
    `, [userId]);

    if (result.rows.length === 0) throw clientError('User not found', 404);

    await logAuthEvent(db, {
        userId,
        merchantId,
        email: result.rows[0].email,
        eventType: 'account_unlocked',
        ipAddress,
        userAgent,
        details: { unlockedBy: unlockedByEmail }
    });

    logger.info('Account unlocked', { userId, unlockedBy: unlockedById });
}

module.exports = { listUsers, createUser, updateUser, adminResetPassword, unlockUser };
