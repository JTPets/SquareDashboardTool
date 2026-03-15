/**
 * Reward Split Service
 *
 * Pure threshold/split logic extracted from reward-progress-service.js.
 * Handles the split-row CTE locking algorithm, reward earning transitions,
 * and multi-threshold rollover when purchase quantity exceeds required_quantity.
 *
 * processThresholdCrossing() is called by updateRewardProgress() when
 * currentQuantity >= offer.required_quantity.
 *
 * Key algorithms:
 * - CTE lock: UPDATE ... FROM ranked_purchases WHERE cumulative_qty <= required
 * - Crossing row: FOR UPDATE SKIP LOCKED on the boundary row, split into
 *   locked child (toward this reward) + excess child (rollover)
 * - Multi-threshold while loop: earns multiple rewards when qty >> required
 * - New in_progress reward creation with ON CONFLICT for concurrency safety
 */

const logger = require('../../utils/logger');
const { RewardStatus, AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { updateCustomerStats } = require('./customer-cache-service');

/**
 * Process threshold crossing: lock purchases via split-row CTE, transition
 * reward to earned, and handle multi-threshold rollover.
 *
 * Loops while currentQuantity >= required_quantity, earning one reward per
 * iteration. Creates a new in_progress reward for the next cycle when
 * rollover units remain.
 *
 * @param {Object} client - Database transaction client
 * @param {Object} params
 * @param {Object} params.reward - Current in_progress reward row
 * @param {Object} params.offer - Offer with required_quantity, offer_name
 * @param {number} params.merchantId
 * @param {string|number} params.offerId
 * @param {string} params.squareCustomerId
 * @param {number} params.currentQuantity - Current unlocked quantity
 * @param {Function} params.resolveConflictFn - resolveConflictViaSquare callback
 * @returns {Promise<{ earnedRewardIds: string[], reward: Object, currentQuantity: number }>}
 */
async function processThresholdCrossing(client, {
    reward, offer, merchantId, offerId, squareCustomerId,
    currentQuantity, resolveConflictFn
}) {
    const earnedRewardIds = [];

    while (reward && currentQuantity >= offer.required_quantity && reward.status === 'in_progress') {
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
            // selecting and splitting the same crossing row.
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

        // Transition reward to earned status
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
        }, client);

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

        // Collect earned reward ID for post-commit Square discount creation (MED-1)
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

            // On conflict, verify quantity via Square API (same as initial INSERT path)
            if (reward && reward.conflict_occurred && resolveConflictFn) {
                const greatestQty = parseInt(reward.current_quantity) || 0;
                const existingQty = greatestQty !== currentQuantity ? greatestQty : currentQuantity;
                const verifiedQty = await resolveConflictFn(client, reward, {
                    merchantId,
                    offerId,
                    squareCustomerId,
                    existingQuantity: existingQty,
                    incomingQuantity: currentQuantity
                });
                currentQuantity = verifiedQty;
            }
        } else {
            break;
        }
    }

    return { earnedRewardIds, reward, currentQuantity };
}

module.exports = { processThresholdCrossing };
