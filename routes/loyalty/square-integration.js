/**
 * Loyalty Square Integration Routes
 *
 * Square Loyalty program integration and POS sync:
 * - GET /square-program - Get Square Loyalty program and tiers
 * - PUT /offers/:id/square-tier - Link offer to Square reward tier
 * - POST /rewards/:id/create-square-reward - Create Square discount for reward
 * - POST /rewards/sync-to-pos - Bulk sync earned rewards to POS
 * - GET /rewards/pending-sync - Get pending/synced reward counts
 */

const express = require('express');
const router = express.Router();
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

    const offer = await loyaltyService.linkOfferToSquareTier({
        merchantId,
        offerId,
        squareRewardTierId
    });

    if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
    }

    logger.info('Linked offer to Square Loyalty tier', {
        merchantId,
        offerId,
        squareRewardTierId
    });

    res.json({ success: true, offer });
}));

/**
 * POST /api/loyalty/rewards/:id/create-square-reward
 * Manually create a Square Customer Group Discount for an earned reward
 */
router.post('/rewards/:id/create-square-reward', requireAuth, requireMerchant, requireWriteAccess, validators.createSquareReward, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const rewardId = req.params.id;
    const force = req.query.force === 'true' || req.body.force === true;

    const reward = await loyaltyService.getRewardForSquareSync({ merchantId, rewardId });

    if (!reward) {
        return res.status(404).json({ error: 'Reward not found' });
    }

    if (reward.status !== 'earned') {
        return res.status(400).json({ error: 'Reward must be in "earned" status to sync to POS' });
    }

    // Check if already synced
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
 */
router.post('/rewards/sync-to-pos', requireAuth, requireMerchant, requireWriteAccess, validators.syncToPOS, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const force = req.query.force === 'true' || req.body.force === true;

    const result = await loyaltyService.syncRewardsToPOS({ merchantId, force });
    res.json(result);
}));

/**
 * GET /api/loyalty/rewards/pending-sync
 * Get count of earned rewards - both pending sync and already synced
 */
router.get('/rewards/pending-sync', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const counts = await loyaltyService.getPendingSyncCounts(merchantId);
    res.json(counts);
}));

module.exports = router;
