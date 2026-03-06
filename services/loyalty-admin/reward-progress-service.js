/**
 * Reward Progress Service
 *
 * Manages the loyalty reward state machine: tracks qualifying purchase
 * quantities, creates in_progress rewards, transitions to earned status
 * via the split-row locking algorithm, and handles multi-threshold rollover.
 *
 * Extracted from purchase-service.js as part of file-size compliance split.
 */

const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { RewardStatus, AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { updateCustomerStats } = require('./customer-cache-service');
const { createSquareCustomerGroupDiscount } = require('./square-discount-service');
const { updateCustomerSummary } = require('./customer-summary-service');

/**
 * Update reward progress for a customer+offer after a purchase or refund
 * Implements the rolling window logic and state machine
 *
 * @param {Object} client - Database client (for transaction)
 * @param {Object} data - Update data
 */
async function updateRewardProgress(client, data) {
    const { merchantId, offerId, squareCustomerId, offer } = data;

    // Calculate current qualifying quantity within the rolling window
    // Only count purchases that haven't been locked into an earned reward
    // and are still within their window.
    // Exclude rows that have been superseded by split records (rows whose
    // original_event_id children exist) to prevent double-counting.
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
        const windowResult = await client.query(`
            SELECT MIN(window_start_date) as start_date, MAX(window_end_date) as end_date
            FROM loyalty_purchase_events
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE AND reward_id IS NULL
        `, [merchantId, offerId, squareCustomerId]);

        const windowRow = windowResult.rows[0] || {};
        const { start_date, end_date } = windowRow;

        const newRewardResult = await client.query(`
            INSERT INTO loyalty_rewards (
                merchant_id, offer_id, square_customer_id, status,
                current_quantity, required_quantity,
                window_start_date, window_end_date
            )
            VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7)
            RETURNING *
        `, [
            merchantId, offerId, squareCustomerId,
            currentQuantity, offer.required_quantity,
            start_date, end_date
        ]);

        reward = newRewardResult.rows[0];
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

        // Create Square Customer Group Discount ASYNCHRONOUSLY (fire and forget)
        const earnedRewardId = reward.id;
        createSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId,
            internalRewardId: earnedRewardId,
            offerId
        }).then(squareResult => {
            if (squareResult.success) {
                logger.info('Square discount created for earned reward', {
                    merchantId,
                    rewardId: earnedRewardId,
                    groupId: squareResult.groupId,
                    discountId: squareResult.discountId
                });
            } else {
                logger.warn('Could not create Square discount - manual sync required', {
                    merchantId,
                    rewardId: earnedRewardId,
                    reason: squareResult.error
                });
            }
        }).catch(err => {
            logger.error('Error creating Square discount - manual sync required', {
                error: err.message,
                merchantId,
                rewardId: earnedRewardId
            });
        });

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
                RETURNING *
            `, [merchantId, offerId, squareCustomerId, currentQuantity, offer.required_quantity]);

            reward = nextRewardResult.rows[0];
        } else {
            // Update existing in_progress reward quantity or exit loop
            break;
        }
    }

    // Update customer summary
    await updateCustomerSummary(client, merchantId, squareCustomerId, offerId);

    return {
        rewardId: reward?.id,
        status: reward?.status || 'no_progress',
        currentQuantity,
        requiredQuantity: offer.required_quantity
    };
}

module.exports = {
    updateRewardProgress
};
