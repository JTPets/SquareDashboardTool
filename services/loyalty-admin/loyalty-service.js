/**
 * Square Loyalty Addon - Frequent Buyer Program Service
 *
 * Implements vendor-defined frequent buyer programs (Astro-style loyalty)
 * where customers earn free items after purchasing a defined quantity.
 *
 * BUSINESS RULES (NON-NEGOTIABLE - Required for vendor reimbursement compliance):
 * - One loyalty offer = one brand + one size group
 * - Qualifying purchases must match EXPLICIT variation IDs
 * - NEVER mix sizes to earn or redeem
 * - Rolling time window from first qualifying purchase
 * - Full redemption only (no partials, no substitutions)
 * - Reward is ALWAYS 1 free unit of same size group
 * - Refunds ALWAYS adjust quantities and may revoke earned rewards
 *
 * ARCHITECTURE NOTE (P1-1 Phase 4):
 * This file contains functions NOT YET extracted to modular services.
 * Extracted modules are imported directly below (NOT through index.js).
 * See index.js for the complete public API.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../loyalty/loyalty-logger');

// ============================================================================
// IMPORTS FROM EXTRACTED MODULES (direct imports, not through index.js)
// ============================================================================

// Constants
const { RewardStatus, AuditActions, RedemptionTypes } = require('./constants');

// Shared utilities
const { fetchWithTimeout, getSquareAccessToken, getSquareApi } = require('./shared-utils');

// Audit
const { logAuditEvent } = require('./audit-service');

// Settings
const { getSetting } = require('./settings-service');

// Variation management
const { getOfferForVariation } = require('./variation-admin-service');

// Customer cache
const { updateCustomerStats } = require('./customer-cache-service');

// Customer lookups
const {
    getCustomerDetails,
    lookupCustomerFromLoyalty,
    lookupCustomerFromFulfillmentRecipient,
    lookupCustomerFromOrderRewards
} = require('./customer-admin-service');

// Square discount operations
const {
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount
} = require('./square-discount-service');

// ============================================================================
// PURCHASE PROCESSING - Core loyalty earning logic
// ============================================================================

/**
 * Process a qualifying purchase from an order
 * This is the main entry point for recording purchases from webhooks
 *
 * BUSINESS RULES:
 * - Only explicitly configured variations qualify
 * - Never mix sizes within an offer
 * - Rolling window from first qualifying purchase
 * - Purchases outside window drop off automatically
 *
 * @param {Object} purchaseData - Purchase details
 * @param {number} purchaseData.merchantId - REQUIRED: Merchant ID
 * @param {string} purchaseData.squareOrderId - Square order ID
 * @param {string} purchaseData.squareCustomerId - Square customer ID
 * @param {string} purchaseData.variationId - Square variation ID
 * @param {number} purchaseData.quantity - Quantity purchased
 * @param {number} [purchaseData.unitPriceCents] - Unit price for audit
 * @param {Date} purchaseData.purchasedAt - Purchase timestamp
 * @param {string} [purchaseData.squareLocationId] - Square location ID
 * @param {string} [purchaseData.receiptUrl] - Square receipt URL from tender
 * @param {string} [purchaseData.customerSource] - How customer was identified: order, tender, loyalty_api, or manual
 * @param {string} [purchaseData.paymentType] - Payment method: CARD, CASH, WALLET, etc.
 * @returns {Promise<Object>} Processing result
 */
