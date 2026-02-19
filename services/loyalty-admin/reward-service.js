/**
 * Loyalty Reward Service
 *
 * Handles reward redemption and detection:
 * - redeemReward: Mark earned rewards as redeemed
 * - detectRewardRedemptionFromOrder: Auto-detect redemptions from order discounts
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
    cleanupSquareCustomerGroupDiscount
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
        redeemedByUserId, adminNotes, squareLocationId, redeemedAt
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
                redeemed_value_cents, redeemed_by_user_id, admin_notes,
                redeemed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                    COALESCE($14, NOW()))
            RETURNING *
        `, [
            merchantId, rewardId, reward.offer_id, reward.square_customer_id,
            redemptionType || RedemptionTypes.ORDER_DISCOUNT, squareOrderId, squareLocationId,
            redeemedVariationId, itemName, variationName,
            redeemedValueCents, redeemedByUserId, adminNotes,
            redeemedAt || null
        ]);

        const redemption = redemptionResult.rows[0];

        // Update reward status
        const effectiveRedeemedAt = redeemedAt || null;
        await client.query(`
            UPDATE loyalty_rewards
            SET status = 'redeemed',
                redeemed_at = COALESCE($1, NOW()),
                redemption_id = $2,
                redemption_order_id = $3,
                updated_at = NOW()
            WHERE id = $4
        `, [effectiveRedeemedAt, redemption.id, squareOrderId, rewardId]);

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
async function matchEarnedRewardByFreeItem(order, merchantId, { squareCustomerId: customerIdOverride } = {}) {
    // Use provided customer ID or extract from order
    let customerId = customerIdOverride || order.customer_id;
    if (!customerId && order.tenders) {
        for (const tender of order.tenders) {
            if (tender.customer_id) {
                customerId = tender.customer_id;
                break;
            }
        }
    }
    if (!customerId) {
        logger.info('Strategy 2: no customer ID on order, skipping', {
            orderId: order.id, merchantId
        });
        return null;
    }

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

    // DIAGNOSTIC: Log free item identification
    logger.info('Strategy 2: free item scan', {
        orderId: order.id,
        merchantId,
        customerId,
        lineItemCount: lineItems.length,
        freeVariationIds,
        lineItemDetails: lineItems.map(li => ({
            name: li.name,
            catalog_object_id: li.catalog_object_id || null,
            base_price_amount: li.base_price_money?.amount,
            total_money_amount: li.total_money?.amount,
            isFree: Number(li.base_price_money?.amount || 0) > 0
                && (li.total_money?.amount != null ? Number(li.total_money.amount) : Number(li.base_price_money?.amount || 0)) === 0
        }))
    });

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

    // DIAGNOSTIC: No match — query qualifying variations without the reward
    // join to isolate which condition is failing
    try {
        const diagResult = await db.query(`
            SELECT qv.variation_id, qv.offer_id, qv.is_active AS qv_active,
                   o.offer_name, o.is_active AS offer_active
            FROM loyalty_qualifying_variations qv
            LEFT JOIN loyalty_offers o ON qv.offer_id = o.id AND qv.merchant_id = o.merchant_id
            WHERE qv.merchant_id = $1
              AND qv.variation_id = ANY($2)
        `, [merchantId, freeVariationIds]);

        if (diagResult.rows.length === 0) {
            logger.warn('Strategy 2: no qualifying variations found for free item IDs', {
                orderId: order.id, merchantId, freeVariationIds
            });
        } else {
            // Check earned rewards for the offers found
            const offerIds = [...new Set(diagResult.rows.map(r => r.offer_id))];
            const rewardCheck = await db.query(`
                SELECT id AS reward_id, offer_id, square_customer_id, status
                FROM loyalty_rewards
                WHERE merchant_id = $1
                  AND offer_id = ANY($2)
                  AND square_customer_id = $3
            `, [merchantId, offerIds, customerId]);

            logger.warn('Strategy 2: free items found but no match — diagnostic', {
                orderId: order.id,
                merchantId,
                customerId,
                freeVariationIds,
                qualifyingVariations: diagResult.rows.map(r => ({
                    variation_id: r.variation_id,
                    offer_id: r.offer_id,
                    offer_name: r.offer_name,
                    qv_active: r.qv_active,
                    offer_active: r.offer_active
                })),
                customerRewards: rewardCheck.rows.map(r => ({
                    reward_id: r.reward_id,
                    offer_id: r.offer_id,
                    square_customer_id: r.square_customer_id,
                    status: r.status
                }))
            });
        }
    } catch (_) { /* diagnostic only — don't break detection */ }

    return null;
}

/**
 * Strategy 3: Match earned reward by total discount amount on qualifying variations.
 *
 * When a pricing rule auto-applies a FIXED_AMOUNT catalog discount that gets spread
 * across multiple qualifying items, no single item ends up $0, so Strategy 2 (free
 * item fallback) misses it. This strategy sums total_discount_money on qualifying
 * variations and compares against the expected reward value (highest unit price from
 * purchase events linked to the reward).
 *
 * 95% threshold handles rounding when Square distributes FIXED_AMOUNT across items.
 *
 * @param {Object} params
 * @param {Object} params.order - Square order object (normalized to snake_case)
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Match info or null
 */
