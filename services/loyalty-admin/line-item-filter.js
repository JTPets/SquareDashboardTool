/**
 * Line Item Filter Service
 *
 * Extracted from order-intake.js — line item qualification and discount detection.
 *
 * Determines which line items in a Square order qualify for loyalty tracking
 * and which should be skipped (free items, zero quantity, loyalty reward
 * redemptions, etc.).
 *
 * @module services/loyalty-admin/line-item-filter
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');

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
        // LOGIC CHANGE (LOW-3): Added AND status = 'earned' filter.
        // Before: fetched discount IDs from ALL reward statuses, causing
        // non-earned reward discounts to incorrectly skip qualifying items.
        const loyaltyDiscountsResult = await db.query(`
            SELECT square_discount_id, square_pricing_rule_id
            FROM loyalty_rewards
            WHERE merchant_id = $1
              AND status = 'earned'
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

module.exports = { shouldSkipLineItem, buildDiscountMap };