async function processQualifyingPurchase(purchaseData) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, purchasedAt, squareLocationId, receiptUrl,
        customerSource = 'order', paymentType = null
    } = purchaseData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    if (!squareCustomerId) {
        logger.debug('Skipping loyalty processing - no customer ID', { squareOrderId });
        return { processed: false, reason: 'no_customer' };
    }

    // Check if variation qualifies for any offer (tenant-scoped)
    const offer = await getOfferForVariation(variationId, merchantId);
    if (!offer) {
        logger.debug('Variation does not qualify for any offer', { variationId, merchantId });
        return { processed: false, reason: 'variation_not_qualifying' };
    }

    // Generate idempotency key to prevent duplicate processing
    const idempotencyKey = `${squareOrderId}:${variationId}:${quantity}`;

    // Check for existing event (idempotency)
    const existingEvent = await db.query(`
        SELECT id FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND idempotency_key = $2
    `, [merchantId, idempotencyKey]);

    if (existingEvent.rows.length > 0) {
        logger.debug('Purchase event already processed (idempotent)', { idempotencyKey });
        return { processed: false, reason: 'already_processed' };
    }

    logger.info('Processing qualifying purchase', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity,
        offerId: offer.id,
        offerName: offer.offer_name
    });

    // Begin transaction for consistency
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Calculate window dates
        const purchaseDate = new Date(purchasedAt);
        const windowEndDate = new Date(purchaseDate);
        windowEndDate.setMonth(windowEndDate.getMonth() + offer.window_months);

        // Get or determine window start date for this customer+offer
        const existingPurchases = await client.query(`
            SELECT MIN(purchased_at) as first_purchase
            FROM loyalty_purchase_events
            WHERE merchant_id = $1
              AND offer_id = $2
              AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE
              AND quantity > 0
        `, [merchantId, offer.id, squareCustomerId]);

        let windowStartDate = purchaseDate;
        if (existingPurchases.rows[0]?.first_purchase) {
            windowStartDate = new Date(existingPurchases.rows[0].first_purchase);
        }

        // Record the purchase event
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, idempotency_key, receipt_url, customer_source, payment_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, quantity, unitPriceCents,
            purchasedAt, windowStartDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0],
            false, idempotencyKey, receiptUrl || null, customerSource, paymentType
        ]);

        const purchaseEvent = eventResult.rows[0];
        if (!purchaseEvent) {
            throw new Error('Failed to insert purchase event - no row returned');
        }

        await logAuditEvent({
            merchantId,
            action: AuditActions.PURCHASE_RECORDED,
            offerId: offer.id,
            purchaseEventId: purchaseEvent.id,
            squareCustomerId,
            squareOrderId,
            newQuantity: quantity,
            triggeredBy: 'WEBHOOK',
            details: { variationId, unitPriceCents }
        }, client);  // Pass transaction client to avoid deadlock

        // Update reward progress
        const rewardResult = await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        await client.query('COMMIT');

        logger.info('Purchase processed successfully', {
            merchantId,
            purchaseEventId: purchaseEvent.id,
            rewardStatus: rewardResult.status,
            currentQuantity: rewardResult.currentQuantity
        });

        return {
            processed: true,
            purchaseEvent,
            reward: rewardResult
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to process qualifying purchase', {
            error: error.message,
            stack: error.stack,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update reward progress for a customer+offer after a purchase or refund
 * Implements the rolling window logic and state machine
 *
 * @param {Object} client - Database client (for transaction)
 * @param {Object} data - Update data
 */
async function updateRewardProgress(client, data) {
    const { merchantId, offerId, squareCustomerId, offer } = data;

    // Calculate current qualifying quantity within the rolling window
    // Only count purchases that haven't been locked into an earned reward
    // and are still within their window
    const quantityResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) as total_quantity
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND window_end_date >= CURRENT_DATE
          AND reward_id IS NULL
    `, [merchantId, offerId, squareCustomerId]);

    const currentQuantity = parseInt(quantityResult.rows[0].total_quantity) || 0;

    // Get or create the in_progress reward
    let rewardResult = await client.query(`
        SELECT * FROM loyalty_rewards
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND status = 'in_progress'
        FOR UPDATE
    `, [merchantId, offerId, squareCustomerId]);

    let reward = rewardResult.rows[0];

    if (!reward && currentQuantity > 0) {
        // Create new in_progress reward
        const windowResult = await client.query(`
            SELECT MIN(window_start_date) as start_date, MAX(window_end_date) as end_date
            FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE AND reward_id IS NULL
        `, [merchantId, offerId, squareCustomerId]);

        const windowRow = windowResult.rows[0] || {};
        const { start_date, end_date } = windowRow;

        const newRewardResult = await client.query(`
            INSERT INTO loyalty_rewards (
                merchant_id, offer_id, square_customer_id, status,
                current_quantity, required_quantity,
                window_start_date, window_end_date
            )
            VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7)
            RETURNING *
        `, [
            merchantId, offerId, squareCustomerId,
            currentQuantity, offer.required_quantity,
            start_date, end_date
        ]);

        reward = newRewardResult.rows[0];
    } else if (reward) {
        // Update existing reward
        const oldQuantity = reward.current_quantity;

        await client.query(`
            UPDATE loyalty_rewards
            SET current_quantity = $1, updated_at = NOW()
            WHERE id = $2
        `, [currentQuantity, reward.id]);

        reward.current_quantity = currentQuantity;

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_PROGRESS_UPDATED,
            offerId,
            rewardId: reward.id,
            squareCustomerId,
            oldQuantity,
            newQuantity: currentQuantity,
            triggeredBy: 'SYSTEM'
        }, client);  // Pass transaction client to avoid deadlock
    }

    // Check if reward has been earned
    if (reward && currentQuantity >= offer.required_quantity && reward.status === 'in_progress') {
        // Lock the contributing purchases to this reward
        // PostgreSQL requires a subquery for UPDATE with ORDER BY and LIMIT
        await client.query(`
            UPDATE loyalty_purchase_events
            SET reward_id = $1, updated_at = NOW()
            WHERE id IN (
                SELECT id FROM loyalty_purchase_events
                WHERE merchant_id = $2
                  AND offer_id = $3
                  AND square_customer_id = $4
                  AND window_end_date >= CURRENT_DATE
                  AND reward_id IS NULL
                ORDER BY purchased_at ASC
                LIMIT $5
            )
        `, [reward.id, merchantId, offerId, squareCustomerId, offer.required_quantity]);

        // Transition reward to earned status
        await client.query(`
            UPDATE loyalty_rewards
            SET status = 'earned', earned_at = NOW(), updated_at = NOW()
            WHERE id = $1
        `, [reward.id]);

        reward.status = RewardStatus.EARNED;

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_EARNED,
            offerId,
            rewardId: reward.id,
            squareCustomerId,
            oldState: RewardStatus.IN_PROGRESS,
            newState: RewardStatus.EARNED,
            details: { requiredQuantity: offer.required_quantity }
        }, client);  // Pass transaction client to avoid deadlock

        logger.info('Reward earned!', {
            merchantId,
            rewardId: reward.id,
            squareCustomerId,
            offerName: offer.offer_name
        });

        // Update customer stats (async, don't block)
        updateCustomerStats(squareCustomerId, merchantId, {
            incrementRewards: true,
            hasActiveRewards: true
        }).catch(err => logger.debug('Failed to update customer stats', { error: err.message }));

        // Create Square Customer Group Discount ASYNCHRONOUSLY (fire and forget)
        // This prevents timeout issues when processing multiple rewards
        // Errors are logged - manual sync available via Settings if needed
        createSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId,
            internalRewardId: reward.id,
            offerId
        }).then(squareResult => {
            if (squareResult.success) {
                logger.info('Square discount created for earned reward', {
                    merchantId,
                    rewardId: reward.id,
                    groupId: squareResult.groupId,
                    discountId: squareResult.discountId
                });
            } else {
                // Log failure - reward is still earned, can be synced manually via Settings
                logger.warn('Could not create Square discount - manual sync required', {
                    merchantId,
                    rewardId: reward.id,
                    reason: squareResult.error
                });
            }
        }).catch(err => {
            // Log error but don't fail - reward is earned, can be synced manually
            logger.error('Error creating Square discount - manual sync required', {
                error: err.message,
                merchantId,
                rewardId: reward.id
            });
        });
    }

    // Update customer summary
    await updateCustomerSummary(client, merchantId, squareCustomerId, offerId);

    return {
        rewardId: reward?.id,
        status: reward?.status || 'no_progress',
        currentQuantity,
        requiredQuantity: offer.required_quantity
    };
}

// ============================================================================
// REFUND PROCESSING - Adjusts quantities and may revoke rewards
// ============================================================================

/**
 * Process a refund that affects loyalty purchases
 * BUSINESS RULE: Refunds ALWAYS adjust quantities immediately
 * If a refund causes an earned reward to become invalid, the reward is REVOKED
 *
 * @param {Object} refundData - Refund details
 */
async function processRefund(refundData) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, refundedAt, squareLocationId, originalEventId
    } = refundData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Check if variation qualifies for any offer
    const offer = await getOfferForVariation(variationId, merchantId);
    if (!offer) {
        return { processed: false, reason: 'variation_not_qualifying' };
    }

    const refundQuantity = Math.abs(quantity) * -1;  // Ensure negative
    const idempotencyKey = `refund:${squareOrderId}:${variationId}:${quantity}:${Date.now()}`;

    logger.info('Processing loyalty refund', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        refundQuantity,
        offerId: offer.id
    });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Calculate window dates based on original purchase
        const refundDate = new Date(refundedAt || Date.now());
        const windowEndDate = new Date(refundDate);
        windowEndDate.setMonth(windowEndDate.getMonth() + offer.window_months);

        // Record the refund event
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, original_event_id, idempotency_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $13)
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, refundQuantity, unitPriceCents,
            refundedAt || new Date(), refundDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0], originalEventId, idempotencyKey
        ]);

        const refundEvent = eventResult.rows[0];

        await logAuditEvent({
            merchantId,
            action: AuditActions.REFUND_PROCESSED,
            offerId: offer.id,
            purchaseEventId: refundEvent.id,
            squareCustomerId,
            squareOrderId,
            newQuantity: refundQuantity,
            triggeredBy: 'WEBHOOK',
            details: { variationId, originalEventId }
        }, client);  // Pass transaction client to avoid deadlock

        // Check if this refund affects an earned reward
        const earnedReward = await client.query(`
            SELECT r.*
            FROM loyalty_rewards r
            WHERE r.merchant_id = $1
              AND r.offer_id = $2
              AND r.square_customer_id = $3
              AND r.status = 'earned'
            FOR UPDATE
        `, [merchantId, offer.id, squareCustomerId]);

        if (earnedReward.rows.length > 0) {
            const reward = earnedReward.rows[0];

            // Calculate remaining locked purchases after refund
            const lockedQuantity = await client.query(`
                SELECT COALESCE(SUM(quantity), 0) as total
                FROM loyalty_purchase_events
                WHERE reward_id = $1
            `, [reward.id]);

            const remainingQuantity = parseInt(lockedQuantity.rows[0].total) || 0;

            // If refund causes reward to be invalid, revoke it
            if (remainingQuantity < offer.required_quantity) {
                await client.query(`
                    UPDATE loyalty_rewards
                    SET status = 'revoked',
                        revoked_at = NOW(),
                        revocation_reason = 'Refund reduced qualifying quantity below threshold',
                        updated_at = NOW()
                    WHERE id = $1
                `, [reward.id]);

                // Unlock the purchase events
                await client.query(`
                    UPDATE loyalty_purchase_events
                    SET reward_id = NULL, updated_at = NOW()
                    WHERE reward_id = $1
                `, [reward.id]);

                await logAuditEvent({
                    merchantId,
                    action: AuditActions.REWARD_REVOKED,
                    offerId: offer.id,
                    rewardId: reward.id,
                    squareCustomerId,
                    oldState: RewardStatus.EARNED,
                    newState: RewardStatus.REVOKED,
                    details: {
                        reason: 'refund',
                        remainingQuantity,
                        requiredQuantity: offer.required_quantity
                    }
                }, client);  // Pass transaction client to avoid deadlock

                logger.warn('Earned reward revoked due to refund', {
                    merchantId,
                    rewardId: reward.id,
                    squareCustomerId,
                    remainingQuantity,
                    requiredQuantity: offer.required_quantity
                });

                // Update customer summary after revocation to keep it in sync
                await updateCustomerSummary(client, merchantId, squareCustomerId, offer.id);
            }
        }

        // Update reward progress for any in-progress reward
        await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        await client.query('COMMIT');

        return {
            processed: true,
            refundEvent,
            rewardAffected: earnedReward.rows.length > 0
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to process refund', {
            error: error.message,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// REDEMPTION PROCESSING
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
// CUSTOMER SUMMARY MANAGEMENT
// ============================================================================

/**
 * Update the denormalized customer summary
 * Called after any purchase, refund, or redemption
 */
async function updateCustomerSummary(client, merchantId, squareCustomerId, offerId) {
    // Get current stats
    const stats = await client.query(`
        SELECT
            COALESCE(SUM(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL THEN pe.quantity ELSE 0 END), 0) as current_quantity,
            COALESCE(SUM(CASE WHEN pe.quantity > 0 THEN pe.quantity ELSE 0 END), 0) as lifetime_purchases,
            MAX(pe.purchased_at) as last_purchase,
            MIN(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL THEN pe.window_start_date END) as window_start,
            MAX(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL THEN pe.window_end_date END) as window_end
        FROM loyalty_purchase_events pe
        WHERE pe.merchant_id = $1
          AND pe.offer_id = $2
          AND pe.square_customer_id = $3
    `, [merchantId, offerId, squareCustomerId]);

    const earnedRewards = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'earned'
    `, [merchantId, offerId, squareCustomerId]);

    const redeemedRewards = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'redeemed'
    `, [merchantId, offerId, squareCustomerId]);

    const totalEarned = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
          AND status IN ('earned', 'redeemed')
    `, [merchantId, offerId, squareCustomerId]);

    const offer = await client.query(`
        SELECT required_quantity FROM loyalty_offers WHERE id = $1
    `, [offerId]);

    const s = stats.rows[0];
    const hasEarned = parseInt(earnedRewards.rows[0]?.count || 0) > 0;

    // Get the earned reward ID if exists
    let earnedRewardId = null;
    if (hasEarned) {
        const earnedResult = await client.query(`
            SELECT id FROM loyalty_rewards
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'earned'
            ORDER BY earned_at ASC LIMIT 1
        `, [merchantId, offerId, squareCustomerId]);
        earnedRewardId = earnedResult.rows[0]?.id;
    }

    await client.query(`
        INSERT INTO loyalty_customer_summary (
            merchant_id, square_customer_id, offer_id,
            current_quantity, required_quantity,
            window_start_date, window_end_date,
            has_earned_reward, earned_reward_id,
            total_lifetime_purchases, total_rewards_earned, total_rewards_redeemed,
            last_purchase_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (merchant_id, square_customer_id, offer_id) DO UPDATE SET
            current_quantity = EXCLUDED.current_quantity,
            window_start_date = EXCLUDED.window_start_date,
            window_end_date = EXCLUDED.window_end_date,
            has_earned_reward = EXCLUDED.has_earned_reward,
            earned_reward_id = EXCLUDED.earned_reward_id,
            total_lifetime_purchases = EXCLUDED.total_lifetime_purchases,
            total_rewards_earned = EXCLUDED.total_rewards_earned,
            total_rewards_redeemed = EXCLUDED.total_rewards_redeemed,
            last_purchase_at = EXCLUDED.last_purchase_at,
            updated_at = NOW()
    `, [
        merchantId, squareCustomerId, offerId,
        parseInt(s.current_quantity) || 0,
        offer.rows[0]?.required_quantity || 0,
        s.window_start, s.window_end,
        hasEarned, earnedRewardId,
        parseInt(s.lifetime_purchases) || 0,
        parseInt(totalEarned.rows[0]?.count || 0),
        parseInt(redeemedRewards.rows[0]?.count || 0),
        s.last_purchase
    ]);
}

