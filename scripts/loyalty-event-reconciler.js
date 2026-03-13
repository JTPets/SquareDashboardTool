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
// LOGIC CHANGE: Unit-based chronological replay with split-row awareness.
// Replaces the old whole-event assignment that incorrectly assigned entire
// events to single reward slots even when events crossed reward boundaries.
// The real system (reward-progress-service.js:334-449) splits crossing events
// into locked + excess child rows. This replay mirrors that logic at the unit
// level without creating split rows — it tracks which units belong where.
// ---------------------------------------------------------------------------
function assignEventsToRewards(timeline, rewards, requiredQuantity) {
    const unitAssignments = [];
    const splitEvents = [];
    const unassignedEvents = [];

    let currentRewardIndex = 0;
    let unitsAssignedToCurrentReward = 0;

    // Per-reward accumulators for corrections
    const rewardUnitTotals = new Map();
    for (const r of rewards) {
        rewardUnitTotals.set(r.id, 0);
    }

    for (const event of timeline) {
        let remainingUnits = event.quantity;
        const eventParts = [];

        while (remainingUnits > 0) {
            const currentReward = currentRewardIndex < rewards.length
                ? rewards[currentRewardIndex] : null;
            const capacityLeft = currentReward
                ? requiredQuantity - unitsAssignedToCurrentReward : 0;

            if (!currentReward) {
                // No more rewards — remaining units are unassigned (future in_progress)
                eventParts.push({
                    eventId: event.eventId,
                    squareOrderId: event.squareOrderId,
                    variationId: event.variationId,
                    totalEventQuantity: event.quantity,
                    assignedUnits: remainingUnits,
                    rewardId: null,
                    isExisting: event.type === 'existing',
                    orderDate: event.orderDate,
                    currentRewardId: event.currentRewardId,
                    idempotencyKey: event.idempotencyKey,
                    locationId: event.locationId,
                    unitPriceCents: event.unitPriceCents,
                    totalPriceCents: event.totalPriceCents,
                });
                remainingUnits = 0;
            } else if (remainingUnits <= capacityLeft) {
                // Event fits entirely in current reward
                eventParts.push({
                    eventId: event.eventId,
                    squareOrderId: event.squareOrderId,
                    variationId: event.variationId,
                    totalEventQuantity: event.quantity,
                    assignedUnits: remainingUnits,
                    rewardId: currentReward.id,
                    isExisting: event.type === 'existing',
                    orderDate: event.orderDate,
                    currentRewardId: event.currentRewardId,
                    idempotencyKey: event.idempotencyKey,
                    locationId: event.locationId,
                    unitPriceCents: event.unitPriceCents,
                    totalPriceCents: event.totalPriceCents,
                });
                unitsAssignedToCurrentReward += remainingUnits;
                rewardUnitTotals.set(currentReward.id,
                    (rewardUnitTotals.get(currentReward.id) || 0) + remainingUnits);
                remainingUnits = 0;

                if (unitsAssignedToCurrentReward === requiredQuantity) {
                    currentRewardIndex++;
                    unitsAssignedToCurrentReward = 0;
                }
            } else {
                // Event CROSSES reward boundary — needs split
                eventParts.push({
                    eventId: event.eventId,
                    squareOrderId: event.squareOrderId,
                    variationId: event.variationId,
                    totalEventQuantity: event.quantity,
                    assignedUnits: capacityLeft,
                    rewardId: currentReward.id,
                    isExisting: event.type === 'existing',
                    orderDate: event.orderDate,
                    currentRewardId: event.currentRewardId,
                    idempotencyKey: event.idempotencyKey,
                    locationId: event.locationId,
                    unitPriceCents: event.unitPriceCents,
                    totalPriceCents: event.totalPriceCents,
                });
                rewardUnitTotals.set(currentReward.id,
                    (rewardUnitTotals.get(currentReward.id) || 0) + capacityLeft);
                remainingUnits -= capacityLeft;
                currentRewardIndex++;
                unitsAssignedToCurrentReward = 0;
            }
        }

        // Determine if event was split across rewards
        const distinctRewards = new Set(eventParts.map(p => p.rewardId));
        const isSplit = distinctRewards.size > 1;

        // Set isSplit and splitType on each part
        for (const part of eventParts) {
            part.isSplit = isSplit;
            if (isSplit) {
                part.splitType = part.rewardId ? 'locked' : 'excess';
            } else {
                part.splitType = null;
            }
            unitAssignments.push(part);
            if (part.rewardId === null) {
                unassignedEvents.push(part);
            }
        }

        // Track split events for warnings
        if (isSplit) {
            splitEvents.push({
                eventId: event.eventId,
                squareOrderId: event.squareOrderId,
                variationId: event.variationId,
                totalQuantity: event.quantity,
                isExisting: event.type === 'existing',
                portions: eventParts.map(p => ({
                    units: p.assignedUnits,
                    rewardId: p.rewardId
                }))
            });
        }
    }

    // Calculate per-reward correct quantities
    const rewardCorrections = rewards.map(r => {
        const correctLockedQty = rewardUnitTotals.get(r.id) || 0;
        return {
            rewardId: r.id,
            status: r.status,
            capacity: parseInt(r.required_quantity) || requiredQuantity,
            correctLockedQty,
            belowRequired: (r.status === 'earned' || r.status === 'redeemed') &&
                correctLockedQty < (parseInt(r.required_quantity) || requiredQuantity)
        };
    });

    return { unitAssignments, rewardCorrections, splitEvents, unassignedEvents };
}

