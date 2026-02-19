/**
 * Loyalty Backfill Service
 *
 * Handles backfill, catchup, and order history audit operations:
 * - Prefetch loyalty events for batch processing
 * - Check if orders are already processed
 * - Manual order backfill for specific customers
 * - Background catchup for missed orders
 * - Customer order history audit with qualifying item analysis
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { AuditActions } = require('./constants');
const { fetchWithTimeout, getSquareAccessToken } = require('./shared-utils');
const { logAuditEvent } = require('./audit-service');
const { processLoyaltyOrder } = require('./order-intake');

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
            const response = await fetch('https://connect.squareup.com/v2/loyalty/events/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                },
                body: JSON.stringify(requestBody)
            });
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
                const accountResponse = await fetch(`https://connect.squareup.com/v2/loyalty/accounts/${accountId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2025-01-16'
                    }
                });
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

/**
 * Check if an order has already been processed for loyalty
 * Uses the idempotency constraint on loyalty_purchase_events
 *
 * @param {string} squareOrderId - Square order ID
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<boolean>} True if order was already processed
 */
async function isOrderAlreadyProcessedForLoyalty(squareOrderId, merchantId) {
    const result = await db.query(`
        SELECT 1 FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND square_order_id = $2
        LIMIT 1
    `, [merchantId, squareOrderId]);
    return result.rows.length > 0;
}

/**
 * Process an order for loyalty ONLY if not already processed (idempotent)
 * Used by sales velocity sync to catch missed orders without double-counting.
 *
 * Order history is append-only - once COMPLETED, orders don't change.
 * So if we've processed an order once, we never need to reprocess it.
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<Object>} Result with processed status
 */
async function processOrderForLoyaltyIfNeeded(order, merchantId) {
    // Skip if order was already processed (idempotent check)
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

    // Use the customer_id from the order directly
    // The consolidated intake handles the case where squareCustomerId is null
    const intakeResult = await processLoyaltyOrder({
        order,
        merchantId,
        squareCustomerId: order.customer_id || null,
        source: 'backfill',
        customerSource: 'order'
    });

    // Adapt to the legacy return format expected by callers
    return {
        processed: !intakeResult.alreadyProcessed && intakeResult.purchaseEvents.length > 0,
        reason: intakeResult.alreadyProcessed ? 'already_processed' : undefined,
        orderId: order.id,
        purchasesRecorded: intakeResult.purchaseEvents,
        rewardEarned: intakeResult.rewardEarned
    };
}

/**
 * Get customer order history for loyalty audit with qualifying item analysis
 * Supports both chunked mode (months-based) and legacy mode (days-based)
 *
 * @param {Object} params
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.merchantId - Internal merchant ID
 * @param {number} [params.startMonthsAgo=null] - Start of chunk (0 = now)
 * @param {number} [params.endMonthsAgo=null] - End of chunk (3 = 3 months ago)
 * @param {number} [params.periodDays=null] - Legacy: how many days of history to fetch
 * @returns {Promise<Object>} Order history with loyalty analysis
 */
