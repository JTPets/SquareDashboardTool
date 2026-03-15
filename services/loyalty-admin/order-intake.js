/**
 * Loyalty Order Intake Service
 *
 * Single entry point for ALL loyalty order processing. Every code path
 * that evaluates an order for loyalty (webhook, catchup job, backfill,
 * audit) MUST route through processLoyaltyOrder().
 *
 * Guarantees:
 * - Writes loyalty_processed_orders AND loyalty_purchase_events in the
 *   SAME database transaction (atomic — both or neither)
 * - Idempotent: safe to call twice for the same order
 * - Source-tagged for debugging/audit trail
 *
 * @module services/loyalty-admin/order-intake
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { processQualifyingPurchase } = require('./purchase-service');
const { shouldSkipLineItem, buildDiscountMap } = require('./line-item-filter');

/**
 * Process an order for loyalty tracking.
 *
 * This is the ONLY function that should write to loyalty_processed_orders
 * or loyalty_purchase_events. All entry points (webhook, catchup, backfill,
 * manual audit) must call this function.
 *
 * @param {Object} params
 * @param {Object} params.order - Square order object (must have id, line_items)
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} params.squareCustomerId - Square customer ID (caller identifies)
 * @param {string} [params.source='webhook'] - Source tag: 'webhook', 'catchup', 'backfill', 'audit'
 * @param {string} [params.customerSource='order'] - How customer was identified: 'order', 'tender', 'loyalty_api', 'manual', 'catchup_reverse_lookup'
 * @returns {Promise<Object>} { alreadyProcessed, purchaseEvents, rewardEarned }
 */
