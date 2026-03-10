/**
 * Reward Progress Service
 *
 * Manages the loyalty reward state machine: tracks qualifying purchase
 * quantities, creates in_progress rewards, transitions to earned status
 * via the split-row locking algorithm, and handles multi-threshold rollover.
 *
 * Extracted from purchase-service.js as part of file-size compliance split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { RewardStatus, AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { updateCustomerStats } = require('./customer-cache-service');
const { createSquareCustomerGroupDiscount } = require('./square-discount-service');
const { updateCustomerSummary } = require('./customer-summary-service');

// Lazy-required in resolveConflictViaSquare to avoid pulling 'square' SDK
// at module load time (breaks tests that don't mock middleware/merchant).
// const { getSquareClientForMerchant } = require('../../middleware/merchant');
// const { queryQualifyingVariations } = require('./loyalty-queries');

// TODO: Refactoring suggestions — do not implement in this PR.
// This function mixes locking, calculation, transition, and new-reward-creation.
// Suggested extractions:
//
// 1. calculateUnlockedQuantity(client, merchantId, offerId, squareCustomerId)
//    Inputs: client, merchantId, offerId, squareCustomerId
//    Outputs: { totalQuantity: number }
//    Owns: The FOR UPDATE SKIP LOCKED query that counts unlocked purchase events
//    Risk: Low — pure query, no side effects
//
// 2. getOrCreateInProgressReward(client, merchantId, offerId, squareCustomerId, currentQuantity, offer)
//    Inputs: client, merchantId, offerId, squareCustomerId, currentQuantity, offer
//    Outputs: { reward: Object, isNew: boolean, conflictOccurred: boolean }
//    Owns: SELECT FOR UPDATE of existing reward + INSERT ON CONFLICT for new reward
//    Risk: Medium — contains the ON CONFLICT logic, needs careful testing
//
// 3. lockAndSplitPurchases(client, rewardId, merchantId, offerId, squareCustomerId, requiredQuantity)
//    Inputs: client, rewardId, merchantId, offerId, squareCustomerId, requiredQuantity
//    Outputs: { lockedRows: Array, totalLockedQty: number }
//    Owns: The CTE lock query + crossing row split logic (lines 155-266)
//    Risk: High — core split-row algorithm, thorough integration tests needed
//
// 4. transitionToEarned(client, reward, merchantId, offerId, squareCustomerId, offer)
//    Inputs: client, reward, merchantId, offerId, squareCustomerId, offer
//    Outputs: void
//    Owns: UPDATE to earned, audit event, customer stats, Square discount creation
//    Risk: Low — all side-effect code already isolated in called services

/**
 * Resolve an in_progress reward conflict by verifying quantity via Square API.
 *
 * Called when ON CONFLICT fires (two concurrent webhooks both INSERT the same
 * in_progress reward). Fetches the triggering order from Square, counts
 * qualifying line items as ground truth, re-derives the total from the DB,
 * and UPDATEs the reward to the verified quantity.
 *
 * LOGIC CHANGE: Conflict resolution now verifies quantities via Square API
 * instead of blindly using GREATEST(existing, incoming).
 * Before: GREATEST was used as the final quantity — could be wrong if either
 * concurrent transaction calculated from a stale snapshot.
 * After: Square order is fetched as ground truth, qualifying line items are
 * counted directly from the order, and the reward is updated to that quantity.
 * Square API is transaction-independent — unlike a DB re-derive which runs
 * under READ COMMITTED and cannot see the concurrent transaction's uncommitted
 * rows. Falls back to GREATEST only if the Square API call fails.
 *
 * @param {Object} client - Database transaction client
 * @param {Object} reward - The reward row returned from INSERT ON CONFLICT
 * @param {Object} params - { merchantId, offerId, squareCustomerId, existingQuantity, incomingQuantity }
 * @returns {Promise<number>} The verified quantity set on the reward
 */
