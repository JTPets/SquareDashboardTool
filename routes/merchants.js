/**
 * Merchant Management Routes
 *
 * Handles merchant management and configuration:
 * - List merchants for current user
 * - Switch active merchant
 * - Get merchant context
 * - Get frontend configuration
 *
 * Endpoints:
 * - GET  /api/merchants          - List merchants user has access to
 * - POST /api/merchants/switch   - Switch active merchant
 * - GET  /api/merchants/context  - Get current merchant context
 * - GET  /api/config             - Get frontend configuration
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { getUserMerchants, switchActiveMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/merchants');

/**
 * GET /api/merchants
 * List all merchants the current user has access to
 */
router.get('/merchants', requireAuth, validators.list, asyncHandler(async (req, res) => {
    const merchants = await getUserMerchants(req.session.user.id);

    res.json({
        success: true,
        merchants,
        activeMerchantId: req.session.activeMerchantId || null,
        activeMerchant: req.merchantContext || null
    });
}));

/**
 * POST /api/merchants/switch
 * Switch the active merchant for the current session
 */
router.post('/merchants/switch', requireAuth, validators.switch, asyncHandler(async (req, res) => {
    const { merchantId } = req.body;

    if (!merchantId) {
        return res.status(400).json({
            success: false,
            error: 'merchantId is required'
        });
    }

    const switched = await switchActiveMerchant(
        req.session,
        req.session.user.id,
        parseInt(merchantId)
    );

    if (!switched) {
        return res.status(403).json({
            success: false,
            error: 'You do not have access to this merchant'
        });
    }

    res.json({
        success: true,
        activeMerchantId: req.session.activeMerchantId,
        message: 'Merchant switched successfully'
    });
}));

/**
 * GET /api/merchants/context
 * Get current merchant context for the session
 */
router.get('/merchants/context', requireAuth, validators.context, async (req, res) => {
    res.json({
        success: true,
        hasMerchant: !!req.merchantContext,
        merchant: req.merchantContext || null,
        connectUrl: '/api/square/oauth/connect'
    });
});

/**
 * GET /api/config
 * Get frontend configuration from environment variables
 */
router.get('/config', requireAuth, validators.config, asyncHandler(async (req, res) => {
    // Check Square connection by checking if merchant has locations synced
    let squareConnected = false;
    try {
            if (req.merchantContext?.id) {
                const result = await db.query(
                    'SELECT id FROM locations WHERE merchant_id = $1 LIMIT 1',
                    [req.merchantContext.id]
                );
                squareConnected = result.rows.length > 0;
            }
        } catch (e) {
            logger.warn('Square connection check failed', { error: e.message, merchantId: req.merchantContext?.id });
            squareConnected = false;
        }

        // Try to load merchant settings if merchant context available
        let merchantSettings = null;
        const merchantId = req.merchantContext?.id;
        if (merchantId) {
            try {
                merchantSettings = await db.getMerchantSettings(merchantId);
            } catch (e) {
                logger.warn('Failed to load merchant settings for config', { merchantId, error: e.message });
            }
        }

        // Use merchant settings if available, otherwise fall back to env vars
        res.json({
            defaultSupplyDays: merchantSettings?.default_supply_days ??
                parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45'),
            reorderSafetyDays: merchantSettings?.reorder_safety_days ??
                parseInt(process.env.REORDER_SAFETY_DAYS || '7'),
            reorderPriorityThresholds: {
                urgent: merchantSettings?.reorder_priority_urgent_days ??
                    parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0'),
                high: merchantSettings?.reorder_priority_high_days ??
                    parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7'),
                medium: merchantSettings?.reorder_priority_medium_days ??
                    parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14'),
                low: merchantSettings?.reorder_priority_low_days ??
                    parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30')
            },
            square_connected: squareConnected,
            square_environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
            email_configured: process.env.EMAIL_ENABLED === 'true' && !!process.env.EMAIL_USER,
            sync_intervals: {
                catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL || '60'),
                inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL || '15'),
                sales: parseInt(process.env.SYNC_SALES_INTERVAL || '60')
            },
        usingMerchantSettings: !!merchantSettings
    });
}));

module.exports = router;
