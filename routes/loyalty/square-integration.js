/**
 * Loyalty Square Integration Routes
 *
 * Square Loyalty program integration and POS sync:
 * - GET /square-program - Get Square Loyalty program and tiers
 * - PUT /offers/:id/square-tier - Link offer to Square reward tier
 * - POST /rewards/:id/create-square-reward - Create Square discount for reward
 * - POST /rewards/sync-to-pos - Bulk sync earned rewards to POS
 * - GET /rewards/pending-sync - Get pending/synced reward counts
 *
 * OBSERVATION LOG:
 * - PUT /offers/:id/square-tier has inline SQL UPDATE (should be in offer-admin-service)
 * - POST /rewards/:id/create-square-reward has inline SQL SELECT (should be in reward-service)
 * - POST /rewards/sync-to-pos has inline SQL SELECT + loop with service calls
 *   (query should be in a service, loop logic is orchestration)
 * - GET /rewards/pending-sync has 2 inline COUNT queries (should be in a sync service)
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
 * GET /api/loyalty/square-program
 * Get the merchant's Square Loyalty program and available reward tiers
 */
router.get('/square-program', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const program = await loyaltyService.getSquareLoyaltyProgram(merchantId);

    if (!program) {
        return res.json({
            hasProgram: false,
            message: 'No Square Loyalty program found. Set up Square Loyalty in your Square Dashboard first.',
            setupUrl: 'https://squareup.com/dashboard/loyalty'
        });
    }

    // Extract reward tiers for configuration UI
    const rewardTiers = (program.reward_tiers || []).map(tier => ({
        id: tier.id,
        name: tier.name,
        points: tier.points,
        definition: tier.definition
    }));

    res.json({
        hasProgram: true,
        programId: program.id,
        programName: program.terminology?.one || 'Loyalty',
        rewardTiers
    });
}));

/**
 * PUT /api/loyalty/offers/:id/square-tier
 * Link an offer to a Square Loyalty reward tier
 */
router.put('/offers/:id/square-tier', requireAuth, requireMerchant, requireWriteAccess, validators.linkSquareTier, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const offerId = req.params.id;
    const { squareRewardTierId } = req.body;

    // Update the offer with the Square reward tier ID
    const result = await db.query(
        `UPDATE loyalty_offers
         SET square_reward_tier_id = $1, updated_at = NOW()
         WHERE id = $2 AND merchant_id = $3
         RETURNING id, offer_name, square_reward_tier_id`,
        [squareRewardTierId || null, offerId, merchantId]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Offer not found' });
    }

    logger.info('Linked offer to Square Loyalty tier', {
        merchantId,
        offerId,
        squareRewardTierId
    });

    res.json({
        success: true,
        offer: result.rows[0]
    });
}));

/**
 * POST /api/loyalty/rewards/:id/create-square-reward
 * Manually create a Square Customer Group Discount for an earned reward
 * This makes the reward auto-apply at Square POS when customer is identified
 *
 * Query params:
 *   force=true - Delete existing discount and recreate (for fixing broken discounts)
 */
router.post('/rewards/:id/create-square-reward', requireAuth, requireMerchant, requireWriteAccess, validators.createSquareReward, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const rewardId = req.params.id;
    const force = req.query.force === 'true' || req.body.force === true;

    // Get the reward details
    const rewardResult = await db.query(
        `SELECT r.*, o.offer_name
         FROM loyalty_rewards r
         JOIN loyalty_offers o ON r.offer_id = o.id
         WHERE r.id = $1 AND r.merchant_id = $2`,
        [rewardId, merchantId]
    );

    if (rewardResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reward not found' });
    }

    const reward = rewardResult.rows[0];

    if (reward.status !== 'earned') {
        return res.status(400).json({ error: 'Reward must be in "earned" status to sync to POS' });
    }

    // Check if already synced (has Customer Group Discount created)
    if (reward.square_group_id && reward.square_discount_id) {
        if (!force) {
            return res.json({
                success: true,
                message: 'Already synced to Square POS',
                groupId: reward.square_group_id,
                discountId: reward.square_discount_id
            });
        }

        // Force mode: cleanup existing discount first
        logger.info('Force re-sync: cleaning up existing Square discount', {
            rewardId,
            merchantId,
            existingGroupId: reward.square_group_id
        });

        await loyaltyService.cleanupSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId: reward.square_customer_id,
            internalRewardId: rewardId
        });
    }

    // Create the Square Customer Group Discount
    const result = await loyaltyService.createSquareCustomerGroupDiscount({
        merchantId,
        squareCustomerId: reward.square_customer_id,
        internalRewardId: rewardId,
        offerId: reward.offer_id
    });

    res.json(result);
}));

