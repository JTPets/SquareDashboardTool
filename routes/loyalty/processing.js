/**
 * Loyalty Order Processing Routes
 *
 * Order processing, backfill, catchup, and maintenance:
 * - POST /process-order/:orderId - Manually process a single order
 * - POST /backfill - Backfill loyalty from recent Square orders
 * - POST /catchup - Run reverse-lookup loyalty catchup
 * - POST /refresh-customers - Refresh customer details for rewards
 * - POST /manual-entry - Manual loyalty purchase entry
 * - POST /process-expired - Process expired window entries and rewards
 *
 * FILE LENGTH VIOLATION (>300 lines):
 * This file is ~530 lines due to 3 handlers with substantial inline business logic:
 * - POST /process-order has raw Square API call + token decryption
 * - POST /backfill has 232 lines of inline logic (Square API pagination,
 *   order iteration, loyalty prefetch, diagnostics) - should be extracted
 *   to a backfill orchestration service
 * - POST /refresh-customers has inline SQL + concurrent fetch with semaphore
 * These are documented for future service extraction. Logic moved as-is
 * per splitting rules (no refactoring during extraction).
 *
 * OBSERVATION LOG:
 * - POST /process-order uses raw fetch() instead of squareClient SDK
 * - POST /process-order has duplicate `const merchantId` declaration (line 118 shadows line 90)
 * - POST /backfill uses raw fetch() instead of squareClient SDK
 * - POST /backfill has inconsistent indentation (4-space body inside handler)
 * - POST /refresh-customers reinvents semaphore pattern (should use p-limit or similar)
 * - POST /refresh-customers has inline SQL for finding customers with missing phone data
 */

const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');
const { decryptToken, isEncryptedToken } = require('../../utils/token-encryption');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');

/**
 * POST /api/loyalty/process-order/:orderId
 * Manually fetch and process a specific Square order for loyalty
 * Useful for testing/debugging when webhooks aren't working
 */
