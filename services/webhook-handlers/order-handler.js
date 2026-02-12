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

const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');
const deliveryApi = require('../../utils/delivery-api');
const loyaltyService = require('../../utils/loyalty-service');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const { FEATURE_FLAGS } = require('../../config/constants');

// Modern loyalty service (feature-flagged)
const { LoyaltyWebhookService } = require('../loyalty');

// Cart activity tracking for DRAFT orders
const cartActivityService = require('../cart/cart-activity-service');

// Square API version for direct API calls
const SQUARE_API_VERSION = '2025-01-16';

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

/**
 * Process order for loyalty using either modern or legacy service
 * Feature flag: USE_NEW_LOYALTY_SERVICE
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} [options] - Processing options
 * @param {string} [options.source] - Source of event (e.g., 'WEBHOOK', 'PAYMENT')
 * @param {Object} [options.redemptionContext] - Redemption context if this is a redemption order
 * @param {string} [options.redemptionContext.rewardId] - ID of reward being redeemed
 * @param {string} [options.redemptionContext.offerId] - Offer ID of the reward
 * @param {boolean} [options.redemptionContext.isRedemptionOrder] - True if this order has a redemption
 * @returns {Promise<Object>} Normalized result compatible with legacy format
 */
async function processOrderForLoyalty(order, merchantId, options = {}) {
    const { source = 'WEBHOOK', redemptionContext = null } = options;

    if (FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE) {
        // Use modern service
        logger.debug('Using modern loyalty service for order processing', {
            orderId: order.id,
            merchantId,
            source,
            hasRedemptionContext: !!redemptionContext
        });

        const service = new LoyaltyWebhookService(merchantId);
        await service.initialize();
        const result = await service.processOrder(order, { source, redemptionContext });

        // Adapt modern result to legacy format for compatibility
        // Modern: { processed, customerId, lineItemResults, summary, trace }
        // Legacy: { processed, purchasesRecorded, customerId }
        return {
            processed: result.processed,
            customerId: result.customerId || null,
            purchasesRecorded: (result.lineItemResults || [])
                .filter(r => r.recorded)
                .map(r => ({
                    variationId: r.variationId,
                    quantity: r.quantity,
                    rewardEarned: r.rewardEarned || false,
                    rewardId: r.purchaseResult?.results?.[0]?.progress?.rewardEarned
                        ? r.purchaseResult.results[0].purchaseEventId
                        : null,
                    reward: r.rewardEarned ? {
                        status: 'earned',
                        rewardId: r.purchaseResult?.results?.[0]?.purchaseEventId
                    } : null
                })),
            // Include modern-only fields for enhanced logging
            _modern: true,
            _trace: result.trace,
            _summary: result.summary
        };
    }

    // Use legacy service (default)
    return loyaltyService.processOrderForLoyalty(order, merchantId);
}

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

        logger.info('Order event detected via webhook', {
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
            const velocityResult = await squareApi.updateSalesVelocityFromOrder(order, merchantId);
            result.salesVelocity = {
                method: 'incremental',
                updated: velocityResult.updated,
                skipped: velocityResult.skipped,
                periods: velocityResult.periods
            };
            logger.info('Sales velocity updated incrementally from completed order (P0-API-2)', {
                orderId: order.id,
                updated: velocityResult.updated,
                merchantId
            });
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
     *
     * Called when webhook doesn't contain complete order data (which is normal
     * for notification-style webhooks vs expanded webhooks).
     *
     * @private
     * @param {string} orderId - Square order ID
     * @param {number} merchantId - Internal merchant ID
     * @returns {Promise<Object|null>} Order object or null if fetch fails
     */
    async _fetchFullOrder(orderId, merchantId) {
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
     * @private
     */
    async _ingestDeliveryOrder(order, merchantId, result) {
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
            logger.error('Failed to ingest order for delivery', {
                error: deliveryError.message,
                orderId: order.id
            });
        }
    }

    /**
     * Handle order cancellation
     * @private
     */
    async _handleOrderCancellation(orderId, merchantId, result) {
        try {
            await deliveryApi.handleSquareOrderUpdate(merchantId, orderId, 'CANCELED');
            logger.info('Removed cancelled order from delivery queue', { squareOrderId: orderId });
        } catch (cancelError) {
            logger.error('Failed to handle order cancellation for delivery', {
                error: cancelError.message,
                orderId
            });
        }
    }

    /**
     * Handle order completion
     * @private
     */
    async _handleOrderCompletion(orderId, merchantId, result) {
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
     * Process DRAFT order for cart activity tracking
     * @private
     */
    async _processCartActivity(order, merchantId, result) {
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
     * @private
     */
    async _checkCartConversion(orderId, merchantId) {
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
     * @private
     */
    async _markCartCanceled(orderId, merchantId) {
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

    /**
     * Refresh customer data for orders that were ingested with incomplete data
     * Triggered when order state changes from DRAFT to OPEN/COMPLETED
     * @private
     */
    async _refreshDeliveryOrderCustomerIfNeeded(order, merchantId, result) {
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
                fullOrder = await this._fetchFullOrder(order.id, merchantId);
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
                    const { LoyaltyCustomerService } = require('../loyalty');
                    const customerService = new LoyaltyCustomerService(merchantId);
                    await customerService.initialize();
                    const customerDetails = await customerService.getCustomerDetails(squareCustomerId);

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
     * Pre-check if an order contains a reward redemption
     *
     * BUG FIX: This must run BEFORE processing purchases. Previously, purchases
     * were recorded first, linking them to the old reward being redeemed. Now we
     * detect redemption first so new purchases can start a fresh reward window.
     *
     * Matches order discounts against loyalty_rewards.square_discount_id or
     * square_pricing_rule_id (NOT discount name strings - those are fragile).
     *
     * @private
     * @param {Object} order - Square order object
     * @param {number} merchantId - Internal merchant ID
     * @returns {Promise<Object>} Redemption info or { isRedemptionOrder: false }
     */
    async _checkOrderForRedemption(order, merchantId) {
        const discounts = order.discounts || [];
        if (discounts.length === 0) {
            return { isRedemptionOrder: false };
        }

        const db = require('../../utils/database');

        for (const discount of discounts) {
            const catalogObjectId = discount.catalog_object_id;
            if (!catalogObjectId) continue;

            // Check if this discount matches any of our earned rewards
            // Match on square_discount_id OR square_pricing_rule_id (Square may use either)
            const rewardResult = await db.query(`
                SELECT r.id, r.offer_id, r.square_customer_id, o.offer_name
                FROM loyalty_rewards r
                JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.merchant_id = $1
                  AND (r.square_discount_id = $2 OR r.square_pricing_rule_id = $2)
                  AND r.status = 'earned'
            `, [merchantId, catalogObjectId]);

            if (rewardResult.rows.length > 0) {
                const reward = rewardResult.rows[0];

                logger.info('Pre-detected reward redemption on order', {
                    action: 'REDEMPTION_PRE_CHECK',
                    orderId: order.id,
                    rewardId: reward.id,
                    offerId: reward.offer_id,
                    discountCatalogId: catalogObjectId,
                    merchantId
                });

                return {
                    isRedemptionOrder: true,
                    rewardId: reward.id,
                    offerId: reward.offer_id,
                    offerName: reward.offer_name,
                    squareCustomerId: reward.square_customer_id,
                    discountCatalogId: catalogObjectId
                };
            }
        }

        return { isRedemptionOrder: false };
    }

    /**
     * Process loyalty for completed order
     *
     * BUG FIX: Now checks for redemption BEFORE processing purchases.
     * This ensures that paid qualifying items on a redemption order start
     * a new reward window instead of being linked to the old reward.
     *
     * @private
     */
    async _processLoyalty(order, merchantId, result) {
        try {
            // Dedup check - prevent duplicate loyalty processing
            const alreadyProcessed = await loyaltyService.isOrderAlreadyProcessedForLoyalty(order.id, merchantId);
            if (alreadyProcessed) {
                logger.debug('Loyalty skip - order already processed', {
                    action: 'LOYALTY_SKIP_DUPLICATE',
                    orderId: order.id,
                    merchantId
                });
                return;
            }

            // BUG FIX: Check for redemption BEFORE processing purchases
            // This allows purchase processing to know it should start a new reward window
            const redemptionCheck = await this._checkOrderForRedemption(order, merchantId);

            if (redemptionCheck.isRedemptionOrder) {
                logger.info('Processing redemption order - new purchases will start fresh window', {
                    orderId: order.id,
                    rewardBeingRedeemed: redemptionCheck.rewardId,
                    offerId: redemptionCheck.offerId,
                    merchantId
                });
            }

            // Process purchases with redemption context
            // If this is a redemption order, the purchase service will treat any
            // existing earned reward as "about to be redeemed" and start a new window
            const loyaltyResult = await processOrderForLoyalty(order, merchantId, {
                source: 'WEBHOOK',
                redemptionContext: redemptionCheck.isRedemptionOrder ? {
                    rewardId: redemptionCheck.rewardId,
                    offerId: redemptionCheck.offerId,
                    isRedemptionOrder: true
                } : null
            });

            if (loyaltyResult.processed) {
                result.loyalty = {
                    purchasesRecorded: loyaltyResult.purchasesRecorded.length,
                    customerId: loyaltyResult.customerId,
                    isRedemptionOrder: redemptionCheck.isRedemptionOrder
                };
                logger.info('Loyalty purchases processed via webhook', {
                    orderId: order.id,
                    purchaseCount: loyaltyResult.purchasesRecorded.length,
                    isRedemptionOrder: redemptionCheck.isRedemptionOrder,
                    merchantId
                });

                // Log earned rewards
                for (const purchase of loyaltyResult.purchasesRecorded) {
                    if (purchase.reward && purchase.reward.status === 'earned') {
                        logger.info('Customer earned a loyalty reward!', {
                            orderId: order.id,
                            customerId: loyaltyResult.customerId,
                            rewardId: purchase.reward.rewardId
                        });
                    }
                }
            }

            // Finalize reward redemption AFTER purchases are recorded
            // This uses the existing detectRewardRedemptionFromOrder which also
            // handles cleanup of Square discount objects
            const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, merchantId);
            if (redemptionResult.detected) {
                result.loyaltyRedemption = {
                    rewardId: redemptionResult.rewardId,
                    offerName: redemptionResult.offerName
                };
                logger.info('Loyalty reward redemption finalized', {
                    orderId: order.id,
                    rewardId: redemptionResult.rewardId,
                    offerName: redemptionResult.offerName,
                    merchantId
                });
            }

            // Process refunds if present
            if (order.refunds && order.refunds.length > 0) {
                const refundResult = await loyaltyService.processOrderRefundsForLoyalty(order, merchantId);
                if (refundResult.processed) {
                    result.loyaltyRefunds = {
                        refundsProcessed: refundResult.refundsProcessed.length
                    };
                    logger.info('Loyalty refunds processed via webhook', {
                        orderId: order.id,
                        refundCount: refundResult.refundsProcessed.length
                    });
                }
            }
        } catch (loyaltyError) {
            logger.error('Failed to process order for loyalty', {
                error: loyaltyError.message,
                orderId: order.id,
                merchantId
            });
            result.loyaltyError = loyaltyError.message;
        }
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
            try {
                const squareClient = await getSquareClientForMerchant(merchantId);
                const orderResponse = await squareClient.orders.get({ orderId: data.order_id });

                // SDK v43+ returns camelCase — normalize to snake_case
                const fulfillmentOrder = normalizeSquareOrder(orderResponse.order);
                if (fulfillmentOrder?.state === 'COMPLETED') {
                    const velocityResult = await squareApi.updateSalesVelocityFromOrder(
                        fulfillmentOrder,
                        merchantId
                    );
                    result.salesVelocity = {
                        method: 'incremental',
                        fromFulfillment: true,
                        updated: velocityResult.updated
                    };
                    logger.info('Sales velocity updated incrementally via fulfillment (P0-API-2)', {
                        orderId: data.order_id,
                        updated: velocityResult.updated,
                        apiCallsSaved: 36  // 1 fetch vs 37 full sync
                    });
                }
            } catch (fetchErr) {
                logger.warn('Could not fetch order for fulfillment velocity update', {
                    orderId: data.order_id,
                    error: fetchErr.message
                });
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
     * @private
     */
    async _handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result) {
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
                await this._autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);
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
     * @private
     */
    async _autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result) {
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
        logger.info('Payment created webhook received', {
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
     * @private
     */
    async _processPaymentForLoyalty(payment, merchantId, result, source) {
        try {
            logger.info('Payment completed - fetching order for loyalty processing', {
                paymentId: payment.id,
                orderId: payment.order_id
            });

            const squareClient = await getSquareClientForMerchant(merchantId);
            const orderResponse = await squareClient.orders.get({ orderId: payment.order_id });

            if (!orderResponse.order || orderResponse.order.state !== 'COMPLETED') {
                return;
            }

            // SDK v43+ returns camelCase — normalize to snake_case
            const order = normalizeSquareOrder(orderResponse.order);

            // Dedup check - prevent duplicate loyalty processing
            const alreadyProcessed = await loyaltyService.isOrderAlreadyProcessedForLoyalty(order.id, merchantId);
            if (alreadyProcessed) {
                logger.debug('Loyalty skip - order already processed via payment webhook', {
                    action: 'LOYALTY_SKIP_DUPLICATE',
                    orderId: order.id,
                    merchantId,
                    source
                });
                return;
            }

            // Process for loyalty
            const loyaltyResult = await processOrderForLoyalty(order, merchantId, { source });
            if (loyaltyResult.processed) {
                result.loyalty = {
                    purchasesRecorded: loyaltyResult.purchasesRecorded.length,
                    customerId: loyaltyResult.customerId,
                    source
                };
                logger.info(`Loyalty purchases recorded via ${source} webhook`, {
                    orderId: order.id,
                    customerId: loyaltyResult.customerId,
                    purchases: loyaltyResult.purchasesRecorded.length
                });

                // Create reward discounts for earned rewards
                if (loyaltyResult.purchasesRecorded.length > 0) {
                    for (const purchase of loyaltyResult.purchasesRecorded) {
                        if (purchase.rewardEarned) {
                            try {
                                await loyaltyService.createRewardDiscount({
                                    merchantId,
                                    squareCustomerId: loyaltyResult.customerId,
                                    internalRewardId: purchase.rewardId
                                });
                                logger.info('Created reward discount via payment webhook', {
                                    rewardId: purchase.rewardId
                                });
                            } catch (discountErr) {
                                logger.error('Failed to create reward discount', {
                                    error: discountErr.message,
                                    rewardId: purchase.rewardId
                                });
                            }
                        }
                    }
                }
            }

            // Check for reward redemption
            const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, merchantId);
            if (redemptionResult.detected) {
                result.loyaltyRedemption = {
                    rewardId: redemptionResult.rewardId,
                    offerName: redemptionResult.offerName
                };
                logger.info('Reward redemption detected via payment webhook', {
                    orderId: order.id,
                    rewardId: redemptionResult.rewardId
                });
            }
        } catch (paymentErr) {
            logger.error('Error processing payment for loyalty', {
                error: paymentErr.message,
                paymentId: payment.id
            });
        }
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

        const accessToken = await loyaltyService.getSquareAccessToken(merchantId);
        if (!accessToken) {
            return result;
        }

        try {
            const orderResponse = await fetch(
                `https://connect.squareup.com/v2/orders/${refund.order_id}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': SQUARE_API_VERSION
                    }
                }
            );

            if (!orderResponse.ok) {
                return result;
            }

            const orderData = await orderResponse.json();
            const order = orderData.order;

            if (order && order.refunds && order.refunds.length > 0) {
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
