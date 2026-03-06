/**
 * Sales velocity update logic for order webhooks
 *
 * Extracted from order-handler.js (Phase 2 split).
 * Contains the dedup cache and incremental velocity update functions
 * for both order.created/updated and fulfillment.updated paths.
 *
 * @module services/webhook-handlers/order-handler/order-velocity
 */

const logger = require('../../../utils/logger');
const squareApi = require('../../square');
const { getSquareClientForMerchant } = require('../../../middleware/merchant');
const TTLCache = require('../../../utils/ttl-cache');
const { normalizeSquareOrder } = require('./order-normalize');

/**
 * Dedup cache for completed order velocity updates.
 * Prevents calling velocity update for duplicate order.created/order.updated/fulfillment.updated
 * webhooks for the same completed order. Keyed by `${orderId}:${merchantId}`.
 * 60s TTL covers the typical burst window of 4-5 webhooks over ~5 seconds.
 * The velocity function in square-velocity.js has its own 120s dedup as a safety net.
 */
const completedOrderVelocityCache = new TTLCache(60000);

/**
 * Update sales velocity incrementally from a completed order.
 * Handles dedup via completedOrderVelocityCache and wraps the velocity
 * update in try/catch so failures don't block downstream processing.
 *
 * Called from handleOrderCreatedOrUpdated for COMPLETED orders.
 *
 * @param {Object} order - Square order object (must be COMPLETED)
 * @param {number} merchantId - Internal merchant ID
 * @returns {Object} Velocity result for the webhook result object
 */
async function updateVelocityFromOrder(order, merchantId) {
    const velocityDedupKey = `${order.id}:${merchantId}`;
    if (completedOrderVelocityCache.has(velocityDedupKey)) {
        logger.debug('Sales velocity dedup — skipping duplicate order webhook', {
            orderId: order.id,
            merchantId
        });
        return { method: 'incremental', deduplicated: true };
    }

    try {
        completedOrderVelocityCache.set(velocityDedupKey, true);
        const velocityResult = await squareApi.updateSalesVelocityFromOrder(order, merchantId);
        if (velocityResult.updated > 0) {
            logger.info('Sales velocity updated incrementally from completed order', {
                orderId: order.id,
                updated: velocityResult.updated,
                merchantId
            });
        }
        return {
            method: 'incremental',
            updated: velocityResult.updated,
            skipped: velocityResult.skipped,
            periods: velocityResult.periods
        };
    } catch (velocityError) {
        logger.warn('Sales velocity update failed — continuing with delivery and loyalty', {
            orderId: order.id,
            merchantId,
            error: velocityError.message
        });
        return { method: 'incremental', error: velocityError.message };
    }
}

/**
 * Update sales velocity from a fulfillment webhook.
 * Fulfillment webhooks don't include line_items, so this fetches the order
 * first (1 API call) then updates velocity if the order is COMPLETED.
 *
 * Called from handleFulfillmentUpdated for COMPLETED fulfillments.
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Object|null} Velocity result or null if not applicable
 */
async function updateVelocityFromFulfillment(orderId, merchantId) {
    const velocityDedupKey = `${orderId}:${merchantId}`;
    if (completedOrderVelocityCache.has(velocityDedupKey)) {
        logger.debug('Sales velocity dedup — skipping duplicate fulfillment webhook', {
            orderId,
            merchantId
        });
        return { method: 'incremental', fromFulfillment: true, deduplicated: true };
    }

    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId });

        // SDK v43+ returns camelCase — normalize to snake_case
        const fulfillmentOrder = normalizeSquareOrder(orderResponse.order);
        if (fulfillmentOrder?.state === 'COMPLETED') {
            completedOrderVelocityCache.set(velocityDedupKey, true);
            const velocityResult = await squareApi.updateSalesVelocityFromOrder(
                fulfillmentOrder,
                merchantId
            );
            if (velocityResult.updated > 0) {
                logger.info('Sales velocity updated incrementally via fulfillment', {
                    orderId,
                    updated: velocityResult.updated
                });
            }
            return {
                method: 'incremental',
                fromFulfillment: true,
                updated: velocityResult.updated
            };
        }
        return null;
    } catch (fetchErr) {
        logger.warn('Could not fetch order for fulfillment velocity update', {
            orderId,
            error: fetchErr.message
        });
        return null;
    }
}

module.exports = {
    completedOrderVelocityCache,
    updateVelocityFromOrder,
    updateVelocityFromFulfillment
};
