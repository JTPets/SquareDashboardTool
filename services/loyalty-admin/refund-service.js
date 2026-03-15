/**
 * Loyalty Refund Service
 *
 * Handles refund processing that affects loyalty tracking:
 * - processRefund: Adjust quantities, revoke rewards if needed
 *
 * Extracted from purchase-service.js for single-responsibility compliance.
 *
 * @module services/loyalty-admin/refund-service
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { RewardStatus, AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { getOfferForVariation } = require('./variation-admin-service');
const { cleanupSquareCustomerGroupDiscount, createSquareCustomerGroupDiscount } = require('./square-discount-service');
const { updateRewardProgress, markSyncPendingIfRewardExists } = require('./reward-progress-service');
const { updateCustomerSummary } = require('./customer-summary-service');

// ============================================================================
// REFUND PROCESSING
// ============================================================================

/**
 * Process a refund that affects loyalty purchases
 * BUSINESS RULE: Refunds ALWAYS adjust quantities immediately
 * If a refund causes an earned reward to become invalid, the reward is REVOKED
 *
 * @param {Object} refundData - Refund details
 * @param {Object} [transactionClient=null] - Optional external transaction client.
 *   When provided, the caller owns the transaction (BEGIN/COMMIT/ROLLBACK).
 *   When omitted, processRefund manages its own transaction (backward compatible).
 */
