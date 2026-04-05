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
 *   GET  /api/admin/merchants/:merchantId/payments     - Billing history for a merchant
 *   GET  /api/admin/settings                           - List all platform settings
 *   PUT  /api/admin/settings/:key                      - Update a platform setting
 *   POST /api/admin/test-email                          - Test email configuration
 *   GET  /api/admin/promo-codes                        - List all platform promo codes
 *   POST /api/admin/promo-codes                        - Create a platform-owner promo code
 *   POST /api/admin/promo-codes/:id/deactivate         - Soft-deactivate a promo code
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
// LOGIC CHANGE: verify admin has access to target merchant (Audit 2.6.1)
const { requireMerchantAccess } = require('../middleware/merchant-access');
const asyncHandler = require('../middleware/async-handler');
const platformSettings = require('../services/merchant/platform-settings');
const validators = require('../middleware/validators/admin');
const emailNotifier = require('../utils/email-notifier');
const { sendSuccess, sendError } = require('../utils/response-helper');
const requireSuperAdmin = require('../middleware/require-super-admin');
const subscriptionHandler = require('../utils/subscription-handler');
const featureRegistry = require('../config/feature-registry');

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
router.post('/merchants/:merchantId/extend-trial', requireAuth, requireAdmin, requireSuperAdmin, requireMerchantAccess, validators.extendTrial, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);
    const { days } = req.body;

    const result = await db.query(`
        UPDATE merchants
        SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + INTERVAL '1 day' * $1,
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

/**
 * GET /api/admin/promo-codes
 * List all platform-owner promo codes with usage stats.
 */
router.get('/promo-codes', requireAuth, requireAdmin, requireSuperAdmin, validators.listPromoCodes, asyncHandler(async (req, res) => {
    const ownerResult = await db.query(`
        SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1
    `);
    if (ownerResult.rows.length === 0) {
        return sendError(res, 'No platform_owner merchant configured', 500, 'NO_PLATFORM_OWNER');
    }
    const platformMerchantId = ownerResult.rows[0].id;

    const result = await db.query(`
        SELECT id, code, description, discount_type, discount_value, fixed_price_cents,
               duration_months, max_uses, times_used, is_active, valid_until, created_by, created_at
        FROM promo_codes
        WHERE merchant_id = $1
        ORDER BY created_at DESC
    `, [platformMerchantId]);

    sendSuccess(res, { promoCodes: result.rows });
}));

/**
 * POST /api/admin/promo-codes/:id/deactivate
 * Soft-deactivate a promo code (sets is_active = FALSE).
 */
router.post('/promo-codes/:id/deactivate', requireAuth, requireAdmin, requireSuperAdmin, validators.deactivatePromoCode, asyncHandler(async (req, res) => {
    const promoId = parseInt(req.params.id, 10);

    const ownerResult = await db.query(`
        SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1
    `);
    if (ownerResult.rows.length === 0) {
        return sendError(res, 'No platform_owner merchant configured', 500, 'NO_PLATFORM_OWNER');
    }
    const platformMerchantId = ownerResult.rows[0].id;

    const result = await db.query(`
        UPDATE promo_codes
        SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, code, is_active
    `, [promoId, platformMerchantId]);

    if (result.rows.length === 0) {
        return sendError(res, 'Promo code not found', 404);
    }

    logger.info('Promo code deactivated by admin', {
        promoId,
        code: result.rows[0].code,
        adminUserId: req.session.user.id
    });

    sendSuccess(res, { promo: result.rows[0] });
}));

/**
 * GET /api/admin/merchants/:merchantId/payments
 * Billing history for a merchant (via subscriber link).
 */
router.get('/merchants/:merchantId/payments', requireAuth, requireAdmin, requireSuperAdmin, validators.listMerchantPayments, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await db.query(`
        SELECT sp.id, sp.amount_cents, sp.currency, sp.status, sp.payment_type,
               sp.billing_period_start, sp.billing_period_end,
               sp.refund_amount_cents, sp.refund_reason, sp.refunded_at,
               sp.receipt_url, sp.failure_reason, sp.created_at,
               s.email, s.subscription_plan
        FROM subscription_payments sp
        JOIN subscribers s ON s.id = sp.subscriber_id
        WHERE s.merchant_id = $1
        ORDER BY sp.created_at DESC
        LIMIT $2 OFFSET $3
    `, [merchantId, limit, offset]);

    const countResult = await db.query(`
        SELECT COUNT(*) FROM subscription_payments sp
        JOIN subscribers s ON s.id = sp.subscriber_id
        WHERE s.merchant_id = $1
    `, [merchantId]);

    sendSuccess(res, {
        payments: result.rows,
        total: parseInt(countResult.rows[0].count, 10)
    });
}));

/**
 * GET /api/admin/merchants/:merchantId/features
 * Returns merchant's current feature states plus all available paid modules.
 */
router.get('/merchants/:merchantId/features', requireAuth, requireAdmin, requireSuperAdmin, validators.getMerchantFeatures, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);

    const result = await db.query(
        `SELECT feature_key, enabled, source, enabled_at, disabled_at
         FROM merchant_features
         WHERE merchant_id = $1`,
        [merchantId]
    );

    const featureMap = {};
    result.rows.forEach(row => { featureMap[row.feature_key] = row; });

    const features = featureRegistry.getPaidModules().map(mod => {
        const row = featureMap[mod.key] || null;
        return {
            feature_key: mod.key,
            name: mod.name,
            price_cents: mod.price_cents,
            enabled: row ? row.enabled : false,
            source: row ? row.source : null,
            enabled_at: row ? row.enabled_at : null,
            disabled_at: row ? row.disabled_at : null,
        };
    });

    sendSuccess(res, { features });
}));

/**
 * PUT /api/admin/merchants/:merchantId/features/:featureKey
 * Upsert a merchant_features row with source = 'admin_override'.
 */
router.put('/merchants/:merchantId/features/:featureKey', requireAuth, requireAdmin, requireSuperAdmin, validators.updateMerchantFeature, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);
    const { featureKey } = req.params;
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    const disabledAt = enabled ? null : new Date().toISOString();

    const result = await db.query(
        `INSERT INTO merchant_features (merchant_id, feature_key, enabled, source, enabled_at, disabled_at)
         VALUES ($1, $2, $3, 'admin_override', NOW(), $4)
         ON CONFLICT (merchant_id, feature_key)
         DO UPDATE SET
             enabled = EXCLUDED.enabled,
             source = 'admin_override',
             enabled_at = NOW(),
             disabled_at = EXCLUDED.disabled_at
         RETURNING feature_key, enabled, source`,
        [merchantId, featureKey, enabled, disabledAt]
    );

    logger.info('Merchant feature toggled by admin', {
        merchantId, featureKey, enabled,
        adminUserId: req.session.user.id
    });

    sendSuccess(res, { feature: result.rows[0] });
}));

/**
 * POST /api/admin/merchants/:merchantId/activate
 * Manually comp-activate a merchant: sets subscription_status = 'active'
 * and grants all paid modules with source = 'admin_override'.
 */
router.post('/merchants/:merchantId/activate', requireAuth, requireAdmin, requireSuperAdmin, validators.activateMerchant, asyncHandler(async (req, res) => {
    const merchantId = parseInt(req.params.merchantId, 10);

    const merchantResult = await db.query(
        `UPDATE merchants
         SET subscription_status = 'active', updated_at = NOW()
         WHERE id = $1
         RETURNING id, business_name, subscription_status`,
        [merchantId]
    );

    if (merchantResult.rows.length === 0) {
        return sendError(res, 'Merchant not found', 404);
    }

    const paidModules = featureRegistry.getPaidModules();
    for (const mod of paidModules) {
        await db.query(
            `INSERT INTO merchant_features (merchant_id, feature_key, enabled, source, enabled_at, disabled_at)
             VALUES ($1, $2, TRUE, 'admin_override', NOW(), NULL)
             ON CONFLICT (merchant_id, feature_key)
             DO UPDATE SET
                 enabled = TRUE,
                 source = 'admin_override',
                 enabled_at = NOW(),
                 disabled_at = NULL`,
            [merchantId, mod.key]
        );
    }

    logger.info('Merchant manually activated by admin', {
        merchantId,
        modulesGranted: paidModules.length,
        adminUserId: req.session.user.id
    });

    sendSuccess(res, { merchant: merchantResult.rows[0], modulesGranted: paidModules.length });
}));

module.exports = router;
