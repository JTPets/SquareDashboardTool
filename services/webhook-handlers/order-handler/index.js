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
const TTLCache = require('../../../utils/ttl-cache');

// Consolidated order intake (single entry point for all loyalty order processing)
const { processLoyaltyOrder } = require('../../loyalty-admin/order-intake');
// Customer identification service (6-method fallback chain)
const { LoyaltyCustomerService } = require('../../loyalty-admin/customer-identification-service');

// Extracted in Phase 2 split
const { normalizeSquareOrder, fetchFullOrder } = require('./order-normalize');
const { processCartActivity, checkCartConversion, markCartCanceled } = require('./order-cart');
const { completedOrderVelocityCache, updateVelocityFromOrder, updateVelocityFromFulfillment } = require('./order-velocity');
const {
    ingestDeliveryOrder, handleOrderCancellation, handleOrderCompletion,
    refreshDeliveryOrderCustomerIfNeeded, handleFulfillmentDeliveryUpdate,
    autoIngestFromFulfillment
} = require('./order-delivery');

/**
 * Cache of order processing results for dedup between order.* and payment.* webhooks.
 * Keyed by `${orderId}:${merchantId}`. Stores { customerId, pointsAwarded, redemptionChecked }.
 * 120s TTL ensures self-healing if something goes wrong.
 */
const orderProcessingCache = new TTLCache(120000);


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
 * Identify the Square customer associated with an order.
 * Uses the LoyaltyCustomerService's 6-method fallback chain.
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<{customerId: string|null, customerSource: string}>}
 */
