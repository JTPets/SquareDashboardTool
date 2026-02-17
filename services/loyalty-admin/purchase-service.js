/**
 * Loyalty Purchase Service
 *
 * Handles purchase and refund processing for loyalty program:
 * - processQualifyingPurchase: Record qualifying purchases from orders
 * - processRefund: Handle refunds that affect loyalty tracking
 * - updateRewardProgress: Update reward state after purchases/refunds
 * - updateCustomerSummary: Maintain denormalized customer stats
 *
 * Extracted from loyalty-service.js as part of final P1-1 monolith elimination.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Direct sibling imports (not through index.js)
const { RewardStatus, AuditActions } = require('./constants');
const { logAuditEvent } = require('./audit-service');
const { getOfferForVariation } = require('./variation-admin-service');
const { updateCustomerStats } = require('./customer-cache-service');
const { createSquareCustomerGroupDiscount } = require('./square-discount-service');

// ============================================================================
// CUSTOMER SUMMARY MANAGEMENT
// ============================================================================

/**
 * Update the denormalized customer summary
 * Called after any purchase, refund, or redemption
 *
 * @param {Object} client - Database client (for transaction)
 * @param {number} merchantId - Merchant ID
 * @param {string} squareCustomerId - Square customer ID
 * @param {number} offerId - Offer ID
 */
async function updateCustomerSummary(client, merchantId, squareCustomerId, offerId) {
    // Get current stats — exclude superseded parent rows (rows that have
    // been split into locked + excess children via original_event_id)
    const stats = await client.query(`
        SELECT
            COALESCE(SUM(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events child WHERE child.original_event_id = pe.id)
                THEN pe.quantity ELSE 0 END), 0) as current_quantity,
            COALESCE(SUM(CASE WHEN pe.quantity > 0
                AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events child WHERE child.original_event_id = pe.id)
                THEN pe.quantity ELSE 0 END), 0) as lifetime_purchases,
            MAX(pe.purchased_at) as last_purchase,
            MIN(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events child WHERE child.original_event_id = pe.id)
                THEN pe.window_start_date END) as window_start,
            MAX(CASE WHEN pe.window_end_date >= CURRENT_DATE AND pe.reward_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events child WHERE child.original_event_id = pe.id)
                THEN pe.window_end_date END) as window_end
        FROM loyalty_purchase_events pe
        WHERE pe.merchant_id = $1
          AND pe.offer_id = $2
          AND pe.square_customer_id = $3
    `, [merchantId, offerId, squareCustomerId]);

    const earnedRewards = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'earned'
    `, [merchantId, offerId, squareCustomerId]);

    const redeemedRewards = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'redeemed'
    `, [merchantId, offerId, squareCustomerId]);

    const totalEarned = await client.query(`
        SELECT COUNT(*) as count FROM loyalty_rewards
        WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
          AND status IN ('earned', 'redeemed')
    `, [merchantId, offerId, squareCustomerId]);

    const offer = await client.query(`
        SELECT required_quantity FROM loyalty_offers WHERE id = $1
    `, [offerId]);

    const s = stats.rows[0];
    const hasEarned = parseInt(earnedRewards.rows[0]?.count || 0) > 0;

    // Get the earned reward ID if exists
    let earnedRewardId = null;
    if (hasEarned) {
        const earnedResult = await client.query(`
            SELECT id FROM loyalty_rewards
            WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3 AND status = 'earned'
            ORDER BY earned_at ASC LIMIT 1
        `, [merchantId, offerId, squareCustomerId]);
        earnedRewardId = earnedResult.rows[0]?.id;
    }

    await client.query(`
        INSERT INTO loyalty_customer_summary (
            merchant_id, square_customer_id, offer_id,
            current_quantity, required_quantity,
            window_start_date, window_end_date,
            has_earned_reward, earned_reward_id,
            total_lifetime_purchases, total_rewards_earned, total_rewards_redeemed,
            last_purchase_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (merchant_id, square_customer_id, offer_id) DO UPDATE SET
            current_quantity = EXCLUDED.current_quantity,
            window_start_date = EXCLUDED.window_start_date,
            window_end_date = EXCLUDED.window_end_date,
            has_earned_reward = EXCLUDED.has_earned_reward,
            earned_reward_id = EXCLUDED.earned_reward_id,
            total_lifetime_purchases = EXCLUDED.total_lifetime_purchases,
            total_rewards_earned = EXCLUDED.total_rewards_earned,
            total_rewards_redeemed = EXCLUDED.total_rewards_redeemed,
            last_purchase_at = EXCLUDED.last_purchase_at,
            updated_at = NOW()
    `, [
        merchantId, squareCustomerId, offerId,
        parseInt(s.current_quantity) || 0,
        offer.rows[0]?.required_quantity || 0,
        s.window_start, s.window_end,
        hasEarned, earnedRewardId,
        parseInt(s.lifetime_purchases) || 0,
        parseInt(totalEarned.rows[0]?.count || 0),
        parseInt(redeemedRewards.rows[0]?.count || 0),
        s.last_purchase
    ]);
}

