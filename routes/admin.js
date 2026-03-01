/**
 * Admin Routes
 *
 * Platform administration endpoints for managing merchants and settings.
 * All routes require admin authentication.
 *
 * Endpoints:
 *   GET  /api/admin/merchants                          - List all merchants
 *   POST /api/admin/merchants/:merchantId/extend-trial - Extend merchant trial
 *   POST /api/admin/merchants/:merchantId/deactivate   - Deactivate merchant (expire trial)
 *   GET  /api/admin/settings                           - List all platform settings
 *   PUT  /api/admin/settings/:key                      - Update a platform setting
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/async-handler');
const platformSettings = require('../services/platform-settings');
const validators = require('../middleware/validators/admin');

/**
 * GET /api/admin/merchants
 * List all merchants with subscription info
 */
router.get('/merchants', requireAuth, requireAdmin, validators.listMerchants, asyncHandler(async (req, res) => {
    const result = await db.query(`
        SELECT id, business_name, square_merchant_id, subscription_status,
               trial_ends_at, subscription_ends_at, is_active, created_at, updated_at
        FROM merchants
        ORDER BY created_at DESC
    `);

    res.json({
        success: true,
        merchants: result.rows
    });
}));

/**
 * POST /api/admin/merchants/:merchantId/extend-trial
 * Extend a merchant's trial by N days from NOW
 * If no trial exists, sets trial_ends_at = NOW() + days
 */
router.post('/merchants/:merchantId/extend-trial', requireAuth, requireAdmin, validators.extendTrial, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);
    const { days } = req.body;

    const result = await db.query(`
        UPDATE merchants
        SET trial_ends_at = NOW() + INTERVAL '1 day' * $1,
            subscription_status = CASE
                WHEN subscription_status IN ('expired', 'suspended') THEN 'trial'
                ELSE subscription_status
            END,
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, business_name, trial_ends_at, subscription_status
    `, [days, merchantId]);

    if (result.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'Merchant not found'
        });
    }

    const merchant = result.rows[0];
    logger.info('Trial extended by admin', {
        merchantId,
        days,
        trialEndsAt: merchant.trial_ends_at,
        adminUserId: req.session.user.id
    });

    res.json({
        success: true,
        merchant
    });
}));

/**
 * POST /api/admin/merchants/:merchantId/deactivate
 * Immediately expire a merchant's trial (sets trial_ends_at to NOW)
 */
router.post('/merchants/:merchantId/deactivate', requireAuth, requireAdmin, validators.deactivateMerchant, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);

    const result = await db.query(`
        UPDATE merchants
        SET trial_ends_at = NOW(),
            subscription_status = 'expired',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, business_name, trial_ends_at, subscription_status
    `, [merchantId]);

    if (result.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'Merchant not found'
        });
    }

    const merchant = result.rows[0];
    logger.info('Merchant deactivated by admin', {
        merchantId,
        adminUserId: req.session.user.id
    });

    res.json({
        success: true,
        merchant
    });
}));

/**
 * GET /api/admin/settings
 * List all platform settings
 */
router.get('/settings', requireAuth, requireAdmin, validators.listSettings, asyncHandler(async (req, res) => {
    const settings = await platformSettings.getAllSettings();

    res.json({
        success: true,
        settings
    });
}));

/**
 * PUT /api/admin/settings/:key
 * Update a platform setting
 */
router.put('/settings/:key', requireAuth, requireAdmin, validators.updateSetting, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    await platformSettings.setSetting(key, value);

    logger.info('Platform setting updated by admin', {
        key,
        adminUserId: req.session.user.id
    });

    res.json({
        success: true,
        setting: { key, value }
    });
}));

module.exports = router;
