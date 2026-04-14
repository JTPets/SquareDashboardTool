/**
 * Order History Audit Service
 *
 * Provides customer order history analysis for loyalty audit:
 * - getCustomerOrderHistoryForAudit: Fetch + analyze orders with qualifying items
 * - addOrdersToLoyaltyTracking: Manual backfill for specific customer orders
 *
 * Extracted from backfill-service.js for 300-line compliance.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { AuditActions } = require('./constants');
const { makeSquareRequest, getMerchantToken, SquareApiError } = require('../square/square-client');
const { logAuditEvent } = require('./audit-service');
const { processLoyaltyOrder } = require('./order-intake');
const { SQUARE: { MAX_PAGINATION_ITERATIONS } } = require('../../config/constants');

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
        isChunkedMode = true;
        endDate = new Date();
        endDate.setDate(1);
        endDate.setMonth(endDate.getMonth() - startMonthsAgo);
        if (startMonthsAgo === 0) {
            endDate = new Date();
        } else {
            endDate.setMonth(endDate.getMonth() + 1);
            endDate.setDate(0);
            endDate.setHours(23, 59, 59, 999);
        }
        startDate = new Date();
        startDate.setDate(1);
        startDate.setMonth(startDate.getMonth() - endMonthsAgo);
        startDate.setHours(0, 0, 0, 0);
    } else {
        const days = periodDays || 91;
        endDate = new Date();
        startDate = new Date(endDate.getTime() - (days * 24 * 60 * 60 * 1000));
    }

    logger.info('Fetching customer order history for loyalty audit', {
        squareCustomerId, merchantId, isChunkedMode,
        startMonthsAgo, endMonthsAgo, periodDays,
        dateRange: { start: startDate.toISOString(), end: endDate.toISOString() }
    });

    // getMerchantToken throws when merchant is missing/inactive/no token;
    // legacy getSquareAccessToken returned null for the same cases. Preserve
    // the prior "No access token available" error for callers.
    let accessToken;
    try {
        accessToken = await getMerchantToken(merchantId);
    } catch (err) {
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
                offerId: offer.id, offerName: offer.offer_name,
                brandName: offer.brand_name, sizeGroup: offer.size_group,
                requiredQuantity: offer.required_quantity
            });
        }
    }

    // Get orders already tracked for this customer
    const trackedOrdersResult = await db.query(`
        SELECT DISTINCT ON (square_order_id) square_order_id, customer_source
        FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND square_customer_id = $2
        ORDER BY square_order_id, created_at ASC
    `, [merchantId, squareCustomerId]);
    const trackedOrderIds = new Set(trackedOrdersResult.rows.map(r => r.square_order_id));
    const trackedOrderSources = new Map(trackedOrdersResult.rows.map(r => [r.square_order_id, r.customer_source]));

    // Get redemption records for cross-reference
    const redemptionsResult = await db.query(`
        SELECT lr.square_order_id, lr.redeemed_item_name, lr.redeemed_variation_id,
               lr.redeemed_variation_name, lr.redeemed_value_cents, lo.offer_name
        FROM loyalty_redemptions lr
        JOIN loyalty_offers lo ON lr.offer_id = lo.id
        WHERE lr.merchant_id = $1 AND lr.square_customer_id = $2
          AND lr.square_order_id IS NOT NULL
    `, [merchantId, squareCustomerId]);

    const orderRedemptionsMap = new Map();
    for (const row of redemptionsResult.rows) {
        if (!orderRedemptionsMap.has(row.square_order_id)) {
            orderRedemptionsMap.set(row.square_order_id, []);
        }
        orderRedemptionsMap.get(row.square_order_id).push({
            itemName: row.redeemed_item_name, variationId: row.redeemed_variation_id,
            variationName: row.redeemed_variation_name, valueCents: row.redeemed_value_cents,
            offerName: row.offer_name
        });
    }

    // Get customer's current loyalty status
    const rewardsResult = await db.query(`
        SELECT r.*, o.offer_name, o.required_quantity
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1 AND r.square_customer_id = $2
        ORDER BY r.created_at DESC
    `, [merchantId, squareCustomerId]);

    // Get merchant's location IDs
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
    let paginationIterations = 0;
    do {
        if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
            logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/orders/search (order-history-audit)' });
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

        const ordersSearchStart = Date.now();
        let data;
        try {
            data = await makeSquareRequest('/v2/orders/search', {
                method: 'POST',
                accessToken,
                timeout: 15000,
                body: JSON.stringify(requestBody)
            });

            loyaltyLogger.squareApi({
                endpoint: '/orders/search', method: 'POST',
                status: 200, duration: Date.now() - ordersSearchStart,
                success: true, merchantId, context: 'findMissedQualifyingOrders',
            });
        } catch (error) {
            const status = error instanceof SquareApiError ? error.status : 0;
            loyaltyLogger.squareApi({
                endpoint: '/orders/search', method: 'POST',
                status, duration: Date.now() - ordersSearchStart,
                success: false, merchantId, context: 'findMissedQualifyingOrders',
            });
            throw error;
        }

        orders.push(...(data.orders || []));
        cursor = data.cursor;
    } while (cursor);

    // Analyze each order
    // LOGIC CHANGE: renamed from _analyzeOrders for public export (BACKLOG-71)
    const analyzedOrders = analyzeOrders(orders, variationToOffer, trackedOrderIds, trackedOrderSources, orderRedemptionsMap);

    // Summary stats
    const summary = {
        totalOrders: orders.length,
        alreadyTracked: analyzedOrders.filter(o => o.isAlreadyTracked).length,
        canBeAdded: analyzedOrders.filter(o => o.canBeAdded).length,
        totalQualifyingQtyAvailable: analyzedOrders
            .filter(o => o.canBeAdded)
            .reduce((sum, o) => sum + o.totalQualifyingQty, 0)
    };

    const response = {
        squareCustomerId,
        dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
        currentRewards: rewardsResult.rows,
        summary,
        orders: analyzedOrders
    };

    if (isChunkedMode) {
        response.chunk = { startMonthsAgo, endMonthsAgo };
        response.hasMoreHistory = endMonthsAgo < 18;
    } else {
        response.periodDays = periodDays || 91;
    }

    return response;
}

// LOGIC CHANGE: exported analyzeOrders for independent testing (BACKLOG-71)
/**
 * Analyze orders for qualifying items, free items, and redemption cross-references.
 *
 * @param {Array<Object>} orders - Square order objects
 * @param {Map<string, Object>} variationToOffer - Maps variation ID to offer info
 * @param {Set<string>} trackedOrderIds - Already-tracked Square order IDs
 * @param {Map<string, string>} trackedOrderSources - Order ID to customer_source mapping
 * @param {Map<string, Array>} orderRedemptionsMap - Order ID to redemption records
 * @returns {Array<Object>} Analyzed orders with qualifying/non-qualifying items
 */
