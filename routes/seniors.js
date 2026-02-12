/**
 * Seniors Discount Routes
 *
 * Admin endpoints for monitoring and configuring the seniors discount program.
 *
 * Endpoints: 5 total
 * - GET  /api/seniors/status     Dashboard overview
 * - GET  /api/seniors/config     Current configuration
 * - PATCH /api/seniors/config    Update configuration
 * - GET  /api/seniors/members    List enrolled seniors
 * - GET  /api/seniors/audit-log  Recent audit log
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/seniors');
const asyncHandler = require('../middleware/async-handler');
const { SeniorsService } = require('../services/seniors');

// ==================== STATUS / DASHBOARD ====================

/**
 * GET /api/seniors/status
 * Dashboard overview: enrolled count, pricing rule state, config summary
 */
router.get('/seniors/status', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const config = await db.query(
        `SELECT * FROM seniors_discount_config WHERE merchant_id = $1`,
        [merchantId]
    );

    if (config.rows.length === 0) {
        return res.json({
            configured: false,
            message: 'Seniors discount not set up. Run setup script first.',
        });
    }

    const cfg = config.rows[0];

    const memberCount = await db.query(
        `SELECT COUNT(*) as count FROM seniors_group_members
         WHERE merchant_id = $1 AND is_active = TRUE`,
        [merchantId]
    );

    // Check pricing rule state in Square
    let pricingRuleState = null;
    if (cfg.square_pricing_rule_id) {
        try {
            const service = new SeniorsService(merchantId);
            await service.initialize();
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
            const dayOfMonth = parseInt(today.split('-')[2], 10);
            const expectedEnabled = dayOfMonth === (cfg.day_of_month || 1);
            pricingRuleState = await service.verifyPricingRuleState(expectedEnabled);
        } catch (error) {
            pricingRuleState = { error: error.message };
        }
    }

    res.json({
        configured: true,
        enrolledCount: parseInt(memberCount.rows[0].count, 10),
        config: {
            discountPercent: cfg.discount_percent,
            minAge: cfg.min_age,
            dayOfMonth: cfg.day_of_month || 1,
            isEnabled: cfg.is_enabled,
        },
        squareObjects: {
            groupId: cfg.square_group_id,
            discountId: cfg.square_discount_id,
            pricingRuleId: cfg.square_pricing_rule_id,
        },
        pricingRuleState,
        timestamps: {
            lastEnabled: cfg.last_enabled_at,
            lastDisabled: cfg.last_disabled_at,
            createdAt: cfg.created_at,
            updatedAt: cfg.updated_at,
        },
    });
}));

// ==================== CONFIGURATION ====================

/**
 * GET /api/seniors/config
 * Current configuration values
 */
router.get('/seniors/config', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const result = await db.query(
        `SELECT discount_percent, min_age, day_of_month, is_enabled,
                last_enabled_at, last_disabled_at, updated_at
         FROM seniors_discount_config
         WHERE merchant_id = $1`,
        [merchantId]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Seniors discount not configured' });
    }

    res.json({ config: result.rows[0] });
}));

/**
 * PATCH /api/seniors/config
 * Update configurable values (discount_percent, min_age, day_of_month, is_enabled)
 */
router.patch('/seniors/config',
    requireAuth, requireMerchant, requireWriteAccess, validators.updateConfig,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const { discount_percent, min_age, day_of_month, is_enabled } = req.body;

        // Build dynamic SET clause from provided fields
        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (discount_percent !== undefined) {
            updates.push(`discount_percent = $${paramIndex++}`);
            values.push(discount_percent);
        }
        if (min_age !== undefined) {
            updates.push(`min_age = $${paramIndex++}`);
            values.push(min_age);
        }
        if (day_of_month !== undefined) {
            updates.push(`day_of_month = $${paramIndex++}`);
            values.push(day_of_month);
        }
        if (is_enabled !== undefined) {
            updates.push(`is_enabled = $${paramIndex++}`);
            values.push(is_enabled);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push(`updated_at = NOW()`);
        values.push(merchantId);

        const result = await db.query(
            `UPDATE seniors_discount_config
             SET ${updates.join(', ')}
             WHERE merchant_id = $${paramIndex}
             RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Seniors discount not configured' });
        }

        logger.info('Seniors discount config updated', {
            merchantId,
            changes: req.body,
            userId: req.session.user.id,
        });

        res.json({ config: result.rows[0] });
    })
);

// ==================== MEMBERS ====================

/**
 * GET /api/seniors/members
 * List enrolled seniors (paginated)
 */
router.get('/seniors/members', requireAuth, requireMerchant, validators.listMembers,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const limit = parseInt(req.query.limit || '50', 10);
        const offset = parseInt(req.query.offset || '0', 10);

        const members = await db.query(
            `SELECT sgm.square_customer_id, sgm.birthday, sgm.age_at_last_check,
                    sgm.is_active, sgm.added_to_group_at,
                    lc.given_name, lc.family_name, lc.email_address, lc.phone_number
             FROM seniors_group_members sgm
             LEFT JOIN loyalty_customers lc
                ON sgm.square_customer_id = lc.square_customer_id
                AND sgm.merchant_id = lc.merchant_id
             WHERE sgm.merchant_id = $1 AND sgm.is_active = TRUE
             ORDER BY sgm.added_to_group_at DESC
             LIMIT $2 OFFSET $3`,
            [merchantId, limit, offset]
        );

        const total = await db.query(
            `SELECT COUNT(*) as count FROM seniors_group_members
             WHERE merchant_id = $1 AND is_active = TRUE`,
            [merchantId]
        );

        res.json({
            members: members.rows,
            total: parseInt(total.rows[0].count, 10),
            limit,
            offset,
        });
    })
);

// ==================== AUDIT LOG ====================

/**
 * GET /api/seniors/audit-log
 * Recent audit log entries
 */
router.get('/seniors/audit-log', requireAuth, requireMerchant, validators.listAuditLog,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const limit = parseInt(req.query.limit || '100', 10);

        const result = await db.query(
            `SELECT * FROM seniors_discount_audit_log
             WHERE merchant_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [merchantId, limit]
        );

        res.json({ entries: result.rows, count: result.rows.length });
    })
);

module.exports = router;
