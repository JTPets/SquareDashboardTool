/**
 * Square Sync Service
 *
 * Orchestrates syncing earned rewards to Square POS and queries
 * for pending/synced reward counts.
 *
 * Extracted from routes/loyalty/square-integration.js (A-18)
 * — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - syncRewardsToPOS loops through rewards sequentially (could be batched)
 * - getRewardForSquareSync and linkOfferToSquareTier have simple inline SQL
 *   that could eventually live in offer-admin-service / reward-service
 * - getPendingSyncCounts runs 2 separate COUNT queries (could be 1 query)
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const {
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount
} = require('./square-discount-service');

/**
 * Link an offer to a Square Loyalty reward tier.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} params.offerId - Offer ID
 * @param {string|null} params.squareRewardTierId - Square reward tier ID (or null to unlink)
 * @returns {Promise<Object|null>} Updated offer or null if not found
 */
async function linkOfferToSquareTier({ merchantId, offerId, squareRewardTierId }) {
    if (!merchantId) {
        throw new Error('merchantId is required for linkOfferToSquareTier - tenant isolation required');
    }

    const result = await db.query(
        `UPDATE loyalty_offers
         SET square_reward_tier_id = $1, updated_at = NOW()
         WHERE id = $2 AND merchant_id = $3
         RETURNING id, offer_name, square_reward_tier_id`,
        [squareRewardTierId || null, offerId, merchantId]
    );

    return result.rows[0] || null;
}

/**
 * Get a reward with offer details for Square sync.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} params.rewardId - Reward ID
 * @returns {Promise<Object|null>} Reward with offer_name or null
 */
async function getRewardForSquareSync({ merchantId, rewardId }) {
    if (!merchantId) {
        throw new Error('merchantId is required for getRewardForSquareSync - tenant isolation required');
    }

    const result = await db.query(
        `SELECT r.*, o.offer_name
         FROM loyalty_rewards r
         JOIN loyalty_offers o ON r.offer_id = o.id
         WHERE r.id = $1 AND r.merchant_id = $2`,
        [rewardId, merchantId]
    );

    return result.rows[0] || null;
}

/**
 * Bulk sync earned rewards to Square POS.
 * Creates Customer Group Discounts for earned rewards.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {boolean} [params.force=false] - Re-sync ALL earned rewards
 * @returns {Promise<Object>} Sync results
 */
async function syncRewardsToPOS({ merchantId, force = false }) {
    if (!merchantId) {
        throw new Error('merchantId is required for syncRewardsToPOS - tenant isolation required');
    }

    // Find earned rewards to sync
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
        return {
            success: true,
            message: force ? 'No earned rewards to re-sync' : 'All earned rewards are already synced to POS',
            synced: 0
        };
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
                await cleanupSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId: reward.square_customer_id,
                    internalRewardId: reward.id
                });
            }

            const result = await createSquareCustomerGroupDiscount({
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

    return {
        success: true,
        message: `Synced ${successCount} of ${pending.length} rewards to Square POS`,
        synced: successCount,
        total: pending.length,
        results
    };
}

/**
 * Get count of pending and synced earned rewards.
 *
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} { pendingCount, syncedCount }
 */
async function getPendingSyncCounts(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getPendingSyncCounts - tenant isolation required');
    }

    const pendingResult = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND (square_group_id IS NULL OR square_discount_id IS NULL)
    `, [merchantId]);

    const syncedResult = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND square_group_id IS NOT NULL
          AND square_discount_id IS NOT NULL
    `, [merchantId]);

    return {
        pendingCount: parseInt(pendingResult.rows[0].count, 10),
        syncedCount: parseInt(syncedResult.rows[0].count, 10)
    };
}

module.exports = {
    linkOfferToSquareTier,
    getRewardForSquareSync,
    syncRewardsToPOS,
    getPendingSyncCounts
};