async function processRefund(refundData, transactionClient = null) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, refundedAt, squareLocationId, originalEventId,
        returnLineItemUid
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

    // Idempotency key includes returnLineItemUid to distinguish partial refunds
    // of the same item with the same quantity (LA-5 fix)
    const idempotencyKey = returnLineItemUid
        ? `refund:${squareOrderId}:${variationId}:${returnLineItemUid}`
        : `refund:${squareOrderId}:${variationId}:${quantity}`;

    // Check for existing event (idempotency) — prevents duplicate refund inserts
    // from rapid-fire webhooks (Square sends 4-5 per event)
    // LOGIC CHANGE (HIGH-3): Use transactionClient for idempotency check when provided,
    // so the check is within the same transaction snapshot as the insert
    const queryFn = transactionClient || db;
    const existingEvent = await queryFn.query(`
        SELECT id FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND idempotency_key = $2
    `, [merchantId, idempotencyKey]);

    if (existingEvent.rows.length > 0) {
        logger.debug('Refund event already processed (idempotent)', { idempotencyKey });
        return { processed: false, reason: 'already_processed' };
    }

    logger.info('Processing loyalty refund', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        refundQuantity,
        offerId: offer.id
    });

    // LOGIC CHANGE (HIGH-3): When transactionClient is provided, the caller manages
    // the transaction (BEGIN/COMMIT/ROLLBACK). This enables atomic batch refunds.
    const client = transactionClient || await db.pool.connect();
    const managesOwnTransaction = !transactionClient;
    // Track revoked reward for post-transaction Square cleanup
    let revokedReward = null;
    try {
        if (managesOwnTransaction) {
            await client.query('BEGIN');
        }

        // LA-11 fix: Look up the original purchase event's window dates
        // instead of calculating from the refund date
        let windowStartDate, windowEndDate;
        const originalPurchase = await client.query(`
            SELECT window_start_date, window_end_date
            FROM loyalty_purchase_events
            WHERE merchant_id = $1
              AND square_order_id = $2
              AND variation_id = $3
              AND is_refund = FALSE
              AND quantity > 0
            ORDER BY purchased_at DESC
            LIMIT 1
        `, [merchantId, squareOrderId, variationId]);

        if (originalPurchase.rows.length > 0) {
            windowStartDate = originalPurchase.rows[0].window_start_date;
            windowEndDate = originalPurchase.rows[0].window_end_date;
        } else {
            // Fallback: no original purchase found (edge case — refund without purchase record)
            logger.warn('No original purchase event found for refund — using refund date for window', {
                merchantId, squareOrderId, variationId
            });
            const refundDate = new Date(refundedAt || Date.now());
            windowStartDate = refundDate.toISOString().split('T')[0];
            const fallbackEnd = new Date(refundDate);
            fallbackEnd.setMonth(fallbackEnd.getMonth() + offer.window_months);
            windowEndDate = fallbackEnd.toISOString().split('T')[0];
        }

        // Record the refund event (total_price_cents is negative to match refund direction)
        // LOGIC CHANGE (CRIT-3): Added ON CONFLICT DO NOTHING — same race condition fix
        // as processQualifyingPurchase. Concurrent refund webhooks can both pass the
        // SELECT idempotency check before either commits.
        const refundTotalPriceCents = unitPriceCents ? refundQuantity * unitPriceCents : null;
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents, total_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, original_event_id, idempotency_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, $13, $14)
            ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, refundQuantity, unitPriceCents, refundTotalPriceCents,
            refundedAt || new Date(), windowStartDate,
            windowEndDate, originalEventId, idempotencyKey
        ]);

        // LOGIC CHANGE (CRIT-3): If ON CONFLICT suppressed the insert, the refund event
        // already exists from a concurrent transaction. Fetch and return it.
        if (eventResult.rows.length === 0) {
            logger.info('Concurrent duplicate detected via ON CONFLICT', {
                event: 'purchase_event_duplicate',
                idempotencyKey,
                merchantId,
                orderId: squareOrderId
            });

            const existingRow = await client.query(`
                SELECT * FROM loyalty_purchase_events
                WHERE merchant_id = $1 AND idempotency_key = $2
            `, [merchantId, idempotencyKey]);

            if (managesOwnTransaction) {
                await client.query('COMMIT');
            }

            return {
                processed: false,
                reason: 'already_processed',
                refundEvent: existingRow.rows[0] || null,
                alreadyProcessed: true
            };
        }

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

            // LOGIC CHANGE (HIGH-6): If refund causes reward to be invalid, revoke it
            // AND clean up the Square discount so the customer cannot use it at POS.
            // Previously only revoked in DB without removing the Square discount object.
            // (B7 fix: added AND merchant_id)
            if (remainingQuantity < offer.required_quantity) {
                await client.query(`
                    UPDATE loyalty_rewards
                    SET status = 'revoked',
                        revoked_at = NOW(),
                        revocation_reason = 'Refund reduced qualifying quantity below threshold',
                        updated_at = NOW()
                    WHERE id = $1 AND merchant_id = $2
                `, [reward.id, merchantId]);

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

                // Update customer summary after revocation to keep it in sync
                await updateCustomerSummary(client, merchantId, squareCustomerId, offer.id);

                // Save for post-transaction Square cleanup
                revokedReward = reward;
            }
        }

        // Update reward progress for any in-progress reward
        const refundRewardResult = await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        if (managesOwnTransaction) {
            await client.query('COMMIT');
        }

        // LOGIC CHANGE (MED-1): Fire Square discount creation for any rewards
        // earned during refund-triggered progress recalculation (edge case:
        // refund + rollover could still earn a reward). Same pattern as purchase path.
        if (refundRewardResult.earnedRewardIds && refundRewardResult.earnedRewardIds.length > 0) {
            for (const earnedRewardId of refundRewardResult.earnedRewardIds) {
                createSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId,
                    internalRewardId: earnedRewardId,
                    offerId: offer.id
                }).then(async (squareResult) => {
                    if (squareResult.success) {
                        logger.info('Square discount created for earned reward', {
                            merchantId,
                            rewardId: earnedRewardId,
                            groupId: squareResult.groupId,
                            discountId: squareResult.discountId
                        });
                    } else {
                        logger.error('earned_reward_discount_creation_failed', {
                            event: 'earned_reward_discount_creation_failed',
                            rewardId: earnedRewardId,
                            merchantId,
                            error: squareResult.error
                        });
                        await markSyncPendingIfRewardExists(earnedRewardId, merchantId);
                    }
                }).catch(async (err) => {
                    logger.error('earned_reward_discount_creation_failed', {
                        event: 'earned_reward_discount_creation_failed',
                        rewardId: earnedRewardId,
                        merchantId,
                        error: err.message
                    });
                    await markSyncPendingIfRewardExists(earnedRewardId, merchantId);
                });
            }
        }

        // LOGIC CHANGE (HIGH-6): Clean up Square discount objects OUTSIDE the transaction
        // (external API call — matches expiration-service.js and reward-service.js pattern).
        // Without this, the customer retains an active discount in Square POS and can
        // redeem a free item even though their reward was revoked in our DB.
        // LOGIC CHANGE (HIGH-3): When caller owns the transaction, defer Square cleanup
        // to the caller (returned via revokedReward in result) since the transaction
        // has not committed yet.
        if (revokedReward && managesOwnTransaction) {
            logger.info('Reward revoked via refund', {
                event: 'reward_revoked_via_refund',
                customerId: squareCustomerId,
                offerId: offer.id,
                merchantId,
                rewardId: revokedReward.id
            });

            try {
                await cleanupSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId,
                    internalRewardId: revokedReward.id
                });

                logger.info('Revocation cleanup complete', {
                    event: 'revocation_cleanup_complete',
                    customerId: squareCustomerId,
                    offerId: offer.id,
                    merchantId,
                    rewardId: revokedReward.id
                });
            } catch (cleanupError) {
                // Do NOT throw — cleanup failure should not roll back the revocation
                logger.error('Revocation cleanup failed', {
                    event: 'revocation_cleanup_failed',
                    customerId: squareCustomerId,
                    offerId: offer.id,
                    merchantId,
                    rewardId: revokedReward.id,
                    error: cleanupError.message
                });
            }
        }

        return {
            processed: true,
            refundEvent,
            rewardAffected: earnedReward.rows.length > 0,
            revokedReward: revokedReward || null
        };

    } catch (error) {
        if (managesOwnTransaction) {
            await client.query('ROLLBACK');
        }
        logger.error('Failed to process refund', {
            error: error.message,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        if (managesOwnTransaction) {
            client.release();
        }
    }
}

module.exports = {
    processRefund
};
