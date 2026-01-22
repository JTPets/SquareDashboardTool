/**
 * Expiry Discounts Routes
 *
 * Handles automatic discount management for products approaching expiration:
 * - Tier configuration and management
 * - Variation discount status tracking
 * - Discount evaluation and application
 * - Square discount object initialization
 * - Audit logging and settings
 *
 * Endpoints:
 * - GET    /api/expiry-discounts/status           - Get discount status summary
 * - GET    /api/expiry-discounts/tiers            - Get discount tier configurations
 * - PATCH  /api/expiry-discounts/tiers/:id        - Update a tier configuration
 * - GET    /api/expiry-discounts/variations       - Get variations with discount status
 * - POST   /api/expiry-discounts/evaluate         - Run tier evaluation
 * - POST   /api/expiry-discounts/apply            - Apply discounts based on tiers
 * - POST   /api/expiry-discounts/run              - Run full automation (evaluate + apply)
 * - POST   /api/expiry-discounts/init-square      - Initialize Square discount objects
 * - GET    /api/expiry-discounts/audit-log        - Get discount change audit log
 * - GET    /api/expiry-discounts/settings         - Get system settings
 * - PATCH  /api/expiry-discounts/settings         - Update system settings
 * - GET    /api/expiry-discounts/validate         - Validate Square configuration
 * - POST   /api/expiry-discounts/validate-and-fix - Validate and fix issues
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const expiryDiscount = require('../utils/expiry-discount');
const emailNotifier = require('../utils/email-notifier');
const { batchResolveImageUrls } = require('../utils/image-utils');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/expiry-discounts');

/**
 * GET /api/expiry-discounts/status
 * Get summary of current expiry discount status
 */
