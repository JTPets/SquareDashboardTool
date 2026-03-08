/**
 * Square Sync Retry Service (LA-4 fix)
 *
 * Retries Square discount creation for earned rewards where the initial
 * fire-and-forget call to createSquareCustomerGroupDiscount() failed.
 *
 * Rewards are flagged with square_sync_pending = TRUE by
 * reward-progress-service.js when discount creation fails.
 * This service finds those rewards and retries the operation.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { createSquareCustomerGroupDiscount } = require('./square-discount-service');

/**
 * Retry Square discount creation for all pending rewards for a merchant.
 *
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} { retried, succeeded, failed, errors }
 */
async function retryPendingSquareSyncs(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for retryPendingSquareSyncs');
    }

    const result = await db.query(`
        SELECT id, square_customer_id, offer_id
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND square_sync_pending = TRUE
    `, [merchantId]);

    const pending = result.rows;

    if (pending.length === 0) {
        return { retried: 0, succeeded: 0, failed: 0, errors: [] };
    }

    logger.info('Retrying pending Square syncs', {
        merchantId,
        pendingCount: pending.length
    });

    let succeeded = 0;
    let failed = 0;
    const errors = [];

    for (const reward of pending) {
        try {
            const syncResult = await createSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: reward.id,
                offerId: reward.offer_id
            });

            if (syncResult.success) {
                await db.query(
                    `UPDATE loyalty_rewards
                     SET square_sync_pending = FALSE, updated_at = NOW()
                     WHERE id = $1 AND merchant_id = $2`,
                    [reward.id, merchantId]
                );
                succeeded++;
                logger.info('Square sync retry succeeded', {
                    merchantId,
                    rewardId: reward.id,
                    groupId: syncResult.groupId,
                    discountId: syncResult.discountId
                });
            } else {
                failed++;
                errors.push({
                    rewardId: reward.id,
                    error: syncResult.error
                });
                logger.error('Square sync retry failed', {
                    merchantId,
                    rewardId: reward.id,
                    error: syncResult.error
                });
            }
        } catch (err) {
            failed++;
            errors.push({
                rewardId: reward.id,
                error: err.message
            });
            logger.error('Square sync retry threw', {
                merchantId,
                rewardId: reward.id,
                error: err.message
            });
        }
    }

    logger.info('Square sync retry batch complete', {
        merchantId,
        retried: pending.length,
        succeeded,
        failed
    });

    return {
        retried: pending.length,
        succeeded,
        failed,
        errors
    };
}

module.exports = {
    retryPendingSquareSyncs
};
