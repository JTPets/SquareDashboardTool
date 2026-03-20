/**
 * Catalog Location Health Admin Routes
 *
 * Debug tool for viewing and triggering location mismatch health checks.
 * Super admin only. Hard-coded to merchant_id = 3.
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
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/catalog-location-health');
const { sendSuccess } = require('../utils/response-helper');
const {
    checkAndRecordHealth,
    getMismatchHistory,
    getOpenMismatches
} = require('../services/catalog/location-health-service');

const DEBUG_MERCHANT_ID = 3;

/**
 * GET /api/admin/catalog-location-health
 * Returns history and open mismatches for merchant 3
 */
router.get('/', requireAuth, requireAdmin, validators.getHealth, asyncHandler(async (req, res) => {
    const [history, openMismatches] = await Promise.all([
        getMismatchHistory(DEBUG_MERCHANT_ID),
        getOpenMismatches(DEBUG_MERCHANT_ID)
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
router.post('/check', requireAuth, requireAdmin, validators.runCheck, asyncHandler(async (req, res) => {
    logger.info('Manual catalog location health check triggered', {
        adminUserId: req.session.user.id
    });

    const result = await checkAndRecordHealth(DEBUG_MERCHANT_ID);

    sendSuccess(res, result);
}));

module.exports = router;
