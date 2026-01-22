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
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/settings');

/**
 * GET /api/settings/merchant
 * Get merchant-specific settings (reorder rules, cycle count config, etc.)
 * Settings are stored per-merchant and override global env var defaults
 */
router.get('/settings/merchant', requireAuth, requireMerchant, validators.get, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const settings = await db.getMerchantSettings(merchantId);

        res.json({
            success: true,
            settings,
            merchantId
        });

    } catch (error) {
        logger.error('Failed to get merchant settings', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/settings/merchant
 * Update merchant-specific settings
 * Only allows updating known setting fields
 */
router.put('/settings/merchant', requireAuth, requireMerchant, validators.update, async (req, res) => {
    try {
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
                    return res.status(400).json({ error: `Invalid value for ${field}: must be a non-negative number` });
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

        const updated = await db.updateMerchantSettings(merchantId, settings);

        logger.info('Merchant settings updated', {
            merchantId,
            fields: Object.keys(settings)
        });

        res.json({
            success: true,
            settings: updated,
            message: 'Settings saved successfully'
        });

    } catch (error) {
        logger.error('Failed to update merchant settings', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/settings/merchant/defaults
 * Get default merchant settings (from env vars)
 * Useful for resetting to defaults
 */
router.get('/settings/merchant/defaults', requireAuth, validators.defaults, async (req, res) => {
    res.json({
        success: true,
        defaults: db.DEFAULT_MERCHANT_SETTINGS
    });
});

module.exports = router;
