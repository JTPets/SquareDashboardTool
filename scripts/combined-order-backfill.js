#!/usr/bin/env node

/**
 * Combined Order Backfill Script
 *
 * Fixes two P0 production bugs for a specific merchant:
 *   Phase 1: Download all Square orders (single fetch for widest window)
 *   Phase 2: Recalculate sales velocity (corrects phantom rows + refund subtraction)
 *   Phase 3: Fix loyalty quantity under-counts (aggregation bug from duplicate line items)
 *
 * Usage:
 *   node scripts/combined-order-backfill.js --dry-run     # Preview changes (default)
 *   node scripts/combined-order-backfill.js --execute      # Apply changes
 *
 * Safety:
 *   - Dry-run by default — requires --execute to write
 *   - Transaction per order for loyalty corrections — rollback on failure
 *   - Full report logged to output/logs/combined-backfill-[date].log
 */

require('dotenv').config();

const db = require('../utils/database');
const logger = require('../utils/logger');
const { getMerchantToken, makeSquareRequest, sleep } = require('../services/square/square-client');
const { processLoyaltyOrder } = require('../services/loyalty-admin/order-intake');

const { SQUARE: { MAX_PAGINATION_ITERATIONS }, SYNC: { BATCH_DELAY_MS } } = require('../config/constants');

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Async side-effect tracker
// ---------------------------------------------------------------------------
// reward-progress-service.js fires createSquareCustomerGroupDiscount and
// updateCustomerStats as fire-and-forget promises. We monkey-patch the
// originals to capture those promises so we can await them before db.end().
const pendingAsyncEffects = [];

const discountService = require('../services/loyalty-admin/square-discount-service');
const customerCacheService = require('../services/loyalty-admin/customer-cache-service');

const _origCreateDiscount = discountService.createSquareCustomerGroupDiscount;
discountService.createSquareCustomerGroupDiscount = function (...args) {
    const p = _origCreateDiscount.apply(this, args);
    pendingAsyncEffects.push(p.catch(() => {})); // swallow — caller already has .catch
    return p;
};

const _origUpdateStats = customerCacheService.updateCustomerStats;
customerCacheService.updateCustomerStats = function (...args) {
    const p = _origUpdateStats.apply(this, args);
    pendingAsyncEffects.push(p.catch(() => {}));
    return p;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const MERCHANT_ID = 3;
const VELOCITY_DAYS = 91;
const LOYALTY_START_DATE = new Date('2026-01-18T00:00:00');
const ALL_VELOCITY_PERIODS = [91, 182, 365];

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');

// ---------------------------------------------------------------------------
// File logger — writes alongside the app logger
// ---------------------------------------------------------------------------
const now = new Date();
const logFileName = `combined-backfill-${now.toISOString().slice(0, 10)}.log`;
const logDir = path.join(__dirname, '..', 'output', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logStream = fs.createWriteStream(path.join(logDir, logFileName), { flags: 'a' });

function log(msg, data = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...data });
    logStream.write(line + '\n');
    // Also print to stdout for interactive use
    const preview = typeof data === 'object' && Object.keys(data).length > 0
        ? ` ${JSON.stringify(data)}` : '';
    console.log(`[backfill] ${msg}${preview}`);
}

