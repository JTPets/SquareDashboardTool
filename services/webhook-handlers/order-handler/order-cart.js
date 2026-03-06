/**
 * Cart activity tracking for order webhooks
 *
 * Extracted from order-handler.js (Phase 2 split).
 * Handles DRAFT order → cart_activity routing, conversion detection,
 * and cancellation tracking.
 *
 * @module services/webhook-handlers/order-handler/order-cart
 */

const logger = require('../../../utils/logger');
const cartActivityService = require('../../cart/cart-activity-service');

/**
 * Process DRAFT order for cart activity tracking
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function processCartActivity(order, merchantId, result) {
    try {
        const cart = await cartActivityService.createFromDraftOrder(order, merchantId);
        if (cart) {
            result.cartActivity = {
                id: cart.id,
                itemCount: cart.item_count,
                status: cart.status
            };
            logger.info('DRAFT order routed to cart_activity', {
                merchantId,
                squareOrderId: order.id,
                cartActivityId: cart.id,
                source: order.source?.name
            });
        }
    } catch (err) {
        logger.error('Failed to process cart activity', {
            merchantId,
            squareOrderId: order.id,
            error: err.message
        });
    }
}

/**
 * Check for cart conversion when order transitions to OPEN/COMPLETED
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 */
async function checkCartConversion(orderId, merchantId) {
    try {
        const cart = await cartActivityService.markConverted(orderId, merchantId);
        if (cart) {
            logger.info('Cart conversion detected', {
                merchantId,
                squareOrderId: orderId,
                cartActivityId: cart.id
            });
        }
    } catch (err) {
        logger.warn('Failed to check cart conversion', {
            merchantId,
            squareOrderId: orderId,
            error: err.message
        });
    }
}

/**
 * Mark cart as canceled when order is canceled
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 */
async function markCartCanceled(orderId, merchantId) {
    try {
        await cartActivityService.markCanceled(orderId, merchantId);
    } catch (err) {
        logger.warn('Failed to mark cart canceled', {
            merchantId,
            squareOrderId: orderId,
            error: err.message
        });
    }
}

module.exports = { processCartActivity, checkCartConversion, markCartCanceled };
