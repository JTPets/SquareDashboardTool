/**
 * Delivery routing logic for order webhooks
 *
 * Extracted from order-handler.js (Phase 2 split).
 * Handles auto-ingestion, cancellation, completion, fulfillment updates,
 * and customer data refresh for delivery orders.
 *
 * @module services/webhook-handlers/order-handler/order-delivery
 */

const logger = require('../../../utils/logger');
const deliveryApi = require('../../delivery');
const { getSquareClientForMerchant } = require('../../../middleware/merchant');
const { getCustomerDetails: getSquareCustomerDetails } = require('../../loyalty-admin/customer-details-service');
const { fetchFullOrder } = require('./order-normalize');

/**
 * Auto-ingest order for delivery
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function ingestDeliveryOrder(order, merchantId, result) {
    try {
        const deliverySettings = await deliveryApi.getSettings(merchantId);
        const autoIngest = deliverySettings?.auto_ingest_ready_orders !== false;

        if (!autoIngest) {
            return;
        }

        const deliveryOrder = await deliveryApi.ingestSquareOrder(merchantId, order);
        if (deliveryOrder) {
            result.deliveryOrder = {
                id: deliveryOrder.id,
                customerName: deliveryOrder.customer_name,
                isNew: !deliveryOrder.square_synced_at
            };
            logger.info('Ingested Square order for delivery', {
                merchantId,
                squareOrderId: order.id,
                deliveryOrderId: deliveryOrder.id
            });
        }
    } catch (deliveryError) {
        // LOGIC CHANGE: added merchantId to error log context (L-2)
        logger.error('Failed to ingest order for delivery', {
            error: deliveryError.message,
            orderId: order.id,
            merchantId
        });
    }
}

/**
 * Handle order cancellation
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function handleOrderCancellation(orderId, merchantId, result) {
    try {
        await deliveryApi.handleSquareOrderUpdate(merchantId, orderId, 'CANCELED');
        logger.info('Removed cancelled order from delivery queue', { squareOrderId: orderId });
    } catch (cancelError) {
        // LOGIC CHANGE: added merchantId to error log context (L-2)
        logger.error('Failed to handle order cancellation for delivery', {
            error: cancelError.message,
            orderId,
            merchantId
        });
    }
}

/**
 * Handle order completion
 *
 * @param {string} orderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function handleOrderCompletion(orderId, merchantId, result) {
    try {
        await deliveryApi.handleSquareOrderUpdate(merchantId, orderId, 'COMPLETED');
        result.deliveryCompletion = { squareOrderId: orderId };
        logger.info('Marked delivery order as completed via webhook', { squareOrderId: orderId });
    } catch (completeError) {
        logger.error('Failed to handle order completion for delivery', {
            error: completeError.message,
            orderId
        });
    }
}

/**
 * Refresh customer data for orders that were ingested with incomplete data
 * Triggered when order state changes from DRAFT to OPEN/COMPLETED
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function refreshDeliveryOrderCustomerIfNeeded(order, merchantId, result) {
    try {
        // Check if we have this order and it needs refresh
        const existingOrder = await deliveryApi.getOrderBySquareId(merchantId, order.id);
        if (!existingOrder || !existingOrder.needs_customer_refresh) {
            return;
        }

        logger.info('Refreshing customer data for delivery order', {
            merchantId,
            squareOrderId: order.id,
            deliveryOrderId: existingOrder.id,
            previousName: existingOrder.customer_name,
            newState: order.state
        });

        // Fetch full order from Square API since webhook often lacks fulfillment details
        let fullOrder = order;
        if (!order.fulfillments || order.fulfillments.length === 0) {
            logger.info('Fetching full order from Square API for customer refresh', {
                squareOrderId: order.id,
                merchantId
            });
            fullOrder = await fetchFullOrder(order.id, merchantId);
            if (!fullOrder) {
                logger.warn('Could not fetch full order for customer refresh', {
                    squareOrderId: order.id,
                    merchantId
                });
                return;
            }
        }

        // Find delivery fulfillment
        const deliveryFulfillment = fullOrder.fulfillments?.find(f =>
            f.type === 'DELIVERY' || f.type === 'SHIPMENT'
        );

        let customerName = null;
        let phone = null;

        // Extract customer data from fulfillment recipient
        if (deliveryFulfillment) {
            const deliveryDetails = deliveryFulfillment.deliveryDetails || deliveryFulfillment.delivery_details;
            const shipmentDetails = deliveryFulfillment.shipmentDetails || deliveryFulfillment.shipment_details;
            const details = deliveryDetails || shipmentDetails;

            if (details?.recipient) {
                customerName = details.recipient.displayName || details.recipient.display_name;
                phone = details.recipient.phoneNumber || details.recipient.phone_number;
            }
        }

        // Fallback: lookup customer via customer ID if still missing
        const squareCustomerId = fullOrder.customerId || fullOrder.customer_id;
        if ((!customerName || customerName === existingOrder.customer_name) && squareCustomerId) {
            try {
                const customerDetails = await getSquareCustomerDetails(squareCustomerId, merchantId);

                if (customerDetails) {
                    if (!customerName && customerDetails.displayName) {
                        customerName = customerDetails.displayName;
                    }
                    if (!phone && customerDetails.phone) {
                        phone = customerDetails.phone;
                    }
                }
            } catch (lookupError) {
                logger.warn('Customer lookup failed during refresh', {
                    merchantId,
                    squareCustomerId,
                    error: lookupError.message
                });
            }
        }

        // Build updates
        const updates = {
            squareOrderState: order.state,
            needsCustomerRefresh: false  // Clear the flag
        };

        if (customerName && customerName !== 'Unknown Customer' && customerName !== existingOrder.customer_name) {
            updates.customerName = customerName;
        }
        if (phone && !existingOrder.phone) {
            updates.phone = phone;
        }
        if (squareCustomerId && !existingOrder.square_customer_id) {
            updates.squareCustomerId = squareCustomerId;
        }

        // Also refresh order data (line items, totals) since DRAFT orders have incomplete data
        if (fullOrder.lineItems || fullOrder.line_items) {
            const lineItems = fullOrder.lineItems || fullOrder.line_items || [];
            updates.squareOrderData = {
                lineItems: lineItems.map(item => ({
                    name: item.name,
                    quantity: item.quantity,
                    variationName: item.variationName || item.variation_name,
                    modifiers: item.modifiers || [],
                    note: item.note
                })),
                totalMoney: fullOrder.totalMoney || fullOrder.total_money,
                createdAt: fullOrder.createdAt || fullOrder.created_at,
                state: fullOrder.state
            };
            logger.info('Refreshing order data (line items, total)', {
                merchantId,
                squareOrderId: order.id,
                lineItemCount: lineItems.length,
                totalAmount: updates.squareOrderData.totalMoney?.amount
            });
        }

        await deliveryApi.updateOrder(merchantId, existingOrder.id, updates);

        logger.info('Delivery order customer refreshed', {
            action: 'DELIVERY_CUSTOMER_REFRESHED',
            merchantId,
            deliveryOrderId: existingOrder.id,
            squareOrderId: order.id,
            previousName: existingOrder.customer_name,
            newName: updates.customerName || existingOrder.customer_name,
            hasPhone: !!(updates.phone || existingOrder.phone)
        });

        result.deliveryCustomerRefresh = {
            orderId: existingOrder.id,
            previousName: existingOrder.customer_name,
            newName: updates.customerName || existingOrder.customer_name
        };
    } catch (refreshError) {
        logger.error('Failed to refresh delivery order customer', {
            error: refreshError.message,
            squareOrderId: order.id,
            merchantId
        });
    }
}

/**
 * Handle delivery status update from fulfillment
 *
 * @param {string} squareOrderId - Square order ID
 * @param {Object} fulfillment - Fulfillment object from webhook
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result) {
    const fulfillmentState = fulfillment.state;
    const fulfillmentType = fulfillment.type;

    // Only process delivery/shipment fulfillments
    if (fulfillmentType !== 'DELIVERY' && fulfillmentType !== 'SHIPMENT') {
        return;
    }

    try {
        if (fulfillmentState === 'COMPLETED' || fulfillmentState === 'CANCELED') {
            await deliveryApi.handleSquareOrderUpdate(merchantId, squareOrderId, fulfillmentState);
            result.deliveryUpdate = {
                orderId: squareOrderId,
                fulfillmentState,
                action: fulfillmentState === 'COMPLETED' ? 'marked_completed' : 'removed'
            };
            logger.info('Delivery order updated via fulfillment webhook', {
                squareOrderId,
                fulfillmentState,
                merchantId
            });
        } else if (fulfillmentState === 'FAILED') {
            await deliveryApi.handleSquareOrderUpdate(merchantId, squareOrderId, 'CANCELED');
            result.deliveryUpdate = {
                orderId: squareOrderId,
                fulfillmentState: 'FAILED',
                action: 'removed'
            };
            logger.info('Failed delivery order removed via fulfillment webhook', {
                squareOrderId,
                merchantId
            });
        } else if (!['COMPLETED', 'CANCELED', 'FAILED'].includes(fulfillmentState)) {
            // Auto-ingest non-terminal states
            await autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);
        }
    } catch (deliveryError) {
        logger.warn('Delivery order update via fulfillment webhook failed', {
            error: deliveryError.message,
            orderId: squareOrderId
        });
        result.deliveryError = deliveryError.message;
    }
}

/**
 * Auto-ingest order from fulfillment update
 *
 * @param {string} squareOrderId - Square order ID
 * @param {string} fulfillmentState - Fulfillment state
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result) {
    try {
        const deliverySettings = await deliveryApi.getSettings(merchantId);
        const autoIngest = deliverySettings?.auto_ingest_ready_orders !== false;

        if (!autoIngest) {
            logger.info('Skipped auto-ingest - disabled in settings', {
                squareOrderId,
                fulfillmentState,
                merchantId
            });
            return;
        }

        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId: squareOrderId });
        const fullOrder = orderResponse.order;

        if (fullOrder) {
            const deliveryOrder = await deliveryApi.ingestSquareOrder(merchantId, fullOrder);
            if (deliveryOrder) {
                result.deliveryUpdate = {
                    orderId: squareOrderId,
                    fulfillmentState,
                    action: 'ingested',
                    deliveryOrderId: deliveryOrder.id
                };
                logger.info('Auto-ingested delivery order via fulfillment webhook', {
                    squareOrderId,
                    fulfillmentState,
                    deliveryOrderId: deliveryOrder.id,
                    merchantId
                });
            }
        }
    } catch (ingestError) {
        logger.warn('Auto-ingest via fulfillment webhook failed', {
            error: ingestError.message,
            squareOrderId,
            fulfillmentState
        });
    }
}

module.exports = {
    ingestDeliveryOrder,
    handleOrderCancellation,
    handleOrderCompletion,
    refreshDeliveryOrderCustomerIfNeeded,
    handleFulfillmentDeliveryUpdate,
    autoIngestFromFulfillment
};