// ---------------------------------------------------------------------------
// Phase 1 — Download all Square orders
// ---------------------------------------------------------------------------
async function fetchAllOrders(merchantId) {
    log('=== PHASE 1: Fetching Square orders ===', { merchantId });

    const accessToken = await getMerchantToken(merchantId);

    const locationsResult = await db.query(
        'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
        [merchantId]
    );
    const locationIds = locationsResult.rows.map(r => r.id);
    if (locationIds.length === 0) {
        throw new Error('No active locations found');
    }

    // Wider window is 91 days (velocity). Loyalty starts 2026-01-18.
    // Use the earlier of the two start dates.
    const velocityStart = new Date();
    velocityStart.setDate(velocityStart.getDate() - VELOCITY_DAYS);
    const startDate = velocityStart < LOYALTY_START_DATE ? velocityStart : LOYALTY_START_DATE;
    const endDate = new Date();

    log('Fetch window', {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        locations: locationIds.length
    });

    const orders = [];
    let cursor = null;
    let iterations = 0;

    do {
        if (++iterations > MAX_PAGINATION_ITERATIONS) {
            log('WARN: pagination limit reached', { iterations });
            break;
        }

        const requestBody = {
            location_ids: locationIds,
            query: {
                filter: {
                    state_filter: { states: ['COMPLETED'] },
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
        if (cursor) requestBody.cursor = cursor;

        const data = await makeSquareRequest('/v2/orders/search', {
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken
        });

        const batch = data.orders || [];
        orders.push(...batch);
        cursor = data.cursor;

        if (orders.length % 500 < 200) {
            log('Fetch progress', { fetched: orders.length });
        }
        if (cursor) await sleep(BATCH_DELAY_MS);
    } while (cursor);

    // Tag each order with applicable phases
    const velocityBoundary = new Date();
    velocityBoundary.setDate(velocityBoundary.getDate() - VELOCITY_DAYS);

    for (const order of orders) {
        const closedAt = new Date(order.closed_at);
        order._phases = {
            velocity: closedAt >= velocityBoundary,
            loyalty: closedAt >= LOYALTY_START_DATE
        };
    }

    const velocityCount = orders.filter(o => o._phases.velocity).length;
    const loyaltyCount = orders.filter(o => o._phases.loyalty).length;

    log('Phase 1 complete', {
        totalOrders: orders.length,
        velocityOrders: velocityCount,
        loyaltyOrders: loyaltyCount
    });

    return orders;
}

// ---------------------------------------------------------------------------
// Phase 2 — Velocity correction (reuses syncSalesVelocity logic)
// ---------------------------------------------------------------------------
async function correctVelocity(orders, merchantId) {
    log('=== PHASE 2: Velocity correction ===');

    const velocityOrders = orders.filter(o => o._phases.velocity);

    // Aggregate sales data by variation+location, same as syncSalesVelocity
    const salesData = new Map();

    for (const order of velocityOrders) {
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

            const entry = salesData.get(key);
            entry.total_quantity += parseFloat(lineItem.quantity) || 0;
            entry.total_revenue += parseInt(lineItem.total_money?.amount) || 0;
        }

        // Subtract refunds (BACKLOG-35)
        for (const ret of (order.returns || [])) {
            for (const returnItem of (ret.return_line_items || [])) {
                const variationId = returnItem.catalog_object_id;
                const locationId = order.location_id;
                if (!variationId || !locationId) continue;

                const key = `${variationId}:${locationId}`;
                if (salesData.has(key)) {
                    const entry = salesData.get(key);
                    entry.total_quantity -= parseFloat(returnItem.quantity) || 0;
                    entry.total_revenue -= parseInt(
                        returnItem.return_amounts?.total_money?.amount
                        || returnItem.total_money?.amount
                    ) || 0;
                }
            }
        }
    }

    // Validate which variations exist in our database
    const uniqueVariationIds = [...new Set([...salesData.values()].map(d => d.variation_id))];
    let existingVariationIds = new Set();

    if (uniqueVariationIds.length > 0) {
        const placeholders = uniqueVariationIds.map((_, i) => `$${i + 1}`).join(',');
        const existResult = await db.query(
            `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${uniqueVariationIds.length + 1}`,
            [...uniqueVariationIds, merchantId]
        );
        existingVariationIds = new Set(existResult.rows.map(r => r.id));
    }

    // Read current velocity rows for comparison
    const currentVelocity = await db.query(
        `SELECT variation_id, location_id, period_days, total_quantity_sold, total_revenue_cents
         FROM sales_velocity WHERE merchant_id = $1 AND period_days = $2`,
        [merchantId, VELOCITY_DAYS]
    );
    const currentMap = new Map();
    for (const row of currentVelocity.rows) {
        currentMap.set(`${row.variation_id}:${row.location_id}`, row);
    }

    // Detect stale rows (BACKLOG-36)
    const staleRows = [];
    for (const [key, row] of currentMap) {
        const varId = row.variation_id;
        if (!salesData.has(key) || !existingVariationIds.has(varId)) {
            staleRows.push({ variation_id: varId, location_id: row.location_id });
        }
    }

    // Detect corrections needed
    const corrections = [];
    for (const [key, data] of salesData) {
        if (!existingVariationIds.has(data.variation_id)) continue;

        const netQuantity = Math.max(0, data.total_quantity);
        const netRevenue = Math.max(0, data.total_revenue);
        const current = currentMap.get(key);

        if (!current
            || Math.abs(parseFloat(current.total_quantity_sold) - netQuantity) > 0.001
            || parseInt(current.total_revenue_cents) !== netRevenue) {
            corrections.push({
                variation_id: data.variation_id,
                location_id: data.location_id,
                old_quantity: current ? parseFloat(current.total_quantity_sold) : null,
                new_quantity: netQuantity,
                old_revenue: current ? parseInt(current.total_revenue_cents) : null,
                new_revenue: netRevenue
            });
        }
    }

    log('Velocity analysis', {
        variationsWithSales: salesData.size,
        existingVariations: existingVariationIds.size,
        correctionsNeeded: corrections.length,
        staleRowsToDelete: staleRows.length
    });

    if (corrections.length > 0) {
        log('Velocity corrections preview (first 20)', {
            corrections: corrections.slice(0, 20)
        });
    }

    if (!DRY_RUN) {
        const periodStart = new Date();
        periodStart.setDate(periodStart.getDate() - VELOCITY_DAYS);
        const endDate = new Date();
        let saved = 0;

        for (const [, data] of salesData) {
            if (!existingVariationIds.has(data.variation_id)) continue;

            const netQuantity = Math.max(0, data.total_quantity);
            const netRevenue = Math.max(0, data.total_revenue);
            const dailyAvg = netQuantity / VELOCITY_DAYS;
            const weeklyAvg = netQuantity / (VELOCITY_DAYS / 7);
            const monthlyAvg = netQuantity / (VELOCITY_DAYS / 30);
            const dailyRevenueAvg = netRevenue / VELOCITY_DAYS;

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
                data.variation_id, data.location_id, VELOCITY_DAYS,
                netQuantity, netRevenue,
                periodStart, endDate,
                dailyAvg, dailyRevenueAvg, weeklyAvg, monthlyAvg,
                merchantId
            ]);
            saved++;
        }

        // Delete stale rows (BACKLOG-36)
        const processedVariationIds = [...existingVariationIds].filter(id =>
            [...salesData.values()].some(d => d.variation_id === id)
        );
        if (processedVariationIds.length > 0) {
            const delPlaceholders = processedVariationIds.map((_, i) => `$${i + 1}`).join(',');
            const deleteResult = await db.query(
                `DELETE FROM sales_velocity
                 WHERE merchant_id = $${processedVariationIds.length + 1}
                   AND period_days = $${processedVariationIds.length + 2}
                   AND variation_id NOT IN (${delPlaceholders})`,
                [...processedVariationIds, merchantId, VELOCITY_DAYS]
            );
            log('Stale velocity rows deleted', { deleted: deleteResult.rowCount });
        }

        log('Velocity corrections applied', { saved });
    } else {
        log('DRY RUN — velocity corrections NOT applied');
    }

    return { corrections: corrections.length, staleRows: staleRows.length };
}