router.get('/expiry-discounts/status', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const summary = await expiryDiscount.getDiscountStatusSummary(merchantId);
        res.json(summary);
    } catch (error) {
        logger.error('Get expiry discount status error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/tiers
 * Get all discount tier configurations
 * Creates default tiers for new merchants if none exist
 */
router.get('/expiry-discounts/tiers', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Ensure merchant has default tiers configured
        await expiryDiscount.ensureMerchantTiers(merchantId);

        const result = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE merchant_id = $1
            ORDER BY priority DESC
        `, [merchantId]);
        res.json({ tiers: result.rows });
    } catch (error) {
        logger.error('Get expiry discount tiers error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/expiry-discounts/tiers/:id
 * Update a discount tier configuration
 */
router.patch('/expiry-discounts/tiers/:id', requireAuth, requireMerchant, validators.updateTier, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const merchantId = req.merchantContext.id;

        // Build dynamic update query
        const allowedFields = [
            'tier_name', 'min_days_to_expiry', 'max_days_to_expiry',
            'discount_percent', 'is_auto_apply', 'requires_review',
            'color_code', 'priority', 'is_active'
        ];

        const setClauses = [];
        const params = [id, merchantId];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                params.push(value);
                setClauses.push(`${key} = $${params.length}`);
            }
        }

        if (setClauses.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        setClauses.push('updated_at = NOW()');

        const result = await db.query(`
            UPDATE expiry_discount_tiers
            SET ${setClauses.join(', ')}
            WHERE id = $1 AND merchant_id = $2
            RETURNING *
        `, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tier not found' });
        }

        logger.info('Updated expiry discount tier', { id, updates });
        res.json({ tier: result.rows[0] });

    } catch (error) {
        logger.error('Update expiry discount tier error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/variations
 * Get variations with their discount status
 */
router.get('/expiry-discounts/variations', requireAuth, requireMerchant, validators.getVariations, async (req, res) => {
    try {
        const { tier_code, needs_pull, limit = 100, offset = 0 } = req.query;
        const merchantId = req.merchantContext.id;

        let query = `
            SELECT
                vds.variation_id,
                vds.days_until_expiry,
                vds.original_price_cents,
                vds.discounted_price_cents,
                vds.discount_applied_at,
                vds.needs_pull,
                vds.last_evaluated_at,
                v.sku,
                v.name as variation_name,
                v.price_money as current_price_cents,
                v.images,
                i.name as item_name,
                i.id as item_id,
                i.category_name,
                i.images as item_images,
                ve.expiration_date,
                ve.does_not_expire,
                ve.reviewed_at,
                edt.id as tier_id,
                edt.tier_code,
                edt.tier_name,
                edt.discount_percent,
                edt.color_code,
                edt.is_auto_apply,
                edt.requires_review,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0) as current_stock,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0)
                    - COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as available_to_sell
            FROM variation_discount_status vds
            JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE') AND ic.merchant_id = $1
            WHERE v.is_deleted = FALSE
        `;

        const params = [merchantId];

        if (tier_code) {
            params.push(tier_code);
            query += ` AND edt.tier_code = $${params.length}`;
        }

        if (needs_pull === 'true') {
            query += ` AND vds.needs_pull = TRUE`;
        }

        query += `
            GROUP BY vds.variation_id, vds.days_until_expiry, vds.original_price_cents,
                     vds.discounted_price_cents, vds.discount_applied_at, vds.needs_pull,
                     vds.last_evaluated_at, v.sku, v.name, v.price_money, v.images, i.name, i.id,
                     i.category_name, i.images, ve.expiration_date, ve.does_not_expire, ve.reviewed_at,
                     edt.id, edt.tier_code, edt.tier_name, edt.discount_percent, edt.color_code,
                     edt.is_auto_apply, edt.requires_review
            ORDER BY vds.days_until_expiry ASC NULLS LAST
        `;

        params.push(parseInt(limit));
        query += ` LIMIT $${params.length}`;

        params.push(parseInt(offset));
        query += ` OFFSET $${params.length}`;

        const result = await db.query(query, params);

        // Get total count for pagination
        let countQuery = `
            SELECT COUNT(DISTINCT vds.variation_id) as total
            FROM variation_discount_status vds
            JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
            LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
            WHERE v.is_deleted = FALSE
        `;
        const countParams = [merchantId];

        if (tier_code) {
            countParams.push(tier_code);
            countQuery += ` AND edt.tier_code = $${countParams.length}`;
        }
        if (needs_pull === 'true') {
            countQuery += ` AND vds.needs_pull = TRUE`;
        }

        const countResult = await db.query(countQuery, countParams);

        // Resolve image URLs
        const imageUrlMap = await batchResolveImageUrls(result.rows);
        const variations = result.rows.map((row, index) => ({
            ...row,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,
            item_images: undefined
        }));

        res.json({
            variations,
            total: parseInt(countResult.rows[0]?.total || 0),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

    } catch (error) {
        logger.error('Get expiry discount variations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/evaluate
 * Run expiry tier evaluation for all variations
 */
router.post('/expiry-discounts/evaluate', requireAuth, requireMerchant, validators.evaluate, async (req, res) => {
    try {
        const { dry_run = false } = req.body;
        const merchantId = req.merchantContext.id;

        logger.info('Manual expiry evaluation requested', { dry_run, merchantId });

        const result = await expiryDiscount.evaluateAllVariations({
            dryRun: dry_run,
            triggeredBy: 'MANUAL',
            merchantId
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('Expiry evaluation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/apply
 * Apply discounts based on current tier assignments
 */
router.post('/expiry-discounts/apply', requireAuth, requireMerchant, validators.apply, async (req, res) => {
    try {
        const { dry_run = false } = req.body;
        const merchantId = req.merchantContext.id;

        logger.info('Manual discount application requested', { dry_run, merchantId });

        const result = await expiryDiscount.applyDiscounts({ dryRun: dry_run, merchantId });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('Discount application error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/run
 * Run full expiry discount automation (evaluate + apply)
 */
router.post('/expiry-discounts/run', requireAuth, requireMerchant, validators.run, async (req, res) => {
    try {
        const { dry_run = false } = req.body;
        const merchantId = req.merchantContext.id;

        logger.info('Full expiry discount automation requested', { dry_run, merchantId });

        const result = await expiryDiscount.runExpiryDiscountAutomation({ dryRun: dry_run, merchantId });

        // Send email notification if enabled and not dry run
        if (!dry_run && result.evaluation) {
            const tierChanges = result.evaluation.tierChanges?.length || 0;
            const newAssignments = result.evaluation.newAssignments?.length || 0;

            if (tierChanges > 0 || newAssignments > 0) {
                const emailEnabled = await expiryDiscount.getSetting('email_notifications', merchantId);
                if (emailEnabled === 'true') {
                    try {
                        await emailNotifier.sendAlert(
                            'Expiry Discount Automation Report',
                            `Expiry discount automation completed.\n\n` +
                            `Summary:\n` +
                            `- Total evaluated: ${result.evaluation.totalEvaluated}\n` +
                            `- Tier changes: ${tierChanges}\n` +
                            `- New assignments: ${newAssignments}\n` +
                            `- Discounts applied: ${result.discountApplication?.applied?.length || 0}\n` +
                            `- Discounts removed: ${result.discountApplication?.removed?.length || 0}\n` +
                            `- Errors: ${result.errors?.length || 0}\n\n` +
                            `Duration: ${result.duration}ms`
                        );
                    } catch (emailError) {
                        logger.error('Failed to send automation email', { error: emailError.message });
                    }
                }
            }
        }

        res.json(result);

    } catch (error) {
        logger.error('Expiry discount automation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/init-square
 * Initialize Square discount objects for all tiers
 */
router.post('/expiry-discounts/init-square', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Square discount initialization requested', { merchantId });

        const result = await expiryDiscount.initializeSquareDiscounts(merchantId);

        res.json({
            success: result.errors.length === 0,
            ...result
        });

    } catch (error) {
        logger.error('Square discount init error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/audit-log
 * Get audit log of discount changes
 */
router.get('/expiry-discounts/audit-log', requireAuth, requireMerchant, validators.getAuditLog, async (req, res) => {
    try {
        const { variation_id, limit = 100 } = req.query;
        const merchantId = req.merchantContext.id;

        const logs = await expiryDiscount.getAuditLog(merchantId, {
            variationId: variation_id,
            limit: parseInt(limit)
        });

        res.json({ logs });

    } catch (error) {
        logger.error('Get audit log error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/settings
 * Get expiry discount system settings
 */
router.get('/expiry-discounts/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT setting_key, setting_value, description
            FROM expiry_discount_settings
            WHERE merchant_id = $1
            ORDER BY setting_key
        `, [merchantId]);

        const settings = {};
        for (const row of result.rows) {
            settings[row.setting_key] = {
                value: row.setting_value,
                description: row.description
            };
        }

        res.json({ settings });

    } catch (error) {
        logger.error('Get expiry discount settings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/expiry-discounts/settings
 * Update expiry discount system settings
 */
router.patch('/expiry-discounts/settings', requireAuth, requireMerchant, validators.updateSettings, async (req, res) => {
    try {
        const updates = req.body;
        const merchantId = req.merchantContext.id;

        for (const [key, value] of Object.entries(updates)) {
            await expiryDiscount.updateSetting(key, value, merchantId);
        }

        logger.info('Updated expiry discount settings', { updates, merchantId });

        res.json({ success: true, message: 'Settings updated' });

    } catch (error) {
        logger.error('Update expiry discount settings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/validate
 * Validate expiry discount configuration in Square
 * Checks that discount percentages match and pricing rules are correctly configured
 */
router.get('/expiry-discounts/validate', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await expiryDiscount.validateExpiryDiscounts({
            merchantId,
            fix: false
        });
        res.json(result);
    } catch (error) {
        logger.error('Validate expiry discounts error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/validate-and-fix
 * Validate expiry discount configuration and fix any issues found
 */
router.post('/expiry-discounts/validate-and-fix', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await expiryDiscount.validateExpiryDiscounts({
            merchantId,
            fix: true
        });

        logger.info('Validated and fixed expiry discount issues', {
            merchantId,
            tiersChecked: result.tiersChecked,
            issues: result.issues.length,
            fixed: result.fixed.length
        });

        res.json(result);
    } catch (error) {
        logger.error('Validate and fix expiry discounts error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
