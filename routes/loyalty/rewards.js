/**
 * Loyalty Rewards & Redemptions Routes
 *
 * Reward management and redemption history:
 * - POST /rewards/:rewardId/redeem - Redeem a loyalty reward
 * - PATCH /rewards/:rewardId/vendor-credit - Update vendor credit status
 * - GET /rewards - List rewards with filtering
 * - GET /redemptions - Get redemption history with filtering
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
 */
router.patch('/rewards/:rewardId/vendor-credit', requireAuth, requireMerchant, requireWriteAccess, validators.updateVendorCredit, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { rewardId } = req.params;
    const { status, notes } = req.body;

    const vendorCredit = await loyaltyService.updateVendorCreditStatus({
        merchantId,
        rewardId,
        status,
        notes
    });

    logger.info('Updated vendor credit status', {
        rewardId,
        merchantId,
        status,
        userId: req.session.user.id
    });

    res.json({ success: true, vendorCredit });
}));

/**
 * GET /api/loyalty/rewards
 * Get rewards with filtering (earned, redeemed, etc.)
 */
router.get('/rewards', requireAuth, requireMerchant, validators.listRewards, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { status, offerId, customerId, limit, offset } = req.query;

    const rewards = await loyaltyService.getRewards({
        merchantId,
        status,
        offerId,
        customerId,
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });

    res.json({ rewards });
}));

/**
 * GET /api/loyalty/redemptions
 * Get redemption history with filtering
 */
router.get('/redemptions', requireAuth, requireMerchant, validators.listRedemptions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, customerId, startDate, endDate, limit, offset } = req.query;

    const redemptions = await loyaltyService.getRedemptions({
        merchantId,
        offerId,
        customerId,
        startDate,
        endDate,
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });

    res.json({ redemptions });
}));

module.exports = router;
