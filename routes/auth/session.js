'use strict';

const router = require('express').Router();
const { configureLoginRateLimit } = require('../../middleware/security');
const { getClientIp } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const validators = require('../../middleware/validators/auth');
const sessionService = require('../../services/auth/session-service');

const loginRateLimit = configureLoginRateLimit();

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

router.post('/logout', asyncHandler(async (req, res) => {
    await sessionService.logoutUser(req, {
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent']
    });
    res.clearCookie('sid');
    sendSuccess(res, {});
}));

router.get('/me', (req, res) => {
    if (!req.session?.user) return sendError(res, 'Not authenticated', 401);
    sendSuccess(res, { authenticated: true, user: req.session.user });
});

module.exports = router;
