#!/usr/bin/env node

/**
 * Loyalty Purchase Event Quantity Audit/Correction Tool
 *
 * Fixes under-counted quantities in loyalty_purchase_events caused by a bug
 * in order-intake.js (fixed 2026-03-07). When Square POS produced multiple
 * line items with the same catalog_object_id in a single order, only the
 * first was recorded due to the old idempotency key dedup.
 *
 * This script compares recorded quantities against Square order ground truth
 * and corrects discrepancies. It does NOT insert or delete rows — only UPDATEs
 * existing loyalty_purchase_events and recalculates reward current_quantity.
 *
 * Usage:
 *   node scripts/loyalty-quantity-audit.js [--dry-run|--execute] [--merchant-id=3] [--reward-id=UUID]
 *
 * Default mode is --dry-run (report only, no writes).
 */

require('dotenv').config();

const db = require('../utils/database');
const logger = require('../utils/logger');
const { getSquareClientForMerchant } = require('../middleware/merchant');
const { updateCustomerSummary } = require('../services/loyalty-admin/customer-summary-service');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');

function getArgValue(prefix) {
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

const MERCHANT_ID = parseInt(getArgValue('--merchant-id=')) || 3;
const REWARD_ID_FILTER = getArgValue('--reward-id=') || null;

// Square API rate limit delay (ms between order fetches)
const API_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg, data = {}) {
    const preview = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    console.log(`[loyalty-audit] ${msg}${preview}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Step 1: Query all non-refund purchase events, grouped by order+variation
// ---------------------------------------------------------------------------
async function fetchRecordedEvents(merchantId, rewardIdFilter) {
    let query = `
        SELECT
            lpe.id AS event_id,
            lpe.square_order_id,
            lpe.variation_id,
            lpe.quantity,
            lpe.total_price_cents,
            lpe.unit_price_cents,
            lpe.offer_id,
            lpe.reward_id,
            lpe.square_customer_id,
            lc.given_name,
            lc.family_name
        FROM loyalty_purchase_events lpe
        LEFT JOIN loyalty_customers lc
            ON lc.merchant_id = lpe.merchant_id
            AND lc.square_customer_id = lpe.square_customer_id
        WHERE lpe.merchant_id = $1
          AND lpe.is_refund = FALSE
          AND lpe.quantity > 0
          AND lpe.original_event_id IS NULL
    `;
    const params = [merchantId];

    if (rewardIdFilter) {
        params.push(rewardIdFilter);
        query += ` AND lpe.reward_id = $${params.length}`;
    }

    query += ' ORDER BY lpe.square_order_id, lpe.variation_id';

    const result = await db.query(query, params);
    return result.rows;
}

// ---------------------------------------------------------------------------
// Step 2: Aggregate line items from a Square order (mirrors order-intake.js)
// ---------------------------------------------------------------------------
function aggregateOrderLineItems(order) {
    const lineItems = order.line_items || [];
    const aggregated = new Map();

    for (const lineItem of lineItems) {
        const variationId = lineItem.catalog_object_id;
        if (!variationId) continue;

        const quantity = parseInt(lineItem.quantity) || 0;
        if (quantity <= 0) continue;

        const unitPriceCents = Number(lineItem.base_price_money?.amount || 0);
        const totalPriceCents = quantity * unitPriceCents;

        // Skip 100% discounted items (same logic as order-intake.js)
        const grossSalesCents = Number(lineItem.gross_sales_money?.amount || 0)
            || (unitPriceCents * quantity);
        const rawTotalMoney = lineItem.total_money?.amount;
        const totalMoneyCents = rawTotalMoney != null
            ? Number(rawTotalMoney)
            : grossSalesCents - Number(lineItem.total_discount_money?.amount || 0);

        if (grossSalesCents > 0 && totalMoneyCents === 0) continue;

        const existing = aggregated.get(variationId);
        if (existing) {
            existing.quantity += quantity;
            existing.totalPriceCents += totalPriceCents;
            if (unitPriceCents > existing.unitPriceCents) {
                existing.unitPriceCents = unitPriceCents;
            }
        } else {
            aggregated.set(variationId, {
                variationId,
                quantity,
                unitPriceCents,
                totalPriceCents
            });
        }
    }

    return aggregated;
}

// ---------------------------------------------------------------------------
// Step 3: Fetch order from Square with 404 handling
// ---------------------------------------------------------------------------
async function fetchSquareOrder(squareClient, orderId) {
    try {
        const response = await squareClient.orders.get({ orderId });
        return response.order || null;
    } catch (err) {
        if (err.statusCode === 404 || err.status === 404) {
            return null; // Deleted order
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Step 4: Compare recorded vs actual and build discrepancy list
// ---------------------------------------------------------------------------
function findDiscrepancies(eventsByOrder, orderAggregates) {
    const discrepancies = [];

    for (const [orderKey, events] of eventsByOrder) {
        const aggregated = orderAggregates.get(orderKey);
        if (!aggregated) continue; // Order was 404 — skip

        for (const event of events) {
            const actual = aggregated.get(event.variation_id);
            if (!actual) continue; // Variation not in order line items

            const recordedQty = parseInt(event.quantity) || 0;
            const actualQty = actual.quantity;
            const recordedPrice = event.total_price_cents != null
                ? parseInt(event.total_price_cents) : null;
            const actualPrice = actual.totalPriceCents;

            const qtyMismatch = recordedQty !== actualQty;
            const priceMismatch = recordedPrice !== null && recordedPrice !== actualPrice;

            if (qtyMismatch || priceMismatch) {
                discrepancies.push({
                    eventId: event.event_id,
                    squareOrderId: event.square_order_id,
                    variationId: event.variation_id,
                    customerName: [event.given_name, event.family_name]
                        .filter(Boolean).join(' ') || 'Unknown',
                    squareCustomerId: event.square_customer_id,
                    offerId: event.offer_id,
                    rewardId: event.reward_id,
                    recordedQty,
                    actualQty,
                    recordedPriceCents: recordedPrice,
                    actualPriceCents: actualPrice,
                    qtyDelta: actualQty - recordedQty
                });
            }
        }
    }

    return discrepancies;
}

// ---------------------------------------------------------------------------
// Step 5: Apply corrections (execute mode only)
// Uses db.transaction() per reward group — all events for one reward = one tx
// ---------------------------------------------------------------------------
async function applyCorrections(discrepancies, merchantId) {
    // Group discrepancies by reward_id for transactional batching
    const byReward = new Map();
    for (const d of discrepancies) {
        const key = d.rewardId || 'no_reward';
        if (!byReward.has(key)) byReward.set(key, []);
        byReward.get(key).push(d);
    }

    let totalCorrected = 0;
    const warnings = [];

    for (const [rewardKey, rewardDiscrepancies] of byReward) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            for (const d of rewardDiscrepancies) {
                // LOGIC CHANGE: UPDATE existing purchase event quantities
                await client.query(`
                    UPDATE loyalty_purchase_events
                    SET quantity = $1,
                        total_price_cents = $2,
                        updated_at = NOW()
                    WHERE id = $3 AND merchant_id = $4
                `, [d.actualQty, d.actualPriceCents, d.eventId, merchantId]);

                log('  Corrected event', {
                    eventId: d.eventId,
                    orderId: d.squareOrderId,
                    variationId: d.variationId,
                    oldQty: d.recordedQty,
                    newQty: d.actualQty,
                    oldPrice: d.recordedPriceCents,
                    newPrice: d.actualPriceCents
                });

                totalCorrected++;
            }

            // LOGIC CHANGE: Recalculate reward current_quantity by re-summing
            // locked purchase events (same query as reward-progress-service.js ~line 221)
            if (rewardKey !== 'no_reward') {
                const rewardId = rewardKey;
                const rewardInfo = await client.query(`
                    SELECT lr.offer_id, lr.square_customer_id, lr.status,
                           lo.required_quantity
                    FROM loyalty_rewards lr
                    JOIN loyalty_offers lo ON lo.id = lr.offer_id AND lo.merchant_id = lr.merchant_id
                    WHERE lr.id = $1 AND lr.merchant_id = $2
                `, [rewardId, merchantId]);

                if (rewardInfo.rows.length > 0) {
                    const reward = rewardInfo.rows[0];

                    // Re-sum locked events for this reward
                    const lockedSum = await client.query(`
                        SELECT COALESCE(SUM(quantity), 0) AS total
                        FROM loyalty_purchase_events
                        WHERE reward_id = $1 AND merchant_id = $2
                    `, [rewardId, merchantId]);

                    const newCurrentQty = parseInt(lockedSum.rows[0].total) || 0;

                    // LOGIC CHANGE: UPDATE reward current_quantity
                    await client.query(`
                        UPDATE loyalty_rewards
                        SET current_quantity = $1, updated_at = NOW()
                        WHERE id = $2 AND merchant_id = $3
                    `, [newCurrentQty, rewardId, merchantId]);

                    log('  Recalculated reward', {
                        rewardId,
                        newCurrentQty,
                        status: reward.status
                    });

                    // Validation: flag earned/redeemed rewards where corrected
                    // net qualifying < required_quantity
                    if ((reward.status === 'earned' || reward.status === 'redeemed')
                        && newCurrentQty < parseInt(reward.required_quantity)) {
                        warnings.push({
                            rewardId,
                            status: reward.status,
                            currentQty: newCurrentQty,
                            requiredQty: parseInt(reward.required_quantity),
                            customerId: reward.square_customer_id,
                            offerId: reward.offer_id
                        });
                    }
                }
            }

            // Update customer summaries for affected customers+offers
            const customerOfferPairs = new Set();
            for (const d of rewardDiscrepancies) {
                customerOfferPairs.add(`${d.squareCustomerId}:${d.offerId}`);
            }

            for (const pair of customerOfferPairs) {
                const [customerId, offerId] = pair.split(':');
                await updateCustomerSummary(client, merchantId, customerId, offerId);
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            log('ERROR: Transaction failed for reward group', {
                rewardKey,
                error: err.message
            });
        } finally {
            client.release();
        }
    }

    return { totalCorrected, warnings };
}

// ---------------------------------------------------------------------------
// Step 6: Validation — flag earned/redeemed rewards with insufficient locked qty
// ---------------------------------------------------------------------------
async function validateRewards(merchantId, rewardIdFilter) {
    let query = `
        SELECT lr.id AS reward_id, lr.status, lr.current_quantity,
               lr.required_quantity, lr.square_customer_id, lr.offer_id,
               lo.offer_name,
               lc.given_name, lc.family_name
        FROM loyalty_rewards lr
        JOIN loyalty_offers lo ON lo.id = lr.offer_id AND lo.merchant_id = lr.merchant_id
        LEFT JOIN loyalty_customers lc
            ON lc.merchant_id = lr.merchant_id
            AND lc.square_customer_id = lr.square_customer_id
        WHERE lr.merchant_id = $1
          AND lr.status IN ('earned', 'redeemed')
    `;
    const params = [merchantId];

    if (rewardIdFilter) {
        params.push(rewardIdFilter);
        query += ` AND lr.id = $${params.length}`;
    }

    const result = await db.query(query, params);
    const warnings = [];

    for (const reward of result.rows) {
        const lockedSum = await db.query(`
            SELECT COALESCE(SUM(quantity), 0) AS total
            FROM loyalty_purchase_events
            WHERE reward_id = $1 AND merchant_id = $2
        `, [reward.reward_id, merchantId]);

        const netQualifying = parseInt(lockedSum.rows[0].total) || 0;

        if (netQualifying < parseInt(reward.required_quantity)) {
            warnings.push({
                rewardId: reward.reward_id,
                status: reward.status,
                currentQty: parseInt(reward.current_quantity),
                lockedQty: netQualifying,
                requiredQty: parseInt(reward.required_quantity),
                customerName: [reward.given_name, reward.family_name]
                    .filter(Boolean).join(' ') || 'Unknown',
                customerId: reward.square_customer_id,
                offerId: reward.offer_id,
                offerName: reward.offer_name
            });
        }
    }

    return warnings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    log('========================================');
    log('Loyalty Purchase Event Quantity Audit');
    log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
    log(`Merchant: ${MERCHANT_ID}`);
    if (REWARD_ID_FILTER) log(`Reward filter: ${REWARD_ID_FILTER}`);
    log(`Date: ${new Date().toISOString()}`);
    log('========================================');

    if (DRY_RUN) {
        log('*** DRY RUN MODE — no changes will be written ***');
        log('*** Use --execute flag to apply corrections ***');
    }

    try {
        // Step 1: Fetch all recorded purchase events
        log('Fetching recorded purchase events...');
        const events = await fetchRecordedEvents(MERCHANT_ID, REWARD_ID_FILTER);
        log(`Found ${events.length} purchase events`);

        if (events.length === 0) {
            log('No purchase events found. Nothing to audit.');
            return;
        }

        // Group events by square_order_id (one event per order+variation is correct)
        const eventsByOrder = new Map();
        for (const event of events) {
            if (!eventsByOrder.has(event.square_order_id)) {
                eventsByOrder.set(event.square_order_id, []);
            }
            eventsByOrder.get(event.square_order_id).push(event);
        }

        const uniqueOrderIds = [...eventsByOrder.keys()];
        log(`Unique orders to check: ${uniqueOrderIds.length}`);

        // Step 2: Fetch each order from Square and aggregate line items
        log('Fetching orders from Square API...');
        const squareClient = await getSquareClientForMerchant(MERCHANT_ID);
        const orderAggregates = new Map();
        let fetched = 0;
        let skipped404 = 0;
        let fetchErrors = 0;

        for (const orderId of uniqueOrderIds) {
            try {
                const order = await fetchSquareOrder(squareClient, orderId);

                if (!order) {
                    skipped404++;
                    log(`  Skipped (404/deleted): ${orderId}`);
                } else {
                    const aggregated = aggregateOrderLineItems(order);
                    orderAggregates.set(orderId, aggregated);
                }

                fetched++;
                if (fetched % 50 === 0) {
                    log(`  Progress: ${fetched}/${uniqueOrderIds.length} orders fetched`);
                }
            } catch (err) {
                fetchErrors++;
                log(`  ERROR fetching order ${orderId}: ${err.message}`);
            }

            // Rate limit Square API calls (200ms between fetches)
            await sleep(API_DELAY_MS);
        }

        log('Square API fetch complete', {
            fetched,
            skipped404,
            fetchErrors,
            successfullyAggregated: orderAggregates.size
        });

        // Step 3: Compare and find discrepancies
        const discrepancies = findDiscrepancies(eventsByOrder, orderAggregates);

        // Report discrepancies
        log('========================================');
        log('DISCREPANCY REPORT');
        log('========================================');

        if (discrepancies.length === 0) {
            log('No discrepancies found. All recorded quantities match Square orders.');
        } else {
            const totalQtyDelta = discrepancies.reduce((sum, d) => sum + d.qtyDelta, 0);

            for (const d of discrepancies) {
                log(`DISCREPANCY: order=${d.squareOrderId} variation=${d.variationId}`, {
                    customer: d.customerName,
                    recorded_qty: d.recordedQty,
                    actual_qty: d.actualQty,
                    recorded_total_price_cents: d.recordedPriceCents,
                    actual_total_price_cents: d.actualPriceCents,
                    reward_id: d.rewardId || 'none'
                });
            }

            log('Summary', {
                totalEventsChecked: events.length,
                totalWithDiscrepancies: discrepancies.length,
                totalQuantityDelta: totalQtyDelta
            });
        }

        // Step 4: Apply corrections if in execute mode
        if (!DRY_RUN && discrepancies.length > 0) {
            log('========================================');
            log('APPLYING CORRECTIONS');
            log('========================================');

            const result = await applyCorrections(discrepancies, MERCHANT_ID);
            log('Corrections applied', { totalCorrected: result.totalCorrected });

            if (result.warnings.length > 0) {
                log('========================================');
                log('WARNINGS: Rewards below required quantity after correction');
                log('========================================');
                for (const w of result.warnings) {
                    log(`WARNING: reward=${w.rewardId} status=${w.status}`, {
                        currentQty: w.currentQty,
                        requiredQty: w.requiredQty,
                        customerId: w.customerId,
                        offerId: w.offerId
                    });
                }
            }
        }

        // Step 5: Validation check (runs in both modes)
        log('========================================');
        log('VALIDATION CHECK');
        log('========================================');

        const validationWarnings = await validateRewards(MERCHANT_ID, REWARD_ID_FILTER);

        if (validationWarnings.length === 0) {
            log('All earned/redeemed rewards have sufficient qualifying quantity.');
        } else {
            for (const w of validationWarnings) {
                log(`WARNING: reward=${w.rewardId} status=${w.status} offer="${w.offerName}"`, {
                    customer: w.customerName,
                    lockedQty: w.lockedQty,
                    requiredQty: w.requiredQty,
                    note: 'Reward status NOT changed — manual review needed'
                });
            }
            log(`Total validation warnings: ${validationWarnings.length}`);
        }

        log('========================================');
        log('AUDIT COMPLETE');
        log('========================================');

    } catch (err) {
        log('FATAL ERROR', { error: err.message, stack: err.stack });
        logger.error('Loyalty quantity audit failed', {
            error: err.message,
            stack: err.stack
        });
        process.exitCode = 1;
    } finally {
        await db.pool.end();
    }
}

main();
