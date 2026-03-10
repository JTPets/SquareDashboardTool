/**
 * Loyalty processing logic for order webhooks
 *
 * Extracted from order-handler.js (Phase 2 split).
 * Contains customer identification, loyalty intake for both order.* and
 * payment.* webhook paths, and the order processing cache.
 *
 * @module services/webhook-handlers/order-handler/order-loyalty
 */

const logger = require('../../../utils/logger');
const loyaltyService = require('../../loyalty-admin');
const { getSquareClientForMerchant } = require('../../../middleware/merchant');
const TTLCache = require('../../../utils/ttl-cache');

// Consolidated order intake (single entry point for all loyalty order processing)
const { processLoyaltyOrder } = require('../../loyalty-admin/order-intake');
// Customer identification service (6-method fallback chain)
const { LoyaltyCustomerService } = require('../../loyalty-admin/customer-identification-service');

const { normalizeSquareOrder } = require('./order-normalize');

/**
 * Known permanent error messages that should NOT be retried.
 * Business logic failures where retrying won't change the outcome.
 */
const KNOWN_PERMANENT_ERRORS = [
    'customer not found',
    'offer inactive',
    'offer not found',
    'already processed',
    'order already processed',
    'invalid order state',
    'no qualifying items',
    'order with id is required',
    'merchantId is required',
    'tenant isolation required'
];

/**
 * Determine if an error is transient (retryable) or permanent.
 *
 * Transient errors: DB connection failures, deadlocks, timeouts, network errors.
 * Square will retry the webhook if we re-throw.
 *
 * @param {Error} error
 * @returns {boolean} true if the error is transient and should be retried
 */
// LOGIC CHANGE: New function — classifies errors to decide retry vs swallow
function isTransientError(error) {
    // LOGIC CHANGE (MED-7 follow-up): Errors explicitly marked retryable by
    // upstream callers (e.g., order-intake partial failure) should trigger retry.
    if (error.retryable === true) return true;

    // PostgreSQL error codes indicating transient failures
    const pgCode = error.code;
    if (pgCode) {
        // 40001 = serialization_failure, 40P01 = deadlock_detected
        if (pgCode === '40001' || pgCode === '40P01') return true;
        // 57P03 = cannot_connect_now
        if (pgCode === '57P03') return true;
        // 08* = connection_exception class
        if (typeof pgCode === 'string' && pgCode.startsWith('08')) return true;
    }

    // Network/connection error messages
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('connection') || msg.includes('timeout') ||
        msg.includes('econnrefused') || msg.includes('etimedout')) {
        return true;
    }

    return false;
}

/**
 * Check if an error message matches a known permanent business logic error.
 *
 * @param {Error} error
 * @returns {boolean} true if the error is a known, expected permanent failure
 */
function isKnownPermanentError(error) {
    const msg = (error.message || '').toLowerCase();
    return KNOWN_PERMANENT_ERRORS.some(pattern => msg.includes(pattern));
}

/**
 * Cache of order processing results for dedup between order.* and payment.* webhooks.
 * Keyed by `${orderId}:${merchantId}`. Stores { customerId, pointsAwarded, redemptionChecked }.
 * 120s TTL ensures self-healing if something goes wrong.
 */
const orderProcessingCache = new TTLCache(120000);

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
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 */
async function processLoyalty(order, merchantId, result) {
    try {
        // Identify the customer (6-method fallback chain)
        const { customerId: squareCustomerId, customerSource } = await identifyCustomerForOrder(order, merchantId);

        if (!squareCustomerId) {
            logger.debug('Loyalty skip - no customer identified for order', {
                orderId: order.id,
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
                customerId: squareCustomerId
            };
            logger.info('Loyalty purchases processed via webhook', {
                orderId: order.id,
                purchaseCount: intakeResult.purchaseEvents.length,
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

        // Process returns (item returns) for loyalty adjustment
        if (order.returns?.length > 0) {
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
        // LOGIC CHANGE: Classify errors — re-throw transient so Square retries
        if (isTransientError(loyaltyError)) {
            logger.error('Loyalty transient error — Square will retry webhook', {
                event: 'loyalty_transient_error',
                orderId: order.id,
                merchantId,
                error: loyaltyError.message,
                code: loyaltyError.code,
                willRetry: true
            });
            throw loyaltyError;
        }

        // Permanent error — swallow (retrying won't help)
        if (isKnownPermanentError(loyaltyError)) {
            logger.warn('Loyalty permanent error — not retryable', {
                event: 'loyalty_permanent_error',
                orderId: order.id,
                merchantId,
                error: loyaltyError.message,
                willRetry: false
            });
        } else {
            // Unexpected permanent error — needs human review
            logger.error('Loyalty unexpected error — needs review', {
                event: 'loyalty_unexpected_error',
                orderId: order.id,
                merchantId,
                error: loyaltyError.message,
                stack: loyaltyError.stack,
                willRetry: false
            });
        }
        result.loyaltyError = loyaltyError.message;
    }
}

/**
 * Process payment for loyalty
 * Routes through the consolidated processLoyaltyOrder() intake function.
 *
 * Checks orderProcessingCache first to avoid redundant work when
 * order.* webhook already processed the same order.
 *
 * @param {Object} payment - Square payment object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} result - Webhook result object to populate
 * @param {string} source - Source event type (payment.created or payment.updated)
 */
async function processPaymentForLoyalty(payment, merchantId, result, source) {
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
                source
            };
            logger.info(`Loyalty purchases recorded via ${source} webhook`, {
                orderId: order.id,
                customerId: squareCustomerId,
                purchases: intakeResult.purchaseEvents.length
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
        // LOGIC CHANGE: Classify errors — re-throw transient so Square retries
        if (isTransientError(paymentErr)) {
            logger.error('Payment loyalty transient error — Square will retry webhook', {
                event: 'loyalty_transient_error',
                orderId: payment.order_id,
                merchantId,
                error: paymentErr.message,
                code: paymentErr.code,
                willRetry: true
            });
            throw paymentErr;
        }

        if (isKnownPermanentError(paymentErr)) {
            logger.warn('Payment loyalty permanent error — not retryable', {
                event: 'loyalty_permanent_error',
                orderId: payment.order_id,
                merchantId,
                error: paymentErr.message,
                willRetry: false
            });
        } else {
            logger.error('Payment loyalty unexpected error — needs review', {
                event: 'loyalty_unexpected_error',
                orderId: payment.order_id,
                merchantId,
                error: paymentErr.message,
                stack: paymentErr.stack,
                willRetry: false
            });
        }
    }
}

// TODO: Suggested extraction — handleLoyaltyError(error, orderId, merchantId, result)
//   Inputs: Error object, orderId (string), merchantId (number), result (object)
//   Outputs: void (mutates result.loyaltyError or re-throws)
//   Lines: processLoyalty catch block + processPaymentForLoyalty catch block
//   Risk: Low — pure error classification logic, no side effects beyond logging
//   Both catch blocks share identical classify-log-rethrow/swallow logic.

module.exports = {
    orderProcessingCache,
    identifyCustomerForOrder,
    processLoyalty,
    processPaymentForLoyalty,
    // Exported for testing only
    _isTransientError: isTransientError,
    _isKnownPermanentError: isKnownPermanentError,
    _KNOWN_PERMANENT_ERRORS: KNOWN_PERMANENT_ERRORS
};