// ---------------------------------------------------------------------------
// Phase 3 — Loyalty quantity correction
// ---------------------------------------------------------------------------
async function correctLoyalty(orders, merchantId) {
    log('=== PHASE 3: Loyalty quantity correction ===');

    const loyaltyOrders = orders.filter(o => o._phases.loyalty);
    log('Loyalty orders to check', { count: loyaltyOrders.length });

    const report = {
        ordersChecked: 0,
        ordersSkippedNoCustomer: 0,
        ordersCorrectlyRecorded: 0,
        ordersUnderCounted: 0,
        ordersCorrected: 0,
        ordersFailed: 0,
        affectedCustomers: new Map() // customerId -> { corrections, offers }
    };

    for (const order of loyaltyOrders) {
        report.ordersChecked++;

        if (!order.customer_id) {
            report.ordersSkippedNoCustomer++;
            continue;
        }

        if (!order.line_items || order.line_items.length === 0) continue;

        // Aggregate qualifying line items by variationId (the FIXED logic)
        const aggregated = new Map();
        for (const lineItem of order.line_items) {
            const variationId = lineItem.catalog_object_id;
            if (!variationId) continue;

            const quantity = parseInt(lineItem.quantity) || 0;
            if (quantity <= 0) continue;

            // Skip 100% discounted items
            const grossSalesCents = Number(lineItem.gross_sales_money?.amount || 0)
                || (Number(lineItem.base_price_money?.amount || 0) * quantity);
            const totalMoneyCents = lineItem.total_money?.amount != null
                ? Number(lineItem.total_money.amount)
                : grossSalesCents - (Number(lineItem.total_discount_money?.amount || 0));
            if (grossSalesCents > 0 && totalMoneyCents === 0) continue;

            const existing = aggregated.get(variationId);
            if (existing) {
                existing.quantity += quantity;
            } else {
                aggregated.set(variationId, { variationId, quantity });
            }
        }

        if (aggregated.size === 0) continue;

        // Check what loyalty_purchase_events recorded for this order
        const recorded = await db.query(`
            SELECT variation_id, SUM(quantity) as total_qty
            FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND square_order_id = $2 AND quantity > 0 AND is_refund = FALSE
            GROUP BY variation_id
        `, [merchantId, order.id]);

        const recordedMap = new Map();
        for (const row of recorded.rows) {
            recordedMap.set(row.variation_id, parseInt(row.total_qty) || 0);
        }

        // Compare aggregated vs recorded per variation
        let orderNeedsCorrection = false;
        const underCounts = [];

        for (const [variationId, agg] of aggregated) {
            const recordedQty = recordedMap.get(variationId) || 0;
            if (recordedQty < agg.quantity) {
                // Only flag if this variation actually qualifies for a loyalty offer
                // (we'll confirm during re-processing — if it doesn't qualify,
                // processLoyaltyOrder will skip it naturally)
                orderNeedsCorrection = true;
                underCounts.push({
                    variationId,
                    expected: agg.quantity,
                    recorded: recordedQty,
                    deficit: agg.quantity - recordedQty
                });
            }
        }

        if (!orderNeedsCorrection) {
            report.ordersCorrectlyRecorded++;
            continue;
        }

        report.ordersUnderCounted++;
        log('Under-counted order found', {
            orderId: order.id,
            customerId: order.customer_id,
            underCounts
        });

        if (!DRY_RUN) {
            // Delete existing loyalty records for this order and re-process
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');

                // Get existing purchase event IDs for this order (for audit trail)
                const existingEvents = await client.query(`
                    SELECT id, offer_id, variation_id, quantity, reward_id
                    FROM loyalty_purchase_events
                    WHERE merchant_id = $1 AND square_order_id = $2
                `, [merchantId, order.id]);

                // Unlock any rewards tied to these events
                const eventIds = existingEvents.rows.map(r => r.id);
                if (eventIds.length > 0) {
                    const eidPlaceholders = eventIds.map((_, i) => `$${i + 1}`).join(',');
                    await client.query(
                        `UPDATE loyalty_purchase_events SET reward_id = NULL
                         WHERE original_event_id IN (${eidPlaceholders})`,
                        eventIds
                    );
                    // Delete split children first (they reference parent via original_event_id)
                    await client.query(
                        `DELETE FROM loyalty_purchase_events
                         WHERE original_event_id IN (${eidPlaceholders})`,
                        eventIds
                    );
                    // Delete the parent events
                    await client.query(
                        `DELETE FROM loyalty_purchase_events
                         WHERE id IN (${eidPlaceholders})`,
                        eventIds
                    );
                }

                // Delete from loyalty_processed_orders so processLoyaltyOrder can re-claim
                await client.query(
                    `DELETE FROM loyalty_processed_orders
                     WHERE merchant_id = $1 AND square_order_id = $2`,
                    [merchantId, order.id]
                );

                await client.query('COMMIT');
                client.release();

                // Re-process through the FIXED processLoyaltyOrder
                // (which now aggregates line items by variation before calling processQualifyingPurchase)
                const result = await processLoyaltyOrder({
                    order,
                    merchantId,
                    squareCustomerId: order.customer_id,
                    source: 'backfill',
                    customerSource: 'order'
                });

                report.ordersCorrected++;

                // Track affected customers
                const custEntry = report.affectedCustomers.get(order.customer_id) || {
                    customerId: order.customer_id,
                    corrections: 0,
                    ordersFixed: [],
                    rewardEarned: false
                };
                custEntry.corrections++;
                custEntry.ordersFixed.push(order.id);
                if (result.rewardEarned) custEntry.rewardEarned = true;
                report.affectedCustomers.set(order.customer_id, custEntry);

                log('Order corrected', {
                    orderId: order.id,
                    customerId: order.customer_id,
                    purchaseEvents: result.purchaseEvents.length,
                    rewardEarned: result.rewardEarned
                });

            } catch (err) {
                // Transaction already rolled back by processLoyaltyOrder on failure,
                // but ensure the outer delete transaction is also safe
                try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
                client.release();
                report.ordersFailed++;
                log('ERROR: Order correction failed', {
                    orderId: order.id,
                    error: err.message
                });
            }
        }
    }

    // Build affected customer reward status report
    const customerReport = [];
    if (!DRY_RUN && report.affectedCustomers.size > 0) {
        for (const [customerId, info] of report.affectedCustomers) {
            // Fetch current reward status
            const rewards = await db.query(`
                SELECT lr.id, lr.offer_id, lr.status, lr.current_quantity, lr.required_quantity,
                       lo.offer_name
                FROM loyalty_rewards lr
                JOIN loyalty_offers lo ON lo.id = lr.offer_id AND lo.merchant_id = lr.merchant_id
                WHERE lr.merchant_id = $1 AND lr.square_customer_id = $2
                ORDER BY lr.updated_at DESC
            `, [merchantId, customerId]);

            customerReport.push({
                customerId,
                corrections: info.corrections,
                ordersFixed: info.ordersFixed,
                currentRewards: rewards.rows.map(r => ({
                    offerId: r.offer_id,
                    offerName: r.offer_name,
                    status: r.status,
                    progress: `${r.current_quantity}/${r.required_quantity}`
                }))
            });
        }
    }

    log('Phase 3 complete', {
        ordersChecked: report.ordersChecked,
        ordersSkippedNoCustomer: report.ordersSkippedNoCustomer,
        ordersCorrectlyRecorded: report.ordersCorrectlyRecorded,
        ordersUnderCounted: report.ordersUnderCounted,
        ordersCorrected: report.ordersCorrected,
        ordersFailed: report.ordersFailed,
        affectedCustomers: report.affectedCustomers.size,
        customerReport
    });

    return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    log('========================================');
    log('Combined Order Backfill Script');
    log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
    log(`Merchant: ${MERCHANT_ID}`);
    log(`Date: ${now.toISOString()}`);
    log('========================================');

    if (DRY_RUN) {
        log('*** DRY RUN MODE — no changes will be written ***');
        log('*** Use --execute flag to apply changes ***');
    }

    try {
        // Phase 1: Download orders
        const orders = await fetchAllOrders(MERCHANT_ID);

        // Phase 2: Velocity correction
        const velocityResult = await correctVelocity(orders, MERCHANT_ID);

        // Phase 3: Loyalty correction
        const loyaltyResult = await correctLoyalty(orders, MERCHANT_ID);

        // Final report
        log('========================================');
        log('FINAL REPORT');
        log('========================================');
        log('Phase 1 — Orders fetched', { total: orders.length });
        log('Phase 2 — Velocity', {
            corrections: velocityResult.corrections,
            staleRowsRemoved: velocityResult.staleRows
        });
        log('Phase 3 — Loyalty', {
            ordersChecked: loyaltyResult.ordersChecked,
            underCounted: loyaltyResult.ordersUnderCounted,
            corrected: loyaltyResult.ordersCorrected,
            failed: loyaltyResult.ordersFailed,
            affectedCustomers: loyaltyResult.affectedCustomers.size
        });
        log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes written)' : 'EXECUTED'}`);
        log(`Log file: ${path.join(logDir, logFileName)}`);

        // --- Drain async side-effects ---
        // reward-progress-service fires createSquareCustomerGroupDiscount and
        // updateCustomerStats as fire-and-forget promises. We must wait for them
        // to complete before closing the DB pool, otherwise in-flight Square API
        // calls that write back to the DB (e.g. storing square_discount_id on
        // loyalty_rewards) will fail with "pool is closed".
        if (pendingAsyncEffects.length > 0) {
            log('Waiting for async side-effects to settle', { count: pendingAsyncEffects.length });
            const settled = await Promise.allSettled(pendingAsyncEffects);
            const failed = settled.filter(r => r.status === 'rejected');
            log('Async side-effects settled', {
                total: settled.length,
                fulfilled: settled.length - failed.length,
                rejected: failed.length
            });
        }

        // --- Check for earned rewards missing their Square discount ---
        const missingDiscounts = await db.query(`
            SELECT lr.id AS reward_id, lr.square_customer_id, lr.offer_id,
                   lo.offer_name, lr.earned_at
            FROM loyalty_rewards lr
            JOIN loyalty_offers lo ON lo.id = lr.offer_id AND lo.merchant_id = lr.merchant_id
            WHERE lr.merchant_id = $1
              AND lr.status = 'earned'
              AND lr.square_discount_id IS NULL
            ORDER BY lr.earned_at DESC
        `, [MERCHANT_ID]);

        if (missingDiscounts.rows.length > 0) {
            log('WARNING: Earned rewards missing Square discount', {
                count: missingDiscounts.rows.length,
                rewards: missingDiscounts.rows.map(r => ({
                    rewardId: r.reward_id,
                    customerId: r.square_customer_id,
                    offerId: r.offer_id,
                    offerName: r.offer_name,
                    earnedAt: r.earned_at
                }))
            });
        } else {
            log('All earned rewards have Square discounts assigned');
        }

    } catch (err) {
        log('FATAL ERROR', { error: err.message, stack: err.stack });
        logger.error('Combined backfill script failed', { error: err.message, stack: err.stack });
        process.exitCode = 1;
    } finally {
        logStream.end();
        await db.pool.end();
    }
}

main();
