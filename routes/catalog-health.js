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
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/catalog-health');
const { sendSuccess } = require('../utils/response-helper');
const {
    runFullHealthCheck,
    getHealthHistory,
    getOpenIssues
} = require('../services/catalog/catalog-health-service');

/**
 * GET /api/admin/catalog-health
 * Returns history and open issues for the authenticated admin's active merchant
 */
router.get('/', requireAuth, requireAdmin, requireMerchant, validators.getHealth, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const [history, openIssues] = await Promise.all([
        getHealthHistory(merchantId),
        getOpenIssues(merchantId)
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
router.post('/check', requireAuth, requireAdmin, requireMerchant, validators.runCheck, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Manual catalog health check triggered', {
        adminUserId: req.session.user.id,
        merchantId
    });

    const result = await runFullHealthCheck(merchantId);

    sendSuccess(res, result);
}));

module.exports = router;
