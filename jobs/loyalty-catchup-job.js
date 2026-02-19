/**
 * Loyalty Catchup Job
 *
 * Scheduled job that catches orders missed by the main webhook path.
 * This handles race conditions where webhooks fire before Square
 * populates order data, resulting in skipped processing.
 *
 * Runs hourly by default, processes orders from the last 6 hours.
 *
 * @module jobs/loyalty-catchup-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const { getSquareClientForMerchant } = require('../middleware/merchant');

// Consolidated order intake (single entry point for all loyalty order processing)
const { processLoyaltyOrder } = require('../services/loyalty-admin/order-intake');
// Customer identification service
const { LoyaltyCustomerService } = require('../services/loyalty/customer-service');

// Loyalty admin service (for redemption detection)
const loyaltyService = require('../utils/loyalty-service');

// SDK order normalization (camelCase → snake_case)
const { normalizeSquareOrder } = require('../services/webhook-handlers/order-handler');

/**
 * Get all merchants with active loyalty offers
 *
 * @returns {Promise<Array>} Array of merchant IDs
 */
async function getMerchantsWithLoyalty() {
    const result = await db.query(`
        SELECT DISTINCT m.id, m.square_merchant_id
        FROM merchants m
        INNER JOIN loyalty_offers lo ON lo.merchant_id = m.id
        WHERE m.is_active = TRUE
          AND lo.is_active = TRUE
    `);
    return result.rows;
}

/**
 * Get order IDs already processed for loyalty
 *
 * Checks both loyalty_purchase_events (qualifying orders) and
 * loyalty_processed_orders (all orders including non-qualifying).
 * This prevents reprocessing of orders that had zero qualifying items.
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {Array<string>} orderIds - Order IDs to check
 * @returns {Promise<Set<string>>} Set of already-processed order IDs
 */
async function getProcessedOrderIds(merchantId, orderIds) {
    if (orderIds.length === 0) return new Set();

    // Check both tables:
    // 1. loyalty_purchase_events - orders with qualifying items that were recorded
    // 2. loyalty_processed_orders - all processed orders including non-qualifying
    const result = await db.query(`
        SELECT DISTINCT square_order_id FROM (
            SELECT square_order_id
            FROM loyalty_purchase_events
            WHERE merchant_id = $1
              AND square_order_id = ANY($2)
            UNION
            SELECT square_order_id
            FROM loyalty_processed_orders
            WHERE merchant_id = $1
              AND square_order_id = ANY($2)
        ) AS processed
    `, [merchantId, orderIds]);

    return new Set(result.rows.map(r => r.square_order_id));
}

/**
 * Fetch recent completed orders from Square
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {number} hoursBack - How many hours back to search
 * @returns {Promise<Array>} Array of order objects
 */
async function fetchRecentCompletedOrders(merchantId, hoursBack = 6) {
    const squareClient = await getSquareClientForMerchant(merchantId);

    // Calculate time range
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - (hoursBack * 60 * 60 * 1000));

    // Get location IDs for this merchant
    const locationsResult = await db.query(`
        SELECT square_location_id
        FROM locations
        WHERE merchant_id = $1 AND active = TRUE
    `, [merchantId]);

    const locationIds = locationsResult.rows.map(r => r.square_location_id).filter(Boolean);

    if (locationIds.length === 0) {
        logger.debug('No active locations for merchant', { merchantId });
        return [];
    }

    // Search for completed orders
    const orders = [];
    let cursor = null;

    do {
        const response = await squareClient.orders.search({
            locationIds,
            query: {
                filter: {
                    stateFilter: {
                        states: ['COMPLETED']
                    },
                    dateTimeFilter: {
                        closedAt: {
                            startAt: startTime.toISOString(),
                            endAt: endTime.toISOString()
                        }
                    }
                },
                sort: {
                    sortField: 'CLOSED_AT',
                    sortOrder: 'DESC'
                }
            },
            limit: 100,
            cursor
        });

        if (response.orders) {
            // SDK v43+ returns camelCase — normalize to snake_case
            orders.push(...response.orders.map(normalizeSquareOrder));
        }

        cursor = response.cursor;
    } while (cursor && orders.length < 500); // Cap at 500 orders per merchant

    return orders;
}

/**
 * Process a single merchant's missed orders
 *
 * @param {Object} merchant - Merchant object with id and square_merchant_id
 * @param {number} hoursBack - How many hours back to search
 * @returns {Promise<Object>} Processing results
 */
