/**
 * Catalog Health Admin Routes
 *
 * Debug tool for viewing and triggering catalog health checks.
 * Super admin only. Hard-coded to merchant_id = 3.
 *
 * Routes:
 *   GET  /api/admin/catalog-health       - view history + open issues
 *   POST /api/admin/catalog-health/check  - trigger full health check now
 *
 * @module routes/catalog-health
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/catalog-health');
const { sendSuccess } = require('../utils/response-helper');
const {
    runFullHealthCheck,
    getHealthHistory,
    getOpenIssues
} = require('../services/catalog/catalog-health-service');

const DEBUG_MERCHANT_ID = 3;

/**
 * GET /api/admin/catalog-health
 * Returns history and open issues for merchant 3
 */
router.get('/', requireAuth, requireAdmin, validators.getHealth, asyncHandler(async (req, res) => {
    const [history, openIssues] = await Promise.all([
        getHealthHistory(DEBUG_MERCHANT_ID),
        getOpenIssues(DEBUG_MERCHANT_ID)
    ]);

    sendSuccess(res, {
        history,
        openIssues
    });
}));

/**
 * POST /api/admin/catalog-health/check
 * Trigger a full health check now and return results
 */
router.post('/check', requireAuth, requireAdmin, validators.runCheck, asyncHandler(async (req, res) => {
    logger.info('Manual catalog health check triggered', {
        adminUserId: req.session.user.id
    });

    const result = await runFullHealthCheck(DEBUG_MERCHANT_ID);

    sendSuccess(res, result);
}));

module.exports = router;
