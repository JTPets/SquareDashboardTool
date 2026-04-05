'use strict';

const router = require('express').Router();
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const validators = require('../../middleware/validators/auth');
const accountService = require('../../services/auth/account-service');
const ctx = (req) => ({ ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] });

// GET /users — list users scoped to active merchant (S-6: multi-tenant isolation)
router.get('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const merchantId = req.session.activeMerchantId;
    if (!merchantId) return sendError(res, 'No active merchant selected', 403);
    const users = await accountService.listUsers(merchantId);
    sendSuccess(res, { users });
}));

// POST /users — create user and link to active merchant
router.post('/users', requireAuth, requireAdmin, validators.createUser, asyncHandler(async (req, res) => {
    const merchantId = req.session.activeMerchantId;
    if (!merchantId) return sendError(res, 'No active merchant selected', 403);
    let result;
    try {
        result = await accountService.createUser(
            merchantId,
            { email: req.body.email, name: req.body.name, role: req.body.role, password: req.body.password },
            { createdByEmail: req.session.user.email, createdById: req.session.user.id, ...ctx(req) }
        );
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    const response = { user: result.user };
    if (result.generatedPassword) {
        response.generatedPassword = result.generatedPassword;
        response.message = 'User created with generated password. Make sure to share it securely.';
    }
    sendSuccess(res, response);
}));

// PUT /users/:id — update name/role/is_active
router.put('/users/:id', requireAuth, requireAdmin, validators.updateUser, asyncHandler(async (req, res) => {
    const merchantId = req.session.activeMerchantId;
    if (!merchantId) return sendError(res, 'No active merchant selected', 403);
    let user;
    try {
        user = await accountService.updateUser(
            merchantId,
            parseInt(req.params.id),
            { name: req.body.name, role: req.body.role, is_active: req.body.is_active },
            { actorId: req.session.user.id, actorEmail: req.session.user.email, ...ctx(req) }
        );
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    sendSuccess(res, { user });
}));

// POST /users/:id/reset-password — admin resets user password
router.post('/users/:id/reset-password', requireAuth, requireAdmin, validators.resetUserPassword, asyncHandler(async (req, res) => {
    const merchantId = req.session.activeMerchantId;
    if (!merchantId) return sendError(res, 'No active merchant selected', 403);
    let result;
    try {
        result = await accountService.adminResetPassword(
            merchantId,
            parseInt(req.params.id),
            req.body.newPassword || null,
            { resetByEmail: req.session.user.email, resetById: req.session.user.id, ...ctx(req) }
        );
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    const response = { message: 'Password has been reset' };
    if (result.generatedPassword) {
        response.generatedPassword = result.generatedPassword;
        response.message = 'Password reset with generated password. Make sure to share it securely.';
    }
    sendSuccess(res, response);
}));

// POST /users/:id/unlock — clear lockout
router.post('/users/:id/unlock', requireAuth, requireAdmin, validators.unlockUser, asyncHandler(async (req, res) => {
    const merchantId = req.session.activeMerchantId;
    if (!merchantId) return sendError(res, 'No active merchant selected', 403);
    try {
        await accountService.unlockUser(
            merchantId,
            parseInt(req.params.id),
            { unlockedByEmail: req.session.user.email, unlockedById: req.session.user.id, ...ctx(req) }
        );
    } catch (err) {
        return sendError(res, err.message, err.statusCode || 500);
    }
    sendSuccess(res, { message: 'Account unlocked successfully' });
}));

module.exports = router;
