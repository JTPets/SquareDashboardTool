/**
 * Loyalty Webhook Processing Service
 *
 * Handles refund processing from Square webhooks:
 * - processOrderRefundsForLoyalty: Process refunds that affect loyalty tracking
 *
 * Note: Order processing (purchases) is handled by order-intake.js via processLoyaltyOrder().
 * The legacy processOrderForLoyalty() was removed (LA-15) after LA-1/LA-2 migrated all callers.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { processRefund } = require('./refund-service');
const { cleanupSquareCustomerGroupDiscount } = require('./square-discount-service');

// ============================================================================
// WEBHOOK REFUND PROCESSING
// ============================================================================

/**
 * Process refunds in an order (called from webhook handler)
 *
 * Square puts line-item returns in order.returns[].return_line_items[],
 * NOT in order.refunds[]. Each return entry has a source_line_item_uid
 * linking back to the original line item.
 *
 * @param {Object} order - Square order object with returns
 * @param {number} merchantId - Internal merchant ID
 */
async function processOrderRefundsForLoyalty(order, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const returns = order.returns || [];
    if (returns.length === 0) {
        return { processed: false, reason: 'no_returns' };
    }

    const squareCustomerId = order.customer_id;

    logger.info('Processing order returns for loyalty', {
        merchantId,
        orderId: order.id,
        returnCount: returns.length
    });

    // Build the list of refund line items to process (filtering/validation first)
    const refundItems = [];
    for (const ret of returns) {
        for (const returnItem of ret.return_line_items || []) {
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

            // Use source_line_item_uid or uid for unique idempotency per return line item
            const returnLineItemUid = returnItem.uid || returnItem.source_line_item_uid;

            refundItems.push({
                merchantId,
                squareOrderId: order.id,
                squareCustomerId,
                variationId,
                quantity,
                unitPriceCents,
                refundedAt: ret.created_at || order.updated_at,
                squareLocationId: order.location_id,
                returnLineItemUid
            });
        }
    }

    if (refundItems.length === 0) {
        return { processed: false, reason: 'no_qualifying_returns' };
    }

    // LOGIC CHANGE (HIGH-3): Wrap all refund line items in a single transaction.
    // Previously each processRefund() call created its own transaction, so a failure
    // on the Nth item left items 1..N-1 committed and N+1..end unattempted.
    // Now all succeed or all rollback atomically.
    const client = await db.pool.connect();
    const results = {
        processed: true,
        orderId: order.id,
        refundsProcessed: [],
        revokedRewards: []
    };

    try {
        await client.query('BEGIN');

        for (let i = 0; i < refundItems.length; i++) {
            const refundResult = await processRefund(refundItems[i], client);

            if (refundResult.processed) {
                results.refundsProcessed.push({
                    variationId: refundItems[i].variationId,
                    quantity: refundItems[i].quantity,
                    rewardAffected: refundResult.rewardAffected
                });

                // Collect revoked rewards for post-commit Square cleanup
                if (refundResult.revokedReward) {
                    results.revokedRewards.push({
                        reward: refundResult.revokedReward,
                        squareCustomerId: refundItems[i].squareCustomerId,
                        offerId: refundResult.revokedReward.offer_id
                    });
                }
            }
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Refund batch failed', {
            event: 'refund_batch_failed',
            orderId: order.id,
            merchantId,
            failedAt: results.refundsProcessed.length,
            error: error.message
        });
        throw error;
    } finally {
        client.release();
    }

    // LOGIC CHANGE (HIGH-3): Run Square cleanup for revoked rewards AFTER commit
    // (external API calls must not be inside the transaction)
    for (const revoked of results.revokedRewards) {
        try {
            await cleanupSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: revoked.squareCustomerId,
                internalRewardId: revoked.reward.id
            });

            logger.info('Revocation cleanup complete', {
                event: 'revocation_cleanup_complete',
                customerId: revoked.squareCustomerId,
                offerId: revoked.offerId,
                merchantId,
                rewardId: revoked.reward.id
            });
        } catch (cleanupError) {
            // Do NOT throw — cleanup failure should not affect the committed refund batch
            logger.error('Revocation cleanup failed', {
                event: 'revocation_cleanup_failed',
                customerId: revoked.squareCustomerId,
                offerId: revoked.offerId,
                merchantId,
                rewardId: revoked.reward.id,
                error: cleanupError.message
            });
        }
    }

    return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    processOrderRefundsForLoyalty
};