// ============================================================================
// CUSTOMER LOOKUP APIs
// ============================================================================


// ============================================================================
// WEBHOOK ORDER PROCESSING
// ============================================================================

/**
 * Process an order for loyalty (called from webhook handler)
 * Extracts line items and processes qualifying purchases
 *
 * @param {Object} order - Square order object from webhook
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.customerSourceOverride] - Override customer source (e.g., 'manual' for admin-added orders)
 */
async function processOrderForLoyalty(order, merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Check if loyalty is enabled for this merchant
    const loyaltyEnabled = await getSetting('loyalty_enabled', merchantId);
    if (loyaltyEnabled === 'false') {
        logger.debug('Loyalty processing disabled for merchant', { merchantId });
        return { processed: false, reason: 'loyalty_disabled' };
    }

    // RELIABLE CUSTOMER IDENTIFICATION - Only use trustworthy identifiers
    // Priority order: order.customer_id > tenders.customer_id > loyalty event by order_id
    let squareCustomerId = order.customer_id;
    let customerSource = options.customerSourceOverride || 'order.customer_id';

    // Log customer identification attempt
    if (squareCustomerId) {
        loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_SUCCESS',
            orderId: order.id,
            method: 'ORDER_CUSTOMER_ID',
            customerId: squareCustomerId,
            merchantId,
        });
    } else {
        loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_ATTEMPT',
            orderId: order.id,
            method: 'ORDER_CUSTOMER_ID',
            success: false,
            merchantId,
        });
    }

    // Fallback 1: Check tenders for customer_id (some POS workflows attach customer to payment)
    if (!squareCustomerId && order.tenders && order.tenders.length > 0) {
        loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_ATTEMPT',
            orderId: order.id,
            method: 'TENDER_CUSTOMER_ID',
            merchantId,
        });
        for (const tender of order.tenders) {
            if (tender.customer_id) {
                squareCustomerId = tender.customer_id;
                customerSource = 'tender.customer_id';
                loyaltyLogger.customer({
                    action: 'CUSTOMER_LOOKUP_SUCCESS',
                    orderId: order.id,
                    method: 'TENDER_CUSTOMER_ID',
                    customerId: squareCustomerId,
                    merchantId,
                });
                logger.debug('Found customer_id on tender', { orderId: order.id, customerId: squareCustomerId });
                break;
            }
        }
        if (!squareCustomerId) {
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_FAILED',
                orderId: order.id,
                method: 'TENDER_CUSTOMER_ID',
                reason: 'no_customer_id_on_tenders',
                merchantId,
            });
        }
    }

    // Fallback 2: Lookup via Square Loyalty API using order_id (NOT timestamp)
    if (!squareCustomerId) {
        loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_ATTEMPT',
            orderId: order.id,
            method: 'LOYALTY_API',
            merchantId,
        });
        logger.debug('No customer_id on order or tenders, trying loyalty lookup by order_id', { orderId: order.id });
        squareCustomerId = await lookupCustomerFromLoyalty(order.id, merchantId);
        if (squareCustomerId) {
            customerSource = 'loyalty_event_order_id';
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_SUCCESS',
                orderId: order.id,
                method: 'LOYALTY_API',
                customerId: squareCustomerId,
                merchantId,
            });
            logger.info('Found customer via loyalty API (order_id match)', {
                orderId: order.id,
                customerId: squareCustomerId
            });
        } else {
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_FAILED',
                orderId: order.id,
                method: 'LOYALTY_API',
                reason: 'no_loyalty_events_found',
                merchantId,
            });
        }
    }

    // Fallback 3: If order has Square Loyalty rewards, look up customer from reward
    if (!squareCustomerId) {
        loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_ATTEMPT',
            orderId: order.id,
            method: 'ORDER_REWARDS',
            hasRewards: !!(order.rewards?.length),
            merchantId,
        });
        logger.debug('Trying order rewards lookup', { orderId: order.id, hasRewards: !!(order.rewards?.length) });
        squareCustomerId = await lookupCustomerFromOrderRewards(order, merchantId);
        if (squareCustomerId) {
            customerSource = 'order_rewards';
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_SUCCESS',
                orderId: order.id,
                method: 'ORDER_REWARDS',
                customerId: squareCustomerId,
                merchantId,
            });
            logger.info('Found customer via order rewards lookup', {
                orderId: order.id,
                customerId: squareCustomerId
            });
        } else {
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_FAILED',
                orderId: order.id,
                method: 'ORDER_REWARDS',
                reason: 'no_customer_from_rewards',
                merchantId,
            });
        }
    }

    // Fallback 4: For web/online orders - lookup by fulfillment recipient phone/email
    // Square Online orders often don't have customer_id but have recipient contact info
    if (!squareCustomerId) {
        loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_ATTEMPT',
            orderId: order.id,
            method: 'FULFILLMENT_RECIPIENT',
            merchantId,
        });
        logger.debug('Trying fulfillment recipient lookup for web order', { orderId: order.id });
        squareCustomerId = await lookupCustomerFromFulfillmentRecipient(order, merchantId);
        if (squareCustomerId) {
            customerSource = 'fulfillment_recipient';
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_SUCCESS',
                orderId: order.id,
                method: 'FULFILLMENT_RECIPIENT',
                customerId: squareCustomerId,
                merchantId,
            });
            logger.info('Found customer via fulfillment recipient lookup (phone/email match)', {
                orderId: order.id,
                customerId: squareCustomerId
            });
        } else {
            loyaltyLogger.customer({
                action: 'CUSTOMER_LOOKUP_FAILED',
                orderId: order.id,
                method: 'FULFILLMENT_RECIPIENT',
                reason: 'no_customer_from_fulfillment',
                merchantId,
            });
        }
    }

    // No customer found through any method
    if (!squareCustomerId) {
        loyaltyLogger.customer({
            action: 'CUSTOMER_NOT_IDENTIFIED',
            orderId: order.id,
            attemptedMethods: ['ORDER_CUSTOMER_ID', 'TENDER_CUSTOMER_ID', 'LOYALTY_API', 'ORDER_REWARDS', 'FULFILLMENT_RECIPIENT'],
            merchantId,
        });
        logger.debug('Order has no reliable customer identifier after all lookups', { orderId: order.id });
        return { processed: false, reason: 'no_customer' };
    }

    const lineItems = order.line_items || [];
    if (lineItems.length === 0) {
        return { processed: false, reason: 'no_line_items' };
    }

    // Extract receipt URL and payment type from tenders (usually on card payments)
    let receiptUrl = null;
    let paymentType = null;
    if (order.tenders && order.tenders.length > 0) {
        // Get primary tender info (first tender is usually the main payment)
        const primaryTender = order.tenders[0];
        paymentType = primaryTender.type; // CARD, CASH, WALLET, SQUARE_GIFT_CARD, etc.

        for (const tender of order.tenders) {
            if (tender.receipt_url) {
                receiptUrl = tender.receipt_url;
                break;
            }
        }
    }

    logger.info('Processing order for loyalty', {
        merchantId,
        orderId: order.id,
        customerId: squareCustomerId,
        customerSource,
        lineItemCount: lineItems.length,
        hasReceiptUrl: !!receiptUrl
    });

    // Cache customer details BEFORE processing purchases
    // This ensures phone number is available in rewards reporting
    try {
        const customer = await getCustomerDetails(squareCustomerId, merchantId);
        if (customer) {
            // Update stats asynchronously - don't block on this
            updateCustomerStats(squareCustomerId, merchantId, { incrementOrders: true })
                .catch(err => logger.debug('Failed to update customer stats', { error: err.message }));
        }
    } catch (err) {
        // Log but don't fail order processing if customer caching fails
        logger.warn('Failed to cache customer during order processing', {
            error: err.message,
            customerId: squareCustomerId
        });
    }

    const results = {
        processed: true,
        orderId: order.id,
        customerId: squareCustomerId,
        customerSource,  // 'order' or 'loyalty_lookup'
        purchasesRecorded: [],
        skippedFreeItems: [],
        errors: []
    };

    // CRITICAL: Detect free/discounted items to prevent double-counting
    // 1. Check if order has any of OUR loyalty discounts applied
    // 2. Check if any line items are 100% discounted (free via any coupon)
    const orderDiscounts = order.discounts || [];

    // Get our loyalty discount IDs to detect our own discounts being redeemed
    let ourLoyaltyDiscountIds = new Set();
    try {
        const loyaltyDiscountsResult = await db.query(`
            SELECT square_discount_id, square_pricing_rule_id
            FROM loyalty_rewards
            WHERE merchant_id = $1
              AND (square_discount_id IS NOT NULL OR square_pricing_rule_id IS NOT NULL)
        `, [merchantId]);

        for (const row of loyaltyDiscountsResult.rows) {
            if (row.square_discount_id) ourLoyaltyDiscountIds.add(row.square_discount_id);
            if (row.square_pricing_rule_id) ourLoyaltyDiscountIds.add(row.square_pricing_rule_id);
        }
    } catch (err) {
        logger.warn('Could not fetch loyalty discount IDs for free item detection', { error: err.message });
    }

    // Check if this order used one of our loyalty discounts (redemption order)
    const orderUsedOurDiscount = orderDiscounts.some(d =>
        d.catalog_object_id && ourLoyaltyDiscountIds.has(d.catalog_object_id)
    );

    // Build a map of line item UIDs that had discounts applied
    const lineItemDiscountMap = new Map();
    for (const discount of orderDiscounts) {
        // Check if this is one of our loyalty discounts
        const isOurLoyaltyDiscount = discount.catalog_object_id &&
            ourLoyaltyDiscountIds.has(discount.catalog_object_id);

        // Track which line items this discount was applied to
        if (discount.applied_money?.amount > 0) {
            // Line-item level discounts have scope = 'LINE_ITEM' and reference specific items
            // Order-level discounts have scope = 'ORDER' but still track applied amounts per line
            const uid = discount.uid;
            lineItemDiscountMap.set(uid, {
                isOurLoyaltyDiscount,
                amount: discount.applied_money.amount
            });
        }
    }

    for (const lineItem of lineItems) {
        try {
            // Get variation ID from line item
            const variationId = lineItem.catalog_object_id;
            if (!variationId) {
                loyaltyLogger.debug({
                    action: 'LINE_ITEM_EVALUATION',
                    orderId: order.id,
                    lineItemId: lineItem.uid,
                    variationId: null,
                    decision: 'SKIP_NO_VARIATION',
                    merchantId,
                });
                continue;  // Skip items without variation ID
            }

            const quantity = parseInt(lineItem.quantity) || 0;
            if (quantity <= 0) {
                loyaltyLogger.debug({
                    action: 'LINE_ITEM_EVALUATION',
                    orderId: order.id,
                    lineItemId: lineItem.uid,
                    variationId,
                    quantity,
                    decision: 'SKIP_ZERO_QUANTITY',
                    merchantId,
                });
                continue;  // Skip zero or negative quantities
            }

            // Get pricing info (convert BigInt to Number for Square SDK v43+)
            const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
            const grossSalesCents = Number(lineItem.gross_sales_money?.amount || 0) || (unitPriceCents * quantity);
            const totalDiscountCents = Number(lineItem.total_discount_money?.amount || 0);
            // Use nullish check to preserve 0 values (free items have total_money = 0)
            const rawTotalMoney = lineItem.total_money?.amount;
            const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : (grossSalesCents - totalDiscountCents);

            // SKIP FREE ITEMS: Check if item was 100% discounted (free)
            // This prevents counting free items from ANY source (coupons, loyalty rewards, promos)
            if (grossSalesCents > 0 && totalMoneyCents === 0) {
                loyaltyLogger.debug({
                    action: 'LINE_ITEM_EVALUATION',
                    orderId: order.id,
                    lineItemId: lineItem.uid,
                    variationId,
                    quantity,
                    unitPrice: unitPriceCents,
                    grossSales: grossSalesCents,
                    totalDiscount: totalDiscountCents,
                    totalMoney: totalMoneyCents,
                    decision: 'SKIP_FREE',
                    merchantId,
                });
                logger.info('Skipping FREE item from loyalty tracking (100% discounted)', {
                    orderId: order.id,
                    variationId,
                    quantity,
                    grossSalesCents,
                    totalDiscountCents,
                    reason: 'item_fully_discounted'
                });
                results.skippedFreeItems.push({
                    variationId,
                    quantity,
                    reason: 'fully_discounted_to_zero'
                });
                continue;
            }

            // SKIP OUR LOYALTY REDEMPTIONS: Check if this specific line item had our discount applied
            // Square's applied_discounts array on line items contains discount UIDs
            const appliedDiscounts = lineItem.applied_discounts || [];
            const itemHasOurLoyaltyDiscount = appliedDiscounts.some(ad => {
                const discountInfo = lineItemDiscountMap.get(ad.discount_uid);
                return discountInfo?.isOurLoyaltyDiscount;
            });

            if (itemHasOurLoyaltyDiscount) {
                loyaltyLogger.debug({
                    action: 'LINE_ITEM_EVALUATION',
                    orderId: order.id,
                    lineItemId: lineItem.uid,
                    variationId,
                    quantity,
                    decision: 'SKIP_OUR_LOYALTY',
                    merchantId,
                });
                logger.info('Skipping item with OUR loyalty discount applied', {
                    orderId: order.id,
                    variationId,
                    quantity,
                    reason: 'our_loyalty_discount_applied'
                });
                results.skippedFreeItems.push({
                    variationId,
                    quantity,
                    reason: 'loyalty_reward_redemption'
                });
                continue;
            }

            // Log that this item will be processed
            loyaltyLogger.debug({
                action: 'LINE_ITEM_EVALUATION',
                orderId: order.id,
                lineItemId: lineItem.uid,
                variationId,
                quantity,
                unitPrice: unitPriceCents,
                totalMoney: totalMoneyCents,
                decision: 'PROCESS',
                merchantId,
            });

            // Process the purchase (item was paid for, not free)
            // Map customerSource to shorter DB values: order.customer_id -> order, tender.customer_id -> tender, loyalty_event_order_id -> loyalty_api
            const dbCustomerSource = customerSource === 'order.customer_id' ? 'order'
                : customerSource === 'tender.customer_id' ? 'tender'
                : customerSource === 'loyalty_event_order_id' ? 'loyalty_api'
                : 'order';
            const purchaseResult = await processQualifyingPurchase({
                merchantId,
                squareOrderId: order.id,
                squareCustomerId,
                variationId,
                quantity,
                unitPriceCents,
                purchasedAt: order.created_at || new Date(),
                squareLocationId: order.location_id,
                receiptUrl,
                customerSource: dbCustomerSource,
                paymentType
            });

            if (purchaseResult.processed) {
                results.purchasesRecorded.push({
                    variationId,
                    quantity,
                    reward: purchaseResult.reward
                });
            }
        } catch (error) {
            logger.error('Error processing line item for loyalty', {
                error: error.message,
                lineItemUid: lineItem.uid,
                orderId: order.id
            });
            results.errors.push({
                lineItemUid: lineItem.uid,
                error: error.message
            });
        }
    }

    // Log summary if we skipped any free items
    if (results.skippedFreeItems.length > 0) {
        logger.info('Loyalty processing skipped free items', {
            orderId: order.id,
            skippedCount: results.skippedFreeItems.length,
            skippedItems: results.skippedFreeItems,
            orderUsedOurDiscount
        });
    }

    return results;
}

