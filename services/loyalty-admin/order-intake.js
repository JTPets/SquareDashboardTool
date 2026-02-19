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
            client.release();
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
            client.release();

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

        // --- Process each line item ---
        const purchaseEvents = [];
        let rewardEarned = false;
        const skippedFreeItems = [];

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

            try {
                const result = await processQualifyingPurchase({
                    merchantId,
                    squareOrderId: orderId,
                    squareCustomerId,
                    variationId,
                    quantity,
                    unitPriceCents,
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
                // Log but don't fail the whole order — other items may still qualify
                logger.error('Error processing line item in order intake', {
                    error: err.message,
                    orderId,
                    variationId,
                    merchantId,
                    source
                });
            }
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

/**
 * Build a map of discount UIDs to loyalty-discount info.
 * Used to detect and skip line items that have our loyalty discounts applied.
 *
 * @param {Object} order - Square order
 * @param {number} merchantId
 * @returns {Promise<Object>} { lineItemDiscountMap, orderUsedOurDiscount }
 */
async function buildDiscountMap(order, merchantId) {
    const orderDiscounts = order.discounts || [];
    const lineItemDiscountMap = new Map();

    if (orderDiscounts.length === 0) {
        return { lineItemDiscountMap, orderUsedOurDiscount: false };
    }

    // Fetch our loyalty discount IDs
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

    const orderUsedOurDiscount = orderDiscounts.some(d =>
        d.catalog_object_id && ourLoyaltyDiscountIds.has(d.catalog_object_id)
    );

    for (const discount of orderDiscounts) {
        const isOurLoyaltyDiscount = discount.catalog_object_id &&
            ourLoyaltyDiscountIds.has(discount.catalog_object_id);

        if (discount.applied_money?.amount > 0) {
            lineItemDiscountMap.set(discount.uid, {
                isOurLoyaltyDiscount,
                amount: discount.applied_money.amount
            });
        }
    }

    return { lineItemDiscountMap, orderUsedOurDiscount };
}

/**
 * Determine if a line item should be skipped (free, no variation, etc.)
 *
 * @param {Object} lineItem - Square line item
 * @param {Map} lineItemDiscountMap - Discount map from buildDiscountMap
 * @param {string} orderId - For logging
 * @param {number} merchantId - For logging
 * @returns {Object} { skip: boolean, reason?: string, variationId?, quantity? }
 */
function shouldSkipLineItem(lineItem, lineItemDiscountMap, orderId, merchantId) {
    const variationId = lineItem.catalog_object_id;

    if (!variationId) {
        loyaltyLogger.debug({
            action: 'LINE_ITEM_EVALUATION',
            orderId,
            lineItemId: lineItem.uid,
            variationId: null,
            decision: 'SKIP_NO_VARIATION',
            merchantId,
        });
        return { skip: true };
    }

    const quantity = parseInt(lineItem.quantity) || 0;
    if (quantity <= 0) {
        loyaltyLogger.debug({
            action: 'LINE_ITEM_EVALUATION',
            orderId,
            lineItemId: lineItem.uid,
            variationId,
            quantity,
            decision: 'SKIP_ZERO_QUANTITY',
            merchantId,
        });
        return { skip: true };
    }

    // Pricing checks (BigInt → Number for Square SDK v43+)
    const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
    const grossSalesCents = Number(lineItem.gross_sales_money?.amount || 0) || (unitPriceCents * quantity);
    const totalDiscountCents = Number(lineItem.total_discount_money?.amount || 0);
    const rawTotalMoney = lineItem.total_money?.amount;
    const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : (grossSalesCents - totalDiscountCents);

    // Skip 100% discounted items
    if (grossSalesCents > 0 && totalMoneyCents === 0) {
        loyaltyLogger.debug({
            action: 'LINE_ITEM_EVALUATION',
            orderId,
            lineItemId: lineItem.uid,
            variationId,
            quantity,
            decision: 'SKIP_FREE',
            merchantId,
        });
        return { skip: true, reason: 'fully_discounted_to_zero', variationId, quantity };
    }

    // Skip items with our loyalty discount applied
    const appliedDiscounts = lineItem.applied_discounts || [];
    const itemHasOurLoyaltyDiscount = appliedDiscounts.some(ad => {
        const discountInfo = lineItemDiscountMap.get(ad.discount_uid);
        return discountInfo?.isOurLoyaltyDiscount;
    });

    if (itemHasOurLoyaltyDiscount) {
        loyaltyLogger.debug({
            action: 'LINE_ITEM_EVALUATION',
            orderId,
            lineItemId: lineItem.uid,
            variationId,
            quantity,
            decision: 'SKIP_OUR_LOYALTY',
            merchantId,
        });
        return { skip: true, reason: 'loyalty_reward_redemption', variationId, quantity };
    }

    // Item should be processed
    loyaltyLogger.debug({
        action: 'LINE_ITEM_EVALUATION',
        orderId,
        lineItemId: lineItem.uid,
        variationId,
        quantity,
        decision: 'PROCESS',
        merchantId,
    });
    return { skip: false };
}

module.exports = {
    processLoyaltyOrder,
    isOrderAlreadyProcessed
};
