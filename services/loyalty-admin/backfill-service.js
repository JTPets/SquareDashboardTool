/**
 * Loyalty Backfill Service
 *
 * Handles backfill and catchup operations:
 * - isOrderAlreadyProcessedForLoyalty: Idempotency check
 * - processOrderForLoyaltyIfNeeded: Process if not already done
 * - runLoyaltyCatchup: Background catchup for missed orders
 *
 * Delegates to:
 * - loyalty-event-prefetch-service.js: prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents
 * - order-history-audit-service.js: getCustomerOrderHistoryForAudit, addOrdersToLoyaltyTracking
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 * Split into 3 files for 300-line compliance (2026-03-06).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION } = require('./shared-utils'); // LOGIC CHANGE: use centralized Square API version from constants (CRIT-5)
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../../config/constants');
const { processLoyaltyOrder } = require('./order-intake');
const TTLCache = require('../../utils/ttl-cache');

// Re-export from extracted modules for backward compatibility
const { prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents } = require('./loyalty-event-prefetch-service');
const { getCustomerOrderHistoryForAudit, addOrdersToLoyaltyTracking } = require('./order-history-audit-service');

/**
 * Dedup guard for runLoyaltyCatchup calls.
 * Keyed by `${customerId}:${merchantId}`. 120s TTL.
 * Prevents redundant catchup when loyalty.event.created, loyalty.account.updated,
 * and customer.updated all fire for the same customer within seconds.
 */
const catchupRecentlyRan = new TTLCache(120000);

/**
 * Check if an order has already been processed for loyalty.
 * Checks both loyalty_processed_orders AND loyalty_purchase_events
 * to match the idempotency check in order-intake.js (LA-22 fix).
 *
 * Previously only checked loyalty_purchase_events, causing backfill
 * to re-process non-qualifying orders (which exist in
 * loyalty_processed_orders but not in loyalty_purchase_events).
 *
 * @param {string} squareOrderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<boolean>} True if order was already processed
 */
async function isOrderAlreadyProcessedForLoyalty(squareOrderId, merchantId) {
    const result = await db.query(`
        SELECT 1 FROM (
            SELECT 1 FROM loyalty_processed_orders
            WHERE merchant_id = $1 AND square_order_id = $2
            UNION ALL
            SELECT 1 FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND square_order_id = $2
            LIMIT 1
        ) AS found
        LIMIT 1
    `, [merchantId, squareOrderId]);
    return result.rows.length > 0;
}

/**
 * Process an order for loyalty ONLY if not already processed (idempotent)
 * Used by sales velocity sync to catch missed orders without double-counting.
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} Result with processed status
 */
async function processOrderForLoyaltyIfNeeded(order, merchantId) {
    const alreadyProcessed = await isOrderAlreadyProcessedForLoyalty(order.id, merchantId);
    if (alreadyProcessed) {
        return { processed: false, reason: 'already_processed', orderId: order.id };
    }

    logger.info('Processing missed order for loyalty (backfill)', {
        orderId: order.id,
        customerId: order.customer_id || '(no customer_id on order)',
        merchantId,
        source: 'sync_backfill'
    });

    const intakeResult = await processLoyaltyOrder({
        order,
        merchantId,
        squareCustomerId: order.customer_id || null,
        source: 'backfill',
        customerSource: 'order'
    });

    return {
        processed: !intakeResult.alreadyProcessed && intakeResult.purchaseEvents.length > 0,
        reason: intakeResult.alreadyProcessed ? 'already_processed' : undefined,
        orderId: order.id,
        purchasesRecorded: intakeResult.purchaseEvents,
        rewardEarned: intakeResult.rewardEarned
    };
}

/**
 * Run loyalty catchup for customers using Square's internal order linkage.
 *
 * This does a "reverse lookup" - instead of finding customer from order,
 * we take known customers and ask Square for their orders.
 *
 * @param {Object} params
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string[]} [params.customerIds] - Specific customer IDs to process (default: all active)
 * @param {number} [params.periodDays=30] - How many days of history to check
 * @param {number} [params.maxCustomers=100] - Max customers to process (for rate limiting)
 * @returns {Promise<Object>} Catchup results
 */
