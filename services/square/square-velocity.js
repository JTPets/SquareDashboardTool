/**
 * Square Sales Velocity
 *
 * Handles sales velocity sync and incremental updates from order webhooks.
 * Fetches completed orders from Square and calculates daily/weekly/monthly
 * averages for inventory reorder planning.
 *
 * Exports:
 *   syncSalesVelocity(periodDays, merchantId)              — single-period sync
 *   syncSalesVelocityAllPeriods(merchantId, maxPeriod, options) — optimized multi-period
 *   updateSalesVelocityFromOrder(order, merchantId)         — incremental from webhook
 *
 * Usage:
 *   const { syncSalesVelocity, updateSalesVelocityFromOrder } = require('./square-velocity');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep } = require('./square-client');
const TTLCache = require('../../utils/ttl-cache');

const { SQUARE: { MAX_PAGINATION_ITERATIONS }, SYNC: { BATCH_DELAY_MS } } = require('../../config/constants');

/**
 * Velocity idempotency guard.
 * Prevents double-counting when both order.updated and order.fulfillment.updated
 * fire for the same COMPLETED order. Keyed by `${orderId}:${merchantId}`.
 * 120s TTL ensures self-healing.
 */
const recentlyProcessedVelocityOrders = new TTLCache(120000);

/**
 * Sync sales velocity for a specific time period
 * @param {number} periodDays - Number of days to analyze (91, 182, or 365)
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of variations with velocity data
 */
