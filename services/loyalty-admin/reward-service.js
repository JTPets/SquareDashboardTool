/**
 * Loyalty Reward Service
 *
 * Handles reward redemption and detection:
 * - redeemReward: Mark earned rewards as redeemed
 * - detectRewardRedemptionFromOrder: Auto-detect redemptions from order discounts
 * - createSquareLoyaltyReward: Legacy redirect to Customer Group Discount
 *
 * Extracted from loyalty-service.js and square-discount-service.js as part of
 * final P1-1 monolith elimination.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { RewardStatus, AuditActions, RedemptionTypes } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const {
    cleanupSquareCustomerGroupDiscount,
    createSquareCustomerGroupDiscount
} = require('./square-discount-service');

// Import from purchase-service.js (sibling)
const { updateCustomerSummary } = require('./purchase-service');

// ============================================================================
// REWARD REDEMPTION
// ============================================================================

/**
 * Redeem an earned reward
 * BUSINESS RULES:
 * - Full redemption only (no partials)
 * - Same size group as earned
 * - One reward = one free unit
 *
 * @param {Object} redemptionData - Redemption details
 */
async function redeemReward(redemptionData) {
    const {
        merchantId, rewardId, squareOrderId, squareCustomerId,
        redemptionType, redeemedVariationId, redeemedValueCents,
        redeemedByUserId, adminNotes, squareLocationId
    } = redemptionData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Get and lock the reward
        const rewardResult = await client.query(`
            SELECT r.*, o.brand_name, o.size_group, o.offer_name
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.id = $1 AND r.merchant_id = $2
            FOR UPDATE
        `, [rewardId, merchantId]);

        const reward = rewardResult.rows[0];

        if (!reward) {
            throw new Error('Reward not found or access denied');
        }

        if (reward.status !== RewardStatus.EARNED) {
            throw new Error(`Cannot redeem reward in status: ${reward.status}`);
        }

        // Verify customer matches
        if (squareCustomerId && reward.square_customer_id !== squareCustomerId) {
            throw new Error('Customer ID mismatch - cannot redeem reward for different customer');
        }

        // Get variation details for redemption record
        let itemName = null;
        let variationName = null;

        if (redeemedVariationId) {
            const varResult = await client.query(`
                SELECT item_name, variation_name
                FROM loyalty_qualifying_variations
                WHERE variation_id = $1 AND merchant_id = $2
            `, [redeemedVariationId, merchantId]);

            if (varResult.rows[0]) {
                itemName = varResult.rows[0].item_name;
                variationName = varResult.rows[0].variation_name;
            }
        }

        // LEGACY: Remove after migration - modern reward-service.js doesn't use this table
        // Create redemption record in legacy table (kept for backward compatibility)
        const redemptionResult = await client.query(`
            INSERT INTO loyalty_redemptions (
                merchant_id, reward_id, offer_id, square_customer_id,
                redemption_type, square_order_id, square_location_id,
                redeemed_variation_id, redeemed_item_name, redeemed_variation_name,
                redeemed_value_cents, redeemed_by_user_id, admin_notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            merchantId, rewardId, reward.offer_id, reward.square_customer_id,
            redemptionType || RedemptionTypes.ORDER_DISCOUNT, squareOrderId, squareLocationId,
            redeemedVariationId, itemName, variationName,
            redeemedValueCents, redeemedByUserId, adminNotes
        ]);

        const redemption = redemptionResult.rows[0];

        // Update reward status
        await client.query(`
            UPDATE loyalty_rewards
            SET status = 'redeemed',
                redeemed_at = NOW(),
                redemption_id = $1,
                redemption_order_id = $2,
                updated_at = NOW()
            WHERE id = $3
        `, [redemption.id, squareOrderId, rewardId]);

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_REDEEMED,
            offerId: reward.offer_id,
            rewardId,
            redemptionId: redemption.id,
            squareCustomerId: reward.square_customer_id,
            squareOrderId,
            oldState: RewardStatus.EARNED,
            newState: RewardStatus.REDEEMED,
            triggeredBy: redeemedByUserId ? 'ADMIN' : 'SYSTEM',
            userId: redeemedByUserId,
            details: {
                redemptionType,
                redeemedVariationId,
                redeemedValueCents
            }
        }, client);  // Pass transaction client to avoid deadlock

        // Update customer summary
        await updateCustomerSummary(client, merchantId, reward.square_customer_id, reward.offer_id);

        await client.query('COMMIT');

        // Clean up Square discount objects (outside transaction - non-critical)
        try {
            await cleanupSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: rewardId
            });
        } catch (cleanupErr) {
            // Log but don't fail - the redemption was successful
            logger.warn('Failed to cleanup Square discount after redemption', {
                error: cleanupErr.message,
                rewardId
            });
        }

        logger.info('Reward redeemed successfully', {
            merchantId,
            rewardId,
            redemptionId: redemption.id,
            squareCustomerId: reward.square_customer_id
        });

        return {
            success: true,
            redemption,
            reward: { ...reward, status: RewardStatus.REDEEMED }
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to redeem reward', {
            error: error.message,
            merchantId,
            rewardId
        });
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// REWARD DETECTION (moved from square-discount-service.js)
// ============================================================================

/**
 * Detect if an order contains a redemption of one of our loyalty rewards
 * This is called during order processing to auto-mark rewards as redeemed
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} Result with redeemed reward info if found
 */
async function detectRewardRedemptionFromOrder(order, merchantId) {
    try {
        const discounts = order.discounts || [];
        if (discounts.length === 0) {
            return { detected: false };
        }

        // Look for any of our reward discounts in the order
        for (const discount of discounts) {
            const catalogObjectId = discount.catalog_object_id;
            if (!catalogObjectId) continue;

            // Check if this discount matches any of our earned rewards
            // Check BOTH square_discount_id AND square_pricing_rule_id because Square
            // may reference either one in the order discount depending on how it was applied
            const rewardResult = await db.query(`
                SELECT r.*, o.offer_name
                FROM loyalty_rewards r
                JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.merchant_id = $1
                  AND (r.square_discount_id = $2 OR r.square_pricing_rule_id = $2)
                  AND r.status = 'earned'
            `, [merchantId, catalogObjectId]);

            if (rewardResult.rows.length > 0) {
                const reward = rewardResult.rows[0];

                logger.info('Detected reward redemption from order', {
                    merchantId,
                    orderId: order.id,
                    rewardId: reward.id,
                    discountId: catalogObjectId
                });

                // Redeem the reward (now a direct call, no lazy require needed)
                const redemptionResult = await redeemReward({
                    merchantId,
                    rewardId: reward.id,
                    squareOrderId: order.id,
                    squareCustomerId: order.customer_id,
                    redemptionType: RedemptionTypes.AUTO_DETECTED,
                    redeemedValueCents: Number(discount.applied_money?.amount || 0),
                    squareLocationId: order.location_id
                });

                return {
                    detected: true,
                    rewardId: reward.id,
                    offerName: reward.offer_name,
                    redemptionResult
                };
            }
        }

        return { detected: false };

    } catch (error) {
        logger.error('Error detecting reward redemption', {
            error: error.message,
            orderId: order?.id,
            merchantId
        });
        return { detected: false, error: error.message };
    }
}

// ============================================================================
// LEGACY REDIRECT (moved from square-discount-service.js)
// ============================================================================

/**
 * Legacy function for backward compatibility - now uses Customer Group Discounts
 * Keep the old name for any existing code references, but redirect to new implementation
 */
async function createSquareLoyaltyReward({ merchantId, squareCustomerId, internalRewardId, offerId }) {
    logger.info('createSquareLoyaltyReward called - redirecting to Customer Group Discount approach');
    return createSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId, offerId });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    redeemReward,
    detectRewardRedemptionFromOrder,
    createSquareLoyaltyReward
};
