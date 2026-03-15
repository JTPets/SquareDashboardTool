/**
 * Reward Progress Service
 *
 * Manages the loyalty reward state machine: tracks qualifying purchase
 * quantities, creates in_progress rewards, transitions to earned status
 * via the split-row locking algorithm, and handles multi-threshold rollover.
 *
 * Extracted from purchase-service.js as part of file-size compliance split.
 * Split-row CTE locking, reward earning transition, and multi-threshold
 * rollover logic further extracted to reward-split-service.js.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { updateCustomerSummary } = require('./customer-summary-service');
const { processThresholdCrossing } = require('./reward-split-service');

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

    // Serialize concurrent reward progress updates for the same customer+offer.
    // Advisory lock replaces FOR UPDATE on the aggregate query below, which is
    // incompatible with SUM/COALESCE ("FOR UPDATE is not allowed with aggregate
    // functions"). The lock achieves the same race-condition protection: only one
    // transaction can process the same customer+offer at a time. The lock
    // auto-releases when the transaction commits or rolls back.  (CRIT-2 fix)
    const lockKey = Buffer.from(`${merchantId}:${offerId}:${squareCustomerId}`).reduce(
        (hash, byte) => ((hash << 5) - hash + byte) | 0, 0
    );
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Calculate current qualifying quantity within the rolling window
    // Only count purchases that haven't been locked into an earned reward
    // and are still within their window.
    // Exclude rows that have been superseded by split records (rows whose
    // original_event_id children exist) to prevent double-counting.
    // Race-condition protection for this aggregate query is handled by the
    // pg_advisory_xact_lock above (CRIT-2 fix). FOR UPDATE cannot be used
    // with aggregate functions (SUM/COALESCE).
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

    // Threshold crossing: lock purchases, split crossing rows, earn rewards,
    // handle multi-threshold rollover. Extracted to reward-split-service.js.
    const thresholdResult = await processThresholdCrossing(client, {
        reward, offer, merchantId, offerId, squareCustomerId, currentQuantity,
        resolveConflictFn: resolveConflictViaSquare
    });

    const earnedRewardIds = thresholdResult.earnedRewardIds;
    currentQuantity = thresholdResult.currentQuantity;
    reward = thresholdResult.reward;

    // Update customer summary
    await updateCustomerSummary(client, merchantId, squareCustomerId, offerId);

    // Return earnedRewardIds so the caller (purchase-service.js) can fire
    // Square discount creation AFTER the transaction commits (MED-1).
    return {
        rewardId: reward?.id,
        status: reward?.status || 'no_progress',
        currentQuantity,
        requiredQuantity: offer.required_quantity,
        earnedRewardIds
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
        // LOGIC CHANGE (LOW-7): Log at error level with full details.
        // Before: catch block swallowed silently with no logging.
        // After: logs error with rewardId and stack for debugging.
        // Do NOT re-throw — the sync retry job will catch unsynced rewards.
        logger.error('Failed to mark reward for sync retry', {
            event: 'sync_pending_mark_failed',
            error: err.message,
            stack: err.stack,
            rewardId,
            merchantId
        });
    }
}

module.exports = {
    updateRewardProgress,
    markSyncPendingIfRewardExists
};
