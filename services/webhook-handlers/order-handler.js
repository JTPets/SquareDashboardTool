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

// Square API version for direct API calls
const SQUARE_API_VERSION = '2025-01-16';

/**
 * Metrics for tracking webhook order data usage vs API fallback
 * Helps measure effectiveness of P0-API-1 optimization
 */
const webhookOrderStats = {
    directUse: 0,
    apiFallback: 0,
    lastReset: Date.now()
};

/**
 * P0-API-4: Debounced committed inventory sync
 *
 * Instead of syncing on every webhook, we wait for a quiet period.
 * This prevents redundant syncs when multiple webhooks arrive in quick succession.
 *
 * Example: 4 webhooks in 10 seconds → 1 sync instead of 4 syncs
 */
const COMMITTED_SYNC_DEBOUNCE_MS = 60000; // 1 minute debounce window
const pendingCommittedSyncs = new Map(); // merchantId → { timer, requestCount, firstRequestAt }

/**
 * Metrics for tracking debounce effectiveness
 */
const committedSyncStats = {
    requested: 0,
    executed: 0,
    debounced: 0,
    lastReset: Date.now()
};

/**
 * Request a debounced committed inventory sync for a merchant.
 * Multiple requests within the debounce window result in a single sync.
 *
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Result with sync status
 */
async function debouncedSyncCommittedInventory(merchantId) {
    committedSyncStats.requested++;

    const existing = pendingCommittedSyncs.get(merchantId);

    if (existing) {
        // Already have a pending sync - increment counter but don't reset timer
        // (We use trailing-edge debounce: execute after quiet period from FIRST request)
        existing.requestCount++;
        committedSyncStats.debounced++;

        logger.debug('Committed inventory sync debounced (P0-API-4)', {
            merchantId,
            pendingRequests: existing.requestCount,
            waitingFor: `${Math.ceil((existing.executeAt - Date.now()) / 1000)}s`
        });

        return {
            debounced: true,
            pendingRequests: existing.requestCount,
            executeAt: new Date(existing.executeAt).toISOString()
        };
    }

    // No pending sync - schedule a new one
    const executeAt = Date.now() + COMMITTED_SYNC_DEBOUNCE_MS;

    const syncState = {
        requestCount: 1,
        firstRequestAt: Date.now(),
        executeAt,
        timer: setTimeout(async () => {
            pendingCommittedSyncs.delete(merchantId);
            committedSyncStats.executed++;

            const state = syncState; // Capture for logging
            logger.info('Executing debounced committed inventory sync (P0-API-4)', {
                merchantId,
                requestsBatched: state.requestCount,
                apiCallsSaved: state.requestCount - 1,
                delayMs: Date.now() - state.firstRequestAt
            });

            try {
                const result = await squareApi.syncCommittedInventory(merchantId);
                logger.info('Debounced committed inventory sync complete', {
                    merchantId,
                    result: result?.skipped ? 'skipped' : result
                });
            } catch (error) {
                logger.error('Debounced committed inventory sync failed', {
                    merchantId,
                    error: error.message
                });
            }

            // Log stats periodically
            if (committedSyncStats.executed % 50 === 0) {
                const savedPct = ((committedSyncStats.debounced / committedSyncStats.requested) * 100).toFixed(1);
                logger.info('P0-API-4 Debounce stats', {
                    requested: committedSyncStats.requested,
                    executed: committedSyncStats.executed,
                    debounced: committedSyncStats.debounced,
                    savingsRate: `${savedPct}%`
                });
            }
        }, COMMITTED_SYNC_DEBOUNCE_MS)
    };

    pendingCommittedSyncs.set(merchantId, syncState);

    logger.debug('Scheduled committed inventory sync (P0-API-4)', {
        merchantId,
        executeAt: new Date(executeAt).toISOString(),
        debounceMs: COMMITTED_SYNC_DEBOUNCE_MS
    });

    return {
        scheduled: true,
        executeAt: new Date(executeAt).toISOString()
    };
}