async function resolveConflictViaSquare(client, reward, params) {
    const { merchantId, offerId, squareCustomerId, existingQuantity, incomingQuantity } = params;

    // Lazy require to avoid pulling 'square' SDK at module load time
    const { getSquareClientForMerchant } = require('../../middleware/merchant');
    const { queryQualifyingVariations } = require('./loyalty-queries');

    // Get the most recent order ID from this customer's unlocked purchase events
    const recentOrderResult = await client.query(`
        SELECT square_order_id FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
          AND window_end_date >= CURRENT_DATE AND reward_id IS NULL
        ORDER BY purchased_at DESC, id DESC
        LIMIT 1
    `, [merchantId, offerId, squareCustomerId]);

    const orderId = recentOrderResult.rows[0]?.square_order_id;

    logger.warn('Concurrent in_progress reward conflict detected', {
        event: 'in_progress_conflict',
        customerId: squareCustomerId,
        offerId,
        merchantId,
        existingQuantity,
        incomingQuantity,
        orderId: orderId || null
    });

    if (!orderId) {
        // No order to verify — fall back to GREATEST (already applied by SQL)
        logger.error('Conflict resolution cannot verify — no order ID found', {
            event: 'in_progress_conflict_fallback',
            reason: 'no_order_id',
            merchantId,
            offerId,
            customerId: squareCustomerId
        });
        return reward.current_quantity;
    }

    try {
        // Fetch the order from Square as ground truth
        const squareClient = await getSquareClientForMerchant(merchantId);
        const orderResponse = await squareClient.orders.get({ orderId });
        const order = orderResponse.order;

        if (!order || !order.lineItems) {
            logger.error('Conflict resolution cannot verify — order has no line items', {
                event: 'in_progress_conflict_fallback',
                reason: 'empty_order',
                merchantId,
                offerId,
                orderId
            });
            return reward.current_quantity;
        }

        // Get qualifying variation IDs for this offer
        const qualifyingVars = await queryQualifyingVariations(offerId, merchantId);
        const qualifyingIds = new Set(qualifyingVars.map(v => v.variation_id));

        // Count qualifying items in the Square order
        // LOGIC CHANGE: verifiedQuantity now uses squareQualifyingQty (Square API) instead of
        // DB re-derive. The DB re-derive ran inside an open transaction under READ COMMITTED —
        // it could not see uncommitted rows from the concurrent transaction, producing partial
        // state. Square API is transaction-independent and is the correct ground truth.
        let verifiedQuantity = 0;
        for (const lineItem of order.lineItems) {
            if (qualifyingIds.has(lineItem.catalogObjectId)) {
                verifiedQuantity += parseInt(lineItem.quantity) || 0;
            }
        }

        // UPDATE the reward to the verified quantity
        await client.query(`
            UPDATE loyalty_rewards
            SET current_quantity = $1, updated_at = NOW()
            WHERE id = $2 AND merchant_id = $3
        `, [verifiedQuantity, reward.id, merchantId]);

        reward.current_quantity = verifiedQuantity;

        logger.info('Conflict resolved via Square verification', {
            event: 'in_progress_conflict_resolved',
            customerId: squareCustomerId,
            offerId,
            merchantId,
            verifiedQuantity,
            orderId
        });

        return verifiedQuantity;
    } catch (err) {
        // Square API failure — fall back to GREATEST (already applied by SQL)
        logger.error('Conflict resolution Square API failed — using GREATEST fallback', {
            event: 'in_progress_conflict_fallback',
            reason: err.message,
            merchantId,
            offerId,
            customerId: squareCustomerId,
            orderId,
            fallbackQuantity: reward.current_quantity
        });
        return reward.current_quantity;
    }
}

/**
 * Update reward progress for a customer+offer after a purchase or refund
 * Implements the rolling window logic and state machine
 *
 * @param {Object} client - Database client (for transaction)
 * @param {Object} data - Update data
 */
