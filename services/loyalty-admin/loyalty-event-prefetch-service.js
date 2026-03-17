/**
 * Loyalty Event Prefetch Service
 *
 * Pre-fetches loyalty events from Square API for batch processing.
 * Builds in-memory lookup maps for fast customer identification
 * without per-order API calls.
 *
 * Extracted from backfill-service.js for 300-line compliance.
 * B1/B3 fix: replaced bare fetch() with fetchWithTimeout.
 */

const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { fetchWithTimeout, getSquareAccessToken, SQUARE_API_VERSION } = require('./shared-utils'); // LOGIC CHANGE: use centralized Square API version from constants (CRIT-5)

/**
 * Pre-fetch all recent loyalty ACCUMULATE_POINTS events for batch processing
 * This avoids making individual API calls per order during backfill
 *
 * @param {number} merchantId - Internal merchant ID
 * @param {number} days - Number of days to look back (default 7)
 * @returns {Promise<Object>} Object with events array and lookup maps
 */
async function prefetchRecentLoyaltyEvents(merchantId, days = 7) {
    try {
        const accessToken = await getSquareAccessToken(merchantId);
        if (!accessToken) {
            return { events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} };
        }

        // Calculate date range for filtering
        const beginTime = new Date();
        beginTime.setDate(beginTime.getDate() - days);

        const allEvents = [];
        let cursor = null;

        // Fetch all ACCUMULATE_POINTS events (paginated)
        do {
            const requestBody = {
                query: {
                    filter: {
                        type_filter: {
                            types: ['ACCUMULATE_POINTS']
                        },
                        date_time_filter: {
                            created_at: {
                                start_at: beginTime.toISOString()
                            }
                        }
                    }
                },
                limit: 30
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const startTime = Date.now();
            const response = await fetchWithTimeout('https://connect.squareup.com/v2/loyalty/events/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                },
                body: JSON.stringify(requestBody)
            }, 15000);
            const duration = Date.now() - startTime;

            loyaltyLogger.squareApi({
                endpoint: '/loyalty/events/search',
                method: 'POST',
                status: response.status,
                duration,
                success: response.ok,
                merchantId,
            });

            if (!response.ok) {
                logger.error('Failed to fetch loyalty events', { status: response.status });
                break;
            }

            const data = await response.json();
            const events = data.events || [];
            allEvents.push(...events);
            cursor = data.cursor;

        } while (cursor);

        logger.info('Prefetched loyalty events', { merchantId, eventCount: allEvents.length, days });

        // Build lookup maps for fast matching
        const byOrderId = {};
        const byTimestamp = [];
        const loyaltyAccountIds = new Set();

        for (const event of allEvents) {
            // Map by order_id if present
            if (event.order_id) {
                byOrderId[event.order_id] = event;
            }

            // Store for timestamp matching
            byTimestamp.push({
                loyaltyAccountId: event.loyalty_account_id,
                createdAt: new Date(event.created_at).getTime(),
                orderId: event.order_id
            });

            loyaltyAccountIds.add(event.loyalty_account_id);
        }

        // Fetch all loyalty accounts to get customer IDs
        const loyaltyAccounts = {};
        for (const accountId of loyaltyAccountIds) {
            try {
                const accountStartTime = Date.now();
                const accountResponse = await fetchWithTimeout(`https://connect.squareup.com/v2/loyalty/accounts/${accountId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': SQUARE_API_VERSION
                    }
                }, 10000);
                const accountDuration = Date.now() - accountStartTime;

                loyaltyLogger.squareApi({
                    endpoint: `/loyalty/accounts/${accountId}`,
                    method: 'GET',
                    status: accountResponse.status,
                    duration: accountDuration,
                    success: accountResponse.ok,
                    merchantId,
                });

                if (accountResponse.ok) {
                    const accountData = await accountResponse.json();
                    if (accountData.loyalty_account?.customer_id) {
                        loyaltyAccounts[accountId] = accountData.loyalty_account.customer_id;
                    }
                }
            } catch (err) {
                logger.warn('Failed to fetch loyalty account', { accountId, error: err.message });
            }
        }

        logger.info('Prefetched loyalty accounts', { merchantId, accountCount: Object.keys(loyaltyAccounts).length });

        return {
            events: allEvents,
            byOrderId,
            byTimestamp,
            loyaltyAccounts
        };

    } catch (error) {
        logger.error('Error prefetching loyalty events', { error: error.message, stack: error.stack, merchantId });
        return { events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} };
    }
}

/**
 * Find customer_id from prefetched loyalty events
 * Uses in-memory lookup instead of API calls
 *
 * IMPORTANT: Only uses reliable order_id lookup.
 * Timestamp matching was removed as it could misattribute purchases.
 *
 * @param {string} orderId - Square order ID
 * @param {Object} prefetchedData - Data from prefetchRecentLoyaltyEvents
 * @returns {string|null} customer_id if found, null otherwise
 */
function findCustomerFromPrefetchedEvents(orderId, prefetchedData) {
    const { byOrderId, loyaltyAccounts } = prefetchedData;

    // Direct lookup by order_id (RELIABLE)
    if (byOrderId[orderId]) {
        const event = byOrderId[orderId];
        const customerId = loyaltyAccounts[event.loyalty_account_id];
        if (customerId) {
            logger.debug('Found customer by order_id in prefetched data', { orderId, customerId });
            return customerId;
        }
    }

    // NOTE: Timestamp matching was intentionally removed.
    // It could match the wrong customer if multiple people checked in
    // around the same time. Better to miss a purchase than misattribute it.

    return null;
}

module.exports = {
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents
};