async function runLoyaltyCatchup({ merchantId, customerIds = null, periodDays = 30, maxCustomers = 100 }) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    // Dedup guard: skip if this exact customer+merchant was recently processed
    if (customerIds && customerIds.length === 1) {
        const dedupKey = `${customerIds[0]}:${merchantId}`;
        if (catchupRecentlyRan.has(dedupKey)) {
            logger.debug('Loyalty catchup skipped - recently ran for this customer', {
                customerId: customerIds[0], merchantId, reason: 'catchup_dedup_guard'
            });
            return {
                customersProcessed: 0, ordersFound: 0, ordersAlreadyTracked: 0,
                ordersNewlyTracked: 0, errors: [], skippedByDedup: true
            };
        }
        catchupRecentlyRan.set(dedupKey, true);
    }

    const results = {
        customersProcessed: 0, ordersFound: 0,
        ordersAlreadyTracked: 0, ordersNewlyTracked: 0, errors: []
    };

    logger.info('Starting loyalty catchup', { merchantId, periodDays, maxCustomers });

    const accessToken = await getSquareAccessToken(merchantId);
    if (!accessToken) {
        throw new Error('No access token available');
    }

    // Get customers to process
    let customers;
    if (customerIds && customerIds.length > 0) {
        customers = customerIds.map(id => ({ square_customer_id: id }));
    } else {
        const customersResult = await db.query(`
            SELECT DISTINCT square_customer_id
            FROM (
                SELECT square_customer_id FROM loyalty_purchase_events WHERE merchant_id = $1
                UNION
                SELECT square_customer_id FROM loyalty_rewards WHERE merchant_id = $1
            ) AS active_customers
            LIMIT $2
        `, [merchantId, maxCustomers]);
        customers = customersResult.rows;
    }

    if (customers.length === 0) {
        logger.info('No customers to process for loyalty catchup', { merchantId });
        return results;
    }

    // Get merchant's location IDs
    const locationsResult = await db.query(`
        SELECT id FROM locations WHERE merchant_id = $1 AND active = TRUE
    `, [merchantId]);
    const locationIds = locationsResult.rows.map(r => r.id);
    if (locationIds.length === 0) {
        throw new Error('No active locations found for merchant');
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Process each customer
    for (const customer of customers) {
        const squareCustomerId = customer.square_customer_id;
        results.customersProcessed++;

        try {
            const orders = [];
            let cursor = null;
            let paginationIterations = 0;

            do {
                if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                    logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/orders/search (backfill)' });
                    break;
                }
                const requestBody = {
                    location_ids: locationIds,
                    query: {
                        filter: {
                            customer_filter: { customer_ids: [squareCustomerId] },
                            state_filter: { states: ['COMPLETED'] },
                            date_time_filter: {
                                closed_at: { start_at: startDate.toISOString(), end_at: endDate.toISOString() }
                            }
                        },
                        sort: { sort_field: 'CLOSED_AT', sort_order: 'DESC' }
                    },
                    limit: 50
                };
                if (cursor) requestBody.cursor = cursor;

                const backfillSearchStart = Date.now();
                const response = await fetchWithTimeout('https://connect.squareup.com/v2/orders/search', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': SQUARE_API_VERSION
                    },
                    body: JSON.stringify(requestBody)
                }, 15000);
                const backfillSearchDuration = Date.now() - backfillSearchStart;

                loyaltyLogger.squareApi({
                    endpoint: '/orders/search', method: 'POST',
                    status: response.status, duration: backfillSearchDuration,
                    success: response.ok, merchantId, context: 'backfillCustomerOrders',
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(`Square API error: ${JSON.stringify(errorData)}`);
                }

                const data = await response.json();
                orders.push(...(data.orders || []));
                cursor = data.cursor;
            } while (cursor);

            results.ordersFound += orders.length;

            for (const order of orders) {
                try {
                    const intakeResult = await processLoyaltyOrder({
                        order, merchantId, squareCustomerId,
                        source: 'catchup', customerSource: 'catchup_reverse_lookup'
                    });

                    if (intakeResult.alreadyProcessed) {
                        results.ordersAlreadyTracked++;
                    } else if (intakeResult.purchaseEvents.length > 0) {
                        results.ordersNewlyTracked++;
                        logger.debug('Catchup: tracked new order', {
                            orderId: order.id, customerId: squareCustomerId,
                            purchases: intakeResult.purchaseEvents.length
                        });
                    }
                } catch (orderError) {
                    logger.debug('Catchup: order processing failed', {
                        orderId: order.id, error: orderError.message
                    });
                }
            }
        } catch (customerError) {
            logger.warn('Catchup: customer processing failed', {
                customerId: squareCustomerId, error: customerError.message
            });
            results.errors.push({ customerId: squareCustomerId, error: customerError.message });
        }

        // Small delay between customers to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('Loyalty catchup complete', { merchantId, ...results });
    return results;
}

module.exports = {
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents,
    isOrderAlreadyProcessedForLoyalty,
    processOrderForLoyaltyIfNeeded,
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking,
    runLoyaltyCatchup,
    // Export for testing
    _catchupRecentlyRan: catchupRecentlyRan
};
