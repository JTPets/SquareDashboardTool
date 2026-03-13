#!/usr/bin/env node

/**
 * Loyalty Purchase Event Reconciliation Script
 *
 * Rebuilds the event-to-reward mapping from scratch using Square order ground truth.
 * Before the Mar 7 2026 fix, orders were recorded in loyalty_processed_orders
 * (idempotency gate) but actual loyalty_purchase_events rows were silently dropped
 * by the dedup bug. Rewards may have been earned/redeemed based on incomplete data,
 * and backfills may have locked events to wrong reward slots.
 *
 * This script replays the full purchase history for a customer+offer, inserting
 * missing events and correcting reward_id assignments.
 *
 * Usage:
 *   node scripts/loyalty-event-reconciler.js --dry-run [--merchant-id=3] [--customer-id=SQ_ID] [--offer-id=UUID]
 *   node scripts/loyalty-event-reconciler.js --execute --merchant-id=3 --customer-id=SQ_ID --offer-id=UUID
 *
 * --execute requires all three: --merchant-id, --customer-id, --offer-id
 * --dry-run without customer/offer scans all customers with earned/redeemed rewards
 */

require('dotenv').config();

const db = require('../utils/database');
const logger = require('../utils/logger');
const { getSquareClientForMerchant } = require('../middleware/merchant');
const { updateCustomerSummary } = require('../services/loyalty-admin/customer-summary-service');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');

