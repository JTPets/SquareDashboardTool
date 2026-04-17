/**
 * Catalog Location Health Admin Routes
 *
 * Admin tool for viewing and triggering location mismatch health checks.
 * Super admin only. Scoped to the authenticated admin's active merchant.
 *
 * Routes:
 *   GET  /api/admin/catalog-location-health       → view history + open mismatches
 *   POST /api/admin/catalog-location-health/check  → trigger health check now
 *
 * @module routes/catalog-location-health
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/catalog-location-health');
const { sendSuccess } = require('../utils/response-helper');
const {
    checkAndRecordHealth,
    getMismatchHistory,
    getOpenMismatches
} = require('../services/catalog/location-health-service');

/**
 * GET /api/admin/catalog-location-health
 * Returns history and open mismatches for the authenticated admin's active merchant
 */
router.get('/', requireAuth, requireAdmin, requireMerchant, validators.getHealth, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const [history, openMismatches] = await Promise.all([
        getMismatchHistory(merchantId),
        getOpenMismatches(merchantId)
    ]);

    sendSuccess(res, {
        history,
        openMismatches
    });
}));

/**
 * POST /api/admin/catalog-location-health/check
 * Trigger a health check now and return results
 */
router.post('/check', requireAuth, requireAdmin, requireMerchant, validators.runCheck, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Manual catalog location health check triggered', {
        adminUserId: req.session.user.id,
        merchantId
    });

    const result = await checkAndRecordHealth(merchantId);

    sendSuccess(res, result);
}));

module.exports = router;
