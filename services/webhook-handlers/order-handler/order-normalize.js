/**
 * Order normalization and fetching utilities
 *
 * Extracted from order-handler.js (Phase 2 split).
 * Contains Square SDK camelCase → snake_case normalization
 * and the full order fetch helper.
 *
 * @module services/webhook-handlers/order-handler/order-normalize
 */

const logger = require('../../../utils/logger');
const { getSquareClientForMerchant } = require('../../../middleware/merchant');

/**
 * Normalize Square SDK order fields from camelCase to snake_case.
 * Square SDK v43+ returns camelCase properties, but webhook payloads
 * and most of our codebase expect snake_case. This adds snake_case
 * aliases to critical fields so both formats work.
 *
 * Applied when orders are fetched from the Square API (not webhooks).
 */
function normalizeSquareOrder(order) {
    if (!order) return order;

    // Top-level order fields
    if (order.lineItems && !order.line_items) order.line_items = order.lineItems;
    if (order.customerId && !order.customer_id) order.customer_id = order.customerId;
    if (order.locationId && !order.location_id) order.location_id = order.locationId;
    if (order.totalMoney && !order.total_money) order.total_money = order.totalMoney;
    if (order.createdAt && !order.created_at) order.created_at = order.createdAt;

    // Normalize discount fields (critical for redemption detection)
    if (order.discounts) {
        for (const d of order.discounts) {
            if (d.catalogObjectId && !d.catalog_object_id) d.catalog_object_id = d.catalogObjectId;
            if (d.appliedMoney && !d.applied_money) d.applied_money = d.appliedMoney;
            if (d.amountMoney && !d.amount_money) d.amount_money = d.amountMoney;
        }
    }

    // Normalize line item fields (critical for purchase recording)
    const items = order.line_items || order.lineItems || [];
    for (const item of items) {
        if (item.catalogObjectId && !item.catalog_object_id) item.catalog_object_id = item.catalogObjectId;
        if (item.totalMoney && !item.total_money) item.total_money = item.totalMoney;
        if (item.basePriceMoney && !item.base_price_money) item.base_price_money = item.basePriceMoney;
        if (item.variationName && !item.variation_name) item.variation_name = item.variationName;
    }

    // Normalize tender fields (customer identification fallback)
    if (order.tenders) {
        for (const t of order.tenders) {
            if (t.customerId && !t.customer_id) t.customer_id = t.customerId;
        }
    }

    // Normalize fulfillment fields (customer identification fallback)
    if (order.fulfillments) {
        for (const f of order.fulfillments) {
            if (f.pickupDetails && !f.pickup_details) f.pickup_details = f.pickupDetails;
            if (f.deliveryDetails && !f.delivery_details) f.delivery_details = f.deliveryDetails;
            const details = f.pickup_details || f.delivery_details;
            if (details?.recipient) {
                const r = details.recipient;
                if (r.phoneNumber && !r.phone_number) r.phone_number = r.phoneNumber;
                if (r.emailAddress && !r.email_address) r.email_address = r.emailAddress;
                if (r.displayName && !r.display_name) r.display_name = r.displayName;
            }
        }
    }

    return order;
}

/**
 * Fetch full order from Square API
 *
 * Called when webhook doesn't contain complete order data (which is normal
 * for notification-style webhooks vs expanded webhooks).
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object|null>} Order object or null if fetch fails
 */
async function fetchFullOrder(orderId, merchantId) {
    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId });
        if (orderResponse.order) {
            // SDK v43+ returns camelCase — normalize to snake_case
            return normalizeSquareOrder(orderResponse.order);
        }
        logger.warn('Order fetch returned no order', { orderId, merchantId });
        return null;
    } catch (fetchError) {
        logger.error('Failed to fetch order from Square API', {
            orderId,
            merchantId,
            error: fetchError.message
        });
        return null;
    }
}

module.exports = { normalizeSquareOrder, fetchFullOrder };
