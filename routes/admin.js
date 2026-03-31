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
 *   POST /api/admin/test-email                          - Test email configuration
 *   POST /api/admin/promo-codes                        - Create a platform-owner promo code
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
// LOGIC CHANGE: verify admin has access to target merchant (Audit 2.6.1)
const { requireMerchantAccess } = require('../middleware/merchant-access');
const asyncHandler = require('../middleware/async-handler');
const platformSettings = require('../services/platform-settings');
const validators = require('../middleware/validators/admin');
const emailNotifier = require('../utils/email-notifier');
const { sendSuccess, sendError } = require('../utils/response-helper');

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

    sendSuccess(res, {
        merchants: result.rows
    });
}));

/**
 * POST /api/admin/merchants/:merchantId/extend-trial
 * Extend a merchant's trial by N days from NOW
 * If no trial exists, sets trial_ends_at = NOW() + days
 */
router.post('/merchants/:merchantId/extend-trial', requireAuth, requireAdmin, requireMerchantAccess, validators.extendTrial, asyncHandler(async (req, res) => {
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
        return sendError(res, 'Merchant not found', 404);
    }

    const merchant = result.rows[0];
    logger.info('Trial extended by admin', {
        merchantId,
        days,
        trialEndsAt: merchant.trial_ends_at,
        adminUserId: req.session.user.id
    });

    sendSuccess(res, {
        merchant
    });
}));

/**
 * POST /api/admin/merchants/:merchantId/deactivate
 * Immediately expire a merchant's trial (sets trial_ends_at to NOW)
 */
router.post('/merchants/:merchantId/deactivate', requireAuth, requireAdmin, requireMerchantAccess, validators.deactivateMerchant, asyncHandler(async (req, res) => {
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
        return sendError(res, 'Merchant not found', 404);
    }

    const merchant = result.rows[0];
    logger.info('Merchant deactivated by admin', {
        merchantId,
        adminUserId: req.session.user.id
    });

    sendSuccess(res, {
        merchant
    });
}));

/**
 * GET /api/admin/settings
 * List all platform settings
 */
router.get('/settings', requireAuth, requireAdmin, validators.listSettings, asyncHandler(async (req, res) => {
    const settings = await platformSettings.getAllSettings();

    sendSuccess(res, {
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

    sendSuccess(res, {
        setting: { key, value }
    });
}));

/**
 * POST /api/admin/test-email
 * Send a test email to verify email configuration
 */
router.post('/test-email', requireAuth, requireAdmin, validators.testEmail, asyncHandler(async (req, res) => {
    try {
        await emailNotifier.testEmail();
        sendSuccess(res, {
            message: 'Test email sent successfully',
            provider: emailNotifier.getProvider()
        });
    } catch (error) {
        logger.error('Test email failed', { error: error.message });
        return sendError(res, error.message, 400, 'EMAIL_SEND_FAILED');
    }
}));

/**
 * POST /api/admin/promo-codes
 * Create a promo code scoped to the platform-owner merchant.
 * Platform-owner codes are visible to all merchants during promo validation.
 */
router.post('/promo-codes', requireAuth, requireAdmin, validators.createPromoCode, asyncHandler(async (req, res) => {
    const {
        code, discount_type, discount_value, fixed_price_cents, duration_months,
        max_uses, valid_until, description, notes
    } = req.body;

    // Resolve the platform_owner merchant — codes are stored under that merchant
    const ownerResult = await db.query(`
        SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1
    `);
    if (ownerResult.rows.length === 0) {
        return sendError(res, 'No platform_owner merchant configured', 500, 'NO_PLATFORM_OWNER');
    }
    const platformMerchantId = ownerResult.rows[0].id;

    // discount_value is required for non-fixed_price types
    const resolvedDiscountValue = discount_type === 'fixed_price' ? 0 : Number(discount_value);

    const result = await db.query(`
        INSERT INTO promo_codes
            (merchant_id, code, description, discount_type, discount_value,
             fixed_price_cents, duration_months, max_uses, valid_until, is_active,
             created_by, created_at, updated_at)
        VALUES ($1, UPPER($2), $3, $4, $5, $6, $7, $8, $9, TRUE, $10, NOW(), NOW())
        RETURNING *
    `, [
        platformMerchantId,
        code,
        description || null,
        discount_type,
        resolvedDiscountValue,
        fixed_price_cents || null,
        duration_months || null,
        max_uses || null,
        valid_until || null,
        `admin:${req.session.user.id}`
    ]);

    logger.info('Platform promo code created by admin', {
        code: result.rows[0].code,
        discount_type,
        adminUserId: req.session.user.id
    });

    sendSuccess(res, { promo: result.rows[0] });
}));

module.exports = router;
