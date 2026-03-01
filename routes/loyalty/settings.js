/**
 * Loyalty Settings Routes
 *
 * Handles loyalty program settings:
 * - GET /settings - Get loyalty settings
 * - PUT /settings - Update loyalty settings
 */

const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');

/**
 * GET /api/loyalty/settings
 * Get loyalty settings for the merchant
 */
router.get('/settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Ensure default settings exist
    await loyaltyService.initializeDefaultSettings(merchantId);

    const result = await db.query(`
        SELECT setting_key, setting_value, description
        FROM loyalty_settings
        WHERE merchant_id = $1
    `, [merchantId]);

    const settings = result.rows.reduce((acc, row) => {
        acc[row.setting_key] = row.setting_value;
        return acc;
    }, {});

    res.json({ settings });
}));

/**
 * PUT /api/loyalty/settings
 * Update loyalty settings
 */
router.put('/settings', requireAuth, requireMerchant, requireWriteAccess, validators.updateSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const updates = req.body;

    for (const [key, value] of Object.entries(updates)) {
        await loyaltyService.updateSetting(key, String(value), merchantId);
    }

    logger.info('Updated loyalty settings', { merchantId, keys: Object.keys(updates) });

    res.json({ success: true });
}));

module.exports = router;