// ============================================================================
// REWARD PROGRESS MANAGEMENT
// ============================================================================

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
        // Update existing reward
        const oldQuantity = reward.current_quantity;

        await client.query(`
            UPDATE loyalty_rewards
            SET current_quantity = $1, updated_at = NOW()
            WHERE id = $2
        `, [currentQuantity, reward.id]);

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
                SELECT id, quantity, square_order_id, variation_id, unit_price_cents,
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
                await client.query(`
                    INSERT INTO loyalty_purchase_events (
                        merchant_id, offer_id, square_customer_id, square_order_id,
                        square_location_id, variation_id, quantity, unit_price_cents,
                        purchased_at, window_start_date, window_end_date,
                        reward_id, original_event_id, idempotency_key,
                        receipt_url, customer_source, payment_type
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                `, [
                    merchantId, offerId, squareCustomerId, cr.square_order_id,
                    cr.square_location_id, cr.variation_id, neededFromCrossing, cr.unit_price_cents,
                    cr.purchased_at, cr.window_start_date, cr.window_end_date,
                    reward.id, cr.id, cr.idempotency_key + ':split_locked:' + reward.id,
                    cr.receipt_url, cr.customer_source, cr.payment_type
                ]);

                // Create unlocked excess child (rollover for next cycle)
                if (excessQty > 0) {
                    await client.query(`
                        INSERT INTO loyalty_purchase_events (
                            merchant_id, offer_id, square_customer_id, square_order_id,
                            square_location_id, variation_id, quantity, unit_price_cents,
                            purchased_at, window_start_date, window_end_date,
                            reward_id, original_event_id, idempotency_key,
                            receipt_url, customer_source, payment_type
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13, $14, $15, $16)
                    `, [
                        merchantId, offerId, squareCustomerId, cr.square_order_id,
                        cr.square_location_id, cr.variation_id, excessQty, cr.unit_price_cents,
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
            WHERE id = $1
        `, [reward.id]);

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

// ============================================================================
// PURCHASE PROCESSING
// ============================================================================

/**
 * Process a qualifying purchase from an order
 * This is the main entry point for recording purchases from webhooks
 *
 * BUSINESS RULES:
 * - Only explicitly configured variations qualify
 * - Never mix sizes within an offer
 * - Rolling window from first qualifying purchase
 * - Purchases outside window drop off automatically
 *
 * @param {Object} purchaseData - Purchase details
 * @param {number} purchaseData.merchantId - REQUIRED: Merchant ID
 * @param {string} purchaseData.squareOrderId - Square order ID
 * @param {string} purchaseData.squareCustomerId - Square customer ID
 * @param {string} purchaseData.variationId - Square variation ID
 * @param {number} purchaseData.quantity - Quantity purchased
 * @param {number} [purchaseData.unitPriceCents] - Unit price for audit
 * @param {Date} purchaseData.purchasedAt - Purchase timestamp
 * @param {string} [purchaseData.squareLocationId] - Square location ID
 * @param {string} [purchaseData.receiptUrl] - Square receipt URL from tender
 * @param {string} [purchaseData.customerSource] - How customer was identified: order, tender, loyalty_api, or manual
 * @param {string} [purchaseData.paymentType] - Payment method: CARD, CASH, WALLET, etc.
 * @returns {Promise<Object>} Processing result
 */
async function processQualifyingPurchase(purchaseData) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, purchasedAt, squareLocationId, receiptUrl,
        customerSource = 'order', paymentType = null
    } = purchaseData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    if (!squareCustomerId) {
        logger.debug('Skipping loyalty processing - no customer ID', { squareOrderId });
        return { processed: false, reason: 'no_customer' };
    }

    // Check if variation qualifies for any offer (tenant-scoped)
    const offer = await getOfferForVariation(variationId, merchantId);
    if (!offer) {
        logger.debug('Variation does not qualify for any offer', { variationId, merchantId });
        return { processed: false, reason: 'variation_not_qualifying' };
    }

    // Generate idempotency key to prevent duplicate processing
    const idempotencyKey = `${squareOrderId}:${variationId}:${quantity}`;

    // Check for existing event (idempotency)
    const existingEvent = await db.query(`
        SELECT id FROM loyalty_purchase_events
        WHERE merchant_id = $1 AND idempotency_key = $2
    `, [merchantId, idempotencyKey]);

    if (existingEvent.rows.length > 0) {
        logger.debug('Purchase event already processed (idempotent)', { idempotencyKey });
        return { processed: false, reason: 'already_processed' };
    }

    logger.info('Processing qualifying purchase', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity,
        offerId: offer.id,
        offerName: offer.offer_name
    });

    // Begin transaction for consistency
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Calculate window dates
        const purchaseDate = new Date(purchasedAt);
        const windowEndDate = new Date(purchaseDate);
        windowEndDate.setMonth(windowEndDate.getMonth() + offer.window_months);

        // Get or determine window start date for this customer+offer
        const existingPurchases = await client.query(`
            SELECT MIN(purchased_at) as first_purchase
            FROM loyalty_purchase_events
            WHERE merchant_id = $1
              AND offer_id = $2
              AND square_customer_id = $3
              AND window_end_date >= CURRENT_DATE
              AND quantity > 0
        `, [merchantId, offer.id, squareCustomerId]);

        let windowStartDate = purchaseDate;
        if (existingPurchases.rows[0]?.first_purchase) {
            windowStartDate = new Date(existingPurchases.rows[0].first_purchase);
        }

        // Record the purchase event
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, idempotency_key, receipt_url, customer_source, payment_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, quantity, unitPriceCents,
            purchasedAt, windowStartDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0],
            false, idempotencyKey, receiptUrl || null, customerSource, paymentType
        ]);

        const purchaseEvent = eventResult.rows[0];
        if (!purchaseEvent) {
            throw new Error('Failed to insert purchase event - no row returned');
        }

        await logAuditEvent({
            merchantId,
            action: AuditActions.PURCHASE_RECORDED,
            offerId: offer.id,
            purchaseEventId: purchaseEvent.id,
            squareCustomerId,
            squareOrderId,
            newQuantity: quantity,
            triggeredBy: 'WEBHOOK',
            details: { variationId, unitPriceCents }
        }, client);  // Pass transaction client to avoid deadlock

        // Update reward progress
        const rewardResult = await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        await client.query('COMMIT');

        logger.info('Purchase processed successfully', {
            merchantId,
            purchaseEventId: purchaseEvent.id,
            rewardStatus: rewardResult.status,
            currentQuantity: rewardResult.currentQuantity
        });

        return {
            processed: true,
            purchaseEvent,
            reward: rewardResult
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to process qualifying purchase', {
            error: error.message,
            stack: error.stack,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// REFUND PROCESSING
// ============================================================================

/**
 * Process a refund that affects loyalty purchases
 * BUSINESS RULE: Refunds ALWAYS adjust quantities immediately
 * If a refund causes an earned reward to become invalid, the reward is REVOKED
 *
 * @param {Object} refundData - Refund details
 */
async function processRefund(refundData) {
    const {
        merchantId, squareOrderId, squareCustomerId, variationId,
        quantity, unitPriceCents, refundedAt, squareLocationId, originalEventId
    } = refundData;

    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    // Check if variation qualifies for any offer
    const offer = await getOfferForVariation(variationId, merchantId);
    if (!offer) {
        return { processed: false, reason: 'variation_not_qualifying' };
    }

    const refundQuantity = Math.abs(quantity) * -1;  // Ensure negative
    const idempotencyKey = `refund:${squareOrderId}:${variationId}:${quantity}:${Date.now()}`;

    logger.info('Processing loyalty refund', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        refundQuantity,
        offerId: offer.id
    });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Calculate window dates based on original purchase
        const refundDate = new Date(refundedAt || Date.now());
        const windowEndDate = new Date(refundDate);
        windowEndDate.setMonth(windowEndDate.getMonth() + offer.window_months);

        // Record the refund event
        const eventResult = await client.query(`
            INSERT INTO loyalty_purchase_events (
                merchant_id, offer_id, square_customer_id, square_order_id,
                square_location_id, variation_id, quantity, unit_price_cents,
                purchased_at, window_start_date, window_end_date,
                is_refund, original_event_id, idempotency_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $13)
            RETURNING *
        `, [
            merchantId, offer.id, squareCustomerId, squareOrderId,
            squareLocationId, variationId, refundQuantity, unitPriceCents,
            refundedAt || new Date(), refundDate.toISOString().split('T')[0],
            windowEndDate.toISOString().split('T')[0], originalEventId, idempotencyKey
        ]);

        const refundEvent = eventResult.rows[0];

        await logAuditEvent({
            merchantId,
            action: AuditActions.REFUND_PROCESSED,
            offerId: offer.id,
            purchaseEventId: refundEvent.id,
            squareCustomerId,
            squareOrderId,
            newQuantity: refundQuantity,
            triggeredBy: 'WEBHOOK',
            details: { variationId, originalEventId }
        }, client);  // Pass transaction client to avoid deadlock

        // Check if this refund affects an earned reward
        const earnedReward = await client.query(`
            SELECT r.*
            FROM loyalty_rewards r
            WHERE r.merchant_id = $1
              AND r.offer_id = $2
              AND r.square_customer_id = $3
              AND r.status = 'earned'
            FOR UPDATE
        `, [merchantId, offer.id, squareCustomerId]);

        if (earnedReward.rows.length > 0) {
            const reward = earnedReward.rows[0];

            // Calculate remaining locked purchases after refund
            const lockedQuantity = await client.query(`
                SELECT COALESCE(SUM(quantity), 0) as total
                FROM loyalty_purchase_events
                WHERE reward_id = $1
            `, [reward.id]);

            const remainingQuantity = parseInt(lockedQuantity.rows[0].total) || 0;

            // If refund causes reward to be invalid, revoke it
            if (remainingQuantity < offer.required_quantity) {
                await client.query(`
                    UPDATE loyalty_rewards
                    SET status = 'revoked',
                        revoked_at = NOW(),
                        revocation_reason = 'Refund reduced qualifying quantity below threshold',
                        updated_at = NOW()
                    WHERE id = $1
                `, [reward.id]);

                // Unlock the purchase events
                await client.query(`
                    UPDATE loyalty_purchase_events
                    SET reward_id = NULL, updated_at = NOW()
                    WHERE reward_id = $1
                `, [reward.id]);

                await logAuditEvent({
                    merchantId,
                    action: AuditActions.REWARD_REVOKED,
                    offerId: offer.id,
                    rewardId: reward.id,
                    squareCustomerId,
                    oldState: RewardStatus.EARNED,
                    newState: RewardStatus.REVOKED,
                    details: {
                        reason: 'refund',
                        remainingQuantity,
                        requiredQuantity: offer.required_quantity
                    }
                }, client);  // Pass transaction client to avoid deadlock

                logger.warn('Earned reward revoked due to refund', {
                    merchantId,
                    rewardId: reward.id,
                    squareCustomerId,
                    remainingQuantity,
                    requiredQuantity: offer.required_quantity
                });

                // Update customer summary after revocation to keep it in sync
                await updateCustomerSummary(client, merchantId, squareCustomerId, offer.id);
            }
        }

        // Update reward progress for any in-progress reward
        await updateRewardProgress(client, {
            merchantId,
            offerId: offer.id,
            squareCustomerId,
            offer
        });

        await client.query('COMMIT');

        return {
            processed: true,
            refundEvent,
            rewardAffected: earnedReward.rows.length > 0
        };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Failed to process refund', {
            error: error.message,
            merchantId,
            squareOrderId
        });
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Customer summary (shared with reward-service.js)
    updateCustomerSummary,

    // Reward progress (used by expiration-service.js)
    updateRewardProgress,

    // Purchase processing
    processQualifyingPurchase,
    processRefund
};
