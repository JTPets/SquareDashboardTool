'use strict';

/**
 * Staff Invitation Service — BACKLOG-41
 *
 * Manages staff membership and invitations for a merchant.
 * Token security: plaintext token sent to user via email link,
 * SHA-256 hash stored in DB (same pattern as password-reset-tokens).
 */

const crypto = require('crypto');
const db = require('../../utils/database');
const { hashPassword } = require('../../utils/password');
const logger = require('../../utils/logger');

const VALID_ROLES = ['manager', 'clerk', 'readonly'];
const TOKEN_EXPIRY_DAYS = 7;

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function staffError(message, code, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Invite a new staff member.
 * Generates a crypto token, stores SHA-256 hash with 7-day expiry.
 * @returns {{ rawToken, email, role, expiresAt }}
 */
async function inviteStaff({ merchantId, email, role, invitedBy }) {
    if (!VALID_ROLES.includes(role)) {
        throw staffError('Invalid role. Must be manager, clerk, or readonly', 'INVALID_ROLE');
    }

    const normalizedEmail = email.toLowerCase();

    // Reject if already an active member
    const existingMember = await db.query(
        `SELECT um.id FROM user_merchants um
         JOIN users u ON u.id = um.user_id
         WHERE um.merchant_id = $1 AND u.email = $2`,
        [merchantId, normalizedEmail]
    );
    if (existingMember.rows.length > 0) {
        throw staffError('User is already a staff member of this merchant', 'ALREADY_MEMBER', 409);
    }

    // Reject if an unexpired pending invite exists
    const existingInvite = await db.query(
        `SELECT id FROM staff_invitations
         WHERE merchant_id = $1 AND email = $2 AND expires_at > NOW() AND accepted_at IS NULL`,
        [merchantId, normalizedEmail]
    );
    if (existingInvite.rows.length > 0) {
        throw staffError('A pending invitation already exists for this email', 'PENDING_INVITE', 409);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await db.transaction(async (client) => {
        // Clear any stale (expired or accepted) invite for this email/merchant
        await client.query(
            'DELETE FROM staff_invitations WHERE merchant_id = $1 AND email = $2',
            [merchantId, normalizedEmail]
        );
        await client.query(
            `INSERT INTO staff_invitations (merchant_id, email, role, token_hash, expires_at, invited_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [merchantId, normalizedEmail, role, tokenHash, expiresAt, invitedBy]
        );
    });

    logger.info('Staff invitation created', { merchantId, email: normalizedEmail, role, invitedBy });
    return { rawToken, email: normalizedEmail, role, expiresAt };
}

/**
 * Accept an invitation. Creates user if new, links to merchant.
 * @returns {{ email, role, merchantId }}
 */
async function acceptInvitation({ token, password }) {
    const tokenHash = hashToken(token);

    return await db.transaction(async (client) => {
        const inviteResult = await client.query(
            `SELECT id, merchant_id, email, role, invited_by
             FROM staff_invitations
             WHERE token_hash = $1 AND expires_at > NOW() AND accepted_at IS NULL
             FOR UPDATE`,
            [tokenHash]
        );

        if (inviteResult.rows.length === 0) {
            throw staffError('Invalid or expired invitation token', 'INVALID_TOKEN');
        }

        const invite = inviteResult.rows[0];

        const userResult = await client.query(
            'SELECT id FROM users WHERE email = $1',
            [invite.email]
        );

        let userId;
        if (userResult.rows.length > 0) {
            userId = userResult.rows[0].id;
        } else {
            // New user requires a password
            if (!password) {
                throw staffError('Password is required for new accounts', 'PASSWORD_REQUIRED');
            }
            const passwordHash = await hashPassword(password);
            const newUser = await client.query(
                `INSERT INTO users (email, password_hash, role, is_active)
                 VALUES ($1, $2, 'user', TRUE)
                 RETURNING id`,
                [invite.email, passwordHash]
            );
            userId = newUser.rows[0].id;
        }

        await client.query(
            `INSERT INTO user_merchants (user_id, merchant_id, role, invited_by, invited_at, accepted_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             ON CONFLICT (user_id, merchant_id) DO NOTHING`,
            [userId, invite.merchant_id, invite.role, invite.invited_by]
        );

        await client.query(
            'UPDATE staff_invitations SET accepted_at = NOW() WHERE id = $1',
            [invite.id]
        );

        logger.info('Staff invitation accepted', {
            merchantId: invite.merchant_id,
            email: invite.email,
            role: invite.role
        });
        return { email: invite.email, role: invite.role, merchantId: invite.merchant_id };
    });
}

/**
 * List all staff members and pending invitations for a merchant.
 * @returns {{ staff: [], pendingInvitations: [] }}
 */
async function listStaff(merchantId) {
    const staffResult = await db.query(
        `SELECT u.id, u.email, u.name, um.role, u.last_login AS last_active,
                um.invited_at, um.accepted_at
         FROM user_merchants um
         JOIN users u ON u.id = um.user_id
         WHERE um.merchant_id = $1
         ORDER BY
             CASE um.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'clerk' THEN 2 ELSE 3 END,
             u.email ASC`,
        [merchantId]
    );

    const inviteResult = await db.query(
        `SELECT id, email, role, expires_at, created_at
         FROM staff_invitations
         WHERE merchant_id = $1 AND expires_at > NOW() AND accepted_at IS NULL
         ORDER BY created_at DESC`,
        [merchantId]
    );

    return { staff: staffResult.rows, pendingInvitations: inviteResult.rows };
}

/**
 * Remove a staff member from the merchant.
 * Cannot remove owner or self.
 */
async function removeStaff({ merchantId, userId, requestingUserId }) {
    if (userId === requestingUserId) {
        throw staffError('Cannot remove yourself', 'CANNOT_REMOVE_SELF');
    }

    const memberResult = await db.query(
        'SELECT role FROM user_merchants WHERE merchant_id = $1 AND user_id = $2',
        [merchantId, userId]
    );

    if (memberResult.rows.length === 0) {
        throw staffError('Staff member not found', 'NOT_FOUND', 404);
    }

    if (memberResult.rows[0].role === 'owner') {
        throw staffError('Cannot remove the owner', 'CANNOT_REMOVE_OWNER');
    }

    await db.query(
        'DELETE FROM user_merchants WHERE merchant_id = $1 AND user_id = $2',
        [merchantId, userId]
    );

    logger.info('Staff member removed', {
        merchantId,
        removedUserId: userId,
        byUserId: requestingUserId
    });
}

/**
 * Change a staff member's role.
 * Cannot change owner role, own role, or promote to manager unless owner.
 */
async function changeRole({ merchantId, userId, newRole, changedBy }) {
    if (!VALID_ROLES.includes(newRole)) {
        throw staffError('Invalid role. Must be manager, clerk, or readonly', 'INVALID_ROLE');
    }

    if (userId === changedBy) {
        throw staffError('Cannot change your own role', 'CANNOT_CHANGE_OWN_ROLE');
    }

    const [targetResult, requestorResult] = await Promise.all([
        db.query('SELECT role FROM user_merchants WHERE merchant_id = $1 AND user_id = $2', [merchantId, userId]),
        db.query('SELECT role FROM user_merchants WHERE merchant_id = $1 AND user_id = $2', [merchantId, changedBy])
    ]);

    if (targetResult.rows.length === 0) {
        throw staffError('Staff member not found', 'NOT_FOUND', 404);
    }

    if (targetResult.rows[0].role === 'owner') {
        throw staffError("Cannot change the owner's role", 'CANNOT_CHANGE_OWNER');
    }

    const requestorRole = requestorResult.rows[0]?.role;
    if (newRole === 'manager' && requestorRole !== 'owner') {
        throw staffError('Only the owner can promote to manager', 'OWNER_REQUIRED', 403);
    }

    await db.query(
        'UPDATE user_merchants SET role = $1 WHERE merchant_id = $2 AND user_id = $3',
        [newRole, merchantId, userId]
    );

    logger.info('Staff role changed', { merchantId, userId, newRole, changedBy });
}

/**
 * Cancel a pending staff invitation.
 * Only cancels invitations belonging to the merchant (multi-tenant isolation).
 * Already-accepted invitations cannot be cancelled.
 */
async function cancelInvitation({ merchantId, invitationId }) {
    const result = await db.query(
        `DELETE FROM staff_invitations
         WHERE id = $1 AND merchant_id = $2 AND accepted_at IS NULL
         RETURNING id`,
        [invitationId, merchantId]
    );

    if (result.rows.length === 0) {
        throw staffError('Invitation not found', 'NOT_FOUND', 404);
    }

    logger.info('Staff invitation cancelled', { merchantId, invitationId });
}

/**
 * Validate an invitation token without accepting it.
 * Returns token metadata for the accept-invite page.
 * @returns {{ valid, merchantName, role, existingUser }}
 */
async function validateToken(token) {
    const tokenHash = hashToken(token);

    const inviteResult = await db.query(
        `SELECT si.email, si.role, m.business_name
         FROM staff_invitations si
         JOIN merchants m ON m.id = si.merchant_id
         WHERE si.token_hash = $1 AND si.expires_at > NOW() AND si.accepted_at IS NULL`,
        [tokenHash]
    );

    if (inviteResult.rows.length === 0) {
        return { valid: false };
    }

    const invite = inviteResult.rows[0];

    const userResult = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [invite.email]
    );

    return {
        valid: true,
        merchantName: invite.business_name,
        role: invite.role,
        existingUser: userResult.rows.length > 0
    };
}

module.exports = { inviteStaff, acceptInvitation, listStaff, removeStaff, changeRole, validateToken, cancelInvitation };