// ---------------------------------------------------------------------------
// Report diagnostic results for a customer+offer
// LOGIC CHANGE: Shows unit-based timeline replay instead of whole-event list.
// ---------------------------------------------------------------------------
function reportDiagnosis(merchantId, customerId, diagnosis) {
    if (diagnosis.error) {
        log(`  ERROR: ${diagnosis.error}`, { offerId: diagnosis.offerId });
        return;
    }

    const { offer, rewards, existingEventCount, missingEventCount, skipped404,
        processedOrderCount, assignments } = diagnosis;
    const { unitAssignments, rewardCorrections, splitEvents, unassignedEvents } = assignments;

    const shortId = (id) => id ? id.substring(0, 8) : 'null';

    log(`  Offer: "${offer.name}" (buy ${offer.required_quantity})`, { offerId: offer.id });
    log(`  Orders processed: ${processedOrderCount}, Events existing: ${existingEventCount}, Events MISSING: ${missingEventCount}`);
    if (skipped404.length > 0) {
        log(`  Skipped 404 orders: ${skipped404.length}`, { orderIds: skipped404.slice(0, 5) });
    }

    // --- TIMELINE REPLAY (unit-based) ---
    log('');
    log('  TIMELINE REPLAY (unit-based):');

    // Group unit assignments by source event (consecutive assignments share idempotencyKey)
    const eventGroups = [];
    for (const ua of unitAssignments) {
        const last = eventGroups[eventGroups.length - 1];
        if (last && last[0].idempotencyKey === ua.idempotencyKey) {
            last.push(ua);
        } else {
            eventGroups.push([ua]);
        }
    }

    let currentDisplayRewardId = '__none__';
    let displayRunning = 0;

    for (const group of eventGroups) {
        const first = group[0];
        const date = new Date(first.orderDate).toISOString().split('T')[0];
        const status = first.isExisting ? 'EXISTING' : 'MISSING';

        if (group.length === 1 && !first.isSplit) {
            // Non-split event — single line
            if (first.rewardId !== currentDisplayRewardId) {
                currentDisplayRewardId = first.rewardId;
                displayRunning = 0;
                if (first.rewardId) {
                    const r = rewards.find(r => r.id === first.rewardId);
                    log(`  [reward ${shortId(first.rewardId)} — ${r?.status || 'unknown'}, need ${offer.required_quantity}]`);
                } else {
                    log(`  [unlocked — future in_progress]`);
                }
            }
            displayRunning += first.assignedUnits;
            const unitWord = first.assignedUnits === 1 ? 'unit' : 'units';
            const rewardLabel = first.rewardId ? shortId(first.rewardId) : 'unlocked';
            const progress = first.rewardId ? ` (${displayRunning}/${offer.required_quantity})` : '';
            const filled = first.rewardId && displayRunning >= offer.required_quantity;
            const filledMark = filled ? ' ✓ FILLED' : '';
            log(`    ${date} order=${first.squareOrderId} qty=${first.totalEventQuantity} → ${first.assignedUnits} ${unitWord} to ${rewardLabel}${progress} ${status}${filledMark}`);
        } else {
            // Split event — show SPLIT line with all portions
            // Ensure reward header is shown for first portion if needed
            if (group[0].rewardId && group[0].rewardId !== currentDisplayRewardId) {
                currentDisplayRewardId = group[0].rewardId;
                displayRunning = 0;
                const r = rewards.find(r => r.id === group[0].rewardId);
                log(`  [reward ${shortId(group[0].rewardId)} — ${r?.status || 'unknown'}, need ${offer.required_quantity}]`);
            }

            const parts = [];
            for (const ua of group) {
                if (ua.rewardId && ua.rewardId !== currentDisplayRewardId) {
                    currentDisplayRewardId = ua.rewardId;
                    displayRunning = 0;
                }
                displayRunning += ua.assignedUnits;
                const unitWord = ua.assignedUnits === 1 ? 'unit' : 'units';
                const rewardLabel = ua.rewardId ? shortId(ua.rewardId) : 'next';
                const progress = ua.rewardId ? ` (${displayRunning}/${offer.required_quantity})` : '';
                const filled = ua.rewardId && displayRunning >= offer.required_quantity;
                parts.push(`${ua.assignedUnits} ${unitWord} to ${rewardLabel}${progress}${filled ? ' ✓ FILLED' : ''}`);
            }
            log(`    SPLIT: ${date} order=${first.squareOrderId} qty=${first.totalEventQuantity} → ${parts.join(', ')} ${status}`);
        }
    }

    // --- Unassigned events ---
    if (unassignedEvents.length > 0) {
        const totalUnassigned = unassignedEvents.reduce((sum, u) => sum + u.assignedUnits, 0);
        log(`  UNASSIGNED units (no reward slot): ${totalUnassigned}`);
    }

    // --- Per-reward corrections ---
    for (const rc of rewardCorrections) {
        const existingReward = rewards.find(r => r.id === rc.rewardId);
        const currentQty = existingReward ? parseInt(existingReward.current_quantity) : 0;
        if (currentQty !== rc.correctLockedQty || rc.belowRequired) {
            log(`  REWARD: ${rc.rewardId} status=${rc.status}`, {
                current_locked_qty: currentQty,
                correct_locked_qty: rc.correctLockedQty,
                required: rc.capacity,
                WARNING: rc.belowRequired ? 'BELOW_REQUIRED — earned/redeemed with insufficient units. Manual review needed.' : undefined
            });
        }
    }

    // --- Split warnings ---
    if (splitEvents.length > 0) {
        log(`  SPLIT WARNINGS: ${splitEvents.length} event(s) cross reward boundaries`);
        for (const se of splitEvents) {
            const tag = se.isExisting ? 'existing (needs manual split)' : 'missing (will insert with NULL reward_id)';
            const portionDesc = se.portions.map(p =>
                `${p.units} → ${p.rewardId ? shortId(p.rewardId) : 'unlocked'}`
            ).join(', ');
            log(`    order=${se.squareOrderId} var=${se.variationId} qty=${se.totalQuantity} [${portionDesc}] ${tag}`);
        }
    }

    // Determine what actions exist
    const wrongAssignments = unitAssignments.filter(ua =>
        ua.isExisting && !ua.isSplit && ua.rewardId !== ua.currentRewardId
    );

    return {
        hasMissing: missingEventCount > 0,
        hasWrongAssignments: wrongAssignments.length > 0,
        hasWarnings: rewardCorrections.some(r => r.belowRequired),
        hasSplitWarnings: splitEvents.length > 0
    };
}