async function matchEarnedRewardByDiscountAmount({ order, squareCustomerId, merchantId }) {
    if (!squareCustomerId) return null;

    // Get all earned rewards for this customer, with qualifying variations
    const earnedResult = await db.query(`
        SELECT r.id AS reward_id, r.offer_id, r.square_customer_id, o.offer_name,
               ARRAY_AGG(qv.variation_id) AS qualifying_variation_ids
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id AND r.merchant_id = o.merchant_id
        JOIN loyalty_qualifying_variations qv ON qv.offer_id = o.id
            AND qv.merchant_id = o.merchant_id AND qv.is_active = TRUE
        WHERE r.merchant_id = $1
          AND r.square_customer_id = $2
          AND r.status = 'earned'
          AND o.is_active = TRUE
        GROUP BY r.id, r.offer_id, r.square_customer_id, o.offer_name
    `, [merchantId, squareCustomerId]);

    if (earnedResult.rows.length === 0) return null;

    const lineItems = order.line_items || [];

    for (const reward of earnedResult.rows) {
        const qualifyingSet = new Set(reward.qualifying_variation_ids);

        // Sum total_discount_money on qualifying line items
        let totalDiscountCents = 0;
        for (const lineItem of lineItems) {
            const variationId = lineItem.catalog_object_id;
            if (!variationId || !qualifyingSet.has(variationId)) continue;

            const discountAmount = Number(lineItem.total_discount_money?.amount || 0);
            totalDiscountCents += discountAmount;
        }

        if (totalDiscountCents <= 0) continue;

        // Get expected reward value: MAX(unit_price_cents) from purchase events
        const priceResult = await db.query(`
            SELECT COALESCE(
                (SELECT MAX(unit_price_cents) FROM loyalty_purchase_events
                 WHERE reward_id = $1 AND merchant_id = $2 AND unit_price_cents > 0),
                (SELECT MAX(unit_price_cents) FROM loyalty_purchase_events
                 WHERE offer_id = $3 AND merchant_id = $2 AND unit_price_cents > 0),
                0
            ) AS expected_value_cents
        `, [reward.reward_id, merchantId, reward.offer_id]);

        const expectedValueCents = parseInt(priceResult.rows[0].expected_value_cents, 10) || 0;
        if (expectedValueCents <= 0) continue;

        // Match if total discount >= 95% of expected value (handles rounding)
        if (totalDiscountCents >= expectedValueCents * 0.95) {
            logger.info('Matched earned reward via discount-amount fallback', {
                action: 'REDEMPTION_DISCOUNT_AMOUNT_MATCH',
                orderId: order.id,
                rewardId: reward.reward_id,
                offerId: reward.offer_id,
                offerName: reward.offer_name,
                totalDiscountCents,
                expectedValueCents,
                ratio: (totalDiscountCents / expectedValueCents).toFixed(3),
                customerId: squareCustomerId,
                merchantId
            });

            return {
                reward_id: reward.reward_id,
                offer_id: reward.offer_id,
                square_customer_id: reward.square_customer_id,
                offer_name: reward.offer_name,
                totalDiscountCents,
                expectedValueCents
            };
        }
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
 * 3. Fallback: match total discount amount on qualifying variations to expected reward value
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.dryRun=false] - If true, detect only — do not redeem
 * @param {string} [options.squareCustomerId] - Override customer ID (for orders missing customer_id)
 * @returns {Promise<Object>} Result with redeemed reward info if found
 */
async function detectRewardRedemptionFromOrder(order, merchantId, { dryRun = false, squareCustomerId: customerIdOverride } = {}) {
    try {
        const discounts = order.discounts || [];

        // Use provided customer ID or extract from order
        const squareCustomerId = customerIdOverride
            || order.customer_id
            || (order.tenders || []).find(t => t.customer_id)?.customer_id;
        logger.info('Redemption detection: scanning order discounts', {
            orderId: order.id,
            squareCustomerId,
            discountCount: discounts.length,
            discounts: discounts.map(d => ({
                uid: d.uid,
                name: d.name,
                type: d.type,
                catalog_object_id: d.catalog_object_id || null,
                pricing_rule_id: d.pricing_rule_id || null,
                applied_money: d.applied_money,
                scope: d.scope
            }))
        });

        // Strategy 1: Match by catalog_object_id (exact discount ID match)
        if (discounts.length > 0) {
            for (const discount of discounts) {
                const catalogObjectId = discount.catalog_object_id;

                // DIAGNOSTIC: Log each discount evaluation (remove after issue confirmed resolved)
                logger.info('Redemption detection: evaluating discount', {
                    orderId: order.id,
                    discountUid: discount.uid,
                    catalogObjectId: catalogObjectId || 'NONE (manual/ad-hoc)',
                    pricingRuleId: discount.pricing_rule_id || 'NONE',
                    discountName: discount.name,
                    discountType: discount.type,
                    appliedMoney: discount.applied_money,
                    skipped: !catalogObjectId
                });

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

                // DIAGNOSTIC: Log reward lookup results (remove after issue confirmed resolved)
                logger.info('Redemption detection: reward lookup', {
                    orderId: order.id,
                    catalogObjectId,
                    pricingRuleId: discount.pricing_rule_id || null,
                    matchedRewardId: rewardResult.rows[0]?.id || null,
                    matchedBy: rewardResult.rows.length > 0 ? 'catalog_id' : 'none',
                    earnedRewardsFound: rewardResult.rows.length
                });

                if (rewardResult.rows.length > 0) {
                    const reward = rewardResult.rows[0];

                    logger.info('Detected reward redemption from order', {
                        merchantId,
                        orderId: order.id,
                        rewardId: reward.id,
                        discountId: catalogObjectId,
                        detectionMethod: 'catalog_object_id',
                        dryRun
                    });

                    let redemptionResult;
                    if (!dryRun) {
                        redemptionResult = await redeemReward({
                            merchantId,
                            rewardId: reward.id,
                            squareOrderId: order.id,
                            squareCustomerId: order.customer_id,
                            redemptionType: RedemptionTypes.AUTO_DETECTED,
                            redeemedValueCents: Number(discount.applied_money?.amount || 0),
                            squareLocationId: order.location_id
                        });
                    }

                    return {
                        detected: true,
                        rewardId: reward.id,
                        offerId: reward.offer_id,
                        offerName: reward.offer_name,
                        squareCustomerId: reward.square_customer_id,
                        redemptionResult,
                        detectionMethod: 'catalog_object_id',
                        discountDetails: {
                            catalogObjectId,
                            appliedMoney: discount.applied_money
                        }
                    };
                }
            }
        }

        // Strategy 2: Fallback — match free items to earned rewards
        // Catches manual discounts, re-applied discounts, migrated discount objects
        const freeItemMatch = await matchEarnedRewardByFreeItem(order, merchantId, { squareCustomerId });
        if (freeItemMatch) {
            logger.info('Detected reward redemption via free item fallback', {
                merchantId,
                orderId: order.id,
                rewardId: freeItemMatch.reward_id,
                matchedVariationId: freeItemMatch.matched_variation_id,
                detectionMethod: 'free_item_fallback',
                dryRun
            });

            let redemptionResult;
            if (!dryRun) {
                redemptionResult = await redeemReward({
                    merchantId,
                    rewardId: freeItemMatch.reward_id,
                    squareOrderId: order.id,
                    squareCustomerId: freeItemMatch.square_customer_id,
                    redemptionType: RedemptionTypes.AUTO_DETECTED,
                    redeemedVariationId: freeItemMatch.matched_variation_id,
                    squareLocationId: order.location_id
                });
            }

            return {
                detected: true,
                rewardId: freeItemMatch.reward_id,
                offerId: freeItemMatch.offer_id,
                offerName: freeItemMatch.offer_name,
                squareCustomerId: freeItemMatch.square_customer_id,
                redemptionResult,
                detectionMethod: 'free_item_fallback',
                discountDetails: {
                    matchedVariationId: freeItemMatch.matched_variation_id
                }
            };
        }

        // Strategy 3: Match by total discount amount on qualifying variations
        const discountAmountMatch = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId, merchantId
        });
        if (discountAmountMatch) {
            logger.info('Reward redemption detected via discount-amount fallback (Strategy 3)', {
                rewardId: discountAmountMatch.reward_id,
                totalDiscountCents: discountAmountMatch.totalDiscountCents,
                expectedValueCents: discountAmountMatch.expectedValueCents,
                orderId: order.id,
                merchantId,
                dryRun
            });

            let redemptionResult;
            if (!dryRun) {
                redemptionResult = await redeemReward({
                    merchantId,
                    rewardId: discountAmountMatch.reward_id,
                    squareOrderId: order.id,
                    squareCustomerId: discountAmountMatch.square_customer_id,
                    redemptionType: RedemptionTypes.AUTO_DETECTED,
                    redeemedValueCents: discountAmountMatch.totalDiscountCents,
                    squareLocationId: order.location_id
                });
            }

            return {
                detected: true,
                rewardId: discountAmountMatch.reward_id,
                offerId: discountAmountMatch.offer_id,
                offerName: discountAmountMatch.offer_name,
                squareCustomerId: discountAmountMatch.square_customer_id,
                redemptionResult,
                detectionMethod: 'discount_amount_fallback',
                discountDetails: {
                    totalDiscountCents: discountAmountMatch.totalDiscountCents,
                    expectedCents: discountAmountMatch.expectedValueCents
                }
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
// EXPORTS
// ============================================================================

module.exports = {
    redeemReward,
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount
};
