/**
 * Order Webhook Handler
 *
 * Handles Square webhook events related to orders, fulfillments, payments, and refunds.
 * This is the largest handler, responsible for:
 * - Committed inventory sync
 * - Sales velocity updates
 * - Delivery order management
 * - Loyalty program integration
 *
 * Event types handled:
 * - order.created
 * - order.updated
 * - order.fulfillment.updated
 * - payment.created
 * - payment.updated
 * - refund.created
 * - refund.updated
 *
 * @module services/webhook-handlers/order-handler
 */

const logger = require('../../../utils/logger');
const loyaltyService = require('../../loyalty-admin');
const { getSquareClientForMerchant } = require('../../../middleware/merchant');

// Extracted in Phase 2 split
const { normalizeSquareOrder, fetchFullOrder } = require('./order-normalize');
const { processCartActivity, checkCartConversion, markCartCanceled } = require('./order-cart');
const { completedOrderVelocityCache, updateVelocityFromOrder, updateVelocityFromFulfillment } = require('./order-velocity');
const {
    ingestDeliveryOrder, handleOrderCancellation, handleOrderCompletion,
    refreshDeliveryOrderCustomerIfNeeded, handleFulfillmentDeliveryUpdate,
    autoIngestFromFulfillment
} = require('./order-delivery');
const {
    orderProcessingCache, identifyCustomerForOrder,
    processLoyalty, processPaymentForLoyalty
} = require('./order-loyalty');


/**
 * Metrics for tracking webhook order data usage vs API fallback
 * Helps measure effectiveness of P0-API-1 optimization
 */
const webhookOrderStats = {
    directUse: 0,
    apiFallback: 0,
    lastReset: Date.now()
};

// BACKLOG-10: Committed inventory sync is now handled by invoice webhooks
// (see inventory-handler.js). The debounced order-triggered sync has been removed.
// A daily reconciliation job provides a safety net (see committed-inventory-reconciliation-job.js).

