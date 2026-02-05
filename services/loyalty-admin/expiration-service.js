/**
 * Loyalty Expiration Service
 *
 * Handles expiration processing for loyalty program:
 * - Rolling window expiration (purchases that fall outside the window)
 * - Earned rewards expiration (rewards where all locked purchases expired)
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { cleanupSquareCustomerGroupDiscount } = require('./square-discount-service');

// Lazy require to avoid circular dependency - updateRewardProgress stays in loyalty-service.js
let _loyaltyService = null;
function getLoyaltyService() {
    if (!_loyaltyService) {
        _loyaltyService = require('./loyalty-service');
    }
    return _loyaltyService;
}

/**
 * Process purchases that have expired from the rolling window
 * Recalculates reward progress for affected customers/offers
 *
 * @param {number} merchantId - REQUIRED: Merchant ID for tenant isolation
 * @returns {Promise<Object>} Result with processedCount
 */
async function processExpiredWindowEntries(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    logger.info('Processing expired window entries', { merchantId });

    // Find purchases that have expired from the window and are not locked to a reward
    const expiredResult = await db.query(`
        SELECT DISTINCT offer_id, square_customer_id
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND window_end_date < CURRENT_DATE
          AND reward_id IS NULL
    `, [merchantId]);

    let processedCount = 0;

    const client = await db.pool.connect();
    try {
        for (const row of expiredResult.rows) {
            await client.query('BEGIN');

            // Get the offer
            const offerResult = await client.query(`
                SELECT * FROM loyalty_offers WHERE id = $1
            `, [row.offer_id]);

            if (offerResult.rows[0]) {
                const { updateRewardProgress } = getLoyaltyService();
                await updateRewardProgress(client, {
                    merchantId,
                    offerId: row.offer_id,
                    squareCustomerId: row.square_customer_id,
                    offer: offerResult.rows[0]
                });

                await logAuditEvent({
                    merchantId,
                    action: AuditActions.WINDOW_EXPIRED,
                    offerId: row.offer_id,
                    squareCustomerId: row.square_customer_id,
                    triggeredBy: 'SYSTEM'
                }, client);  // Pass transaction client to avoid deadlock

                processedCount++;
            }

            await client.query('COMMIT');
        }
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error processing expired entries', { error: error.message, stack: error.stack });
        throw error;
    } finally {
        client.release();
    }

    logger.info('Expired window processing complete', { merchantId, processedCount });

    return { processedCount };
}

/**
 * Process earned rewards where all locked purchases have expired
 * Revokes rewards and cleans up Square discount objects
 *
 * @param {number} merchantId - REQUIRED: Merchant ID for tenant isolation
 * @returns {Promise<Object>} Result with processedCount, revokedRewards, cleanedDiscounts
 */
async function processExpiredEarnedRewards(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    logger.info('Processing expired earned rewards', { merchantId });

    // Find earned rewards where the locked purchases have all expired
    // This shouldn't normally happen since purchases are locked when reward is earned,
    // but we check for edge cases or data inconsistencies
    // Uses the offer's window_months to determine expiration (e.g., 12 months for Smack, 18 months for Big Country Raw)
    const expiredRewardsResult = await db.query(`
        SELECT r.*, o.offer_name, o.required_quantity, o.window_months
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1
          AND r.status = 'earned'
          AND r.earned_at < NOW() - (o.window_months || ' months')::INTERVAL
          AND NOT EXISTS (
              SELECT 1 FROM loyalty_purchase_events pe
              WHERE pe.reward_id = r.id
              AND pe.window_end_date >= CURRENT_DATE
          )
    `, [merchantId]);

    const results = {
        processedCount: 0,
        revokedRewards: [],
        cleanedDiscounts: []
    };

    for (const reward of expiredRewardsResult.rows) {
        logger.info('Found expired earned reward', {
            rewardId: reward.id,
            offerName: reward.offer_name,
            earnedAt: reward.earned_at
        });

        // Revoke the reward
        await db.query(`
            UPDATE loyalty_rewards
            SET status = 'revoked',
                revocation_reason = 'Expired - all locked purchases outside window',
                updated_at = NOW()
            WHERE id = $1
        `, [reward.id]);

        // Unlock the purchase events
        await db.query(`
            UPDATE loyalty_purchase_events
            SET reward_id = NULL, updated_at = NOW()
            WHERE reward_id = $1
        `, [reward.id]);

        results.revokedRewards.push({
            rewardId: reward.id,
            offerName: reward.offer_name,
            squareCustomerId: reward.square_customer_id
        });

        // Cleanup Square discount objects
        if (reward.square_discount_id || reward.square_group_id) {
            const cleanupResult = await cleanupSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: reward.id
            });

            if (cleanupResult.success) {
                results.cleanedDiscounts.push({ rewardId: reward.id });
            }
        }

        // Log audit event
        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_REVOKED,
            offerId: reward.offer_id,
            rewardId: reward.id,
            squareCustomerId: reward.square_customer_id,
            triggeredBy: 'EXPIRATION_CLEANUP',
            details: {
                reason: 'All locked purchases expired',
                earnedAt: reward.earned_at
            }
        });

        results.processedCount++;
    }

    logger.info('Expired earned rewards processing complete', {
        merchantId,
        processedCount: results.processedCount
    });

    return results;
}

module.exports = {
    processExpiredWindowEntries,
    processExpiredEarnedRewards
};