function getArgValue(prefix) {
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

const MERCHANT_ID = parseInt(getArgValue('--merchant-id=')) || 3;
const CUSTOMER_ID_FILTER = getArgValue('--customer-id=') || null;
const OFFER_ID_FILTER = getArgValue('--offer-id=') || null;
const API_DELAY_MS = 200;

function log(msg, data = {}) {
    const extra = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    console.log(`[reconciler] ${msg}${extra}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Validate execute mode requires all flags
// ---------------------------------------------------------------------------
if (!DRY_RUN && (!CUSTOMER_ID_FILTER || !OFFER_ID_FILTER)) {
    console.error('[reconciler] ERROR: --execute mode requires --merchant-id, --customer-id, AND --offer-id');
    console.error('Usage: node scripts/loyalty-event-reconciler.js --execute --merchant-id=3 --customer-id=SQ_ID --offer-id=UUID');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared: fetch Square order with 404 handling
// ---------------------------------------------------------------------------
async function fetchSquareOrder(squareClient, orderId) {
    try {
        const resp = await squareClient.orders.get({ orderId });
        return resp.order || null;
    } catch (err) {
        if (err.statusCode === 404 || err.status === 404) return null;
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Shared: aggregate line items by catalog_object_id (mirrors order-intake.js)
// ---------------------------------------------------------------------------
function aggregateOrderLineItems(order) {
    const aggregated = new Map();
    for (const li of (order.line_items || [])) {
        const variationId = li.catalog_object_id;
        if (!variationId) continue;
        const qty = parseInt(li.quantity) || 0;
        if (qty <= 0) continue;
        const unitPrice = Number(li.base_price_money?.amount || 0);
        const totalPrice = qty * unitPrice;

        const existing = aggregated.get(variationId);
        if (existing) {
            existing.quantity += qty;
            existing.totalPriceCents += totalPrice;
            if (unitPrice > existing.unitPriceCents) existing.unitPriceCents = unitPrice;
        } else {
            aggregated.set(variationId, {
                variationId, quantity: qty, unitPriceCents: unitPrice, totalPriceCents: totalPrice
            });
        }
    }
    return aggregated;
}

// ---------------------------------------------------------------------------
// Get customer+offer pairs to process
// ---------------------------------------------------------------------------
async function getTargetPairs(merchantId, customerId, offerId) {
    if (customerId && offerId) {
        return [{ square_customer_id: customerId, offer_id: offerId }];
    }

    // Scan all customers with earned/redeemed rewards
    const result = await db.query(`
        SELECT DISTINCT lr.square_customer_id, lr.offer_id
        FROM loyalty_rewards lr
        WHERE lr.merchant_id = $1
          AND lr.status IN ('earned', 'redeemed')
        ORDER BY lr.square_customer_id, lr.offer_id
    `, [merchantId]);

    return result.rows;
}

// ---------------------------------------------------------------------------
// Diagnose a single customer+offer pair
// ---------------------------------------------------------------------------
async function diagnoseCustomerOffer(merchantId, squareCustomerId, offerId, squareClient) {
    // 1. Get offer details + qualifying variations
    const offerResult = await db.query(`
        SELECT lo.*, array_agg(lqv.variation_id) FILTER (WHERE lqv.is_active = true) AS qualifying_variation_ids
        FROM loyalty_offers lo
        LEFT JOIN loyalty_qualifying_variations lqv
            ON lqv.offer_id = lo.id AND lqv.merchant_id = lo.merchant_id
        WHERE lo.id = $1 AND lo.merchant_id = $2
        GROUP BY lo.id
    `, [offerId, merchantId]);

    if (offerResult.rows.length === 0) {
        return { error: 'Offer not found', offerId };
    }

    const offer = offerResult.rows[0];
    const qualifyingIds = new Set((offer.qualifying_variation_ids || []).filter(Boolean));

    if (qualifyingIds.size === 0) {
        return { error: 'No qualifying variations for offer', offerId };
    }

    // 2. Get all rewards for this customer+offer, ordered chronologically
    const rewardsResult = await db.query(`
        SELECT id, status, current_quantity, required_quantity,
               window_start_date, window_end_date, created_at
        FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
        ORDER BY created_at ASC
    `, [merchantId, offerId, squareCustomerId]);

    const rewards = rewardsResult.rows;

    // 3. Get existing purchase events (non-refund, non-split-child)
    const existingEventsResult = await db.query(`
        SELECT id, square_order_id, variation_id, quantity, unit_price_cents,
               total_price_cents, reward_id, purchased_at, idempotency_key,
               window_start_date, window_end_date
        FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
          AND is_refund = FALSE AND quantity > 0 AND original_event_id IS NULL
        ORDER BY purchased_at ASC, id ASC
    `, [merchantId, offerId, squareCustomerId]);

    const existingEvents = existingEventsResult.rows;
    const existingByOrderVar = new Map();
    for (const ev of existingEvents) {
        existingByOrderVar.set(`${ev.square_order_id}:${ev.variation_id}`, ev);
    }

    // 4. Get all processed orders for this customer
    const processedOrdersResult = await db.query(`
        SELECT square_order_id, processed_at
        FROM loyalty_processed_orders
        WHERE merchant_id = $1 AND square_customer_id = $2
        ORDER BY processed_at ASC
    `, [merchantId, squareCustomerId]);

    const processedOrders = processedOrdersResult.rows;

    // 5. Find missing events by fetching Square orders
    const missingEvents = [];
    const skipped404 = [];

    for (const po of processedOrders) {
        const orderId = po.square_order_id;

        // Check if we already have events for ALL qualifying variations in this order
        // We need to fetch the order to know what qualifying items were in it
        const order = await fetchSquareOrder(squareClient, orderId);
        if (!order) {
            skipped404.push(orderId);
            await sleep(API_DELAY_MS);
            continue;
        }

        const aggregated = aggregateOrderLineItems(order);
        const orderDate = order.created_at || po.processed_at;

        for (const [variationId, agg] of aggregated) {
            if (!qualifyingIds.has(variationId)) continue;

            const key = `${orderId}:${variationId}`;
            const existing = existingByOrderVar.get(key);

            if (!existing) {
                missingEvents.push({
                    squareOrderId: orderId,
                    variationId,
                    quantity: agg.quantity,
                    unitPriceCents: agg.unitPriceCents,
                    totalPriceCents: agg.totalPriceCents,
                    orderDate,
                    locationId: order.location_id || null,
                    idempotencyKey: key
                });
            }
        }

        await sleep(API_DELAY_MS);
    }

    // 6. Build combined chronological timeline
    const timeline = [];

    // Existing events
    for (const ev of existingEvents) {
        timeline.push({
            type: 'existing',
            eventId: ev.id,
            squareOrderId: ev.square_order_id,
            variationId: ev.variation_id,
            quantity: parseInt(ev.quantity),
            unitPriceCents: ev.unit_price_cents,
            totalPriceCents: ev.total_price_cents,
            orderDate: ev.purchased_at,
            currentRewardId: ev.reward_id,
            idempotencyKey: ev.idempotency_key
        });
    }

    // Missing events
    for (const me of missingEvents) {
        timeline.push({
            type: 'missing',
            eventId: null,
            squareOrderId: me.squareOrderId,
            variationId: me.variationId,
            quantity: me.quantity,
            unitPriceCents: me.unitPriceCents,
            totalPriceCents: me.totalPriceCents,
            orderDate: me.orderDate,
            currentRewardId: null,
            idempotencyKey: me.idempotencyKey,
            locationId: me.locationId
        });
    }

    // Sort chronologically
    timeline.sort((a, b) => new Date(a.orderDate) - new Date(b.orderDate));

    // 7. Walk timeline and assign events to rewards chronologically
    const assignments = assignEventsToRewards(timeline, rewards, offer.required_quantity);

    return {
        offer: { id: offerId, name: offer.offer_name, required_quantity: offer.required_quantity, window_months: offer.window_months },
        rewards,
        existingEventCount: existingEvents.length,
        missingEventCount: missingEvents.length,
        skipped404,
        processedOrderCount: processedOrders.length,
        timeline,
        assignments,
        missingEvents
    };
}

// ---------------------------------------------------------------------------
// Assign events to rewards chronologically
// ---------------------------------------------------------------------------
function assignEventsToRewards(timeline, rewards, requiredQuantity) {
    const rewardSlots = rewards.map(r => ({
        rewardId: r.id,
        status: r.status,
        windowStart: r.window_start_date,
        windowEnd: r.window_end_date,
        capacity: parseInt(r.required_quantity) || requiredQuantity,
        assigned: 0,
        events: []
    }));

    const assignments = [];
    const unassigned = [];

    for (const event of timeline) {
        const eventDate = new Date(event.orderDate);
        let assigned = false;

        // Try to find a reward whose window contains this event date
        // Prefer the one with fewer assigned events (filling first)
        const candidates = rewardSlots
            .filter(s => {
                const start = new Date(s.windowStart);
                const end = new Date(s.windowEnd);
                return eventDate >= start && eventDate <= end && s.assigned < s.capacity;
            })
            .sort((a, b) => a.assigned - b.assigned);

        if (candidates.length > 0) {
            const slot = candidates[0];
            slot.assigned += event.quantity;
            slot.events.push(event);
            assignments.push({
                ...event,
                correctRewardId: slot.rewardId,
                rewardStatus: slot.status,
                needsRewardUpdate: event.currentRewardId !== slot.rewardId
            });
            assigned = true;
        }

        // Backfill scenario: event predates all rewards — assign to earliest with capacity
        if (!assigned) {
            const fallback = rewardSlots.find(s => s.assigned < s.capacity);
            if (fallback) {
                fallback.assigned += event.quantity;
                fallback.events.push(event);
                assignments.push({
                    ...event,
                    correctRewardId: fallback.rewardId,
                    rewardStatus: fallback.status,
                    needsRewardUpdate: event.currentRewardId !== fallback.rewardId,
                    note: 'backfill_assignment'
                });
            } else {
                unassigned.push(event);
            }
        }
    }

    // Calculate per-reward correct quantities
    const rewardCorrections = rewardSlots.map(slot => {
        const correctLockedQty = slot.events.reduce((sum, e) => sum + e.quantity, 0);
        return {
            rewardId: slot.rewardId,
            status: slot.status,
            capacity: slot.capacity,
            correctLockedQty,
            eventCount: slot.events.length,
            belowRequired: (slot.status === 'earned' || slot.status === 'redeemed') && correctLockedQty < slot.capacity
        };
    });

    return { assignments, unassigned, rewardCorrections };
}

// ---------------------------------------------------------------------------
// Report diagnostic results for a customer+offer
// ---------------------------------------------------------------------------
function reportDiagnosis(merchantId, customerId, diagnosis) {
    if (diagnosis.error) {
        log(`  ERROR: ${diagnosis.error}`, { offerId: diagnosis.offerId });
        return;
    }

    const { offer, rewards, existingEventCount, missingEventCount, skipped404,
        processedOrderCount, assignments, missingEvents } = diagnosis;

    log(`  Offer: "${offer.name}" (buy ${offer.required_quantity})`, { offerId: offer.id });
    log(`  Orders processed: ${processedOrderCount}, Events existing: ${existingEventCount}, Events MISSING: ${missingEventCount}`);
    if (skipped404.length > 0) {
        log(`  Skipped 404 orders: ${skipped404.length}`, { orderIds: skipped404.slice(0, 5) });
    }

    // Report missing events
    for (const me of missingEvents) {
        log(`  MISSING: order=${me.squareOrderId} variation=${me.variationId}`, {
            quantity: me.quantity,
            date: new Date(me.orderDate).toISOString().split('T')[0],
            assign_to_reward: assignments.assignments.find(
                a => a.idempotencyKey === me.idempotencyKey
            )?.correctRewardId || 'none'
        });
    }

    // Report wrong reward_id assignments
    const wrongAssignments = assignments.assignments.filter(
        a => a.type === 'existing' && a.needsRewardUpdate
    );
    for (const wa of wrongAssignments) {
        log(`  WRONG_REWARD: event=${wa.eventId} order=${wa.squareOrderId}`, {
            current_reward: wa.currentRewardId || 'null',
            correct_reward: wa.correctRewardId
        });
    }

    // Report per-reward quantities
    for (const rc of assignments.rewardCorrections) {
        const existingReward = rewards.find(r => r.id === rc.rewardId);
        const currentQty = existingReward ? parseInt(existingReward.current_quantity) : 0;
        if (currentQty !== rc.correctLockedQty || rc.belowRequired) {
            log(`  REWARD: ${rc.rewardId} status=${rc.status}`, {
                current_locked_qty: currentQty,
                correct_locked_qty: rc.correctLockedQty,
                required: rc.capacity,
                WARNING: rc.belowRequired ? 'BELOW_REQUIRED' : undefined
            });
        }
    }

    // Unassigned events
    if (assignments.unassigned.length > 0) {
        log(`  UNASSIGNED events (no reward slot): ${assignments.unassigned.length}`);
        for (const u of assignments.unassigned) {
            log(`    order=${u.squareOrderId} variation=${u.variationId} qty=${u.quantity}`);
        }
    }

    return {
        hasMissing: missingEventCount > 0,
        hasWrongAssignments: wrongAssignments.length > 0,
        hasWarnings: assignments.rewardCorrections.some(r => r.belowRequired)
    };
}

// ---------------------------------------------------------------------------
// Phase 2: Apply corrections for a single customer+offer
// ---------------------------------------------------------------------------
async function applyCorrections(merchantId, customerId, offerId, diagnosis) {
    const { offer, rewards, assignments } = diagnosis;
    const { assignments: eventAssignments, rewardCorrections } = assignments;

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        let inserted = 0;
        let rewardIdUpdated = 0;

        // 1. INSERT missing events
        const missingAssignments = eventAssignments.filter(a => a.type === 'missing');
        for (const ma of missingAssignments) {
            // Find the reward to get window dates
            const reward = rewards.find(r => r.id === ma.correctRewardId);
            const windowStart = reward?.window_start_date || new Date(ma.orderDate).toISOString().split('T')[0];
            const windowEnd = reward?.window_end_date || (() => {
                const d = new Date(ma.orderDate);
                d.setMonth(d.getMonth() + offer.window_months);
                return d.toISOString().split('T')[0];
            })();

            // LOGIC CHANGE: INSERT missing purchase event with correct reward_id
            const insertResult = await client.query(`
                INSERT INTO loyalty_purchase_events (
                    merchant_id, offer_id, square_customer_id, square_order_id,
                    square_location_id, variation_id, quantity, unit_price_cents, total_price_cents,
                    purchased_at, window_start_date, window_end_date,
                    is_refund, reward_id, idempotency_key, customer_source
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, $13, $14, 'reconciliation')
                ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
                RETURNING id
            `, [
                merchantId, offerId, customerId, ma.squareOrderId,
                ma.locationId || null, ma.variationId, ma.quantity,
                ma.unitPriceCents, ma.totalPriceCents,
                ma.orderDate, windowStart, windowEnd,
                ma.correctRewardId, ma.idempotencyKey
            ]);

            if (insertResult.rows.length > 0) {
                inserted++;
                log(`  Inserted event: order=${ma.squareOrderId} variation=${ma.variationId}`, {
                    qty: ma.quantity, reward: ma.correctRewardId
                });
            } else {
                log(`  Skipped (already exists): ${ma.idempotencyKey}`);
            }
        }

        // 2. UPDATE existing events with wrong reward_id
        const wrongAssignments = eventAssignments.filter(
            a => a.type === 'existing' && a.needsRewardUpdate
        );
        for (const wa of wrongAssignments) {
            // LOGIC CHANGE: UPDATE reward_id on existing purchase event
            await client.query(`
                UPDATE loyalty_purchase_events
                SET reward_id = $1, updated_at = NOW()
                WHERE id = $2 AND merchant_id = $3
            `, [wa.correctRewardId, wa.eventId, merchantId]);

            rewardIdUpdated++;
            log(`  Reassigned event ${wa.eventId}: ${wa.currentRewardId || 'null'} → ${wa.correctRewardId}`);
        }

        // 3. UPDATE reward current_quantity for each affected reward
        for (const rc of rewardCorrections) {
            const lockedSum = await client.query(`
                SELECT COALESCE(SUM(quantity), 0) AS total
                FROM loyalty_purchase_events
                WHERE reward_id = $1 AND merchant_id = $2
            `, [rc.rewardId, merchantId]);

            const newQty = parseInt(lockedSum.rows[0].total) || 0;

            // LOGIC CHANGE: UPDATE reward current_quantity from re-summed locked events
            await client.query(`
                UPDATE loyalty_rewards
                SET current_quantity = $1, updated_at = NOW()
                WHERE id = $2 AND merchant_id = $3
            `, [newQty, rc.rewardId, merchantId]);

            log(`  Reward ${rc.rewardId}: current_quantity → ${newQty} (status=${rc.status})`);

            if ((rc.status === 'earned' || rc.status === 'redeemed') && newQty < rc.capacity) {
                log(`  WARNING: reward ${rc.rewardId} has ${newQty} < required ${rc.capacity} — status NOT changed`);
            }
        }

        // 4. Update customer summary
        await updateCustomerSummary(client, merchantId, customerId, offerId);

        // 5. COMMIT
        await client.query('COMMIT');

        log(`  Corrections applied: ${inserted} inserted, ${rewardIdUpdated} reassigned`);
        return { inserted, rewardIdUpdated };

    } catch (err) {
        await client.query('ROLLBACK');
        log(`  ERROR: Transaction failed`, { error: err.message });
        throw err;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    log('========================================');
    log('Loyalty Purchase Event Reconciler');
    log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}  Merchant: ${MERCHANT_ID}`);
    if (CUSTOMER_ID_FILTER) log(`Customer: ${CUSTOMER_ID_FILTER}`);
    if (OFFER_ID_FILTER) log(`Offer: ${OFFER_ID_FILTER}`);
    log(`Date: ${new Date().toISOString()}`);
    log('========================================');

    try {
        const squareClient = await getSquareClientForMerchant(MERCHANT_ID);

        // Get target customer+offer pairs
        const pairs = await getTargetPairs(MERCHANT_ID, CUSTOMER_ID_FILTER, OFFER_ID_FILTER);
        log(`Customer+offer pairs to process: ${pairs.length}`);

        const summary = {
            pairsProcessed: 0,
            pairsWithMissing: 0,
            pairsWithWrongAssignments: 0,
            pairsWithWarnings: 0,
            totalInserted: 0,
            totalReassigned: 0
        };

        for (const pair of pairs) {
            const { square_customer_id: custId, offer_id: offId } = pair;

            log('----------------------------------------');
            log(`Processing: customer=${custId} offer=${offId}`);

            const diagnosis = await diagnoseCustomerOffer(MERCHANT_ID, custId, offId, squareClient);
            const reportResult = reportDiagnosis(MERCHANT_ID, custId, diagnosis);

            summary.pairsProcessed++;
            if (reportResult) {
                if (reportResult.hasMissing) summary.pairsWithMissing++;
                if (reportResult.hasWrongAssignments) summary.pairsWithWrongAssignments++;
                if (reportResult.hasWarnings) summary.pairsWithWarnings++;
            }

            // Apply corrections in execute mode
            if (!DRY_RUN && !diagnosis.error) {
                const hasMissing = diagnosis.missingEventCount > 0;
                const hasWrongAssignments = diagnosis.assignments.assignments.some(
                    a => a.type === 'existing' && a.needsRewardUpdate
                );

                if (hasMissing || hasWrongAssignments) {
                    const result = await applyCorrections(MERCHANT_ID, custId, offId, diagnosis);
                    summary.totalInserted += result.inserted;
                    summary.totalReassigned += result.rewardIdUpdated;
                } else {
                    log('  No corrections needed');
                }
            }
        }

        log('========================================');
        log('RECONCILIATION COMPLETE');
        log('========================================');
        log('Summary', summary);

    } catch (err) {
        log('FATAL ERROR', { error: err.message, stack: err.stack });
        logger.error('Loyalty event reconciler failed', { error: err.message, stack: err.stack });
        process.exitCode = 1;
    } finally {
        await db.pool.end();
    }
}

main();