function analyzeOrders(orders, variationToOffer, trackedOrderIds, trackedOrderSources, orderRedemptionsMap) {
    const analyzedOrders = [];

    for (const order of orders) {
        const isAlreadyTracked = trackedOrderIds.has(order.id);
        let receiptUrl = null;
        for (const tender of order.tenders || []) {
            if (tender.receipt_url) { receiptUrl = tender.receipt_url; break; }
        }

        const qualifyingItems = [];
        const nonQualifyingItems = [];

        for (const lineItem of order.line_items || []) {
            const variationId = lineItem.catalog_object_id;
            const quantity = parseInt(lineItem.quantity) || 0;
            const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
            const rawTotalMoney = lineItem.total_money?.amount;
            const totalMoneyCents = rawTotalMoney != null ? Number(rawTotalMoney) : unitPriceCents;
            const isFree = unitPriceCents > 0 && totalMoneyCents === 0;

            const itemInfo = {
                uid: lineItem.uid, variationId, name: lineItem.name,
                quantity, unitPriceCents, totalMoneyCents, isFree
            };

            if (variationId && variationToOffer.has(variationId) && !isFree) {
                const offer = variationToOffer.get(variationId);
                qualifyingItems.push({
                    ...itemInfo,
                    offer: { id: offer.offerId, name: offer.offerName, brandName: offer.brandName, sizeGroup: offer.sizeGroup }
                });
            } else {
                nonQualifyingItems.push({
                    ...itemInfo,
                    skipReason: isFree ? 'free_item' : (variationId ? 'no_matching_offer' : 'no_variation_id')
                });
            }
        }

        // Cross-reference with redemption records
        const orderRedemptions = orderRedemptionsMap.get(order.id) || [];
        for (const redemption of orderRedemptions) {
            const alreadyDetectedFree = nonQualifyingItems.some(
                ni => ni.skipReason === 'free_item' && ni.variationId === redemption.variationId
            );
            if (!alreadyDetectedFree) {
                nonQualifyingItems.push({
                    uid: null, variationId: redemption.variationId,
                    name: redemption.itemName || redemption.variationName || 'Redeemed Item',
                    quantity: 1, unitPriceCents: redemption.valueCents || 0,
                    totalMoneyCents: 0, isFree: true,
                    skipReason: 'redeemed_reward', offerName: redemption.offerName
                });
            }
        }

        const totalQualifyingQty = qualifyingItems.reduce((sum, item) => sum + item.quantity, 0);

        analyzedOrders.push({
            orderId: order.id,
            orderCustomerId: order.customer_id || null,
            customerSource: isAlreadyTracked ? trackedOrderSources.get(order.id) : null,
            closedAt: order.closed_at,
            locationId: order.location_id,
            receiptUrl, isAlreadyTracked,
            canBeAdded: !isAlreadyTracked && totalQualifyingQty > 0,
            qualifyingItems, nonQualifyingItems,
            totalQualifyingQty,
            orderTotal: order.total_money
        });
    }

    return analyzedOrders;
}

