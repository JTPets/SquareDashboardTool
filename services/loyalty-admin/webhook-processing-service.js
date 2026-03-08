/**
 * Loyalty Webhook Processing Service
 *
 * Handles refund processing from Square webhooks:
 * - processOrderRefundsForLoyalty: Process refunds that affect loyalty tracking
 *
 * Note: Order processing (purchases) is handled by order-intake.js via processLoyaltyOrder().
 * The legacy processOrderForLoyalty() was removed (LA-15) after LA-1/LA-2 migrated all callers.
 */

const logger = require('../../utils/logger');
const { processRefund } = require('./purchase-service');

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

    const results = {
        processed: true,
        orderId: order.id,
        refundsProcessed: [],
        errors: []
    };

    for (const ret of returns) {
        for (const returnItem of ret.return_line_items || []) {
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

                // Use source_line_item_uid or uid for unique idempotency per return line item
                const returnLineItemUid = returnItem.uid || returnItem.source_line_item_uid;

                const refundResult = await processRefund({
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
                    orderId: order.id,
                    returnLineItemUid: returnItem.uid
                });
                results.errors.push({
                    returnUid: returnItem.uid,
                    error: error.message
                });
            }
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
