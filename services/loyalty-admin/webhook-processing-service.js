/**
 * Loyalty Webhook Processing Service
 *
 * Handles order processing from Square webhooks:
 * - processOrderForLoyalty: Extract and process qualifying purchases from orders
 * - processOrderRefundsForLoyalty: Process refunds that affect loyalty tracking
 *
 * Extracted from loyalty-service.js as part of final P1-1 monolith elimination.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../loyalty/loyalty-logger');

// Direct sibling imports (not through index.js)
const { getSetting } = require('./settings-service');
const { getCustomerDetails } = require('./customer-admin-service');
const { updateCustomerStats } = require('./customer-cache-service');
const { LoyaltyCustomerService } = require('../loyalty/customer-service');
const { processQualifyingPurchase, processRefund } = require('./purchase-service');

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

    // Customer identification — delegate to canonical LoyaltyCustomerService
    // (6-method fallback chain with rate-limit protection and throttling)
    const customerService = new LoyaltyCustomerService(merchantId);
    await customerService.initialize();
    const customerResult = await customerService.identifyCustomerFromOrder(order);

    let squareCustomerId = customerResult.customerId;
    let customerSource = options.customerSourceOverride || customerResult.method;

    if (!squareCustomerId) {
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
// EXPORTS
// ============================================================================

module.exports = {
    processOrderForLoyalty,
    processOrderRefundsForLoyalty
};
