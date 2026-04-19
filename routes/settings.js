/**
 * Merchant Settings Routes
 *
 * Handles merchant-specific settings:
 * - Get merchant settings
 * - Update merchant settings
 * - Get default settings
 *
 * Endpoints:
 * - GET  /api/settings/merchant          - Get merchant settings
 * - PUT  /api/settings/merchant          - Update merchant settings
 * - GET  /api/settings/merchant/defaults - Get default settings
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { getMerchantSettings, updateMerchantSettings, DEFAULT_MERCHANT_SETTINGS } = require('../services/merchant');
const logger = require('../utils/logger');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/settings');
const { sendSuccess, sendError } = require('../utils/response-helper');

/**
 * GET /api/settings/merchant
 * Get merchant-specific settings (reorder rules, cycle count config, etc.)
 * Settings are stored per-merchant and override global env var defaults
 */
router.get('/settings/merchant', requireAuth, requireMerchant, validators.get, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const settings = await getMerchantSettings(merchantId);

    sendSuccess(res, {
        settings,
        merchantId
    });
}));

/**
 * PUT /api/settings/merchant
 * Update merchant-specific settings
 * Only allows updating known setting fields
 */
router.put('/settings/merchant', requireAuth, requireMerchant, requireWriteAccess, validators.update, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const settings = req.body;

        // Validate numeric fields
        const numericFields = [
            'reorder_safety_days', 'default_supply_days',
            'reorder_priority_urgent_days', 'reorder_priority_high_days',
            'reorder_priority_medium_days', 'reorder_priority_low_days',
            'daily_count_target'
        ];

        for (const field of numericFields) {
            if (settings.hasOwnProperty(field)) {
                const value = parseInt(settings[field]);
                if (isNaN(value) || value < 0) {
                    return sendError(res, `Invalid value for ${field}: must be a non-negative number`, 400);
                }
                settings[field] = value;
            }
        }

        // Validate boolean fields
        const booleanFields = ['cycle_count_email_enabled', 'cycle_count_report_email', 'low_stock_alerts_enabled'];
        for (const field of booleanFields) {
            if (settings.hasOwnProperty(field)) {
                settings[field] = Boolean(settings[field]);
            }
        }

        const updated = await updateMerchantSettings(merchantId, settings);

        logger.info('Merchant settings updated', {
            merchantId,
            fields: Object.keys(settings)
        });

    sendSuccess(res, {
        settings: updated,
        message: 'Settings saved successfully'
    });
}));

/**
 * GET /api/settings/merchant/defaults
 * Get default merchant settings (from env vars)
 * Useful for resetting to defaults
 */
router.get('/settings/merchant/defaults', requireAuth, validators.defaults, async (req, res) => {
    sendSuccess(res, {
        defaults: DEFAULT_MERCHANT_SETTINGS
    });
});

module.exports = router;
