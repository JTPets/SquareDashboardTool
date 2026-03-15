/**
 * Loyalty Purchase Service
 *
 * Handles qualifying purchase processing for loyalty program:
 * - processQualifyingPurchase: Record qualifying purchases from orders
 *
 * Refund processing has been extracted to refund-service.js.
 *
 * Delegates to:
 * - reward-progress-service.js: updateRewardProgress (split-row state machine)
 * - customer-summary-service.js: updateCustomerSummary (denormalized stats)
 *
 * Extracted from loyalty-service.js as part of final P1-1 monolith elimination.
 * Split into 3 files for 300-line compliance (2026-03-06).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { RewardStatus, AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { getOfferForVariation } = require('./variation-admin-service');
const { createSquareCustomerGroupDiscount } = require('./square-discount-service');
const { updateRewardProgress, markSyncPendingIfRewardExists } = require('./reward-progress-service');
const { updateCustomerSummary } = require('./customer-summary-service');

// ============================================================================
// PURCHASE PROCESSING
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
 * @param {number} [purchaseData.totalPriceCents] - Total line item price (quantity × unit) for audit
 * @param {Date} purchaseData.purchasedAt - Purchase timestamp
 * @param {string} [purchaseData.squareLocationId] - Square location ID
 * @param {string} [purchaseData.receiptUrl] - Square receipt URL from tender
 * @param {string} [purchaseData.customerSource] - How customer was identified: order, tender, loyalty_api, or manual
 * @param {string} [purchaseData.paymentType] - Payment method: CARD, CASH, WALLET, etc.
 * @returns {Promise<Object>} Processing result
 */
async function processQualifyingPurchase(purchaseData, options = {}) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, totalPriceCents, purchasedAt, squareLocationId, receiptUrl,
        customerSource = 'order', paymentType = null
    } = purchaseData;

    // When transactionClient is provided, the caller manages the transaction
    // (BEGIN/COMMIT/ROLLBACK). This enables atomic multi-table writes.
    const { transactionClient = null } = options;

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
    // Key is orderId:variationId only — order-intake.js aggregates all line items
    // for the same variation before calling this function, guaranteeing one call
    // per variation per order.
    const idempotencyKey = `${squareOrderId}:${variationId}`;

    // Check for existing event (idempotency)
    // Use transactionClient if available so the check is within the same snapshot
    const queryFn = transactionClient || db;
    const existingEvent = await queryFn.query(`
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

    // If caller provided a transaction client, use it directly (no own transaction)
    const client = transactionClient || await db.pool.connect();
    const managesOwnTransaction = !transactionClient;

    try {
        if (managesOwnTransaction) {
            await client.query('BEGIN');
        }

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
        // LOGIC CHANGE (CRIT-3): Added ON CONFLICT DO NOTHING to handle concurrent
        // inserts with the same idempotency_key. The SELECT-then-INSERT pattern has a
        // race window where two concurrent transactions both pass the SELECT check
        // before either commits, causing a unique constraint violation on the second INSERT.
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents, total_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, idempotency_key, receipt_url, customer_source, payment_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, quantity, unitPriceCents, totalPriceCents ?? null,
            purchasedAt, windowStartDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0],
            false, idempotencyKey, receiptUrl || null, customerSource, paymentType
        ]);

        // LOGIC CHANGE (CRIT-3): If ON CONFLICT suppressed the insert, the event
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
                purchaseEvent: existingRow.rows[0] || null,
                alreadyProcessed: true
            };
        }

        const purchaseEvent = eventResult.rows[0];

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

        if (managesOwnTransaction) {
            await client.query('COMMIT');
        }

        // LOGIC CHANGE (MED-1): Fire Square discount creation AFTER the
        // transaction commits. updateRewardProgress() returns earnedRewardIds
        // but does not fire the discount creation itself — reward rows must
        // be committed before calling the Square API, otherwise a rollback
        // would leave orphaned sync records.
        if (rewardResult.earnedRewardIds && rewardResult.earnedRewardIds.length > 0) {
            for (const earnedRewardId of rewardResult.earnedRewardIds) {
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
        if (managesOwnTransaction) {
            await client.query('ROLLBACK');
        }
        logger.error('Failed to process qualifying purchase', {
            error: error.message,
            stack: error.stack,
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Re-export from extracted modules for backward compatibility
    updateCustomerSummary,
    updateRewardProgress,

    // Purchase processing
    processQualifyingPurchase
};