// ---------------------------------------------------------------------------
// Phase 2: Apply corrections for a single customer+offer
// LOGIC CHANGE: Unit-based correction with split-row awareness.
// Does NOT create split child rows — logs warnings for splits that need
// manual intervention or will be handled by the live system.
// ---------------------------------------------------------------------------
async function applyCorrections(merchantId, customerId, offerId, diagnosis) {
    const { offer, rewards, assignments } = diagnosis;
    const { unitAssignments, rewardCorrections } = assignments;

    // Build per-event correction plan from unit assignments.
    // Each source event (keyed by idempotencyKey) may have 1+ unit assignments
    // if it was split across reward boundaries.
    const eventPlan = new Map();
    for (const ua of unitAssignments) {
        const key = ua.idempotencyKey;
        if (!eventPlan.has(key)) {
            eventPlan.set(key, {
                eventId: ua.eventId,
                isExisting: ua.isExisting,
                squareOrderId: ua.squareOrderId,
                variationId: ua.variationId,
                totalQuantity: ua.totalEventQuantity,
                currentRewardId: ua.currentRewardId,
                portions: [],
                orderDate: ua.orderDate,
                locationId: ua.locationId,
                unitPriceCents: ua.unitPriceCents,
                totalPriceCents: ua.totalPriceCents,
                idempotencyKey: ua.idempotencyKey,
            });
        }
        eventPlan.get(key).portions.push({
            units: ua.assignedUnits,
            rewardId: ua.rewardId
        });
    }

    // Determine per-event: isSplit (crosses reward boundary), targetRewardId
    for (const [, plan] of eventPlan) {
        const distinctRewards = new Set(plan.portions.map(p => p.rewardId));
        plan.isSplit = distinctRewards.size > 1;
        plan.targetRewardId = plan.isSplit ? null : (plan.portions[0]?.rewardId ?? null);
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        let inserted = 0;
        let rewardIdUpdated = 0;
        let splitWarnings = 0;

        for (const [, plan] of eventPlan) {
            if (!plan.isExisting) {
                // --- MISSING event: INSERT ---
                // LOGIC CHANGE: Split events get NULL reward_id — the live system
                // will handle proper split-row locking on next reward progress update.
                // Non-split events get the correct reward_id directly.
                const rewardIdForInsert = plan.isSplit ? null : plan.targetRewardId;
                const firstRewardId = plan.portions[0]?.rewardId;
                const reward = firstRewardId
                    ? rewards.find(r => r.id === firstRewardId) : null;
                const windowStart = reward?.window_start_date
                    || new Date(plan.orderDate).toISOString().split('T')[0];
                const windowEnd = reward?.window_end_date || (() => {
                    const d = new Date(plan.orderDate);
                    d.setMonth(d.getMonth() + offer.window_months);
                    return d.toISOString().split('T')[0];
                })();

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
                    merchantId, offerId, customerId, plan.squareOrderId,
                    plan.locationId || null, plan.variationId, plan.totalQuantity,
                    plan.unitPriceCents, plan.totalPriceCents,
                    plan.orderDate, windowStart, windowEnd,
                    rewardIdForInsert, plan.idempotencyKey
                ]);

                if (insertResult.rows.length > 0) {
                    inserted++;
                    if (plan.isSplit) {
                        splitWarnings++;
                        const portionDesc = plan.portions.map(p =>
                            `${p.units} → ${p.rewardId ? p.rewardId.substring(0, 8) : 'unlocked'}`
                        ).join(', ');
                        log(`  Inserted (SPLIT WARNING): order=${plan.squareOrderId} var=${plan.variationId} qty=${plan.totalQuantity} — reward_id=NULL, needs manual split [${portionDesc}]`);
                    } else {
                        log(`  Inserted: order=${plan.squareOrderId} var=${plan.variationId}`, {
                            qty: plan.totalQuantity, reward: rewardIdForInsert
                        });
                    }
                } else {
                    log(`  Skipped (already exists): ${plan.idempotencyKey}`);
                }
            } else {
                // --- EXISTING event: UPDATE or WARN ---
                if (plan.isSplit) {
                    // LOGIC CHANGE: Do NOT create split child rows in the reconciler.
                    // Log warning — manual intervention or live system will handle split.
                    splitWarnings++;
                    const portionDesc = plan.portions.map(p =>
                        `${p.units} → ${p.rewardId ? p.rewardId.substring(0, 8) : 'unlocked'}`
                    ).join(', ');
                    log(`  SPLIT_WARNING: event=${plan.eventId} order=${plan.squareOrderId} qty=${plan.totalQuantity} crosses boundary [${portionDesc}] — skipped`);
                } else if (plan.targetRewardId !== plan.currentRewardId) {
                    // LOGIC CHANGE: UPDATE reward_id on existing purchase event
                    await client.query(`
                        UPDATE loyalty_purchase_events
                        SET reward_id = $1, updated_at = NOW()
                        WHERE id = $2 AND merchant_id = $3
                    `, [plan.targetRewardId, plan.eventId, merchantId]);

                    rewardIdUpdated++;
                    log(`  Reassigned event ${plan.eventId}: ${plan.currentRewardId || 'null'} → ${plan.targetRewardId}`);
                }
            }
        }

        // --- Re-sum locked events per reward ---
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
                log(`  WARNING: reward ${rc.rewardId} has ${newQty} < required ${rc.capacity} — earned/redeemed with insufficient units. Manual review needed.`);
            }
        }

        // --- Update customer summary ---
        await updateCustomerSummary(client, merchantId, customerId, offerId);

        await client.query('COMMIT');

        log(`  Corrections applied: ${inserted} inserted, ${rewardIdUpdated} reassigned, ${splitWarnings} split warnings`);
        return { inserted, rewardIdUpdated, splitWarnings };

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
            pairsWithSplitWarnings: 0,
            totalInserted: 0,
            totalReassigned: 0,
            totalSplitWarnings: 0
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
                if (reportResult.hasSplitWarnings) summary.pairsWithSplitWarnings++;
            }

            // Apply corrections in execute mode
            if (!DRY_RUN && !diagnosis.error) {
                const hasMissing = diagnosis.missingEventCount > 0;
                const { unitAssignments, splitEvents } = diagnosis.assignments;
                const hasWrongAssignments = unitAssignments.some(ua =>
                    ua.isExisting && !ua.isSplit && ua.rewardId !== ua.currentRewardId
                );

                if (hasMissing || hasWrongAssignments || splitEvents.length > 0) {
                    const result = await applyCorrections(MERCHANT_ID, custId, offId, diagnosis);
                    summary.totalInserted += result.inserted;
                    summary.totalReassigned += result.rewardIdUpdated;
                    summary.totalSplitWarnings += result.splitWarnings;
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