/**
 * Process refunds in an order (called from webhook handler)
 * @param {Object} order - Square order object with refunds
 * @param {number} merchantId - Internal merchant ID
 */
async function processOrderRefundsForLoyalty(order, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const refunds = order.refunds || [];
    if (refunds.length === 0) {
        return { processed: false, reason: 'no_refunds' };
    }

    const squareCustomerId = order.customer_id;

    logger.info('Processing order refunds for loyalty', {
        merchantId,
        orderId: order.id,
        refundCount: refunds.length
    });

    const results = {
        processed: true,
        orderId: order.id,
        refundsProcessed: [],
        errors: []
    };

    for (const refund of refunds) {
        if (refund.status !== 'COMPLETED') {
            continue;  // Only process completed refunds
        }

        for (const tender of refund.tender_id ? [{ tender_id: refund.tender_id }] : []) {
            // Process refund line items
            for (const returnItem of refund.return_line_items || []) {
                try {
                    const variationId = returnItem.catalog_object_id;
                    if (!variationId) continue;

                    const quantity = parseInt(returnItem.quantity) || 0;
                    if (quantity <= 0) continue;

                    // SKIP FREE ITEM REFUNDS: Don't create negative adjustments for items
                    // that were free (never counted toward loyalty in the first place)
                    // Convert BigInt to Number for Square SDK v43+
                    const unitPriceCents = Number(returnItem.base_price_money?.amount || 0);
                    // Use nullish check to preserve 0 values (free items have total_money = 0)
                    const rawTotalMoney = returnItem.total_money?.amount;
                    const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : unitPriceCents;

                    if (unitPriceCents > 0 && totalMoneyCents === 0) {
                        logger.info('Skipping refund of FREE item (was 100% discounted)', {
                            orderId: order.id,
                            variationId,
                            quantity,
                            reason: 'free_item_refund_no_adjustment_needed'
                        });
                        continue;
                    }

                    const refundResult = await processRefund({
                        merchantId,
                        squareOrderId: order.id,
                        squareCustomerId,
                        variationId,
                        quantity,
                        unitPriceCents,
                        refundedAt: refund.created_at,
                        squareLocationId: order.location_id
                    });

                    if (refundResult.processed) {
                        results.refundsProcessed.push({
                            variationId,
                            quantity,
                            rewardAffected: refundResult.rewardAffected
                        });
                    }
                } catch (error) {
                    logger.error('Error processing refund line item', {
                        error: error.message,
                        orderId: order.id
                    });
                    results.errors.push({
                        refundId: refund.id,
                        error: error.message
                    });
                }
            }
        }
    }

    return results;
}