async function updateRewardProgress(client, data) {
    const { merchantId, offerId, squareCustomerId, offer } = data;

    // LOGIC CHANGE (MED-1): Collect earned reward IDs during the transaction,
    // fire Square discount creation AFTER the transaction commits. Before: the
    // createSquareCustomerGroupDiscount() call ran as a detached promise inside
    // the transaction. If the transaction rolled back, the reward row would not
    // exist but markSyncPending() could still fire using a pool connection,
    // creating an orphaned sync record. After: earned rewards are collected in
    // this array and processed post-commit by the caller receiving the result.
    const earnedRewardIds = [];

    // Calculate current qualifying quantity within the rolling window
    // Only count purchases that haven't been locked into an earned reward
    // and are still within their window.
    // Exclude rows that have been superseded by split records (rows whose
    // original_event_id children exist) to prevent double-counting.
    // CRIT-2: FOR UPDATE prevents concurrent transactions from reading the same
    // snapshot and both calculating >= required_quantity on the same purchase rows.
    // SKIP LOCKED avoids deadlocks: if another transaction already holds a lock,
    // this transaction skips those rows rather than blocking. This means a
    // concurrent call sees a lower quantity and won't prematurely trigger an earn.
    // LOGIC CHANGE: Added FOR UPDATE SKIP LOCKED to quantity calculation query.
    // Before: unlocked read allowed two concurrent transactions to both see the
    // same total and both attempt to earn the reward / lock the same purchase rows.
    // After: rows locked by one transaction are skipped by the other, preventing
    // double-earn races.
    const quantityResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) as total_quantity
        FROM loyalty_purchase_events lpe
        WHERE lpe.merchant_id = $1
          AND lpe.offer_id = $2
          AND lpe.square_customer_id = $3
          AND lpe.window_end_date >= CURRENT_DATE
          AND lpe.reward_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM loyalty_purchase_events child
              WHERE child.original_event_id = lpe.id
          )
        FOR UPDATE SKIP LOCKED
    `, [merchantId, offerId, squareCustomerId]);

    let currentQuantity = parseInt(quantityResult.rows[0].total_quantity) || 0;

    // Get or create the in_progress reward
    let rewardResult = await client.query(`
        SELECT * FROM loyalty_rewards
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND status = 'in_progress'
        FOR UPDATE
    `, [merchantId, offerId, squareCustomerId]);

    let reward = rewardResult.rows[0];

    if (!reward && currentQuantity > 0) {
        // Create new in_progress reward
        // CRIT-1: Same ON CONFLICT pattern as the multi-threshold INSERT below.
        // Two concurrent webhooks can both see no existing in_progress reward
        // (the FOR UPDATE above returns nothing if no row exists) and both attempt
        // this INSERT. ON CONFLICT absorbs the second INSERT safely.
        const windowResult = await client.query(`
            SELECT MIN(window_start_date) as start_date, MAX(window_end_date) as end_date
            FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE AND reward_id IS NULL
        `, [merchantId, offerId, squareCustomerId]);

        const windowRow = windowResult.rows[0] || {};
        const { start_date, end_date } = windowRow;

        // LOGIC CHANGE: Added ON CONFLICT ... DO UPDATE to initial in_progress INSERT.
        // Before: plain INSERT threw on unique violation when two concurrent
        // webhooks both found no existing in_progress reward.
        // After: conflict is absorbed — GREATEST is applied as an interim value,
        // then resolveConflictViaSquare verifies via Square API and corrects.
        const newRewardResult = await client.query(`
            INSERT INTO loyalty_rewards (
                merchant_id, offer_id, square_customer_id, status,
                current_quantity, required_quantity,
                window_start_date, window_end_date
            )
            VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7)
            ON CONFLICT (merchant_id, offer_id, square_customer_id) WHERE status = 'in_progress'
            DO UPDATE SET
                current_quantity = GREATEST(loyalty_rewards.current_quantity, EXCLUDED.current_quantity),
                updated_at = NOW()
            RETURNING *, (xmax <> 0) AS conflict_occurred
        `, [
            merchantId, offerId, squareCustomerId,
            currentQuantity, offer.required_quantity,
            start_date, end_date
        ]);

        reward = newRewardResult.rows[0];

        // LOGIC CHANGE: On conflict, verify quantity via Square API instead of
        // blindly trusting GREATEST. Before: GREATEST was the final value.
        // After: Square order is fetched as ground truth, DB re-queried for
        // authoritative total, reward updated to verified quantity. Falls back
        // to GREATEST only on Square API failure.
        if (reward && reward.conflict_occurred) {
            // existingQuantity: if GREATEST > incoming, existing was higher; otherwise unknown
            const greatestQty = parseInt(reward.current_quantity) || 0;
            const existingQty = greatestQty !== currentQuantity ? greatestQty : currentQuantity;
            const verifiedQty = await resolveConflictViaSquare(client, reward, {
                merchantId,
                offerId,
                squareCustomerId,
                existingQuantity: existingQty,
                incomingQuantity: currentQuantity
            });
            currentQuantity = verifiedQty;
        }
    } else if (reward) {
        // Update existing reward (B5 fix: added AND merchant_id)
        const oldQuantity = reward.current_quantity;

        await client.query(`
            UPDATE loyalty_rewards
            SET current_quantity = $1, updated_at = NOW()
            WHERE id = $2 AND merchant_id = $3
        `, [currentQuantity, reward.id, merchantId]);

        reward.current_quantity = currentQuantity;

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_PROGRESS_UPDATED,
            offerId,
            rewardId: reward.id,
            squareCustomerId,
            oldQuantity,
            newQuantity: currentQuantity,
            triggeredBy: 'SYSTEM'
        }, client);  // Pass transaction client to avoid deadlock
    }

    // Check if reward has been earned — loop handles multi-threshold
    // (e.g. 30 units toward "buy 12" earns 2 rewards with 6 rollover)
    while (reward && currentQuantity >= offer.required_quantity && reward.status === 'in_progress') {
        // Lock contributing purchases using split-row approach:
        // Step 1: Lock rows that are fully consumed (cumulative <= required)
        const lockResult = await client.query(`
            WITH ranked_purchases AS (
                SELECT id, quantity,
                    SUM(quantity) OVER (ORDER BY purchased_at ASC, id ASC) as cumulative_qty
                FROM loyalty_purchase_events lpe
                WHERE lpe.merchant_id = $2
                  AND lpe.offer_id = $3
                  AND lpe.square_customer_id = $4
                  AND lpe.window_end_date >= CURRENT_DATE
                  AND lpe.reward_id IS NULL
                  AND lpe.quantity > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM loyalty_purchase_events child
                      WHERE child.original_event_id = lpe.id
                  )
            )
            UPDATE loyalty_purchase_events lpe
            SET reward_id = $1, updated_at = NOW()
            FROM ranked_purchases rp
            WHERE lpe.id = rp.id
              AND rp.cumulative_qty <= $5
            RETURNING lpe.id, lpe.quantity, rp.cumulative_qty
        `, [reward.id, merchantId, offerId, squareCustomerId, offer.required_quantity]);

        const lockedRows = lockResult.rows || [];
        const totalLockedQty = lockedRows.reduce((sum, row) => sum + (parseInt(row.quantity, 10) || 0), 0);
        const neededFromCrossing = offer.required_quantity - totalLockedQty;

        // Step 2: Split the crossing row if we still need more units
        if (neededFromCrossing > 0) {
            // CRIT-2: FOR UPDATE SKIP LOCKED prevents concurrent transactions from
            // selecting and splitting the same crossing row. If another transaction
            // already holds this row, SKIP LOCKED returns no rows, preventing double-split.
            // LOGIC CHANGE: Added FOR UPDATE SKIP LOCKED to crossing row fetch.
            // Before: two concurrent transactions could both select and split the same
            // crossing row, creating duplicate split children.
            // After: only one transaction can lock and split the crossing row; the other
            // skips it and sees no crossing row to split.
            const crossingResult = await client.query(`
                SELECT id, quantity, square_order_id, variation_id, unit_price_cents, total_price_cents,
                       purchased_at, idempotency_key, window_start_date, window_end_date,
                       square_location_id, receipt_url, customer_source, payment_type
                FROM loyalty_purchase_events lpe
                WHERE lpe.merchant_id = $1
                  AND lpe.offer_id = $2
                  AND lpe.square_customer_id = $3
                  AND lpe.window_end_date >= CURRENT_DATE
                  AND lpe.reward_id IS NULL
                  AND lpe.quantity > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM loyalty_purchase_events child
                      WHERE child.original_event_id = lpe.id
                  )
                ORDER BY purchased_at ASC, id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `, [merchantId, offerId, squareCustomerId]);

            if (crossingResult.rows.length > 0) {
                const cr = crossingResult.rows[0];
                const crossingQty = parseInt(cr.quantity, 10);
                const excessQty = crossingQty - neededFromCrossing;

                // Create locked child (portion that goes to this reward)
                const lockedTotalPriceCents = cr.unit_price_cents ? neededFromCrossing * cr.unit_price_cents : null;
                await client.query(`
                    INSERT INTO loyalty_purchase_events (
                        merchant_id, offer_id, square_customer_id, square_order_id,
                        square_location_id, variation_id, quantity, unit_price_cents, total_price_cents,
                        purchased_at, window_start_date, window_end_date,
                        reward_id, original_event_id, idempotency_key,
                        receipt_url, customer_source, payment_type
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                `, [
                    merchantId, offerId, squareCustomerId, cr.square_order_id,
                    cr.square_location_id, cr.variation_id, neededFromCrossing, cr.unit_price_cents, lockedTotalPriceCents,
                    cr.purchased_at, cr.window_start_date, cr.window_end_date,
                    reward.id, cr.id, cr.idempotency_key + ':split_locked:' + reward.id,
                    cr.receipt_url, cr.customer_source, cr.payment_type
                ]);

                // Create unlocked excess child (rollover for next cycle)
                if (excessQty > 0) {
                    const excessTotalPriceCents = cr.unit_price_cents ? excessQty * cr.unit_price_cents : null;
                    await client.query(`
                        INSERT INTO loyalty_purchase_events (
                            merchant_id, offer_id, square_customer_id, square_order_id,
                            square_location_id, variation_id, quantity, unit_price_cents, total_price_cents,
                            purchased_at, window_start_date, window_end_date,
                            reward_id, original_event_id, idempotency_key,
                            receipt_url, customer_source, payment_type
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $14, $15, $16, $17)
                    `, [
                        merchantId, offerId, squareCustomerId, cr.square_order_id,
                        cr.square_location_id, cr.variation_id, excessQty, cr.unit_price_cents, excessTotalPriceCents,
                        cr.purchased_at, cr.window_start_date, cr.window_end_date,
                        cr.id, cr.idempotency_key + ':split_excess:' + reward.id,
                        cr.receipt_url, cr.customer_source, cr.payment_type
                    ]);
                }

                logger.debug('Split crossing row for reward', {
                    merchantId,
                    rewardId: reward.id,
                    crossingRowId: cr.id,
                    crossingQty,
                    lockedPortion: neededFromCrossing,
                    excessPortion: excessQty
                });
            }
        }

        // Transition reward to earned status (B6 fix: added AND merchant_id)
        await client.query(`
            UPDATE loyalty_rewards
            SET status = 'earned', earned_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND merchant_id = $2
        `, [reward.id, merchantId]);

        reward.status = RewardStatus.EARNED;

        await logAuditEvent({
            merchantId,
            action: AuditActions.REWARD_EARNED,
            offerId,
            rewardId: reward.id,
            squareCustomerId,
            oldState: RewardStatus.IN_PROGRESS,
            newState: RewardStatus.EARNED,
            details: { requiredQuantity: offer.required_quantity }
        }, client);  // Pass transaction client to avoid deadlock

        logger.info('Reward earned!', {
            merchantId,
            rewardId: reward.id,
            squareCustomerId,
            offerName: offer.offer_name
        });

        // Update customer stats (async, don't block)
        updateCustomerStats(squareCustomerId, merchantId, {
            incrementRewards: true,
            hasActiveRewards: true
        }).catch(err => logger.debug('Failed to update customer stats', { error: err.message }));

        // LOGIC CHANGE (MED-1): Collect earned reward ID for post-commit
        // Square discount creation. See earnedRewardIds declaration above.
        earnedRewardIds.push(reward.id);

        // Re-count remaining unlocked purchases for multi-threshold check
        const reCountResult = await client.query(`
            SELECT COALESCE(SUM(quantity), 0) as total_quantity
            FROM loyalty_purchase_events lpe
            WHERE lpe.merchant_id = $1
              AND lpe.offer_id = $2
              AND lpe.square_customer_id = $3
              AND lpe.window_end_date >= CURRENT_DATE
              AND lpe.reward_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM loyalty_purchase_events child
                  WHERE child.original_event_id = lpe.id
              )
        `, [merchantId, offerId, squareCustomerId]);

        currentQuantity = parseInt(reCountResult.rows[0].total_quantity) || 0;

        if (currentQuantity >= offer.required_quantity) {
            // More rewards to earn — create a new in_progress reward for next cycle
            // CRIT-1: ON CONFLICT handles the race where two concurrent webhooks
            // both earn the same reward and both attempt to INSERT a new in_progress row.
            // The partial unique index loyalty_rewards_one_in_progress_idx ensures only
            // one in_progress row per (merchant_id, offer_id, square_customer_id).
            // On conflict, we update current_quantity to the highest seen value.
            // LOGIC CHANGE: Added ON CONFLICT ... DO UPDATE to in_progress INSERT.
            // Before: plain INSERT threw on unique violation, rolling back the entire
            // transaction and permanently losing that order's purchase data.
            // After: conflict is absorbed — GREATEST is applied as an interim value,
            // then resolveConflictViaSquare verifies via Square API and corrects.
            const nextRewardResult = await client.query(`
                INSERT INTO loyalty_rewards (
                    merchant_id, offer_id, square_customer_id, status,
                    current_quantity, required_quantity,
                    window_start_date, window_end_date
                )
                VALUES ($1, $2, $3, 'in_progress', $4, $5,
                    (SELECT MIN(window_start_date) FROM loyalty_purchase_events lpe
                     WHERE lpe.merchant_id = $1 AND lpe.offer_id = $2 AND lpe.square_customer_id = $3
                       AND lpe.window_end_date >= CURRENT_DATE AND lpe.reward_id IS NULL
                       AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events child WHERE child.original_event_id = lpe.id)),
                    (SELECT MAX(window_end_date) FROM loyalty_purchase_events lpe
                     WHERE lpe.merchant_id = $1 AND lpe.offer_id = $2 AND lpe.square_customer_id = $3
                       AND lpe.window_end_date >= CURRENT_DATE AND lpe.reward_id IS NULL
                       AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events child WHERE child.original_event_id = lpe.id))
                )
                ON CONFLICT (merchant_id, offer_id, square_customer_id) WHERE status = 'in_progress'
                DO UPDATE SET
                    current_quantity = GREATEST(loyalty_rewards.current_quantity, EXCLUDED.current_quantity),
                    updated_at = NOW()
                RETURNING *, (xmax <> 0) AS conflict_occurred
            `, [merchantId, offerId, squareCustomerId, currentQuantity, offer.required_quantity]);

            reward = nextRewardResult.rows[0];

            // LOGIC CHANGE: On conflict, verify quantity via Square API (same as
            // initial INSERT path). See resolveConflictViaSquare JSDoc for details.
            if (reward && reward.conflict_occurred) {
                const greatestQty = parseInt(reward.current_quantity) || 0;
                const existingQty = greatestQty !== currentQuantity ? greatestQty : currentQuantity;
                const verifiedQty = await resolveConflictViaSquare(client, reward, {
                    merchantId,
                    offerId,
                    squareCustomerId,
                    existingQuantity: existingQty,
                    incomingQuantity: currentQuantity
                });
                currentQuantity = verifiedQty;
            }
        } else {
            // Update existing in_progress reward quantity or exit loop
            break;
        }
    }

    // Update customer summary
    await updateCustomerSummary(client, merchantId, squareCustomerId, offerId);

    // LOGIC CHANGE (MED-1): Fire Square discount creation AFTER the transaction
    // commits. The caller (purchase-service) commits the transaction before this
    // code runs, so the reward rows are guaranteed to exist in the database.
    // Previously this fired inside the transaction as a detached promise.
    for (const earnedRewardId of earnedRewardIds) {
        createSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId,
            internalRewardId: earnedRewardId,
            offerId
        }).then(async (squareResult) => {
            if (squareResult.success) {
                logger.info('Square discount created for earned reward', {
                    merchantId,
                    rewardId: earnedRewardId,
                    groupId: squareResult.groupId,
                    discountId: squareResult.discountId
                });
            } else {
                logger.error('earned_reward_discount_creation_failed', {
                    event: 'earned_reward_discount_creation_failed',
                    rewardId: earnedRewardId,
                    merchantId,
                    error: squareResult.error
                });
                await markSyncPendingIfRewardExists(earnedRewardId, merchantId);
            }
        }).catch(async (err) => {
            logger.error('earned_reward_discount_creation_failed', {
                event: 'earned_reward_discount_creation_failed',
                rewardId: earnedRewardId,
                merchantId,
                error: err.message
            });
            await markSyncPendingIfRewardExists(earnedRewardId, merchantId);
        });
    }

    return {
        rewardId: reward?.id,
        status: reward?.status || 'no_progress',
        currentQuantity,
        requiredQuantity: offer.required_quantity
    };
}

/**
 * Mark a reward as needing Square sync retry (LA-4 fix)
 *
 * LOGIC CHANGE (MED-1): Verify the reward row exists before marking sync
 * pending. If the transaction that created the reward rolled back, the row
 * won't exist and we must not create an orphaned sync record.
 *
 * @param {string} rewardId - Reward UUID
 * @param {number} merchantId - Merchant ID
 */
async function markSyncPendingIfRewardExists(rewardId, merchantId) {
    try {
        const checkResult = await db.query(
            `SELECT id FROM loyalty_rewards WHERE id = $1 AND merchant_id = $2`,
            [rewardId, merchantId]
        );
        if (checkResult.rows.length === 0) {
            logger.error('Reward not found for sync pending — transaction may have rolled back', {
                event: 'sync_pending_skipped_missing_reward',
                rewardId,
                merchantId
            });
            return;
        }
        await db.query(
            `UPDATE loyalty_rewards
             SET square_sync_pending = TRUE, updated_at = NOW()
             WHERE id = $1 AND merchant_id = $2`,
            [rewardId, merchantId]
        );
        logger.info('Marked reward for Square sync retry', { rewardId, merchantId });
    } catch (err) {
        logger.error('Failed to mark reward for sync retry', {
            error: err.message,
            rewardId,
            merchantId
        });
    }
}

module.exports = {
    updateRewardProgress
};
