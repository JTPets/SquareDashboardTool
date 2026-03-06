/**
 * Square Reward Service
 *
 * Handles creating Square Customer Group Discounts for individual
 * earned rewards, including force re-sync with cleanup.
 *
 * Extracted from routes/loyalty/square-integration.js (O-9)
 * — moved as-is, no refactoring.
 */

const logger = require('../../utils/logger');
const { getRewardForSquareSync } = require('./square-sync-service');
const {
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount
} = require('./square-discount-service');

/**
 * Create a Square Customer Group Discount for an earned reward.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} params.rewardId - Internal reward ID
 * @param {boolean} [params.force=false] - Force re-sync even if already synced
 * @returns {Promise<Object>} Sync result
 */
async function createSquareReward({ merchantId, rewardId, force = false }) {
    if (!merchantId) {
        throw new Error('merchantId is required for createSquareReward - tenant isolation required');
    }

    const reward = await getRewardForSquareSync({ merchantId, rewardId });

    if (!reward) {
        return { found: false, error: 'Reward not found' };
    }

    if (reward.status !== 'earned') {
        return { found: true, eligible: false, error: 'Reward must be in "earned" status to sync to POS' };
    }

    // Check if already synced
    if (reward.square_group_id && reward.square_discount_id) {
        if (!force) {
            return {
                found: true,
                eligible: true,
                success: true,
                message: 'Already synced to Square POS',
                groupId: reward.square_group_id,
                discountId: reward.square_discount_id
            };
        }

        // Force mode: cleanup existing discount first
        logger.info('Force re-sync: cleaning up existing Square discount', {
            rewardId,
            merchantId,
            existingGroupId: reward.square_group_id
        });

        await cleanupSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId: reward.square_customer_id,
            internalRewardId: rewardId
        });
    }

    const result = await createSquareCustomerGroupDiscount({
        merchantId,
        squareCustomerId: reward.square_customer_id,
        internalRewardId: rewardId,
        offerId: reward.offer_id
    });

    return { found: true, eligible: true, ...result };
}

module.exports = {
    createSquareReward
};