router.post('/process-order/:orderId', requireAuth, requireMerchant, requireWriteAccess, validators.processOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const squareOrderId = req.params.orderId;

    logger.info('Manually processing order for loyalty', { squareOrderId, merchantId });

    // Get and decrypt access token
    const tokenResult = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );
    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
        return res.status(400).json({ error: 'No Square access token configured for this merchant' });
    }
    const rawToken = tokenResult.rows[0].square_access_token;
    const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

    // Fetch the order from Square using raw API
    const orderResponse = await fetch(`https://connect.squareup.com/v2/orders/${squareOrderId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-18'
        }
    });

    if (!orderResponse.ok) {
        const errText = await orderResponse.text();
        const merchantId = req.merchantContext?.id;
        logger.error('Square API error in loyalty order lookup', {
            status: orderResponse.status,
            error: errText,
            merchantId,
            squareOrderId
        });
        return res.status(502).json({
            success: false,
            error: 'Unable to retrieve order details. Please try again.',
            code: 'EXTERNAL_API_ERROR'
        });
    }

    const orderData = await orderResponse.json();
    const order = orderData.order;

    if (!order) {
        return res.status(404).json({ error: 'Order not found in Square' });
    }

    // Fetch customer details if customer_id exists
    let customerDetails = null;
    if (order.customer_id) {
        customerDetails = await loyaltyService.getCustomerDetails(order.customer_id, merchantId);
    }

    // Return diagnostic info about the order
    const diagnostics = {
        orderId: order.id,
        customerId: order.customer_id || null,
        hasCustomer: !!order.customer_id,
        customerDetails,
        state: order.state,
        createdAt: order.created_at,
        lineItems: (order.line_items || []).map(li => ({
            name: li.name,
            quantity: li.quantity,
            catalogObjectId: li.catalog_object_id,
            variationName: li.variation_name
        }))
    };

    if (!order.customer_id) {
        return res.json({
            processed: false,
            reason: 'Order has no customer ID attached',
            diagnostics,
            tip: 'The sale must have a customer attached in Square POS before payment'
        });
    }

    // Process the order for loyalty (use snake_case since we're using raw API response)
    const loyaltyResult = await loyaltyService.processOrderForLoyalty(order, merchantId);

    res.json({
        processed: loyaltyResult.processed,
        result: loyaltyResult,
        diagnostics
    });
}));

/**
 * POST /api/loyalty/backfill
 * Fetch recent orders from Square and process them for loyalty
 * Useful for catching up on orders that weren't processed via webhook
 */
router.post('/backfill', requireAuth, requireMerchant, requireWriteAccess, validators.backfill, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { days = 7 } = req.body; // Default to last 7 days

        logger.info('Starting loyalty backfill', { merchantId, days });

        // Get location IDs
        const locationsResult = await db.query(
            'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
            [merchantId]
        );
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            return res.json({ error: 'No active locations found', processed: 0 });
        }

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        // Get and decrypt access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token configured for this merchant' });
        }
        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

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
        const prefetchedLoyalty = await loyaltyService.prefetchRecentLoyaltyEvents(merchantId, days);
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

            const response = await fetch('https://connect.squareup.com/v2/orders/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                },
                body: JSON.stringify(requestBody)
            });

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
                        customerId = loyaltyService.findCustomerFromPrefetchedEvents(
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

                    // Transform to camelCase for loyaltyService
                    const orderForLoyalty = {
                        id: order.id,
                        customer_id: customerId,
                        customerId: customerId,
                        state: order.state,
                        created_at: order.created_at,
                        location_id: order.location_id,
                        line_items: order.line_items,
                        lineItems: (order.line_items || []).map(li => ({
                            ...li,
                            catalogObjectId: li.catalog_object_id,
                            quantity: li.quantity,
                            name: li.name
                        }))
                    };

                    const loyaltyResult = await loyaltyService.processOrderForLoyalty(orderForLoyalty, merchantId);
                    if (loyaltyResult.processed && loyaltyResult.purchasesRecorded.length > 0) {
                        loyaltyPurchasesRecorded += loyaltyResult.purchasesRecorded.length;
                        results.push({
                            orderId: order.id,
                            customerId: loyaltyResult.customerId,
                            customerSource: order.customer_id ? 'order' : 'loyalty_prefetch',
                            purchasesRecorded: loyaltyResult.purchasesRecorded.length
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

        res.json({
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
        });
}));

/**
 * POST /api/loyalty/catchup
 * Run "reverse lookup" loyalty catchup for known customers
 */
router.post('/catchup', requireAuth, requireMerchant, requireWriteAccess, validators.catchup, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { days = 30, customerIds = null, maxCustomers = 100 } = req.body;

    logger.info('Starting loyalty catchup via API', { merchantId, days, maxCustomers });

    const result = await loyaltyService.runLoyaltyCatchup({
        merchantId,
        customerIds,
        periodDays: days,
        maxCustomers
    });

    res.json({
        success: true,
        ...result
    });
}));

/**
 * POST /api/loyalty/refresh-customers
 * Refresh customer details for rewards with missing phone numbers
 * Fetches customer data from Square and updates the cache
 */
router.post('/refresh-customers', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Find all unique customer IDs with rewards but no phone in cache
    const missingResult = await db.query(`
        SELECT DISTINCT r.square_customer_id
        FROM loyalty_rewards r
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
          AND (lc.phone_number IS NULL OR lc.square_customer_id IS NULL)
    `, [merchantId]);

    const customerIds = missingResult.rows.map(r => r.square_customer_id);

    if (customerIds.length === 0) {
        return res.json({ success: true, message: 'No customers with missing phone data', refreshed: 0 });
    }

    logger.info('Refreshing customer data for rewards', { merchantId, count: customerIds.length });

    let refreshed = 0;
    let failed = 0;
    const errors = [];

    // Concurrent customer fetch with semaphore (D-3: replaces N+1 sequential loop)
    const CONCURRENCY = 5;
    let active = 0;
    const queue = [];

    function runWithLimit(fn) {
        return new Promise((resolve, reject) => {
            const execute = async () => {
                active++;
                try {
                    resolve(await fn());
                } catch (err) {
                    reject(err);
                } finally {
                    active--;
                    if (queue.length > 0) {
                        queue.shift()();
                    }
                }
            };
            if (active < CONCURRENCY) {
                execute();
            } else {
                queue.push(execute);
            }
        });
    }

    const results = await Promise.allSettled(
        customerIds.map(customerId =>
            runWithLimit(async () => {
                const customer = await loyaltyService.getCustomerDetails(customerId, merchantId);
                return { customerId, customer };
            })
        )
    );

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.customer) {
            refreshed++;
            logger.debug('Refreshed customer', {
                customerId: result.value.customerId,
                phone: result.value.customer.phone ? 'yes' : 'no'
            });
        } else {
            failed++;
            const customerId = result.status === 'fulfilled'
                ? result.value.customerId : 'unknown';
            const error = result.status === 'rejected'
                ? result.reason.message : 'Customer not found in Square';
            errors.push({ customerId, error });
        }
    }

    logger.info('Customer refresh complete', { merchantId, refreshed, failed });

    res.json({
        success: true,
        total: customerIds.length,
        refreshed,
        failed,
        errors: errors.length > 0 ? errors : undefined
    });
}));

/**
 * POST /api/loyalty/manual-entry
 * Manually record a loyalty purchase for orders where customer wasn't attached
 */
router.post('/manual-entry', requireAuth, requireMerchant, requireWriteAccess, validators.manualEntry, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { squareOrderId, squareCustomerId, variationId, quantity, purchasedAt } = req.body;

    const qty = parseInt(quantity) || 1;

    logger.info('Manual loyalty entry', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty
    });

    // Process the purchase using the loyalty service
    const result = await loyaltyService.processQualifyingPurchase({
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty,
        unitPriceCents: 0,  // Unknown for manual entry
        purchasedAt: purchasedAt || new Date(),
        squareLocationId: null,
        customerSource: 'manual'
    });

    if (!result.processed) {
        return res.status(400).json({
            success: false,
            reason: result.reason,
            message: result.reason === 'variation_not_qualifying'
                ? 'This variation is not configured as a qualifying item for any loyalty offer'
                : result.reason === 'already_processed'
                ? 'This purchase has already been recorded'
                : 'Could not process this purchase'
        });
    }

    res.json({
        success: true,
        purchaseEvent: result.purchaseEvent,
        reward: result.reward,
        message: `Recorded ${qty} purchase(s). Progress: ${result.reward.currentQuantity}/${result.reward.requiredQuantity}`
    });
}));

/**
 * POST /api/loyalty/process-expired
 * Process expired window entries (run periodically or on-demand)
 */
router.post('/process-expired', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Process expired window entries (purchases that aged out)
    const windowResult = await loyaltyService.processExpiredWindowEntries(merchantId);

    // Also process expired earned rewards
    const earnedResult = await loyaltyService.processExpiredEarnedRewards(merchantId);

    logger.info('Processed expired loyalty entries', {
        merchantId,
        windowEntriesProcessed: windowResult.processedCount,
        earnedRewardsRevoked: earnedResult.processedCount
    });

    res.json({
        windowEntries: windowResult,
        expiredEarnedRewards: earnedResult
    });
}));

module.exports = router;