async function processMerchantCatchup(merchant, hoursBack) {
    const merchantId = merchant.id;
    const results = {
        merchantId,
        ordersFound: 0,
        ordersAlreadyProcessed: 0,
        ordersProcessed: 0,
        ordersFailed: 0,
        errors: []
    };

    try {
        // Fetch recent completed orders from Square
        const orders = await fetchRecentCompletedOrders(merchantId, hoursBack);
        results.ordersFound = orders.length;

        if (orders.length === 0) {
            return results;
        }

        // Get order IDs already processed
        const orderIds = orders.map(o => o.id);
        const processedIds = await getProcessedOrderIds(merchantId, orderIds);
        results.ordersAlreadyProcessed = processedIds.size;

        // Filter to only unprocessed orders with line items
        const unprocessedOrders = orders.filter(order =>
            !processedIds.has(order.id) &&
            ((order.lineItems?.length > 0) || (order.line_items?.length > 0))
        );

        if (unprocessedOrders.length === 0) {
            return results;
        }

        logger.info('Loyalty catchup found unprocessed orders', {
            merchantId,
            totalOrders: orders.length,
            alreadyProcessed: processedIds.size,
            toProcess: unprocessedOrders.length
        });

        // Process each unprocessed order through consolidated intake
        for (const order of unprocessedOrders) {
            try {
                // Identify customer for this order
                const customerService = new LoyaltyCustomerService(merchantId);
                await customerService.initialize();
                const customerResult = await customerService.identifyCustomerFromOrder(order);
                const squareCustomerId = customerResult.customerId;

                // Consolidated intake: atomic write to both tables
                const intakeResult = await processLoyaltyOrder({
                    order,
                    merchantId,
                    squareCustomerId,
                    source: 'catchup',
                    customerSource: customerResult.method || 'order'
                });

                if (!intakeResult.alreadyProcessed && intakeResult.purchaseEvents.length > 0) {
                    results.ordersProcessed++;
                    logger.info('Loyalty catchup processed order', {
                        orderId: order.id,
                        customerId: squareCustomerId,
                        qualifyingItems: intakeResult.purchaseEvents.length,
                        merchantId
                    });
                }

                // Check for reward redemption regardless of purchase processing result.
                try {
                    const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, merchantId);
                    if (redemptionResult.detected) {
                        logger.info('Loyalty catchup detected reward redemption', {
                            orderId: order.id,
                            rewardId: redemptionResult.rewardId,
                            offerName: redemptionResult.offerName,
                            merchantId
                        });
                    }
                } catch (redemptionError) {
                    logger.error('Loyalty catchup redemption detection failed', {
                        orderId: order.id,
                        error: redemptionError.message,
                        merchantId
                    });
                }
            } catch (orderError) {
                results.ordersFailed++;
                results.errors.push({
                    orderId: order.id,
                    error: orderError.message
                });
                logger.error('Loyalty catchup failed for order', {
                    orderId: order.id,
                    error: orderError.message,
                    merchantId
                });
            }
        }

    } catch (error) {
        logger.error('Loyalty catchup failed for merchant', {
            merchantId,
            error: error.message,
            stack: error.stack
        });
        results.errors.push({ error: error.message });
    }

    return results;
}

/**
 * Run the loyalty catchup job for all merchants
 *
 * @param {Object} [options] - Job options
 * @param {number} [options.hoursBack=6] - How many hours back to search
 * @returns {Promise<Object>} Aggregated results
 */
async function runLoyaltyCatchup(options = {}) {
    const { hoursBack = 6 } = options;

    const startTime = Date.now();
    const aggregateResults = {
        merchantsProcessed: 0,
        totalOrdersFound: 0,
        totalOrdersAlreadyProcessed: 0,
        totalOrdersProcessed: 0,
        totalOrdersFailed: 0,
        merchantErrors: []
    };

    try {
        // Get all merchants with active loyalty programs
        const merchants = await getMerchantsWithLoyalty();

        if (merchants.length === 0) {
            logger.info('Loyalty catchup: No merchants with active loyalty offers');
            return aggregateResults;
        }

        logger.info('Starting loyalty catchup job', {
            merchantCount: merchants.length,
            hoursBack
        });

        // Process each merchant
        for (const merchant of merchants) {
            const results = await processMerchantCatchup(merchant, hoursBack);

            aggregateResults.merchantsProcessed++;
            aggregateResults.totalOrdersFound += results.ordersFound;
            aggregateResults.totalOrdersAlreadyProcessed += results.ordersAlreadyProcessed;
            aggregateResults.totalOrdersProcessed += results.ordersProcessed;
            aggregateResults.totalOrdersFailed += results.ordersFailed;

            if (results.errors.length > 0) {
                aggregateResults.merchantErrors.push({
                    merchantId: merchant.id,
                    errors: results.errors
                });
            }
        }

        const duration = Date.now() - startTime;
        logger.info('Loyalty catchup job completed', {
            ...aggregateResults,
            durationMs: duration
        });

    } catch (error) {
        logger.error('Loyalty catchup job failed', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }

    return aggregateResults;
}

/**
 * Cron job handler for scheduled loyalty catchup
 * Wraps runLoyaltyCatchup with error handling
 *
 * @returns {Promise<void>}
 */
async function runScheduledLoyaltyCatchup() {
    try {
        await runLoyaltyCatchup({ hoursBack: 6 });
    } catch (error) {
        logger.error('Scheduled loyalty catchup error', {
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = {
    runLoyaltyCatchup,
    runScheduledLoyaltyCatchup,
    processMerchantCatchup,
    getMerchantsWithLoyalty
};
