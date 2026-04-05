'use strict';

const router = require('express').Router();
const { configurePasswordResetRateLimit } = require('../../middleware/security');
const { requireAuth, getClientIp } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const validators = require('../../middleware/validators/auth');
const passwordService = require('../../services/auth/password-service');

const passwordResetRateLimit = configurePasswordResetRateLimit();

router.post('/change-password', requireAuth, validators.changePassword, asyncHandler(async (req, res) => {
    try {
        await passwordService.changePassword(req.session.user.id, req.body.currentPassword, req.body.newPassword, {
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

// Security: always returns success — prevents email enumeration
router.post('/forgot-password', validators.forgotPassword, asyncHandler(async (req, res) => {
    const result = await passwordService.forgotPassword(req.body.email, getClientIp(req));
    sendSuccess(res, result);
}));

// Security: token has limited attempts (default 5) to prevent brute-force
router.post('/reset-password', passwordResetRateLimit, validators.resetPassword, asyncHandler(async (req, res) => {
    try {
        await passwordService.resetPassword(req.body.token, req.body.newPassword, {
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent']
        });
        sendSuccess(res, { message: 'Password has been reset successfully. You can now log in with your new password.' });
    } catch (err) {
        sendError(res, err.message, err.statusCode || 500);
    }
}));

router.get('/verify-reset-token', validators.verifyResetToken, asyncHandler(async (req, res) => {
    const result = await passwordService.verifyResetToken(req.query.token);
    sendSuccess(res, result);
}));

module.exports = router;