/**
 * Add selected orders to loyalty tracking (manual backfill for specific customer)
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
        squareCustomerId, merchantId, orderCount: orderIds.length
    });

    // getMerchantToken throws when merchant is missing/inactive/no token;
    // legacy getSquareAccessToken returned null for the same cases. Preserve
    // the prior "No access token available" error for callers.
    let accessToken;
    try {
        accessToken = await getMerchantToken(merchantId);
    } catch (err) {
        throw new Error('No access token available');
    }

    const results = { processed: [], skipped: [], errors: [] };

    for (const orderId of orderIds) {
        try {
            const orderFetchStart = Date.now();
            let data;
            try {
                data = await makeSquareRequest(`/v2/orders/${orderId}`, {
                    method: 'GET',
                    accessToken,
                    timeout: 10000
                });

                loyaltyLogger.squareApi({
                    endpoint: `/orders/${orderId}`, method: 'GET',
                    status: 200, duration: Date.now() - orderFetchStart,
                    success: true, merchantId, context: 'addManualOrders',
                });
            } catch (fetchError) {
                const status = fetchError instanceof SquareApiError ? fetchError.status : 0;
                loyaltyLogger.squareApi({
                    endpoint: `/orders/${orderId}`, method: 'GET',
                    status, duration: Date.now() - orderFetchStart,
                    success: false, merchantId, context: 'addManualOrders',
                });

                if (fetchError instanceof SquareApiError) {
                    const errorData = { errors: fetchError.details || [] };
                    results.errors.push({ orderId, error: `Square API: ${JSON.stringify(errorData)}` });
                    continue;
                }
                throw fetchError;
            }

            const order = data.order;
            if (!order) {
                results.errors.push({ orderId, error: 'Order not found' });
                continue;
            }

            const orderCustomerId = order.customer_id;
            if (orderCustomerId && orderCustomerId !== squareCustomerId) {
                results.errors.push({
                    orderId,
                    error: `Customer ID mismatch - order belongs to ${orderCustomerId.slice(0,8)}..., expected ${squareCustomerId.slice(0,8)}...`
                });
                continue;
            }

            const intakeResult = await processLoyaltyOrder({
                order, merchantId, squareCustomerId,
                source: 'audit', customerSource: 'manual'
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

    await logAuditEvent({
        action: AuditActions.PURCHASE_RECORDED,
        merchantId, squareCustomerId,
        triggeredBy: 'ADMIN_BACKFILL',
        details: {
            ordersProcessed: results.processed.length,
            ordersSkipped: results.skipped.length,
            ordersErrored: results.errors.length
        }
    });

    logger.info('Manual order backfill complete', {
        squareCustomerId, merchantId,
        processed: results.processed.length,
        skipped: results.skipped.length,
        errors: results.errors.length
    });

    return results;
}

module.exports = {
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking,
    analyzeOrders
};
