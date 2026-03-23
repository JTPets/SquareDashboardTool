'use strict';

/**
 * Staff Routes — BACKLOG-41
 *
 * Manages staff membership and invitations for a merchant.
 *
 * Endpoints:
 *   GET    /api/staff                  - List staff + pending invitations
 *   POST   /api/staff/invite           - Send invitation (owner only)
 *   POST   /api/staff/accept           - Accept invitation (public, token-based)
 *   DELETE /api/staff/:userId          - Remove staff member (owner only)
 *   PATCH  /api/staff/:userId/role     - Change role (owner only)
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

    try {
        await emailNotifier.sendStaffInvitation({
            to: email,
            role,
            merchantName: req.merchantContext.businessName,
            inviteUrl,
            invitedByEmail: req.session.user.email
        });
    } catch (emailError) {
        logger.warn('Failed to send invitation email', {
            error: emailError.message,
            email,
            merchantId
        });
        // Non-fatal: invitation is created even if email fails
    }

    sendSuccess(res, { message: 'Invitation sent', email, role, expiresAt }, 201);
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