class OrderHandler {
    /**
     * Handle order.created or order.updated event
     * Syncs committed inventory, sales velocity, delivery orders, and loyalty
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleOrderCreatedOrUpdated(context) {
        const { data, merchantId, event, entityId } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_ORDER_SYNC === 'false') {
            logger.info('Order webhook received but WEBHOOK_ORDER_SYNC is disabled');
            result.skipped = true;
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot sync committed inventory - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        // Square webhook structure varies by event type:
        // - order.created: data.order_created contains the order
        // - order.updated: data.order_updated contains the order
        // - Some webhooks may use data.order or include order directly in data
        const webhookOrder = data.order_created || data.order_updated || data.order || data;

        // Extract order ID from multiple possible locations for robustness
        // Priority: entityId (canonical from event.data.id) > webhook wrapper ID > fallback locations
        const orderId = entityId || webhookOrder?.id || data?.id || data?.order_id ||
                        data?.order_created?.id || data?.order_updated?.id;

        logger.debug('Order event detected via webhook', {
            orderId,
            state: webhookOrder?.state,
            eventType: event.type,
            merchantId,
            hasFulfillments: webhookOrder?.fulfillments?.length > 0
        });

        // BACKLOG-10: Committed inventory sync is now handled by invoice webhooks.
        // No committed inventory sync needed here — invoice.created/updated/etc. handle it.

        // Check if webhook has complete order data (with line_items for velocity calculation)
        const hasCompleteData = webhookOrder?.id && webhookOrder?.state &&
                                Array.isArray(webhookOrder?.line_items) && webhookOrder.line_items.length > 0;

        // Get the full order - either from webhook (if complete) or from API
        let order;
        if (hasCompleteData) {
            // Webhook has complete data - use directly (P0-API-1 optimization)
            order = webhookOrder;
            webhookOrderStats.directUse++;
            logger.debug('Using complete webhook order data', {
                orderId: order.id,
                lineItemCount: order.line_items.length,
                hasFulfillments: !!order.fulfillments?.length
            });
        } else if (orderId) {
            // Webhook only has notification - fetch full order from API (expected behavior)
            webhookOrderStats.apiFallback++;
            order = await this._fetchFullOrder(orderId, merchantId);
            logger.debug('Fetched full order from API', {
                orderId,
                success: !!order,
                hadWebhookData: !!webhookOrder?.id
            });
        } else {
            // No order ID available - cannot process
            logger.warn('Order webhook missing order ID - skipping', {
                merchantId,
                eventType: event.type,
                dataKeys: Object.keys(data || {})
            });
            result.skipped = true;
            result.reason = 'No order ID in webhook';
            return result;
        }

        // Log stats periodically (every 100 orders)
        const totalProcessed = webhookOrderStats.directUse + webhookOrderStats.apiFallback;
        if (totalProcessed > 0 && totalProcessed % 100 === 0) {
            const directRate = ((webhookOrderStats.directUse / totalProcessed) * 100).toFixed(1);
            logger.info('Order webhook stats', {
                directUse: webhookOrderStats.directUse,
                apiFetch: webhookOrderStats.apiFallback,
                directRate: `${directRate}%`
            });
        }

        // P0-API-2 OPTIMIZATION: Update sales velocity incrementally from this order
        // Instead of fetching ALL 91 days of orders (~37 API calls), we update velocity
        // directly from the order data (0 additional API calls)
        if (order && order.state === 'COMPLETED') {
            result.salesVelocity = await updateVelocityFromOrder(order, merchantId);

            // LOGIC CHANGE: Track expiry discount quantity sales (BACKLOG-94)
            try {
                const { trackExpiryDiscountSale } = require('../../expiry/discount-service');
                for (const lineItem of (order.lineItems || order.line_items || [])) {
                    const variationId = lineItem.catalogObjectId || lineItem.catalog_object_id;
                    const qty = parseInt(lineItem.quantity) || 1;
                    if (variationId && qty > 0) {
                        await trackExpiryDiscountSale(variationId, qty, merchantId);
                    }
                }
            } catch (expiryTrackErr) {
                // Non-blocking — don't fail order processing for this
                logger.warn('Failed to track expiry discount sale quantity', {
                    orderId: order.id, merchantId, error: expiryTrackErr.message
                });
            }
        }

        // Process delivery routing
        if (order) {
            await this._processDeliveryRouting(order, merchantId, result);
        }

        // Process loyalty for completed orders
        if (order && order.state === 'COMPLETED') {
            await this._processLoyalty(order, merchantId, result);
        }

        return result;
    }

    /**
     * Fetch full order from Square API
     * Delegates to extracted order-normalize module.
     *
     * @private
     * @param {string} orderId - Square order ID
     * @param {number} merchantId - Internal merchant ID
     * @returns {Promise<Object|null>} Order object or null if fetch fails
     */
    async _fetchFullOrder(orderId, merchantId) {
        return fetchFullOrder(orderId, merchantId);
    }

    /**
     * Process delivery order routing
     * @private
     */
    async _processDeliveryRouting(order, merchantId, result) {
        // Route DRAFT orders to cart_activity, not delivery
        if (order.state === 'DRAFT') {
            await this._processCartActivity(order, merchantId, result);
            return; // Don't process as delivery
        }

        // Check for cart conversion when order transitions to OPEN/COMPLETED
        if (['OPEN', 'COMPLETED'].includes(order.state)) {
            await this._checkCartConversion(order.id, merchantId);
        }

        // Check for cart cancellation
        if (order.state === 'CANCELED') {
            await this._markCartCanceled(order.id, merchantId);
        }

        // IMPORTANT: Check for customer refresh FIRST, before any early returns
        // Webhooks often have no fulfillments even when the order exists in our system
        if (['OPEN', 'COMPLETED'].includes(order.state)) {
            await this._refreshDeliveryOrderCustomerIfNeeded(order, merchantId, result);
        }

        if (!order.fulfillments || order.fulfillments.length === 0) {
            logger.debug('Order has no fulfillments for delivery routing', {
                orderId: order.id,
                state: order.state
            });
            return;
        }

        const deliveryFulfillment = order.fulfillments.find(f =>
            f.type === 'DELIVERY' || f.type === 'SHIPMENT'
        );

        if (!deliveryFulfillment) {
            const fulfillmentTypes = order.fulfillments.map(f => `${f.type}:${f.state}`);
            logger.debug('Order has fulfillments but none eligible for delivery routing', {
                orderId: order.id,
                fulfillments: fulfillmentTypes
            });
            return;
        }

        // Auto-ingest OPEN orders (not DRAFT - those go to cart_activity)
        if (order.state === 'OPEN') {
            await this._ingestDeliveryOrder(order, merchantId, result);
        }

        // Handle cancellation
        if (order.state === 'CANCELED') {
            await this._handleOrderCancellation(order.id, merchantId, result);
        }

        // Handle completion
        if (order.state === 'COMPLETED') {
            await this._handleOrderCompletion(order.id, merchantId, result);
        }
    }