// ============================================================================
// AUDIT LOG QUERIES
// ============================================================================


// ============================================================================
// FUTURE FEATURES - TODO (vNext)
// ============================================================================
// The following features are planned for future releases:
//
// TODO (vNext): Buy X Save Y% instantly (promo-compatible discounting)
// - Instead of "buy 12 get 1 free", support "buy 6+ get 10% off"
// - Must be compatible with existing Square promotions
// - Requires real-time discount application at checkout
// - Need to integrate with Square Catalog pricing rules
//
// TODO (vNext): Pre-checkout POS reward prompts (if Square allows)
// - Notify cashier when customer has earned reward before completing transaction
// - Requires Square POS Terminal API integration (if available)
// - May need Square webhook for cart events (not currently available)
// - Fallback: Display notification on Square Dashboard
//
// TODO (vNext): Customer-facing loyalty dashboard
// - Self-service portal for customers to view their progress
// - QR code on receipts linking to their status
// - Email notifications for milestones (requires opt-in)
//
// TODO (vNext): Square receipt message integration
// - Use Square Receipts API to append reward status to digital receipts
// - Show "You've earned X/Y towards your next free item!"
// - Requires additional Square API permissions
//
// TODO (vNext): Bulk import historical purchases
// - Allow merchants to import existing purchase history
// - Support CSV upload with order ID, customer ID, variation ID, qty
// - Validation against Square catalog
//
// TODO (vNext): Loyalty tiers (Bronze/Silver/Gold)
// - Multiple reward tiers based on lifetime purchases
// - Different earning rates per tier
// - Tier status display and progression tracking
// ============================================================================

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Purchase processing
    processQualifyingPurchase,
    processRefund,

    // Reward management
    redeemReward,
    updateRewardProgress,  // Exported for expiration-service.js

    // Webhook processing
    processOrderForLoyalty,
    processOrderRefundsForLoyalty
};