async function identifyCustomerForOrder(order, merchantId) {
    const customerService = new LoyaltyCustomerService(merchantId);
    await customerService.initialize();
    const result = await customerService.identifyCustomerFromOrder(order);

    if (!result.customerId) {
        return { customerId: null, customerSource: 'unknown' };
    }

    // Map detailed method to shorter DB values
    const sourceMap = {
        'order.customer_id': 'order',
        'tender.customer_id': 'tender',
        'loyalty_event_order_id': 'loyalty_api'
    };
    const customerSource = sourceMap[result.method] || 'order';

    return { customerId: result.customerId, customerSource };
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
     * Pre-check if an order contains a reward redemption
     *
     * BUG FIX: This must run BEFORE processing purchases. Previously, purchases
     * were recorded first, linking them to the old reward being redeemed. Now we
     * detect redemption first so new purchases can start a fresh reward window.
     *
     * Detection strategy (in priority order):
     * 1. Match discount catalog_object_id to stored square_discount_id/pricing_rule_id
     * 2. Fallback: match 100% discounted line items to earned rewards via qualifying variations
     *    (catches manual discounts, re-applied discounts, migrated discount objects)
     *
     * @private
     * @param {Object} order - Square order object
     * @param {number} merchantId - Internal merchant ID
     * @returns {Promise<Object>} Redemption info or { isRedemptionOrder: false }
     */
    async _checkOrderForRedemption(order, merchantId) {
        const db = require('../../../utils/database');

        // Strategy 1: Match by catalog_object_id (exact discount ID match)
        const discounts = order.discounts || [];

        // DIAGNOSTIC: Log all discounts before scanning (remove after issue confirmed resolved)
        const squareCustomerId = order.customer_id || (order.tenders || []).find(t => t.customer_id)?.customer_id;
        logger.debug('Redemption detection: scanning order discounts', {
            orderId: order.id,
            squareCustomerId,
            discountCount: discounts.length,
            discounts: discounts.map(d => ({
                uid: d.uid,
                name: d.name,
                type: d.type,
                catalog_object_id: d.catalog_object_id || null,
                pricing_rule_id: d.pricing_rule_id || null,
                applied_money: d.applied_money,
                scope: d.scope
            }))
        });

        for (const discount of discounts) {
            const catalogObjectId = discount.catalog_object_id;

            // DIAGNOSTIC: Log each discount evaluation (remove after issue confirmed resolved)
            logger.debug('Redemption detection: evaluating discount', {
                orderId: order.id,
                discountUid: discount.uid,
                catalogObjectId: catalogObjectId || 'NONE (manual/ad-hoc)',
                pricingRuleId: discount.pricing_rule_id || 'NONE',
                discountName: discount.name,
                discountType: discount.type,
                appliedMoney: discount.applied_money,
                skipped: !catalogObjectId
            });

            if (!catalogObjectId) continue;

            // Match on square_discount_id OR square_pricing_rule_id (Square may use either)
            const rewardResult = await db.query(`
                SELECT r.id, r.offer_id, r.square_customer_id, o.offer_name
                FROM loyalty_rewards r
                JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.merchant_id = $1
                  AND (r.square_discount_id = $2 OR r.square_pricing_rule_id = $2)
                  AND r.status = 'earned'
            `, [merchantId, catalogObjectId]);

            // DIAGNOSTIC: Log reward lookup results (remove after issue confirmed resolved)
            logger.debug('Redemption detection: reward lookup', {
                orderId: order.id,
                catalogObjectId,
                pricingRuleId: discount.pricing_rule_id || null,
                matchedRewardId: rewardResult.rows[0]?.id || null,
                matchedBy: rewardResult.rows.length > 0 ? 'catalog_id' : 'none',
                earnedRewardsFound: rewardResult.rows.length
            });

            if (rewardResult.rows.length > 0) {
                const reward = rewardResult.rows[0];

                logger.info('Pre-detected reward redemption on order', {
                    action: 'REDEMPTION_PRE_CHECK',
                    orderId: order.id,
                    rewardId: reward.id,
                    offerId: reward.offer_id,
                    discountCatalogId: catalogObjectId,
                    detectionMethod: 'catalog_object_id',
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

        // Strategy 2: Fallback — match free items to earned rewards
        const freeItemMatch = await loyaltyService.matchEarnedRewardByFreeItem(order, merchantId);
        if (freeItemMatch) {
            logger.info('Pre-detected reward redemption via free item fallback', {
                action: 'REDEMPTION_PRE_CHECK_FREE_ITEM',
                orderId: order.id,
                rewardId: freeItemMatch.reward_id,
                offerId: freeItemMatch.offer_id,
                matchedVariationId: freeItemMatch.matched_variation_id,
                merchantId
            });

            return {
                isRedemptionOrder: true,
                rewardId: freeItemMatch.reward_id,
                offerId: freeItemMatch.offer_id,
                offerName: freeItemMatch.offer_name,
                squareCustomerId: freeItemMatch.square_customer_id,
                discountCatalogId: null
            };
        }

        // Strategy 3: Match by total discount amount on qualifying variations
        const discountAmountMatch = await loyaltyService.matchEarnedRewardByDiscountAmount({
            order, squareCustomerId, merchantId
        });
        if (discountAmountMatch) {
            logger.info('Pre-detected reward redemption via discount-amount fallback', {
                action: 'REDEMPTION_PRE_CHECK_DISCOUNT_AMOUNT',
                orderId: order.id,
                rewardId: discountAmountMatch.reward_id,
                offerId: discountAmountMatch.offer_id,
                totalDiscountCents: discountAmountMatch.totalDiscountCents,
                expectedValueCents: discountAmountMatch.expectedValueCents,
                merchantId
            });

            return {
                isRedemptionOrder: true,
                rewardId: discountAmountMatch.reward_id,
                offerId: discountAmountMatch.offer_id,
                offerName: discountAmountMatch.offer_name,
                squareCustomerId: discountAmountMatch.square_customer_id,
                discountCatalogId: null
            };
        }

        return { isRedemptionOrder: false };
    }

    /**
     * Process loyalty for completed order
     *
     * Routes through the consolidated processLoyaltyOrder() intake function
     * which writes both loyalty_processed_orders and loyalty_purchase_events
     * atomically in the same transaction.
     *
     * Redemption detection and refund processing remain separate concerns
     * handled after the intake function returns.
     *
     * @private
     */
    async _processLoyalty(order, merchantId, result) {
        try {
            // Identify the customer (6-method fallback chain)
            const { customerId: squareCustomerId, customerSource } = await identifyCustomerForOrder(order, merchantId);

            if (!squareCustomerId) {
                logger.debug('Loyalty skip - no customer identified for order', {
                    orderId: order.id,
                    merchantId
                });
            }

            // Check for redemption BEFORE processing purchases (for logging)
            const redemptionCheck = await this._checkOrderForRedemption(order, merchantId);

            if (redemptionCheck.isRedemptionOrder) {
                logger.info('Processing redemption order - new purchases will start fresh window', {
                    orderId: order.id,
                    rewardBeingRedeemed: redemptionCheck.rewardId,
                    offerId: redemptionCheck.offerId,
                    merchantId
                });
            }

            // Consolidated intake: atomic write to both tables
            const intakeResult = await processLoyaltyOrder({
                order,
                merchantId,
                squareCustomerId,
                source: 'webhook',
                customerSource
            });

            if (intakeResult.alreadyProcessed) {
                logger.debug('Loyalty skip - order already processed', {
                    action: 'LOYALTY_SKIP_DUPLICATE',
                    orderId: order.id,
                    merchantId
                });
                return;
            }

            if (intakeResult.purchaseEvents.length > 0) {
                result.loyalty = {
                    purchasesRecorded: intakeResult.purchaseEvents.length,
                    customerId: squareCustomerId,
                    isRedemptionOrder: redemptionCheck.isRedemptionOrder
                };
                logger.info('Loyalty purchases processed via webhook', {
                    orderId: order.id,
                    purchaseCount: intakeResult.purchaseEvents.length,
                    isRedemptionOrder: redemptionCheck.isRedemptionOrder,
                    merchantId
                });

                if (intakeResult.rewardEarned) {
                    logger.info('Customer earned a loyalty reward!', {
                        orderId: order.id,
                        customerId: squareCustomerId,
                        merchantId
                    });
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

            // Cache result so payment.* webhooks can skip redundant work
            const cacheKey = `${order.id}:${merchantId}`;
            orderProcessingCache.set(cacheKey, {
                customerId: squareCustomerId,
                pointsAwarded: intakeResult.purchaseEvents.length > 0,
                redemptionChecked: true
            });
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
     * Routes through the consolidated processLoyaltyOrder() intake function.
     *
     * Checks orderProcessingCache first to avoid redundant work when
     * order.* webhook already processed the same order.
     *
     * @private
     */
    async _processPaymentForLoyalty(payment, merchantId, result, source) {
        try {
            const cacheKey = `${payment.order_id}:${merchantId}`;
            const cached = orderProcessingCache.get(cacheKey);

            if (cached) {
                // Full processing already done by order.* webhook
                if (cached.customerId && cached.pointsAwarded) {
                    logger.debug('Payment webhook skipping - order already fully processed', {
                        orderId: payment.order_id,
                        paymentId: payment.id,
                        merchantId,
                        source,
                        cachedCustomerId: cached.customerId,
                        reason: 'customer_identified_and_points_awarded'
                    });
                    result.skippedByCache = true;
                    return;
                }

                // Customer was NOT identified — re-run identification only
                // (payment webhook has tender data that order webhook may not)
                if (!cached.customerId) {
                    logger.debug('Payment webhook re-running identification - no customer in cache', {
                        orderId: payment.order_id,
                        paymentId: payment.id,
                        merchantId,
                        source
                    });
                    // Fall through to normal processing (identification is the value-add)
                }

                // Redemption wasn't checked — re-run that check only
                if (!cached.redemptionChecked) {
                    logger.debug('Payment webhook re-running redemption check', {
                        orderId: payment.order_id,
                        paymentId: payment.id,
                        merchantId,
                        source
                    });
                    // Fall through to normal processing
                }
            }

            logger.debug('Payment completed - fetching order for loyalty processing', {
                paymentId: payment.id,
                orderId: payment.order_id,
                cacheHit: !!cached
            });

            const squareClient = await getSquareClientForMerchant(merchantId);
            const orderResponse = await squareClient.orders.get({ orderId: payment.order_id });

            if (!orderResponse.order || orderResponse.order.state !== 'COMPLETED') {
                return;
            }

            // SDK v43+ returns camelCase — normalize to snake_case
            const order = normalizeSquareOrder(orderResponse.order);

            // Early dedup: use cached customer_id if available (Fix 2)
            // Skips the expensive 6-method identification chain
            let squareCustomerId;
            let customerSource;
            if (cached && cached.customerId) {
                squareCustomerId = cached.customerId;
                customerSource = 'cached';
                logger.debug('Payment webhook using cached customer_id', {
                    orderId: order.id,
                    customerId: squareCustomerId,
                    merchantId,
                    source
                });
            } else {
                // No cached customer — run full identification (value-add path)
                const identification = await identifyCustomerForOrder(order, merchantId);
                squareCustomerId = identification.customerId;
                customerSource = identification.customerSource;
            }

            // Check for redemption BEFORE processing purchases (matching _processLoyalty pattern)
            // Ensures "new purchases start fresh reward window" guarantee holds
            // even when only payment.* webhook fires
            const redemptionCheck = await this._checkOrderForRedemption(order, merchantId);

            if (redemptionCheck.isRedemptionOrder) {
                logger.info('Payment path: processing redemption order - new purchases will start fresh window', {
                    orderId: order.id,
                    rewardBeingRedeemed: redemptionCheck.rewardId,
                    offerId: redemptionCheck.offerId,
                    merchantId,
                    source
                });
            }

            // Consolidated intake: atomic write to both tables (includes dedup)
            const intakeResult = await processLoyaltyOrder({
                order,
                merchantId,
                squareCustomerId,
                source: 'webhook',
                customerSource
            });

            if (intakeResult.alreadyProcessed) {
                logger.debug('Loyalty skip - order already processed via payment webhook', {
                    action: 'LOYALTY_SKIP_DUPLICATE',
                    orderId: order.id,
                    merchantId,
                    source
                });
                return;
            }

            if (intakeResult.purchaseEvents.length > 0) {
                result.loyalty = {
                    purchasesRecorded: intakeResult.purchaseEvents.length,
                    customerId: squareCustomerId,
                    isRedemptionOrder: redemptionCheck.isRedemptionOrder,
                    source
                };
                logger.info(`Loyalty purchases recorded via ${source} webhook`, {
                    orderId: order.id,
                    customerId: squareCustomerId,
                    purchases: intakeResult.purchaseEvents.length,
                    isRedemptionOrder: redemptionCheck.isRedemptionOrder
                });
            }

            // Finalize reward redemption AFTER purchases are recorded
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

        try {
            const squareClient = await getSquareClientForMerchant(merchantId);
            const orderResponse = await squareClient.orders.get({ orderId: refund.order_id });
            const order = orderResponse.order;

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
// Export caches for testing
module.exports._orderProcessingCache = orderProcessingCache;
module.exports._completedOrderVelocityCache = completedOrderVelocityCache;