    /**
     * Auto-ingest order for delivery
     * Delegates to extracted order-delivery module.
     * @private
     */
    async _ingestDeliveryOrder(order, merchantId, result) {
        return ingestDeliveryOrder(order, merchantId, result);
    }

    /**
     * Handle order cancellation
     * Delegates to extracted order-delivery module.
     * @private
     */
    async _handleOrderCancellation(orderId, merchantId, result) {
        return handleOrderCancellation(orderId, merchantId, result);
    }

    /**
     * Handle order completion
     * Delegates to extracted order-delivery module.
     * @private
     */
    async _handleOrderCompletion(orderId, merchantId, result) {
        return handleOrderCompletion(orderId, merchantId, result);
    }

    /**
     * Process DRAFT order for cart activity tracking
     * Delegates to extracted order-cart module.
     * @private
     */
    async _processCartActivity(order, merchantId, result) {
        return processCartActivity(order, merchantId, result);
    }

    /**
     * Check for cart conversion when order transitions to OPEN/COMPLETED
     * Delegates to extracted order-cart module.
     * @private
     */
    async _checkCartConversion(orderId, merchantId) {
        return checkCartConversion(orderId, merchantId);
    }

    /**
     * Mark cart as canceled when order is canceled
     * Delegates to extracted order-cart module.
     * @private
     */
    async _markCartCanceled(orderId, merchantId) {
        return markCartCanceled(orderId, merchantId);
    }

    /**
     * Refresh customer data for orders that were ingested with incomplete data
     * Delegates to extracted order-delivery module.
     * @private
     */
    async _refreshDeliveryOrderCustomerIfNeeded(order, merchantId, result) {
        return refreshDeliveryOrderCustomerIfNeeded(order, merchantId, result);
    }

    /**
     * Process loyalty for completed order
     * Delegates to extracted order-loyalty module.
     * @private
     */
    async _processLoyalty(order, merchantId, result) {
        return processLoyalty(order, merchantId, result);
    }

