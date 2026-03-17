/**
 * Backfill Orchestration Service
 *
 * Fetches recent orders from Square and processes them for loyalty.
 * Handles Square API pagination, order iteration, loyalty prefetch,
 * customer identification fallback, and diagnostics collection.
 *
 * Extracted from routes/loyalty/processing.js POST /backfill (A-12)
 * — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - Uses raw fetch() instead of squareClient SDK
 * - qualifyingVariationIds query duplicates logic in loyalty-queries.js
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION } = require('./shared-utils'); // LOGIC CHANGE: use centralized Square API version from constants (CRIT-5)
const { prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents } = require('./loyalty-event-prefetch-service');
const { processLoyaltyOrder } = require('./order-intake');

/**
 * Run loyalty backfill from recent Square orders.
 * Fetches completed orders from Square, identifies customers,
 * and processes qualifying orders for loyalty.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} [params.days=7] - Number of days to look back
 * @returns {Promise<Object>} Backfill results with diagnostics
 */
async function runBackfill({ merchantId, days = 7 }) {
    if (!merchantId) {
        throw new Error('merchantId is required for runBackfill - tenant isolation required');
    }

    logger.info('Starting loyalty backfill', { merchantId, days });

    // Get location IDs
    const locationsResult = await db.query(
        'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
        [merchantId]
    );
    const locationIds = locationsResult.rows.map(r => r.id);

    if (locationIds.length === 0) {
        const error = new Error('No active locations found for this merchant');
        error.statusCode = 400;
        throw error;
    }

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get access token
    const accessToken = await getSquareAccessToken(merchantId);
    if (!accessToken) {
        const error = new Error('No Square access token configured for this merchant');
        error.statusCode = 400;
        throw error;
    }

    let cursor = null;
    let ordersProcessed = 0;
    let ordersWithCustomer = 0;
    let ordersWithQualifyingItems = 0;
    let loyaltyPurchasesRecorded = 0;
    const results = [];
    const diagnostics = { sampleOrdersWithoutCustomer: [], sampleVariationIds: [] };

    // Get qualifying variation IDs for comparison
    const qualifyingResult = await db.query(
        `SELECT DISTINCT qv.variation_id
         FROM loyalty_qualifying_variations qv
         JOIN loyalty_offers lo ON qv.offer_id = lo.id
         WHERE lo.merchant_id = $1 AND lo.is_active = TRUE`,
        [merchantId]
    );
    const qualifyingVariationIds = new Set(qualifyingResult.rows.map(r => r.variation_id));

    // Pre-fetch ALL loyalty events once at the start
    logger.info('Pre-fetching loyalty events for batch processing', { merchantId, days });
    const prefetchedLoyalty = await prefetchRecentLoyaltyEvents(merchantId, days);
    logger.info('Pre-fetch complete', {
        merchantId,
        eventsFound: prefetchedLoyalty.events.length,
        accountsMapped: Object.keys(prefetchedLoyalty.loyaltyAccounts).length
    });

    let customersFoundViaPrefetch = 0;

    // Use raw Square API
    do {
        const requestBody = {
            location_ids: locationIds,
            query: {
                filter: {
                    state_filter: {
                        states: ['COMPLETED']
                    },
                    date_time_filter: {
                        closed_at: {
                            start_at: startDate.toISOString(),
                            end_at: endDate.toISOString()
                        }
                    }
                }
            },
            limit: 50
        };

        if (cursor) {
            requestBody.cursor = cursor;
        }

        const response = await fetchWithTimeout('https://connect.squareup.com/v2/orders/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': SQUARE_API_VERSION
            },
            body: JSON.stringify(requestBody)
        }, 15000);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Square API error: ${response.status} - ${errText}`);
        }

        const data = await response.json();
        const orders = data.orders || [];

        // Process each order for loyalty
        for (const order of orders) {
            ordersProcessed++;

            // Collect sample variation IDs from orders for diagnostics
            const orderVariationIds = (order.line_items || [])
                .map(li => li.catalog_object_id)
                .filter(Boolean);
            if (diagnostics.sampleVariationIds.length < 10) {
                orderVariationIds.forEach(vid => {
                    if (!diagnostics.sampleVariationIds.includes(vid)) {
                        diagnostics.sampleVariationIds.push(vid);
                    }
                });
            }

            // Check if order has qualifying items (for diagnostics)
            const hasQualifyingItem = orderVariationIds.some(vid => qualifyingVariationIds.has(vid));
            if (hasQualifyingItem) {
                ordersWithQualifyingItems++;
            }

            // Track orders with direct customer_id
            if (order.customer_id) {
                ordersWithCustomer++;
            }

            // Skip orders without qualifying items
            if (!hasQualifyingItem) {
                continue;
            }

            try {
                // If order has no customer_id, try to find one from prefetched loyalty data
                let customerId = order.customer_id;
                if (!customerId && order.tenders) {
                    for (const tender of order.tenders) {
                        if (tender.customer_id) {
                            customerId = tender.customer_id;
                            break;
                        }
                    }
                }
                if (!customerId) {
                    customerId = findCustomerFromPrefetchedEvents(
                        order.id,
                        prefetchedLoyalty
                    );
                    if (customerId) {
                        customersFoundViaPrefetch++;
                    }
                }

                // Skip if still no customer after prefetch lookup
                if (!customerId) {
                    if (diagnostics.sampleOrdersWithoutCustomer.length < 3) {
                        diagnostics.sampleOrdersWithoutCustomer.push({
                            orderId: order.id,
                            createdAt: order.created_at,
                            hasQualifyingItem
                        });
                    }
                    continue;
                }

                const customerSource = order.customer_id
                    ? 'order'
                    : (customerId === order.tenders?.[0]?.customer_id ? 'tender' : 'loyalty_prefetch');

                const loyaltyResult = await processLoyaltyOrder({
                    order,
                    merchantId,
                    squareCustomerId: customerId,
                    source: 'backfill',
                    customerSource
                });
                if (!loyaltyResult.alreadyProcessed && loyaltyResult.purchaseEvents.length > 0) {
                    loyaltyPurchasesRecorded += loyaltyResult.purchaseEvents.length;
                    results.push({
                        orderId: order.id,
                        customerId,
                        customerSource,
                        purchasesRecorded: loyaltyResult.purchaseEvents.length
                    });
                }
            } catch (err) {
                logger.warn('Failed to process order for loyalty during backfill', {
                    orderId: order.id,
                    error: err.message
                });
            }
        }

        cursor = data.cursor;
    } while (cursor);

    logger.info('Loyalty backfill complete', {
        merchantId,
        days,
        ordersProcessed,
        ordersWithQualifyingItems,
        customersFoundViaPrefetch,
        loyaltyPurchasesRecorded
    });

    return {
        success: true,
        ordersProcessed,
        ordersWithCustomer,
        ordersWithQualifyingItems,
        customersFoundViaPrefetch,
        loyaltyPurchasesRecorded,
        results,
        diagnostics: {
            qualifyingVariationIdsConfigured: Array.from(qualifyingVariationIds),
            sampleVariationIdsInOrders: diagnostics.sampleVariationIds,
            sampleOrdersWithoutCustomer: diagnostics.sampleOrdersWithoutCustomer,
            prefetchedLoyaltyEvents: prefetchedLoyalty.events.length,
            prefetchedLoyaltyAccounts: Object.keys(prefetchedLoyalty.loyaltyAccounts).length
        }
    };
}

module.exports = {
    runBackfill
};