/**
 * Process order for loyalty using either modern or legacy service
 * Feature flag: USE_NEW_LOYALTY_SERVICE
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} [options] - Processing options
 * @param {string} [options.source] - Source of event (e.g., 'WEBHOOK', 'PAYMENT')
 * @returns {Promise<Object>} Normalized result compatible with legacy format
 */
async function processOrderForLoyalty(order, merchantId, options = {}) {
    const { source = 'WEBHOOK' } = options;

    if (FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE) {
        // Use modern service
        logger.debug('Using modern loyalty service for order processing', {
            orderId: order.id,
            merchantId,
            source
        });

        const service = new LoyaltyWebhookService(merchantId);
        await service.initialize();
        const result = await service.processOrder(order, { source });

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
        const { data, merchantId, event } = context;
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

        // Square webhook structure: data = event.data.object
        // For order events, data.order should contain the order, but handle both structures
        const webhookOrder = data.order || data;

        // Extract order ID from multiple possible locations for robustness
        const orderId = webhookOrder?.id || data?.id || data?.order_id;

        logger.info('Order event detected via webhook', {
            orderId,
            state: webhookOrder?.state,
            eventType: event.type,
            merchantId,
            hasFulfillments: webhookOrder?.fulfillments?.length > 0
        });

        // P0-API-4 OPTIMIZATION: Debounce committed inventory sync
        // Multiple webhooks in quick succession will batch into a single sync
        const committedResult = await debouncedSyncCommittedInventory(merchantId);
        result.committedInventory = committedResult;
        if (committedResult?.debounced) {
            logger.debug('Committed inventory sync debounced via webhook', {
                pendingRequests: committedResult.pendingRequests
            });
        } else if (committedResult?.scheduled) {
            logger.debug('Committed inventory sync scheduled via webhook', {
                executeAt: committedResult.executeAt
            });
        }

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
                return orderResponse.order;
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

        // Auto-ingest OPEN orders
        if (order.state !== 'COMPLETED' && order.state !== 'CANCELED') {
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
     * Process loyalty for completed order
     * @private
     */
    async _processLoyalty(order, merchantId, result) {
        try {
            const loyaltyResult = await processOrderForLoyalty(order, merchantId, { source: 'WEBHOOK' });
            if (loyaltyResult.processed) {
                result.loyalty = {
                    purchasesRecorded: loyaltyResult.purchasesRecorded.length,
                    customerId: loyaltyResult.customerId
                };
                logger.info('Loyalty purchases processed via webhook', {
                    orderId: order.id,
                    purchaseCount: loyaltyResult.purchasesRecorded.length,
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

            // Check for reward redemption
            const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, merchantId);
            if (redemptionResult.detected) {
                result.loyaltyRedemption = {
                    rewardId: redemptionResult.rewardId,
                    offerName: redemptionResult.offerName
                };
                logger.info('Loyalty reward redemption detected and processed', {
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

        // P0-API-4 OPTIMIZATION: Debounce committed inventory sync
        const committedResult = await debouncedSyncCommittedInventory(merchantId);
        result.committedInventory = committedResult;
        if (committedResult?.debounced) {
            logger.debug('Committed inventory sync debounced via fulfillment webhook', {
                pendingRequests: committedResult.pendingRequests
            });
        }

        // P0-API-2 OPTIMIZATION: Update sales velocity incrementally if completed
        // Fulfillment webhooks don't include line_items, so we fetch THIS order (1 API call)
        // instead of all 91 days of orders (~37 API calls)
        if (fulfillment?.state === 'COMPLETED' && data.order_id) {
            try {
                const squareClient = await getSquareClientForMerchant(merchantId);
                const orderResponse = await squareClient.orders.get({ orderId: data.order_id });

                if (orderResponse.order?.state === 'COMPLETED') {
                    const velocityResult = await squareApi.updateSalesVelocityFromOrder(
                        orderResponse.order,
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

            const order = orderResponse.order;

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