async function processLoyaltyOrder({ order, merchantId, squareCustomerId, source = 'webhook', customerSource = 'order' }) {
    if (!order?.id) {
        throw new Error('order with id is required');
    }
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const orderId = order.id;
    const lineItems = order.line_items || [];

    // --- Idempotency check (fast path, outside transaction) ---
    const alreadyProcessed = await isOrderAlreadyProcessed(merchantId, orderId);
    if (alreadyProcessed) {
        logger.debug('Order already processed for loyalty (idempotent skip)', {
            orderId,
            merchantId,
            source
        });
        return { alreadyProcessed: true, purchaseEvents: [], rewardEarned: false };
    }

    // --- Open single transaction for atomic writes ---
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Claim the order in loyalty_processed_orders (ON CONFLICT = concurrent dedup)
        // Insert with result_type 'pending' — we'll update after processing
        const claimResult = await client.query(`
            INSERT INTO loyalty_processed_orders
                (merchant_id, square_order_id, square_customer_id, result_type,
                 qualifying_items, total_line_items, source, processed_at)
            VALUES ($1, $2, $3, 'pending', 0, $4, $5, NOW())
            ON CONFLICT (merchant_id, square_order_id) DO NOTHING
            RETURNING id
        `, [merchantId, orderId, squareCustomerId, lineItems.length, source.toUpperCase()]);

        // If no row returned, another process already claimed this order
        if (claimResult.rows.length === 0) {
            await client.query('COMMIT');
            return { alreadyProcessed: true, purchaseEvents: [], rewardEarned: false };
        }

        const processedOrderId = claimResult.rows[0].id;

        // --- Early exit: no customer or no line items ---
        if (!squareCustomerId || lineItems.length === 0) {
            const resultType = !squareCustomerId ? 'no_customer' : 'no_line_items';
            await client.query(`
                UPDATE loyalty_processed_orders
                SET result_type = $1
                WHERE id = $2
            `, [resultType, processedOrderId]);
            await client.query('COMMIT');

            logger.debug('Order processed with no qualifying work', {
                orderId, merchantId, resultType, source
            });
            return { alreadyProcessed: false, purchaseEvents: [], rewardEarned: false };
        }

        // --- Detect free/discounted items to prevent double-counting ---
        const { lineItemDiscountMap } = await buildDiscountMap(order, merchantId);

        // --- Extract tender info for receipt_url and payment_type ---
        let receiptUrl = null;
        let paymentType = null;
        if (order.tenders?.length > 0) {
            paymentType = order.tenders[0].type;
            for (const tender of order.tenders) {
                if (tender.receipt_url) {
                    receiptUrl = tender.receipt_url;
                    break;
                }
            }
        }

        // --- Aggregate qualifying line items by variationId ---
        // BUG FIX (2026-03-07): Square POS can produce multiple line items
        // with the same catalog_object_id (e.g., items scanned individually).
        // Previously each line item called processQualifyingPurchase separately,
        // and the idempotency key (orderId:variationId) caused only the first
        // to be recorded — the rest were silently deduped. Now we aggregate
        // quantities and revenue per variation before making one call each.
        const purchaseEvents = [];
        let rewardEarned = false;
        const skippedFreeItems = [];
        const aggregatedByVariation = new Map();

        for (const lineItem of lineItems) {
            const skipResult = shouldSkipLineItem(lineItem, lineItemDiscountMap, orderId, merchantId);
            if (skipResult.skip) {
                if (skipResult.reason) {
                    skippedFreeItems.push({
                        variationId: skipResult.variationId,
                        quantity: skipResult.quantity,
                        reason: skipResult.reason
                    });
                }
                continue;
            }

            const variationId = lineItem.catalog_object_id;
            const quantity = parseInt(lineItem.quantity) || 0;
            const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
            const totalPriceCents = quantity * unitPriceCents;

            const existing = aggregatedByVariation.get(variationId);
            if (existing) {
                existing.quantity += quantity;
                existing.totalPriceCents += totalPriceCents;
                // Keep the higher unit price for audit (variations should match,
                // but if they differ use the max for conservative tracking)
                if (unitPriceCents > existing.unitPriceCents) {
                    existing.unitPriceCents = unitPriceCents;
                }
            } else {
                aggregatedByVariation.set(variationId, {
                    variationId,
                    quantity,
                    unitPriceCents,
                    totalPriceCents
                });
            }
        }

        // LOGIC CHANGE (MED-7): Collect errors per-variation but do NOT
        // silently commit. After the loop, if any variation failed, ROLLBACK
        // the entire transaction to ensure atomicity — all succeed or none do.
        // Previously, partial failures committed successfully, permanently
        // losing the failed variation's purchase with no retry path.
        const variationErrors = [];

        // --- Process one call per variation with aggregated totals ---
        for (const [variationId, agg] of aggregatedByVariation) {
            try {
                const result = await processQualifyingPurchase({
                    merchantId,
                    squareOrderId: orderId,
                    squareCustomerId,
                    variationId,
                    quantity: agg.quantity,
                    unitPriceCents: agg.unitPriceCents,
                    totalPriceCents: agg.totalPriceCents,
                    purchasedAt: order.created_at || new Date(),
                    squareLocationId: order.location_id,
                    receiptUrl,
                    customerSource,
                    paymentType
                }, { transactionClient: client });

                if (result.processed) {
                    purchaseEvents.push(result.purchaseEvent);
                    if (result.reward?.status === 'earned') {
                        rewardEarned = true;
                    }
                }
            } catch (err) {
                variationErrors.push({ variationId, error: err.message });
            }
        }

        // If any variation failed, rollback the entire transaction
        if (variationErrors.length > 0) {
            await client.query('ROLLBACK');
            logger.error('Order intake partial failure — transaction rolled back', {
                event: 'order_intake_partial_failure',
                orderId,
                merchantId,
                failedVariations: variationErrors.map(e => e.variationId),
                errors: variationErrors.map(e => e.error)
            });
            // LOGIC CHANGE (MED-7 follow-up): Mark as retryable so the webhook
            // error classifier in order-loyalty.js re-throws instead of swallowing.
            // Partial intake failures may be transient (e.g., DB deadlock on one
            // variation) and should trigger a Square webhook retry.
            const intakeError = new Error(`Order intake failed for ${variationErrors.length} variation(s): ${variationErrors.map(e => e.variationId).join(', ')}`);
            intakeError.retryable = true;
            throw intakeError;
        }

        // --- Finalize loyalty_processed_orders with actual result ---
        const resultType = purchaseEvents.length > 0 ? 'qualifying' : 'non_qualifying';
        await client.query(`
            UPDATE loyalty_processed_orders
            SET result_type = $1, qualifying_items = $2
            WHERE id = $3
        `, [resultType, purchaseEvents.length, processedOrderId]);

        await client.query('COMMIT');

        // Log summary
        if (skippedFreeItems.length > 0) {
            logger.info('Order intake skipped free items', {
                orderId, merchantId, source,
                skippedCount: skippedFreeItems.length,
                skippedItems: skippedFreeItems
            });
        }

        loyaltyLogger.audit({
            action: 'ORDER_INTAKE_COMPLETE',
            orderId,
            merchantId,
            squareCustomerId,
            source,
            resultType,
            qualifyingItems: purchaseEvents.length,
            totalLineItems: lineItems.length,
            rewardEarned
        });

        return { alreadyProcessed: false, purchaseEvents, rewardEarned };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Order intake failed', {
            error: error.message,
            stack: error.stack,
            orderId,
            merchantId,
            source
        });
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Check if an order has already been processed for loyalty.
 * Checks both loyalty_processed_orders and loyalty_purchase_events.
 *
 * @param {number} merchantId
 * @param {string} squareOrderId
 * @returns {Promise<boolean>}
 */
async function isOrderAlreadyProcessed(merchantId, squareOrderId) {
    const result = await db.query(`
        SELECT 1 FROM (
            SELECT 1 FROM loyalty_processed_orders
            WHERE merchant_id = $1 AND square_order_id = $2
            UNION ALL
            SELECT 1 FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND square_order_id = $2
            LIMIT 1
        ) AS found
        LIMIT 1
    `, [merchantId, squareOrderId]);
    return result.rows.length > 0;
}

module.exports = {
    processLoyaltyOrder,
    isOrderAlreadyProcessed
};