    /**
     * Handle order.fulfillment.updated event
     * Updates delivery status and syncs inventory/velocity
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with sync details
     */
    async handleFulfillmentUpdated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_ORDER_SYNC === 'false') {
            logger.info('Fulfillment webhook received but WEBHOOK_ORDER_SYNC is disabled');
            result.skipped = true;
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot sync fulfillment - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        const fulfillment = data.fulfillment;
        logger.info('Order fulfillment updated via webhook', {
            fulfillmentId: fulfillment?.uid,
            state: fulfillment?.state,
            orderId: data.order_id,
            merchantId
        });

        // BACKLOG-10: Committed inventory sync now handled by invoice webhooks.

        // P0-API-2 OPTIMIZATION: Update sales velocity incrementally if completed
        // Fulfillment webhooks don't include line_items, so we fetch THIS order (1 API call)
        // instead of all 91 days of orders (~37 API calls)
        if (fulfillment?.state === 'COMPLETED' && data.order_id) {
            const velocityResult = await updateVelocityFromFulfillment(data.order_id, merchantId);
            if (velocityResult) {
                result.salesVelocity = velocityResult;
            }
        }

        // Update delivery order status
        if (data.order_id && fulfillment?.state) {
            await this._handleFulfillmentDeliveryUpdate(
                data.order_id,
                fulfillment,
                merchantId,
                result
            );
        }

        return result;
    }

    /**
     * Handle delivery status update from fulfillment
     * Delegates to extracted order-delivery module.
     * @private
     */
    async _handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result) {
        return handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);
    }

    /**
     * Auto-ingest order from fulfillment update
     * Delegates to extracted order-delivery module.
     * @private
     */
    async _autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result) {
        return autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);
    }

    /**
     * Handle payment.created event
     * Logs the payment event and processes loyalty if payment is already completed
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with payment details
     */
    async handlePaymentCreated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (!merchantId) {
            logger.debug('Payment.created webhook - merchant not found, skipping');
            return result;
        }

        const payment = data;
        const paymentLogFn = payment.status === 'COMPLETED' ? logger.info : logger.debug;
        paymentLogFn.call(logger, 'Payment created webhook received', {
            paymentId: payment.id,
            orderId: payment.order_id,
            status: payment.status,
            merchantId
        });

        result.paymentCreated = {
            paymentId: payment.id,
            orderId: payment.order_id,
            status: payment.status
        };

        // If payment is already COMPLETED (rare for .created), process immediately
        if (payment.status === 'COMPLETED' && payment.order_id) {
            await this._processPaymentForLoyalty(payment, merchantId, result, 'payment.created');
        }

        return result;
    }

    /**
     * Handle payment.updated event
     * Processes loyalty when payment is completed
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with loyalty details
     */
    async handlePaymentUpdated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (!merchantId) {
            logger.debug('Payment webhook - merchant not found, skipping loyalty');
            return result;
        }

        const payment = data;

        // Only process COMPLETED payments with an order_id
        if (payment.status === 'COMPLETED' && payment.order_id) {
            await this._processPaymentForLoyalty(payment, merchantId, result, 'payment.updated');
        }

        return result;
    }

    /**
     * Process payment for loyalty
     * Delegates to extracted order-loyalty module.
     * @private
     */
    async _processPaymentForLoyalty(payment, merchantId, result, source) {
        return processPaymentForLoyalty(payment, merchantId, result, source);
    }

    /**
     * Handle refund.created or refund.updated event
     * Processes loyalty refunds when refund is completed
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with refund details
     */
    async handleRefundCreatedOrUpdated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_ORDER_SYNC === 'false') {
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot process refund - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        const refund = data;
        logger.info('Refund event received via webhook', {
            refundId: refund.id,
            orderId: refund.order_id,
            status: refund.status,
            merchantId
        });

        // Only process completed refunds
        if (refund.status !== 'COMPLETED' || !refund.order_id) {
            return result;
        }

        try {
            const squareClient = await getSquareClientForMerchant(merchantId);
            const orderResponse = await squareClient.orders.get({ orderId: refund.order_id });
            const order = orderResponse.order;

            if (order && order.returns?.length > 0) {
                const refundResult = await loyaltyService.processOrderRefundsForLoyalty(order, merchantId);
                if (refundResult.processed) {
                    result.loyaltyRefunds = {
                        refundsProcessed: refundResult.refundsProcessed.length
                    };
                    logger.info('Loyalty refunds processed via refund webhook', {
                        orderId: order.id,
                        refundCount: refundResult.refundsProcessed.length
                    });
                }
            }
        } catch (refundError) {
            logger.error('Refund webhook processing failed', {
                error: refundError.message,
                stack: refundError.stack
            });
            result.error = refundError.message;
        }

        return result;
    }
}

module.exports = OrderHandler;
// Export normalization utility for use by catchup job and other services
module.exports.normalizeSquareOrder = normalizeSquareOrder;
// Export caches for testing
module.exports._orderProcessingCache = orderProcessingCache;
module.exports._completedOrderVelocityCache = completedOrderVelocityCache;
