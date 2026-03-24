'use strict';

/**
 * Staff Routes — BACKLOG-41
 *
 * Manages staff membership and invitations for a merchant.
 *
 * Endpoints:
 *   GET    /api/staff                       - List staff + pending invitations
 *   POST   /api/staff/invite                - Send invitation (owner only)
 *   GET    /api/staff/validate-token        - Validate invitation token (public)
 *   POST   /api/staff/accept               - Accept invitation (public, token-based)
 *   DELETE /api/staff/invitations/:id      - Cancel pending invitation (owner only)
 *   DELETE /api/staff/:userId              - Remove staff member (owner only)
 *   PATCH  /api/staff/:userId/role         - Change role (owner only)
 */

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async-handler');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const { requirePermission } = require('../middleware/require-permission');
const staffService = require('../services/staff');
const emailNotifier = require('../utils/email-notifier');
const validators = require('../middleware/validators/staff');
const { sendSuccess, sendError } = require('../utils/response-helper');
const logger = require('../utils/logger');

const READ = requirePermission('staff', 'read');
const ADMIN = requirePermission('staff', 'admin');

/**
 * GET /api/staff
 * List all staff members and pending invitations.
 * Owner and manager can view (staff:read permission).
 */
router.get('/', requireAuth, requireMerchant, READ, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { staff, pendingInvitations } = await staffService.listStaff(merchantId);
    sendSuccess(res, { staff, pendingInvitations });
}));

/**
 * POST /api/staff/invite
 * Send a staff invitation (owner only via staff:admin).
 */
router.post('/invite', requireAuth, requireMerchant, ADMIN, validators.inviteStaff, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const invitedBy = req.session.user.id;
    const { email, role } = req.body;

    const { rawToken, expiresAt } = await staffService.inviteStaff({ merchantId, email, role, invitedBy });

    const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5001';
    const inviteUrl = `${appUrl}/accept-invite.html?token=${rawToken}`;

    let emailFailed = false;
    try {
        await emailNotifier.sendStaffInvitation({
            to: email,
            role,
            merchantName: req.merchantContext.businessName,
            inviteUrl,
            invitedByEmail: req.session.user.email
        });
    } catch (emailError) {
        emailFailed = true;
        logger.warn('Failed to send invitation email', {
            error: emailError.message,
            email,
            merchantId
        });
    }

    const response = { message: 'Invitation created', email, role, expiresAt };
    if (emailFailed) {
        response.warning = 'Email delivery failed. Share the invite link manually.';
        response.inviteUrl = inviteUrl;
    }
    sendSuccess(res, response, 201);
}));

/**
 * GET /api/staff/validate-token?token=xxx
 * Validate an invitation token without accepting (public).
 * Returns merchant name, role, and whether the user already exists.
 */
router.get('/validate-token', validators.validateTokenQuery, asyncHandler(async (req, res) => {
    const result = await staffService.validateToken(req.query.token);
    if (!result.valid) {
        return sendError(res, 'Invalid or expired invitation token', 400, 'INVALID_TOKEN');
    }
    sendSuccess(res, result);
}));

/**
 * POST /api/staff/accept
 * Accept an invitation via token (public, no auth required).
 */
router.post('/accept', validators.acceptInvitation, asyncHandler(async (req, res) => {
    const { token, password } = req.body;

    try {
        const result = await staffService.acceptInvitation({ token, password });
        sendSuccess(res, { message: 'Invitation accepted', email: result.email, role: result.role });
    } catch (err) {
        if (err.code === 'INVALID_TOKEN') {
            return sendError(res, err.message, 400, err.code);
        }
        if (err.code === 'PASSWORD_REQUIRED') {
            return sendError(res, err.message, 400, err.code);
        }
        throw err;
    }
}));

/**
 * DELETE /api/staff/invitations/:id
 * Cancel a pending staff invitation (owner only via staff:admin).
 * Must be declared before DELETE /:userId to avoid the wildcard matching "invitations".
 */
router.delete('/invitations/:id', requireAuth, requireMerchant, ADMIN, validators.cancelInvitation, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const invitationId = parseInt(req.params.id, 10);

    try {
        await staffService.cancelInvitation({ merchantId, invitationId });
        sendSuccess(res, { message: 'Invitation cancelled' });
    } catch (err) {
        if (err.statusCode) {
            return sendError(res, err.message, err.statusCode, err.code);
        }
        throw err;
    }
}));

/**
 * DELETE /api/staff/:userId
 * Remove a staff member (owner only via staff:admin).
 */
router.delete('/:userId', requireAuth, requireMerchant, ADMIN, validators.removeStaff, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const userId = parseInt(req.params.userId, 10);
    const requestingUserId = req.session.user.id;

    try {
        await staffService.removeStaff({ merchantId, userId, requestingUserId });
        sendSuccess(res, { message: 'Staff member removed' });
    } catch (err) {
        if (err.statusCode) {
            return sendError(res, err.message, err.statusCode, err.code);
        }
        throw err;
    }
}));

/**
 * PATCH /api/staff/:userId/role
 * Change a staff member's role (owner only via staff:admin).
 */
router.patch('/:userId/role', requireAuth, requireMerchant, ADMIN, validators.changeRole, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const userId = parseInt(req.params.userId, 10);
    const changedBy = req.session.user.id;
    const { role } = req.body;

    try {
        await staffService.changeRole({ merchantId, userId, newRole: role, changedBy });
        sendSuccess(res, { message: 'Role updated', role });
    } catch (err) {
        if (err.statusCode) {
            return sendError(res, err.message, err.statusCode, err.code);
        }
        throw err;
    }
}));

module.exports = router;
