/**
 * Loyalty Rewards & Redemptions Routes
 *
 * Reward management and redemption history:
 * - POST /rewards/:rewardId/redeem - Redeem a loyalty reward
 * - PATCH /rewards/:rewardId/vendor-credit - Update vendor credit status
 * - GET /rewards - List rewards with filtering
 * - GET /redemptions - Get redemption history with filtering
 *
 * OBSERVATION LOG:
 * - PATCH /rewards/:rewardId/vendor-credit has inline SQL (SELECT + conditional UPDATE)
 *   Should be in reward-service or a vendor-credit-service
 * - GET /rewards has inline SQL with dynamic WHERE clause
 *   Should be in a reward query service
 * - GET /redemptions has complex inline SQL (90 lines, LATERAL JOIN, 5-table join)
 *   Should be in a redemption query service
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
 * POST /api/loyalty/rewards/:rewardId/redeem
 * Redeem a loyalty reward
 * BUSINESS RULE: Full redemption only - one reward = one free unit
 */
router.post('/rewards/:rewardId/redeem', requireAuth, requireMerchant, requireWriteAccess, validators.redeemReward, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { squareOrderId, redeemedVariationId, redeemedValueCents, adminNotes } = req.body;

    const result = await loyaltyService.redeemReward({
        merchantId,
        rewardId: req.params.rewardId,
        squareOrderId,
        redemptionType: req.body.redemptionType || 'manual_admin',
        redeemedVariationId,
        redeemedValueCents: redeemedValueCents ? parseInt(redeemedValueCents) : null,
        redeemedByUserId: req.session.user.id,
        adminNotes
    });

    logger.info('Loyalty reward redeemed', {
        rewardId: req.params.rewardId,
        redemptionId: result.redemption.id,
        merchantId
    });

    res.json(result);
}));

/**
 * PATCH /api/loyalty/rewards/:rewardId/vendor-credit
 * Update vendor credit submission status for a redeemed reward
 *
 * Body: { status: 'SUBMITTED'|'CREDITED'|'DENIED', notes?: string }
 *
 * Status flow:
 * - null -> SUBMITTED: Mark as submitted for vendor credit
 * - SUBMITTED -> CREDITED: Mark as credit received
 * - SUBMITTED -> DENIED: Mark as credit denied
 */
router.patch('/rewards/:rewardId/vendor-credit', requireAuth, requireMerchant, requireWriteAccess, validators.updateVendorCredit, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { rewardId } = req.params;
    const { status, notes } = req.body;

    // Verify reward exists and is redeemed
    const rewardResult = await db.query(`
        SELECT id, status, vendor_credit_status
        FROM loyalty_rewards
        WHERE id = $1 AND merchant_id = $2
    `, [rewardId, merchantId]);

    if (rewardResult.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'Reward not found',
            code: 'NOT_FOUND'
        });
    }

    const reward = rewardResult.rows[0];

    if (reward.status !== 'redeemed') {
        return res.status(400).json({
            success: false,
            error: 'Only redeemed rewards can have vendor credit status',
            code: 'INVALID_REWARD_STATUS'
        });
    }

    // Build update query based on status transition
    let updateQuery;
    let updateParams;

    if (status === 'SUBMITTED') {
        // Mark as submitted - set submitted timestamp
        updateQuery = `
            UPDATE loyalty_rewards
            SET vendor_credit_status = $1,
                vendor_credit_submitted_at = NOW(),
                vendor_credit_notes = $2,
                updated_at = NOW()
            WHERE id = $3 AND merchant_id = $4
            RETURNING id, vendor_credit_status, vendor_credit_submitted_at, vendor_credit_notes
        `;
        updateParams = [status, notes || null, rewardId, merchantId];
    } else {
        // Mark as CREDITED or DENIED - set resolved timestamp
        updateQuery = `
            UPDATE loyalty_rewards
            SET vendor_credit_status = $1,
                vendor_credit_resolved_at = NOW(),
                vendor_credit_notes = COALESCE($2, vendor_credit_notes),
                updated_at = NOW()
            WHERE id = $3 AND merchant_id = $4
            RETURNING id, vendor_credit_status, vendor_credit_submitted_at, vendor_credit_resolved_at, vendor_credit_notes
        `;
        updateParams = [status, notes || null, rewardId, merchantId];
    }

    const result = await db.query(updateQuery, updateParams);

    logger.info('Updated vendor credit status', {
        rewardId,
        merchantId,
        status,
        previousStatus: reward.vendor_credit_status,
        userId: req.session.user.id
    });

    res.json({
        success: true,
        vendorCredit: result.rows[0]
    });
}));