async function syncSalesVelocity(periodDays = 91, merchantId) {
    logger.info('Starting sales velocity sync', { period_days: periodDays, merchantId });

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - periodDays);

        // Get all active locations for this merchant
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found');
            return 0;
        }

        // Aggregate sales data by variation and location
        const salesData = new Map();

        let cursor = null;
        let ordersProcessed = 0;
        let paginationIterations = 0;

        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/orders/search (velocity)' });
                break;
            }
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
                limit: 200
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/orders/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });

            const orders = data.orders || [];

            // Process each order
            for (const order of orders) {
                if (!order.line_items) continue;

                for (const lineItem of order.line_items) {
                    const variationId = lineItem.catalog_object_id;
                    const locationId = order.location_id;

                    if (!variationId || !locationId) continue;

                    const key = `${variationId}:${locationId}`;

                    if (!salesData.has(key)) {
                        salesData.set(key, {
                            variation_id: variationId,
                            location_id: locationId,
                            total_quantity: 0,
                            total_revenue: 0
                        });
                    }

                    const data = salesData.get(key);
                    data.total_quantity += parseFloat(lineItem.quantity) || 0;
                    data.total_revenue += parseInt(lineItem.total_money?.amount) || 0;
                }
            }

            ordersProcessed += orders.length;
            cursor = data.cursor;
            logger.info('Sales velocity sync progress', { orders_processed: ordersProcessed });

            if (cursor) await sleep(BATCH_DELAY_MS);
        } while (cursor);

        // Validate which variations exist in our database before inserting
        // This prevents foreign key constraint violations for deleted variations
        const uniqueVariationIds = [...new Set([...salesData.values()].map(d => d.variation_id))];

        if (uniqueVariationIds.length === 0) {
            logger.info('No sales data to sync');
            return 0;
        }

        // Query to check which variation IDs exist FOR THIS MERCHANT
        const placeholders = uniqueVariationIds.map((_, i) => `$${i + 1}`).join(',');
        const existingVariationsResult = await db.query(
            `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${uniqueVariationIds.length + 1}`,
            [...uniqueVariationIds, merchantId]
        );

        const existingVariationIds = new Set(existingVariationsResult.rows.map(row => row.id));
        const missingCount = uniqueVariationIds.length - existingVariationIds.size;

        if (missingCount > 0) {
            logger.info('Filtering out deleted variations from sales velocity', {
                total_variations: uniqueVariationIds.length,
                existing: existingVariationIds.size,
                missing: missingCount
            });
        }

        // Save velocity data to database (only for existing variations)
        let savedCount = 0;
        let skippedCount = 0;

        for (const [key, data] of salesData.entries()) {
            // Skip variations that don't exist in our database
            if (!existingVariationIds.has(data.variation_id)) {
                skippedCount++;
                continue;
            }

            const dailyAvg = data.total_quantity / periodDays;
            const weeklyAvg = data.total_quantity / (periodDays / 7);
            const monthlyAvg = data.total_quantity / (periodDays / 30);
            const dailyRevenueAvg = data.total_revenue / periodDays;

            await db.query(`
                INSERT INTO sales_velocity (
                    variation_id, location_id, period_days,
                    total_quantity_sold, total_revenue_cents,
                    period_start_date, period_end_date,
                    daily_avg_quantity, daily_avg_revenue_cents,
                    weekly_avg_quantity, monthly_avg_quantity,
                    merchant_id, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
                ON CONFLICT (variation_id, location_id, period_days, merchant_id) DO UPDATE SET
                    total_quantity_sold = EXCLUDED.total_quantity_sold,
                    total_revenue_cents = EXCLUDED.total_revenue_cents,
                    period_start_date = EXCLUDED.period_start_date,
                    period_end_date = EXCLUDED.period_end_date,
                    daily_avg_quantity = EXCLUDED.daily_avg_quantity,
                    daily_avg_revenue_cents = EXCLUDED.daily_avg_revenue_cents,
                    weekly_avg_quantity = EXCLUDED.weekly_avg_quantity,
                    monthly_avg_quantity = EXCLUDED.monthly_avg_quantity,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                data.variation_id,
                data.location_id,
                periodDays,
                data.total_quantity,
                data.total_revenue,
                startDate,
                endDate,
                dailyAvg,
                dailyRevenueAvg,
                weeklyAvg,
                monthlyAvg,
                merchantId
            ]);
            savedCount++;
        }

        if (skippedCount > 0) {
            logger.info('Skipped sales velocity entries for deleted variations', {
                skipped: skippedCount
            });
        }

        logger.info('Sales velocity sync complete', { combinations: savedCount, period_days: periodDays });
        return savedCount;
    } catch (error) {
        logger.error('Sales velocity sync failed', { period_days: periodDays, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Sync sales velocity for multiple periods with a SINGLE API fetch.
 * This optimized function fetches orders once for the specified max period and calculates
 * all periods up to that max, eliminating redundant API calls.
 *
 * @param {number} merchantId - The merchant ID for multi-tenant token lookup
 * @param {number} [maxPeriod=365] - Maximum period to fetch (91, 182, or 365).
 *                                   Will calculate all periods <= maxPeriod.
 *                                   e.g., maxPeriod=182 fetches 182d and calculates 91d + 182d
 * @returns {Promise<Object>} Summary with counts for each period synced { '91d': count, '182d': count, ... }
 */
async function syncSalesVelocityAllPeriods(merchantId, maxPeriod = 365, options = {}) {
    const { loyaltyBackfill = false } = options;  // Disabled by default - use manual customer audit instead

    const ALL_PERIODS = [91, 182, 365];
    // Only sync periods up to maxPeriod
    const PERIODS = ALL_PERIODS.filter(p => p <= maxPeriod);
    const MAX_PERIOD = Math.max(...PERIODS);

    logger.info('Starting optimized sales velocity sync', {
        periods: PERIODS,
        maxPeriod: MAX_PERIOD,
        merchantId,
        loyaltyBackfill,
        optimization: `single fetch for ${PERIODS.length} period(s)`
    });

    // Lazy-load loyalty service to avoid circular dependency
    let loyaltyService = null;
    if (loyaltyBackfill) {
        try {
            loyaltyService = require('../loyalty-admin');
        } catch (err) {
            logger.warn('Could not load loyalty-service for backfill', { error: err.message });
        }
    }

    // Initialize summary with only the periods we're syncing
    const summary = {
        ordersProcessed: 0,
        apiCallsSaved: 0,
        periodssynced: PERIODS,
        loyaltyOrdersChecked: 0,
        loyaltyOrdersBackfilled: 0
    };
    for (const days of PERIODS) {
        summary[`${days}d`] = 0;
    }

    try {
        const accessToken = await getMerchantToken(merchantId);

        // Calculate date range for the longest period (365 days)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - MAX_PERIOD);

        // Pre-calculate period boundaries for efficient date filtering
        const periodBoundaries = {};
        for (const days of PERIODS) {
            const boundary = new Date();
            boundary.setDate(boundary.getDate() - days);
            periodBoundaries[days] = boundary;
        }

        // Get all active locations for this merchant
        const locationsResult = await db.query('SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            logger.warn('No active locations found for optimized sales velocity sync');
            return summary;
        }

        // Aggregate sales data by variation, location, AND period
        // Structure: Map<"variationId:locationId:periodDays", { data }>
        const salesDataByPeriod = new Map();

        // Initialize maps for each period
        for (const days of PERIODS) {
            salesDataByPeriod.set(days, new Map());
        }

        let cursor = null;
        let ordersProcessed = 0;
        let apiCalls = 0;
        let paginationIterations = 0;

        // Single fetch loop for ALL 365 days of orders
        do {
            if (++paginationIterations > MAX_PAGINATION_ITERATIONS) {
                logger.warn('Pagination loop exceeded max iterations', { merchantId, iterations: paginationIterations, endpoint: '/v2/orders/search (all-periods)' });
                break;
            }
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
                limit: 200
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const data = await makeSquareRequest('/v2/orders/search', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                accessToken
            });
            apiCalls++;

            const orders = data.orders || [];

            // Process each order and assign to appropriate periods based on closed_at date
            for (const order of orders) {
                if (!order.line_items) continue;

                // LOYALTY BACKFILL HOOK: Process order for loyalty if not already done
                // Order history is append-only, so we only need to process each order once
                if (loyaltyService && order.customer_id) {
                    try {
                        summary.loyaltyOrdersChecked++;
                        const loyaltyResult = await loyaltyService.processOrderForLoyaltyIfNeeded(order, merchantId);
                        if (loyaltyResult.processed) {
                            summary.loyaltyOrdersBackfilled++;
                        }
                    } catch (loyaltyErr) {
                        // Non-fatal - log and continue with velocity sync
                        logger.warn('Loyalty backfill failed for order', {
                            orderId: order.id,
                            error: loyaltyErr.message
                        });
                    }
                }

                const orderClosedAt = new Date(order.closed_at);

                for (const lineItem of order.line_items) {
                    const variationId = lineItem.catalog_object_id;
                    const locationId = order.location_id;

                    if (!variationId || !locationId) continue;

                    const quantity = parseFloat(lineItem.quantity) || 0;
                    const revenue = parseInt(lineItem.total_money?.amount) || 0;

                    // Add this line item to ALL periods where it falls within the date range
                    for (const days of PERIODS) {
                        if (orderClosedAt >= periodBoundaries[days]) {
                            const key = `${variationId}:${locationId}`;
                            const periodMap = salesDataByPeriod.get(days);

                            if (!periodMap.has(key)) {
                                periodMap.set(key, {
                                    variation_id: variationId,
                                    location_id: locationId,
                                    total_quantity: 0,
                                    total_revenue: 0
                                });
                            }

                            const itemData = periodMap.get(key);
                            itemData.total_quantity += quantity;
                            itemData.total_revenue += revenue;
                        }
                    }
                }
            }

            ordersProcessed += orders.length;
            cursor = data.cursor;

            if (ordersProcessed % 500 === 0) {
                logger.info('Optimized sales velocity sync progress', {
                    orders_processed: ordersProcessed,
                    api_calls: apiCalls
                });
            }

            if (cursor) await sleep(BATCH_DELAY_MS);
        } while (cursor);

        summary.ordersProcessed = ordersProcessed;
        // Estimate API calls saved: normally would be ~3x the calls for each period
        summary.apiCallsSaved = apiCalls * 2; // We made apiCalls, would have made ~3x

        // Build period_counts dynamically based on which periods we're actually tracking
        const period_counts = {};
        for (const days of PERIODS) {
            const periodMap = salesDataByPeriod.get(days);
            period_counts[`${days}d`] = periodMap ? periodMap.size : 0;
        }

        logger.info('Order fetch complete, processing periods', {
            ordersProcessed,
            apiCalls,
            period_counts
        });

        // Collect all unique variation IDs across all periods for validation
        const allVariationIds = new Set();
        for (const days of PERIODS) {
            for (const data of salesDataByPeriod.get(days).values()) {
                allVariationIds.add(data.variation_id);
            }
        }

        if (allVariationIds.size === 0) {
            logger.info('No sales data to sync across any period');
            return summary;
        }

        // Query to check which variation IDs exist FOR THIS MERCHANT
        const uniqueVariationIds = [...allVariationIds];
        const placeholders = uniqueVariationIds.map((_, i) => `$${i + 1}`).join(',');
        const existingVariationsResult = await db.query(
            `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${uniqueVariationIds.length + 1}`,
            [...uniqueVariationIds, merchantId]
        );

        const existingVariationIds = new Set(existingVariationsResult.rows.map(row => row.id));
        const missingCount = uniqueVariationIds.length - existingVariationIds.size;

        if (missingCount > 0) {
            logger.info('Filtering out deleted variations from sales velocity (all periods)', {
                total_variations: uniqueVariationIds.length,
                existing: existingVariationIds.size,
                missing: missingCount
            });
        }

        // Save velocity data for each period
        for (const periodDays of PERIODS) {
            const periodStartDate = new Date();
            periodStartDate.setDate(periodStartDate.getDate() - periodDays);

            const periodMap = salesDataByPeriod.get(periodDays);
            let savedCount = 0;
            let skippedCount = 0;

            for (const [key, data] of periodMap.entries()) {
                // Skip variations that don't exist in our database
                if (!existingVariationIds.has(data.variation_id)) {
                    skippedCount++;
                    continue;
                }

                const dailyAvg = data.total_quantity / periodDays;
                const weeklyAvg = data.total_quantity / (periodDays / 7);
                const monthlyAvg = data.total_quantity / (periodDays / 30);
                const dailyRevenueAvg = data.total_revenue / periodDays;

                await db.query(`
                    INSERT INTO sales_velocity (
                        variation_id, location_id, period_days,
                        total_quantity_sold, total_revenue_cents,
                        period_start_date, period_end_date,
                        daily_avg_quantity, daily_avg_revenue_cents,
                        weekly_avg_quantity, monthly_avg_quantity,
                        merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
                    ON CONFLICT (variation_id, location_id, period_days, merchant_id) DO UPDATE SET
                        total_quantity_sold = EXCLUDED.total_quantity_sold,
                        total_revenue_cents = EXCLUDED.total_revenue_cents,
                        period_start_date = EXCLUDED.period_start_date,
                        period_end_date = EXCLUDED.period_end_date,
                        daily_avg_quantity = EXCLUDED.daily_avg_quantity,
                        daily_avg_revenue_cents = EXCLUDED.daily_avg_revenue_cents,
                        weekly_avg_quantity = EXCLUDED.weekly_avg_quantity,
                        monthly_avg_quantity = EXCLUDED.monthly_avg_quantity,
                        updated_at = CURRENT_TIMESTAMP
                `, [
                    data.variation_id,
                    data.location_id,
                    periodDays,
                    data.total_quantity,
                    data.total_revenue,
                    periodStartDate,
                    endDate,
                    dailyAvg,
                    dailyRevenueAvg,
                    weeklyAvg,
                    monthlyAvg,
                    merchantId
                ]);
                savedCount++;
            }

            if (skippedCount > 0) {
                logger.info(`Skipped sales velocity entries for deleted variations (${periodDays}d)`, {
                    skipped: skippedCount
                });
            }

            summary[`${periodDays}d`] = savedCount;
            logger.info(`Sales velocity sync complete for ${periodDays}d period`, {
                combinations: savedCount,
                period_days: periodDays
            });
        }

        logger.info('Optimized sales velocity sync complete (all periods)', {
            summary,
            performance: {
                ordersProcessed,
                apiCalls,
                estimatedCallsSaved: summary.apiCallsSaved
            }
        });

        return summary;
    } catch (error) {
        logger.error('Optimized sales velocity sync failed', {
            error: error.message,
            stack: error.stack,
            merchantId
        });
        throw error;
    }
}

/**
 * P0-API-2: Update sales velocity incrementally from a single completed order.
 * This avoids re-fetching all 91 days of historical orders on every order completion.
 *
 * ZERO API calls - just database operations!
 *
 * The function:
 * 1. Validates the order is COMPLETED and has line items
 * 2. Checks which variations exist in our database
 * 3. For each applicable period (91d, 182d, 365d), updates velocity incrementally
 * 4. Uses atomic increment to add quantities/revenue to existing records
 *
 * Note: Daily reconciliation job corrects any drift from window sliding.
 *
 * @param {Object} order - The completed order object (from webhook)
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Update result { updated, skipped, periods, reason? }
 */
async function updateSalesVelocityFromOrder(order, merchantId) {
    // Validate inputs
    if (!order) {
        return { updated: 0, skipped: 0, reason: 'No order provided' };
    }

    if (order.state !== 'COMPLETED') {
        return { updated: 0, skipped: 0, reason: 'Order not completed' };
    }

    if (!order.line_items || order.line_items.length === 0) {
        return { updated: 0, skipped: 0, reason: 'No line items' };
    }

    if (!merchantId) {
        return { updated: 0, skipped: 0, reason: 'No merchantId' };
    }

    // Velocity idempotency: skip if this order was already processed recently
    const velocityKey = `${order.id}:${merchantId}`;
    if (recentlyProcessedVelocityOrders.has(velocityKey)) {
        logger.debug('Velocity already updated for order', {
            orderId: order.id,
            merchantId,
            reason: 'velocity_dedup_guard'
        });
        return { updated: 0, skipped: 0, reason: 'Already processed (dedup)' };
    }
    recentlyProcessedVelocityOrders.set(velocityKey, true);

    const closedAt = order.closed_at ? new Date(order.closed_at) : new Date();
    const locationId = order.location_id;

    if (!locationId) {
        return { updated: 0, skipped: 0, reason: 'No location_id' };
    }

    // Calculate order age in days
    const orderAgeDays = Math.floor((Date.now() - closedAt.getTime()) / (1000 * 60 * 60 * 24));

    // Standard velocity periods
    const ALL_PERIODS = [91, 182, 365];

    // Only update periods that include this order's date
    const applicablePeriods = ALL_PERIODS.filter(p => orderAgeDays <= p);

    if (applicablePeriods.length === 0) {
        logger.debug('Order too old for all velocity periods', {
            orderId: order.id,
            orderAgeDays,
            closedAt
        });
        return { updated: 0, skipped: 0, reason: 'Order too old for all periods' };
    }

    logger.info('Updating sales velocity incrementally from order (P0-API-2)', {
        orderId: order.id,
        lineItemCount: order.line_items.length,
        locationId,
        closedAt: closedAt.toISOString(),
        orderAgeDays,
        applicablePeriods,
        merchantId
    });

    // Get unique variation IDs from line items
    const variationIds = [...new Set(order.line_items
        .filter(li => li.catalog_object_id)
        .map(li => li.catalog_object_id))];

    if (variationIds.length === 0) {
        return { updated: 0, skipped: 0, reason: 'No catalog variations in order' };
    }

    // Validate which variations exist in our database (prevents FK violations)
    const placeholders = variationIds.map((_, i) => `$${i + 1}`).join(',');
    const existingResult = await db.query(
        `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${variationIds.length + 1}`,
        [...variationIds, merchantId]
    );
    const existingIds = new Set(existingResult.rows.map(r => r.id));

    let updated = 0;
    let skipped = 0;

    // Process each line item
    for (const lineItem of order.line_items) {
        const variationId = lineItem.catalog_object_id;

        // Skip if variation doesn't exist in our catalog
        if (!variationId || !existingIds.has(variationId)) {
            skipped++;
            continue;
        }

        const quantity = parseFloat(lineItem.quantity) || 0;
        const revenue = parseInt(lineItem.total_money?.amount) || 0;

        if (quantity <= 0) {
            skipped++;
            continue;
        }

        // Update each applicable period
        for (const periodDays of applicablePeriods) {
            const periodStart = new Date();
            periodStart.setDate(periodStart.getDate() - periodDays);

            try {
                // Atomic upsert: increment existing record or create new one
                // The averages are recalculated based on the new totals
                await db.query(`
                    INSERT INTO sales_velocity (
                        variation_id, location_id, period_days,
                        total_quantity_sold, total_revenue_cents,
                        period_start_date, period_end_date,
                        daily_avg_quantity, daily_avg_revenue_cents,
                        weekly_avg_quantity, monthly_avg_quantity,
                        merchant_id, updated_at
                    )
                    VALUES ($1, $2, $3::integer, $4::decimal, $5::integer, $6, NOW(),
                            $4::decimal / $3::decimal, $5::decimal / $3::decimal,
                            $4::decimal / ($3::decimal / 7),
                            $4::decimal / ($3::decimal / 30),
                            $7, NOW())
                    ON CONFLICT (variation_id, location_id, period_days, merchant_id)
                    DO UPDATE SET
                        total_quantity_sold = sales_velocity.total_quantity_sold + $4::decimal,
                        total_revenue_cents = sales_velocity.total_revenue_cents + $5::integer,
                        daily_avg_quantity = (sales_velocity.total_quantity_sold + $4::decimal) / $3::decimal,
                        daily_avg_revenue_cents = (sales_velocity.total_revenue_cents + $5::integer)::decimal / $3::decimal,
                        weekly_avg_quantity = (sales_velocity.total_quantity_sold + $4::decimal) / ($3::decimal / 7),
                        monthly_avg_quantity = (sales_velocity.total_quantity_sold + $4::decimal) / ($3::decimal / 30),
                        period_end_date = NOW(),
                        updated_at = NOW()
                `, [variationId, locationId, periodDays, quantity, revenue, periodStart, merchantId]);

                updated++;
            } catch (dbError) {
                logger.warn('Failed to update velocity for variation', {
                    variationId,
                    periodDays,
                    orderId: order.id,
                    error: dbError.message
                });
                skipped++;
            }
        }
    }

    logger.info('Incremental sales velocity update complete (P0-API-2)', {
        orderId: order.id,
        updated,
        skipped,
        periods: applicablePeriods,
        apiCalls: 0  // This is the point - ZERO API calls!
    });

    return { updated, skipped, periods: applicablePeriods };
}

module.exports = {
    syncSalesVelocity,
    syncSalesVelocityAllPeriods,
    updateSalesVelocityFromOrder,
    // Export for testing
    _recentlyProcessedVelocityOrders: recentlyProcessedVelocityOrders
};
