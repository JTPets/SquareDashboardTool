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
 * Fallback: match free (100% discounted) line items to earned rewards.
 *
 * Used when catalog_object_id matching fails — e.g. staff applied a manual
 * discount, auto-discount was removed and re-applied, or discount objects
 * were recreated during migration.
 *
 * Uses the same "isFree" logic as the Order History Audit in backfill-service:
 *   base_price > 0 AND total_money === 0
 *
 * Requires the order's customer to have an earned reward whose qualifying
 * variations include the free item's variation.
 *
 * @param {Object} order - Square order object (normalized to snake_case)
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Match info or null
 */
async function matchEarnedRewardByFreeItem(order, merchantId) {
    // Need customer ID to verify reward ownership
    let customerId = order.customer_id;
    if (!customerId && order.tenders) {
        for (const tender of order.tenders) {
            if (tender.customer_id) {
                customerId = tender.customer_id;
                break;
            }
        }
    }
    if (!customerId) return null;

    const lineItems = order.line_items || [];
    const freeVariationIds = [];

    for (const lineItem of lineItems) {
        const variationId = lineItem.catalog_object_id;
        if (!variationId) continue;

        const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
        // Nullish check preserves 0 (free items have total_money = 0)
        const rawTotalMoney = lineItem.total_money?.amount;
        const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : unitPriceCents;

        if (unitPriceCents > 0 && totalMoneyCents === 0) {
            freeVariationIds.push(variationId);
        }
    }

    if (freeVariationIds.length === 0) return null;

    // Find an earned reward for this customer where one of the free items
    // is a qualifying variation for the reward's offer
    const result = await db.query(`
        SELECT r.id AS reward_id, r.offer_id, r.square_customer_id, o.offer_name,
               qv.variation_id AS matched_variation_id
        FROM loyalty_qualifying_variations qv
        JOIN loyalty_offers o ON qv.offer_id = o.id AND qv.merchant_id = o.merchant_id
        JOIN loyalty_rewards r ON r.offer_id = o.id
            AND r.merchant_id = o.merchant_id
            AND r.status = 'earned'
            AND r.square_customer_id = $3
        WHERE qv.merchant_id = $1
          AND qv.variation_id = ANY($2)
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
        LIMIT 1
    `, [merchantId, freeVariationIds, customerId]);

    if (result.rows.length > 0) {
        const match = result.rows[0];
        logger.info('Matched earned reward via free item fallback', {
            action: 'REDEMPTION_FREE_ITEM_MATCH',
            orderId: order.id,
            rewardId: match.reward_id,
            offerId: match.offer_id,
            offerName: match.offer_name,
            matchedVariationId: match.matched_variation_id,
            customerId,
            merchantId
        });
        return match;
    }

    return null;
}

/**
 * Detect if an order contains a redemption of one of our loyalty rewards
 * This is called during order processing to auto-mark rewards as redeemed
 *
 * Detection strategy (in priority order):
 * 1. Match order discount catalog_object_id to stored square_discount_id/pricing_rule_id
 * 2. Fallback: match 100% discounted line items to earned rewards via qualifying variations
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} Result with redeemed reward info if found
 */
async function detectRewardRedemptionFromOrder(order, merchantId) {
    try {
        const discounts = order.discounts || [];

        // Strategy 1: Match by catalog_object_id (exact discount ID match)
        if (discounts.length > 0) {
            for (const discount of discounts) {
                const catalogObjectId = discount.catalog_object_id;
                if (!catalogObjectId) continue;

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
                        discountId: catalogObjectId,
                        detectionMethod: 'catalog_object_id'
                    });

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
                        redemptionResult,
                        detectionMethod: 'catalog_object_id'
                    };
                }
            }
        }

        // Strategy 2: Fallback — match free items to earned rewards
        // Catches manual discounts, re-applied discounts, migrated discount objects
        const freeItemMatch = await matchEarnedRewardByFreeItem(order, merchantId);
        if (freeItemMatch) {
            logger.info('Detected reward redemption via free item fallback', {
                merchantId,
                orderId: order.id,
                rewardId: freeItemMatch.reward_id,
                matchedVariationId: freeItemMatch.matched_variation_id,
                detectionMethod: 'free_item_fallback'
            });

            const redemptionResult = await redeemReward({
                merchantId,
                rewardId: freeItemMatch.reward_id,
                squareOrderId: order.id,
                squareCustomerId: freeItemMatch.square_customer_id,
                redemptionType: RedemptionTypes.AUTO_DETECTED,
                redeemedVariationId: freeItemMatch.matched_variation_id,
                squareLocationId: order.location_id
            });

            return {
                detected: true,
                rewardId: freeItemMatch.reward_id,
                offerName: freeItemMatch.offer_name,
                redemptionResult,
                detectionMethod: 'free_item_fallback'
            };
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
    matchEarnedRewardByFreeItem,
    createSquareLoyaltyReward
};