/**
 * GET /api/loyalty/rewards
 * Get rewards with filtering (earned, redeemed, etc.)
 */
router.get('/rewards', requireAuth, requireMerchant, validators.listRewards, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { status, offerId, customerId, limit, offset } = req.query;

    let query = `
        SELECT r.*, o.offer_name, o.brand_name, o.size_group,
               lc.phone_number as customer_phone, lc.display_name as customer_name
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        LEFT JOIN loyalty_customers lc ON r.square_customer_id = lc.square_customer_id AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
    `;
    const params = [merchantId];

    if (status) {
        params.push(status);
        query += ` AND r.status = $${params.length}`;
    }

    if (offerId) {
        params.push(offerId);
        query += ` AND r.offer_id = $${params.length}`;
    }

    if (customerId) {
        params.push(customerId);
        query += ` AND r.square_customer_id = $${params.length}`;
    }

    query += ` ORDER BY r.created_at DESC`;

    params.push(parseInt(limit) || 100);
    query += ` LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);

    res.json({ rewards: result.rows });
}));

/**
 * GET /api/loyalty/redemptions
 * Get redemption history with filtering
 *
 * Migrated from loyalty_redemptions to loyalty_rewards WHERE status = 'redeemed'
 * Joins to loyalty_purchase_events for item info and calculated value
 */
router.get('/redemptions', requireAuth, requireMerchant, validators.listRedemptions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, customerId, startDate, endDate, limit, offset } = req.query;

    // Query redeemed rewards with item details from loyalty_redemptions
    // (the actual redeemed item), falling back to purchase events only
    // when the redemption record has no item name
    let query = `
        SELECT
            r.id,
            r.merchant_id,
            r.offer_id,
            r.square_customer_id,
            r.redeemed_at,
            r.redemption_order_id as square_order_id,
            -- Vendor credit tracking
            r.vendor_credit_status,
            r.vendor_credit_submitted_at,
            r.vendor_credit_resolved_at,
            o.offer_name,
            o.brand_name,
            o.size_group,
            lc.phone_number as customer_phone,
            lc.display_name as customer_name,
            -- Redeemed item: prefer redemption record, fall back to purchase events
            COALESCE(lr.redeemed_item_name, pe_info.item_name) as redeemed_item_name,
            COALESCE(lr.redeemed_variation_name, pe_info.variation_name) as redeemed_variation_name,
            COALESCE(lr.redeemed_variation_id, pe_info.variation_id) as redeemed_variation_id,
            COALESCE(lr.redeemed_value_cents, pe_info.avg_price) as redeemed_value_cents,
            -- Get source from processed orders (WEBHOOK, CATCHUP_JOB, BACKFILL)
            COALESCE(lpo.source, 'WEBHOOK') as redemption_type
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        LEFT JOIN loyalty_redemptions lr
            ON r.redemption_id = lr.id
        LEFT JOIN LATERAL (
            SELECT
                lqv.item_name,
                lqv.variation_name,
                pe.variation_id,
                AVG(pe.unit_price_cents) FILTER (WHERE pe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events pe
            LEFT JOIN loyalty_qualifying_variations lqv
                ON pe.variation_id = lqv.variation_id AND pe.offer_id = lqv.offer_id
            WHERE pe.reward_id = r.id
            GROUP BY lqv.item_name, lqv.variation_name, pe.variation_id
            LIMIT 1
        ) pe_info ON true
        LEFT JOIN loyalty_processed_orders lpo
            ON r.redemption_order_id = lpo.square_order_id
            AND r.merchant_id = lpo.merchant_id
        WHERE r.merchant_id = $1
          AND r.status = 'redeemed'
    `;
    const params = [merchantId];

    if (offerId) {
        params.push(offerId);
        query += ` AND r.offer_id = $${params.length}`;
    }

    if (customerId) {
        params.push(customerId);
        query += ` AND r.square_customer_id = $${params.length}`;
    }

    if (startDate) {
        params.push(startDate);
        query += ` AND r.redeemed_at >= $${params.length}`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND r.redeemed_at <= $${params.length}`;
    }

    query += ` ORDER BY r.redeemed_at DESC`;

    params.push(parseInt(limit) || 100);
    query += ` LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);

    res.json({ redemptions: result.rows });
}));

module.exports = router;