/**
 * POST /api/loyalty/rewards/sync-to-pos
 * Bulk sync earned rewards to Square POS
 * Creates Customer Group Discounts for earned rewards
 *
 * Query/Body params:
 *   force=true - Re-sync ALL earned rewards (delete and recreate discounts)
 */
router.post('/rewards/sync-to-pos', requireAuth, requireMerchant, requireWriteAccess, validators.syncToPOS, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const force = req.query.force === 'true' || req.body.force === true;

    // Find earned rewards to sync
    // If force=true, get ALL earned rewards; otherwise only those not yet synced
    let query;
    if (force) {
        query = `
            SELECT r.id, r.square_customer_id, r.offer_id, o.offer_name,
                   r.square_group_id, r.square_discount_id
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.merchant_id = $1
              AND r.status = 'earned'
        `;
    } else {
        query = `
            SELECT r.id, r.square_customer_id, r.offer_id, o.offer_name,
                   r.square_group_id, r.square_discount_id
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.merchant_id = $1
              AND r.status = 'earned'
              AND (r.square_group_id IS NULL OR r.square_discount_id IS NULL)
        `;
    }

    const pendingResult = await db.query(query, [merchantId]);
    const pending = pendingResult.rows;

    if (pending.length === 0) {
        return res.json({
            success: true,
            message: force ? 'No earned rewards to re-sync' : 'All earned rewards are already synced to POS',
            synced: 0
        });
    }

    logger.info('Syncing earned rewards to Square POS', {
        merchantId,
        pendingCount: pending.length,
        force
    });

    const results = [];
    for (const reward of pending) {
        try {
            // If force mode and reward has existing Square objects, clean them up first
            if (force && reward.square_group_id) {
                await loyaltyService.cleanupSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId: reward.square_customer_id,
                    internalRewardId: reward.id
                });
            }

            const result = await loyaltyService.createSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: reward.id,
                offerId: reward.offer_id
            });

            results.push({
                rewardId: reward.id,
                offerName: reward.offer_name,
                success: result.success,
                error: result.error || null
            });
        } catch (err) {
            results.push({
                rewardId: reward.id,
                offerName: reward.offer_name,
                success: false,
                error: err.message
            });
        }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info('Finished syncing rewards to POS', {
        merchantId,
        total: pending.length,
        success: successCount,
        force
    });

    res.json({
        success: true,
        message: `Synced ${successCount} of ${pending.length} rewards to Square POS`,
        synced: successCount,
        total: pending.length,
        results
    });
}));

/**
 * GET /api/loyalty/rewards/pending-sync
 * Get count of earned rewards - both pending sync and already synced
 */
router.get('/rewards/pending-sync', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Get count of pending (not yet synced) rewards
    const pendingResult = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND (square_group_id IS NULL OR square_discount_id IS NULL)
    `, [merchantId]);

    // Get count of synced rewards
    const syncedResult = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND square_group_id IS NOT NULL
          AND square_discount_id IS NOT NULL
    `, [merchantId]);

    res.json({
        pendingCount: parseInt(pendingResult.rows[0].count, 10),
        syncedCount: parseInt(syncedResult.rows[0].count, 10)
    });
}));

module.exports = router;