async function getCustomerOrderHistoryForAudit({
    squareCustomerId,
    merchantId,
    startMonthsAgo = null,
    endMonthsAgo = null,
    periodDays = null
}) {
    if (!squareCustomerId || !merchantId) {
        throw new Error('squareCustomerId and merchantId are required');
    }

    // Determine date range based on params
    let startDate, endDate;
    let isChunkedMode = false;

    if (startMonthsAgo !== null && endMonthsAgo !== null) {
        // Chunked mode: calculate dates from months
        // Use day=1 to avoid rollover bugs (e.g., Mar 31 - 1 month should be Feb, not Mar 3)
        isChunkedMode = true;

        endDate = new Date();
        endDate.setDate(1); // Set to 1st to prevent rollover
        endDate.setMonth(endDate.getMonth() - startMonthsAgo);
        // Set to end of month for the "end" boundary (or today if startMonthsAgo=0)
        if (startMonthsAgo === 0) {
            endDate = new Date(); // Use exact current time for most recent chunk
        } else {
            // Go to last day of previous month
            endDate.setMonth(endDate.getMonth() + 1);
            endDate.setDate(0); // Last day of previous month
            endDate.setHours(23, 59, 59, 999);
        }

        startDate = new Date();
        startDate.setDate(1); // Set to 1st to prevent rollover
        startDate.setMonth(startDate.getMonth() - endMonthsAgo);
        startDate.setHours(0, 0, 0, 0);
    } else {
        // Legacy days mode
        const days = periodDays || 91;
        endDate = new Date();
        startDate = new Date(endDate.getTime() - (days * 24 * 60 * 60 * 1000));
    }

    logger.info('Fetching customer order history for loyalty audit', {
        squareCustomerId,
        merchantId,
        isChunkedMode,
        startMonthsAgo,
        endMonthsAgo,
        periodDays,
        dateRange: { start: startDate.toISOString(), end: endDate.toISOString() }
    });

    const accessToken = await getSquareAccessToken(merchantId);
    if (!accessToken) {
        throw new Error('No access token available');
    }

    // Get all active offers and their qualifying variations for this merchant
    const offersResult = await db.query(`
        SELECT o.id, o.offer_name, o.brand_name, o.size_group, o.required_quantity,
               array_agg(qv.variation_id) as variation_ids
        FROM loyalty_offers o
        JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id AND qv.is_active = TRUE
        WHERE o.merchant_id = $1 AND o.is_active = TRUE
        GROUP BY o.id
    `, [merchantId]);

    // Build variation -> offer lookup
    const variationToOffer = new Map();
    for (const offer of offersResult.rows) {
        for (const varId of offer.variation_ids || []) {
            variationToOffer.set(varId, {
                offerId: offer.id,
                offerName: offer.offer_name,
                brandName: offer.brand_name,
                sizeGroup: offer.size_group,
                requiredQuantity: offer.required_quantity
            });
        }
    }

    // Get orders already tracked for this customer (including customer_source for display)
    const trackedOrdersResult = await db.query(`
        SELECT DISTINCT ON (square_order_id) square_order_id, customer_source
        FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND square_customer_id = $2
        ORDER BY square_order_id, created_at ASC
    `, [merchantId, squareCustomerId]);
    const trackedOrderIds = new Set(trackedOrdersResult.rows.map(r => r.square_order_id));
    const trackedOrderSources = new Map(trackedOrdersResult.rows.map(r => [r.square_order_id, r.customer_source]));

    // Get redemption records for this customer to cross-reference with orders
    // This catches cases where the free item isn't visible in Square order data
    // (e.g., discount removed during manual fix, hiccup with discount application)
    const redemptionsResult = await db.query(`
        SELECT lr.square_order_id, lr.redeemed_item_name, lr.redeemed_variation_id,
               lr.redeemed_variation_name, lr.redeemed_value_cents, lo.offer_name
        FROM loyalty_redemptions lr
        JOIN loyalty_offers lo ON lr.offer_id = lo.id
        WHERE lr.merchant_id = $1 AND lr.square_customer_id = $2
          AND lr.square_order_id IS NOT NULL
    `, [merchantId, squareCustomerId]);

    // Build order_id -> redemptions lookup
    const orderRedemptionsMap = new Map();
    for (const row of redemptionsResult.rows) {
        if (!orderRedemptionsMap.has(row.square_order_id)) {
            orderRedemptionsMap.set(row.square_order_id, []);
        }
        orderRedemptionsMap.get(row.square_order_id).push({
            itemName: row.redeemed_item_name,
            variationId: row.redeemed_variation_id,
            variationName: row.redeemed_variation_name,
            valueCents: row.redeemed_value_cents,
            offerName: row.offer_name
        });
    }

    // Get customer's current loyalty status (only needed for first chunk or legacy mode)
    // In chunked mode, frontend caches this from first request
    const rewardsResult = await db.query(`
        SELECT r.*, o.offer_name, o.required_quantity
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1 AND r.square_customer_id = $2
        ORDER BY r.created_at DESC
    `, [merchantId, squareCustomerId]);

    // Get merchant's location IDs (required for Square Orders Search API)
    const locationsResult = await db.query(`
        SELECT id FROM locations WHERE merchant_id = $1 AND active = TRUE
    `, [merchantId]);
    const locationIds = locationsResult.rows.map(r => r.id);

    if (locationIds.length === 0) {
        throw new Error('No active locations found for merchant');
    }

    // Fetch orders from Square
    const orders = [];
    let cursor = null;

    do {
        const requestBody = {
            location_ids: locationIds,
            query: {
                filter: {
                    customer_filter: {
                        customer_ids: [squareCustomerId]
                    },
                    state_filter: {
                        states: ['COMPLETED']
                    },
                    date_time_filter: {
                        closed_at: {
                            start_at: startDate.toISOString(),
                            end_at: endDate.toISOString()
                        }
                    }
                },
                sort: {
                    sort_field: 'CLOSED_AT',
                    sort_order: 'DESC'
                }
            },
            limit: 50
        };

        if (cursor) {
            requestBody.cursor = cursor;
        }

        const ordersSearchStart = Date.now();
        const response = await fetchWithTimeout('https://connect.squareup.com/v2/orders/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify(requestBody)
        }, 15000); // 15 second timeout for search
        const ordersSearchDuration = Date.now() - ordersSearchStart;

        loyaltyLogger.squareApi({
            endpoint: '/orders/search',
            method: 'POST',
            status: response.status,
            duration: ordersSearchDuration,
            success: response.ok,
            merchantId,
            context: 'findMissedQualifyingOrders',
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Square API error: ${JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        orders.push(...(data.orders || []));
        cursor = data.cursor;

    } while (cursor);

    // Analyze each order
    const analyzedOrders = [];

    for (const order of orders) {
        const isAlreadyTracked = trackedOrderIds.has(order.id);

        // Get receipt URL from tenders
        let receiptUrl = null;
        for (const tender of order.tenders || []) {
            if (tender.receipt_url) {
                receiptUrl = tender.receipt_url;
                break;
            }
        }

        // Analyze line items
        const qualifyingItems = [];
        const nonQualifyingItems = [];

        for (const lineItem of order.line_items || []) {
            const variationId = lineItem.catalog_object_id;
            const quantity = parseInt(lineItem.quantity) || 0;
            // Convert BigInt to Number for Square SDK v43+
            const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
            // Use nullish check to preserve 0 values (free items have total_money = 0)
            const rawTotalMoney = lineItem.total_money?.amount;
            const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : unitPriceCents;

            // Check if free (100% discounted)
            const isFree = unitPriceCents > 0 && totalMoneyCents === 0;

            const itemInfo = {
                uid: lineItem.uid,
                variationId,
                name: lineItem.name,
                quantity,
                unitPriceCents,
                totalMoneyCents,
                isFree
            };

            if (variationId && variationToOffer.has(variationId) && !isFree) {
                const offer = variationToOffer.get(variationId);
                qualifyingItems.push({
                    ...itemInfo,
                    offer: {
                        id: offer.offerId,
                        name: offer.offerName,
                        brandName: offer.brandName,
                        sizeGroup: offer.sizeGroup
                    }
                });
            } else {
                nonQualifyingItems.push({
                    ...itemInfo,
                    skipReason: isFree ? 'free_item' : (variationId ? 'no_matching_offer' : 'no_variation_id')
                });
            }
        }

        // Cross-reference with redemption records
        // If this order has a redemption but the redeemed item wasn't detected as free
        // in the line items (e.g., discount removed, hiccup with application), add it
        const orderRedemptions = orderRedemptionsMap.get(order.id) || [];
        for (const redemption of orderRedemptions) {
            const alreadyDetectedFree = nonQualifyingItems.some(
                ni => ni.skipReason === 'free_item' && ni.variationId === redemption.variationId
            );
            if (!alreadyDetectedFree) {
                nonQualifyingItems.push({
                    uid: null,
                    variationId: redemption.variationId,
                    name: redemption.itemName || redemption.variationName || 'Redeemed Item',
                    quantity: 1,
                    unitPriceCents: redemption.valueCents || 0,
                    totalMoneyCents: 0,
                    isFree: true,
                    skipReason: 'redeemed_reward',
                    offerName: redemption.offerName
                });
            }
        }

        // Calculate totals
        const totalQualifyingQty = qualifyingItems.reduce((sum, item) => sum + item.quantity, 0);

        analyzedOrders.push({
            orderId: order.id,
            orderCustomerId: order.customer_id || null,  // Show actual customer_id on order
            customerSource: isAlreadyTracked ? trackedOrderSources.get(order.id) : null,  // How we linked to customer
            closedAt: order.closed_at,
            locationId: order.location_id,
            receiptUrl,
            isAlreadyTracked,
            canBeAdded: !isAlreadyTracked && totalQualifyingQty > 0,
            qualifyingItems,
            nonQualifyingItems,
            totalQualifyingQty,
            orderTotal: order.total_money
        });
    }

    // Summary stats
    const summary = {
        totalOrders: orders.length,
        alreadyTracked: analyzedOrders.filter(o => o.isAlreadyTracked).length,
        canBeAdded: analyzedOrders.filter(o => o.canBeAdded).length,
        totalQualifyingQtyAvailable: analyzedOrders
            .filter(o => o.canBeAdded)
            .reduce((sum, o) => sum + o.totalQualifyingQty, 0)
    };

    // Build response with chunk info for chunked mode
    const response = {
        squareCustomerId,
        dateRange: {
            start: startDate.toISOString(),
            end: endDate.toISOString()
        },
        currentRewards: rewardsResult.rows,
        summary,
        orders: analyzedOrders
    };

    if (isChunkedMode) {
        // Chunked mode: include chunk info and hasMoreHistory flag
        response.chunk = {
            startMonthsAgo,
            endMonthsAgo
        };
        response.hasMoreHistory = endMonthsAgo < 18;
    } else {
        // Legacy mode: include periodDays for backward compat
        response.periodDays = periodDays || 91;
    }

    return response;
}

/**
 * Add selected orders to loyalty tracking (manual backfill for specific customer)
 * Called after admin reviews order history and selects which orders to add
 *
 * @param {Object} params
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.merchantId - Internal merchant ID
 * @param {Array<string>} params.orderIds - Array of Square order IDs to add
 * @returns {Promise<Object>} Results of adding orders
 */
async function addOrdersToLoyaltyTracking({ squareCustomerId, merchantId, orderIds }) {
    if (!squareCustomerId || !merchantId || !orderIds?.length) {
        throw new Error('squareCustomerId, merchantId, and orderIds are required');
    }

    logger.info('Manually adding orders to loyalty tracking', {
        squareCustomerId,
        merchantId,
        orderCount: orderIds.length
    });

    const accessToken = await getSquareAccessToken(merchantId);
    if (!accessToken) {
        throw new Error('No access token available');
    }

    const results = {
        processed: [],
        skipped: [],
        errors: []
    };

    // Fetch each order and process through consolidated intake
    for (const orderId of orderIds) {
        try {
            // Fetch order from Square with timeout
            const orderFetchStart = Date.now();
            const response = await fetchWithTimeout(`https://connect.squareup.com/v2/orders/${orderId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2025-01-16'
                }
            }, 10000); // 10 second timeout per order
            const orderFetchDuration = Date.now() - orderFetchStart;

            loyaltyLogger.squareApi({
                endpoint: `/orders/${orderId}`,
                method: 'GET',
                status: response.status,
                duration: orderFetchDuration,
                success: response.ok,
                merchantId,
                context: 'addManualOrders',
            });

            if (!response.ok) {
                const errorData = await response.json();
                results.errors.push({ orderId, error: `Square API: ${JSON.stringify(errorData)}` });
                continue;
            }

            const data = await response.json();
            const order = data.order;

            if (!order) {
                results.errors.push({ orderId, error: 'Order not found' });
                continue;
            }

            // Verify customer matches (or allow override for orders without customer_id)
            const orderCustomerId = order.customer_id;
            if (orderCustomerId && orderCustomerId !== squareCustomerId) {
                results.errors.push({
                    orderId,
                    error: `Customer ID mismatch - order belongs to ${orderCustomerId.slice(0,8)}..., expected ${squareCustomerId.slice(0,8)}...`
                });
                continue;
            }

            // Consolidated intake: atomic write to both tables (includes dedup)
            const intakeResult = await processLoyaltyOrder({
                order,
                merchantId,
                squareCustomerId,
                source: 'audit',
                customerSource: 'manual'
            });

            if (intakeResult.alreadyProcessed) {
                results.skipped.push({ orderId, reason: 'already_tracked' });
            } else {
                results.processed.push({
                    orderId,
                    purchasesRecorded: intakeResult.purchaseEvents.length,
                    skippedFreeItems: 0
                });
            }

        } catch (error) {
            logger.error('Error adding order to loyalty', { orderId, error: error.message });
            results.errors.push({ orderId, error: error.message });
        }
    }

    // Log audit event
    await logAuditEvent({
        action: AuditActions.PURCHASE_RECORDED,
        merchantId,
        squareCustomerId,
        triggeredBy: 'ADMIN_BACKFILL',
        details: {
            ordersProcessed: results.processed.length,
            ordersSkipped: results.skipped.length,
            ordersErrored: results.errors.length
        }
    });

    logger.info('Manual order backfill complete', {
        squareCustomerId,
        merchantId,
        processed: results.processed.length,
        skipped: results.skipped.length,
        errors: results.errors.length
    });

    return results;
}

/**
 * Run loyalty catchup for customers using Square's internal order linkage.
 *
 * This does a "reverse lookup" - instead of finding customer from order,
 * we take known customers and ask Square for their orders. Square internally
 * links orders to customers via payment -> loyalty -> phone, even when the
 * order itself doesn't have customer_id set.
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

    const results = {
        customersProcessed: 0,
        ordersFound: 0,
        ordersAlreadyTracked: 0,
        ordersNewlyTracked: 0,
        errors: []
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
        // Get customers with loyalty activity (have made purchases or have rewards)
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

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Process each customer
    for (const customer of customers) {
        const squareCustomerId = customer.square_customer_id;
        results.customersProcessed++;

        try {
            // Search Square for this customer's orders (using their internal linkage)
            const orders = [];
            let cursor = null;

            do {
                const requestBody = {
                    location_ids: locationIds,
                    query: {
                        filter: {
                            customer_filter: {
                                customer_ids: [squareCustomerId]
                            },
                            state_filter: {
                                states: ['COMPLETED']
                            },
                            date_time_filter: {
                                closed_at: {
                                    start_at: startDate.toISOString(),
                                    end_at: endDate.toISOString()
                                }
                            }
                        },
                        sort: {
                            sort_field: 'CLOSED_AT',
                            sort_order: 'DESC'
                        }
                    },
                    limit: 50
                };

                if (cursor) {
                    requestBody.cursor = cursor;
                }

                const backfillSearchStart = Date.now();
                const response = await fetchWithTimeout('https://connect.squareup.com/v2/orders/search', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2025-01-16'
                    },
                    body: JSON.stringify(requestBody)
                }, 15000);
                const backfillSearchDuration = Date.now() - backfillSearchStart;

                loyaltyLogger.squareApi({
                    endpoint: '/orders/search',
                    method: 'POST',
                    status: response.status,
                    duration: backfillSearchDuration,
                    success: response.ok,
                    merchantId,
                    context: 'backfillCustomerOrders',
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

            // Process each order through consolidated intake
            for (const order of orders) {
                try {
                    const intakeResult = await processLoyaltyOrder({
                        order,
                        merchantId,
                        squareCustomerId,
                        source: 'catchup',
                        customerSource: 'catchup_reverse_lookup'
                    });

                    if (intakeResult.alreadyProcessed) {
                        results.ordersAlreadyTracked++;
                    } else if (intakeResult.purchaseEvents.length > 0) {
                        results.ordersNewlyTracked++;
                        logger.debug('Catchup: tracked new order', {
                            orderId: order.id,
                            customerId: squareCustomerId,
                            purchases: intakeResult.purchaseEvents.length
                        });
                    }
                } catch (orderError) {
                    logger.debug('Catchup: order processing failed', {
                        orderId: order.id,
                        error: orderError.message
                    });
                }
            }

        } catch (customerError) {
            logger.warn('Catchup: customer processing failed', {
                customerId: squareCustomerId,
                error: customerError.message
            });
            results.errors.push({
                customerId: squareCustomerId,
                error: customerError.message
            });
        }

        // Small delay between customers to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('Loyalty catchup complete', {
        merchantId,
        ...results
    });

    return results;
}

module.exports = {
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents,
    isOrderAlreadyProcessedForLoyalty,
    processOrderForLoyaltyIfNeeded,
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking,
    runLoyaltyCatchup
};
