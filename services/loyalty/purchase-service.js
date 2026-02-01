/**
 * Loyalty Purchase Service
 *
 * Handles recording qualifying purchases and updating reward progress:
 * - Record purchases for qualifying variations
 * - Update customer progress toward rewards
 * - Handle idempotency for duplicate orders
 * - Track rolling window calculations
 */

const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');

/**
 * LoyaltyPurchaseService - Records purchases and tracks progress
 */
class LoyaltyPurchaseService {
  /**
   * @param {number} merchantId - Internal merchant ID
   * @param {Object} [tracer] - Optional tracer instance for correlation
   */
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
  }

  /**
   * Record a qualifying purchase
   * @param {Object} purchaseData - Purchase data
   * @param {string} purchaseData.squareOrderId - Square order ID
   * @param {string} purchaseData.squareCustomerId - Square customer ID
   * @param {string} purchaseData.variationId - Catalog variation ID
   * @param {number} purchaseData.quantity - Quantity purchased
   * @param {number} purchaseData.unitPriceCents - Unit price in cents
   * @param {number} [purchaseData.totalPriceCents] - Total price in cents
   * @param {string} purchaseData.purchasedAt - Purchase timestamp
   * @param {string} [purchaseData.traceId] - Correlation trace ID
   * @param {Object} [purchaseData.redemptionContext] - Context if this is a redemption order
   * @param {string} [purchaseData.redemptionContext.rewardId] - ID of reward being redeemed
   * @param {string} [purchaseData.redemptionContext.offerId] - Offer ID of the reward
   * @param {boolean} [purchaseData.redemptionContext.isRedemptionOrder] - True if redemption order
   * @returns {Promise<Object>} Result with purchase details
   */
  async recordPurchase(purchaseData) {
    const {
      squareOrderId,
      squareCustomerId,
      variationId,
      quantity,
      unitPriceCents,
      totalPriceCents = unitPriceCents * quantity,
      purchasedAt,
      traceId,
      redemptionContext = null,  // BUG FIX: Accept redemption context
    } = purchaseData;

    // Get offers for this variation
    const offersResult = await db.query(`
      SELECT
        lo.id as offer_id,
        lo.offer_name as offer_name,
        lo.required_quantity,
        lo.window_months
      FROM loyalty_offers lo
      INNER JOIN loyalty_qualifying_variations lqv ON lo.id = lqv.offer_id
      WHERE lo.merchant_id = $1
        AND lo.is_active = TRUE
        AND lqv.variation_id = $2
    `, [this.merchantId, variationId]);

    if (offersResult.rows.length === 0) {
      this.tracer?.span('PURCHASE_NO_OFFER', { variationId });
      loyaltyLogger.debug({
        action: 'PURCHASE_NO_QUALIFYING_OFFER',
        variationId,
        squareOrderId,
        merchantId: this.merchantId,
      });
      return {
        recorded: false,
        reason: 'no_qualifying_offer',
      };
    }

    const results = [];

    // Record purchase for each qualifying offer
    for (const offer of offersResult.rows) {
      const client = await db.getClient();

      try {
        await client.query('BEGIN');

        // Generate idempotency key: order + variation + offer
        const idempotencyKey = `${squareOrderId}:${variationId}:${offer.offer_id}`;

        // Get existing window dates for this customer+offer, or calculate new ones
        const existingWindowResult = await client.query(`
          SELECT
            MIN(window_start_date) as window_start,
            MIN(window_end_date) as window_end
          FROM loyalty_purchase_events
          WHERE merchant_id = $1
            AND offer_id = $2
            AND square_customer_id = $3
            AND reward_id IS NULL
            AND quantity > 0
        `, [this.merchantId, offer.offer_id, squareCustomerId]);

        let windowStartDate, windowEndDate;
        if (existingWindowResult.rows[0]?.window_start) {
          // Use existing window dates
          windowStartDate = existingWindowResult.rows[0].window_start;
          windowEndDate = existingWindowResult.rows[0].window_end;
        } else {
          // First purchase for this customer+offer - calculate new window
          const purchaseDate = new Date(purchasedAt);
          windowStartDate = purchaseDate.toISOString().split('T')[0]; // DATE format
          const endDate = new Date(purchaseDate);
          endDate.setMonth(endDate.getMonth() + (offer.window_months || 12));
          windowEndDate = endDate.toISOString().split('T')[0]; // DATE format
        }

        // Insert purchase event with atomic idempotency check using ON CONFLICT
        // This prevents race conditions where duplicate webhooks could insert twice
        const insertResult = await client.query(`
          INSERT INTO loyalty_purchase_events
            (merchant_id, offer_id, square_customer_id, square_order_id,
             variation_id, quantity, unit_price_cents, total_price_cents,
             purchased_at, trace_id, idempotency_key,
             window_start_date, window_end_date, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
          ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
          RETURNING id
        `, [
          this.merchantId,
          offer.offer_id,
          squareCustomerId,
          squareOrderId,
          variationId,
          quantity,
          unitPriceCents,
          totalPriceCents,
          purchasedAt,
          traceId,
          idempotencyKey,
          windowStartDate,
          windowEndDate,
        ]);

        // If no rows returned, this was a duplicate
        if (insertResult.rows.length === 0) {
          await client.query('COMMIT');
          client.release();

          this.tracer?.span('PURCHASE_DUPLICATE', { squareOrderId, variationId, offerId: offer.offer_id });
          loyaltyLogger.debug({
            action: 'PURCHASE_ALREADY_RECORDED',
            squareOrderId,
            variationId,
            offerId: offer.offer_id,
            idempotencyKey,
            merchantId: this.merchantId,
          });

          results.push({
            recorded: false,
            reason: 'duplicate',
            offerId: offer.offer_id,
            offerName: offer.offer_name,
          });
          continue;
        }

        const purchaseEventId = insertResult.rows[0].id;

        // Update reward progress
        // BUG FIX: Pass redemption context so we know if the old reward is about to be redeemed
        // Only applies if this offer matches the one being redeemed
        const isRedemptionForThisOffer = redemptionContext?.isRedemptionOrder &&
          redemptionContext.offerId === offer.offer_id;

        const progressResult = await this.updateRewardProgress(
          client,
          squareCustomerId,
          offer.offer_id,
          offer.required_quantity,
          offer.window_months,
          traceId,
          isRedemptionForThisOffer ? redemptionContext : null  // Only pass if relevant
        );

        await client.query('COMMIT');

        this.tracer?.span('PURCHASE_RECORDED', {
          purchaseEventId,
          offerId: offer.offer_id,
          newProgress: progressResult.currentProgress,
          rewardEarned: progressResult.rewardEarned,
        });

        loyaltyLogger.purchase({
          action: 'PURCHASE_RECORDED',
          purchaseEventId,
          squareOrderId,
          squareCustomerId,
          variationId,
          quantity,
          offerId: offer.offer_id,
          offerName: offer.offer_name,
          currentProgress: progressResult.currentProgress,
          requiredQuantity: offer.required_quantity,
          rewardEarned: progressResult.rewardEarned,
          merchantId: this.merchantId,
        });

        results.push({
          recorded: true,
          purchaseEventId,
          offerId: offer.offer_id,
          offerName: offer.offer_name,
          progress: progressResult,
        });

      } catch (error) {
        await client.query('ROLLBACK');
        loyaltyLogger.error({
          action: 'PURCHASE_RECORD_ERROR',
          squareOrderId,
          variationId,
          offerId: offer.offer_id,
          error: error.message,
          merchantId: this.merchantId,
        });
        throw error;
      } finally {
        client.release();
      }
    }

    // Check if any purchases were actually recorded (not all duplicates)
    const anyRecorded = results.some(r => r.recorded);

    return {
      recorded: anyRecorded,
      results,
    };
  }

  /**
   * Update reward progress for a customer on an offer
   * @private
   * @param {Object} client - Database client
   * @param {string} squareCustomerId - Square customer ID
   * @param {string} offerId - Offer ID
   * @param {number} requiredQuantity - Required quantity for reward
   * @param {number} windowMonths - Rolling window in months
   * @param {string} traceId - Trace ID for logging
   * @param {Object|null} redemptionContext - Context if this is a redemption order for this offer
   */
  async updateRewardProgress(client, squareCustomerId, offerId, requiredQuantity, windowMonths, traceId, redemptionContext = null) {
    // Get the window start date from the customer's first unlocked purchase (rolling window)
    // The window is anchored to the FIRST qualifying purchase, not the current date
    const windowResult = await client.query(`
      SELECT
        MIN(purchased_at) as window_start,
        MIN(purchased_at) + INTERVAL '1 month' * $4 as window_end
      FROM loyalty_purchase_events
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND reward_id IS NULL
        AND quantity > 0
    `, [this.merchantId, offerId, squareCustomerId, windowMonths || 12]);

    const windowStart = windowResult.rows[0]?.window_start;
    const windowEnd = windowResult.rows[0]?.window_end;

    // If no unlocked purchases exist, there's no progress yet (this purchase is the first)
    // Progress will be calculated on next call after this purchase is committed
    if (!windowStart) {
      return {
        currentProgress: 0,
        requiredQuantity,
        rewardEarned: false,
        windowMonths: windowMonths,
        windowStart: null,
        windowEnd: null,
      };
    }

    // Check if window has expired (current date is past window end)
    const now = new Date();
    if (windowEnd && now > new Date(windowEnd)) {
      // Window expired - need to expire old purchases and recalculate
      // For now, we'll still count all unlocked purchases and let the business decide
      loyaltyLogger.debug({
        action: 'WINDOW_EXPIRED_CHECK',
        squareCustomerId,
        offerId,
        windowStart,
        windowEnd,
        merchantId: this.merchantId,
      });
    }

    // Count all unlocked purchases within the valid window
    // Include negative quantities (refunds) to properly subtract from progress
    // Note: quantity can be positive (purchase) or negative (refund)
    //
    // BUG FIX: Exclude rows that have been "split" (have children with original_event_id
    // pointing to them). When a row crosses the threshold, we create split records and
    // the original should not be counted directly - only the splits should be counted.
    const progressResult = await client.query(`
      SELECT COALESCE(SUM(quantity), 0) as total_quantity
      FROM loyalty_purchase_events lpe
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND purchased_at >= $4
        AND purchased_at < $5
        AND reward_id IS NULL
        -- Exclude rows that have been superseded by split records
        AND NOT EXISTS (
          SELECT 1 FROM loyalty_purchase_events child
          WHERE child.original_event_id = lpe.id
        )
    `, [this.merchantId, offerId, squareCustomerId, windowStart, windowEnd]);

    const currentProgress = parseInt(progressResult.rows[0].total_quantity, 10) || 0;

    // Check if customer has earned a reward
    const rewardEarned = currentProgress >= requiredQuantity;

    if (rewardEarned) {
      // Create or update reward status
      // BUG FIX: Pass redemption context so we know if an existing earned reward
      // is about to be redeemed (don't skip creating a new one in that case)
      await this.createOrUpdateReward(
        client,
        squareCustomerId,
        offerId,
        currentProgress,
        requiredQuantity,
        traceId,
        redemptionContext
      );
    }

    return {
      currentProgress,
      requiredQuantity,
      rewardEarned,
      windowMonths: windowMonths,
      windowStart: windowStart,
      windowEnd: windowEnd,
    };
  }

  /**
   * Create or update reward when threshold is reached
   * Also handles locking purchases to the reward and rollover of excess purchases
   *
   * BUG FIX: Now accepts redemptionContext to handle the case where an earned
   * reward is being redeemed on this order. In that case, we should NOT skip
   * creating a new reward - the old reward is about to be consumed, so new
   * purchases should start a fresh reward cycle.
   *
   * @private
   * @param {Object} client - Database client
   * @param {string} squareCustomerId - Square customer ID
   * @param {string} offerId - Offer ID
   * @param {number} currentProgress - Current progress count
   * @param {number} requiredQuantity - Required quantity for reward
   * @param {string} traceId - Trace ID for logging
   * @param {Object|null} redemptionContext - Context if this is a redemption order
   */
  async createOrUpdateReward(client, squareCustomerId, offerId, currentProgress, requiredQuantity, traceId, redemptionContext = null) {
    // Get window dates from purchases for the reward record
    const windowDates = await client.query(`
      SELECT
        MIN(window_start_date) as window_start,
        MIN(window_end_date) as window_end
      FROM loyalty_purchase_events
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND reward_id IS NULL
        AND quantity > 0
    `, [this.merchantId, offerId, squareCustomerId]);

    const windowStart = windowDates.rows[0]?.window_start || new Date().toISOString().split('T')[0];
    const windowEnd = windowDates.rows[0]?.window_end || new Date().toISOString().split('T')[0];

    // Check for existing in_progress reward
    const existingResult = await client.query(`
      SELECT id, status FROM loyalty_rewards
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND status = 'in_progress'
      FOR UPDATE
    `, [this.merchantId, offerId, squareCustomerId]);

    let rewardId;

    if (existingResult.rows.length > 0) {
      // Update existing reward to earned
      rewardId = existingResult.rows[0].id;
      await client.query(`
        UPDATE loyalty_rewards
        SET status = 'earned',
            current_quantity = $1,
            earned_at = NOW(),
            updated_at = NOW()
        WHERE id = $2
      `, [requiredQuantity, rewardId]);

      this.tracer?.span('REWARD_EARNED', { rewardId });

      loyaltyLogger.reward({
        action: 'REWARD_EARNED',
        rewardId,
        offerId,
        squareCustomerId,
        progress: currentProgress,
        required: requiredQuantity,
        merchantId: this.merchantId,
      });
    } else {
      // Check if there's already an unredeemed earned reward
      const earnedCheck = await client.query(`
        SELECT id FROM loyalty_rewards
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND status = 'earned'
          AND redeemed_at IS NULL
      `, [this.merchantId, offerId, squareCustomerId]);

      if (earnedCheck.rows.length > 0) {
        const existingRewardId = earnedCheck.rows[0].id;

        // BUG FIX: Log when this is a redemption order - the early return is
        // correct (unique constraint prevents multiple rewards), but we need to
        // ensure new purchases on this order stay UNLOCKED (not linked to old reward).
        // The locking query won't run because we return early here.
        // New purchases will contribute to the next reward cycle after redemption.
        const isRedemptionForThisReward = redemptionContext?.isRedemptionOrder &&
          redemptionContext.rewardId === existingRewardId;

        if (isRedemptionForThisReward) {
          loyaltyLogger.debug({
            action: 'REDEMPTION_ORDER_EXISTING_REWARD',
            existingRewardId,
            offerId,
            squareCustomerId,
            message: 'Redemption order - returning early, new purchases stay unlocked for next cycle',
            merchantId: this.merchantId,
          });

          this.tracer?.span('REDEMPTION_EXISTING_REWARD', {
            existingRewardId,
            isRedemptionOrder: true,
            newPurchasesStayUnlocked: true,
          });
        }

        // Return early - unique constraint prevents multiple rewards.
        // New purchases remain unlocked (reward_id = NULL) and will
        // contribute to the next reward after this one is redeemed.
        return existingRewardId;
      }

      // Create new earned reward with required schema fields
      const newRewardResult = await client.query(`
        INSERT INTO loyalty_rewards
          (merchant_id, offer_id, square_customer_id, status,
           current_quantity, required_quantity, window_start_date, window_end_date,
           earned_at, created_at, updated_at)
        VALUES ($1, $2, $3, 'earned', $4, $5, $6, $7, NOW(), NOW(), NOW())
        RETURNING id
      `, [this.merchantId, offerId, squareCustomerId, requiredQuantity, requiredQuantity, windowStart, windowEnd]);

      rewardId = newRewardResult.rows[0].id;

      this.tracer?.span('REWARD_CREATED', { rewardId, status: 'earned' });

      loyaltyLogger.reward({
        action: 'REWARD_CREATED',
        rewardId,
        offerId,
        squareCustomerId,
        status: 'earned',
        progress: currentProgress,
        merchantId: this.merchantId,
      });
    }

    // BUG FIX: Lock exactly required_quantity UNITS, properly splitting the crossing row
    //
    // Previous bug: The condition `cumulative_qty - quantity < required` locked ALL rows
    // up to and including the one that crossed the threshold, then created a duplicate
    // rollover record. For 1+3+3+3+3=13 with required=12, this locked 13 units and
    // created a rollover of 1, resulting in 14 tracked units.
    //
    // Fixed approach:
    // 1. Lock rows where cumulative <= required (fully within threshold)
    // 2. For the crossing row, create split records:
    //    - A locked partial with qty = (required - locked_so_far)
    //    - An unlocked excess with qty = (crossing_qty - needed)
    // 3. The original crossing row stays unchanged (for audit trail)
    //    but is marked as "split" via original_event_id on the split records
    //
    // Example: Buy 12, get 13th free with purchases 1+3+3+3+3=13
    //   - Lock rows 1-4 (cumulative 1,4,7,10 are all <= 12): 10 units locked
    //   - Row 5 (qty=3) crosses threshold: need 2 more to reach 12
    //   - Create locked split: qty=2, original_event_id=row5.id
    //   - Create unlocked split: qty=1, original_event_id=row5.id (rollover)
    //   - Row 5 stays unchanged but is excluded from future counting (has children)
    //   - Result: 12 units locked, 1 unit for next cycle

    // Step 1: Lock rows that are fully consumed (cumulative <= required)
    const lockResult = await client.query(`
      WITH ranked_purchases AS (
        SELECT
          id,
          quantity,
          SUM(quantity) OVER (ORDER BY purchased_at ASC, id ASC) as cumulative_qty
        FROM loyalty_purchase_events
        WHERE merchant_id = $2
          AND offer_id = $3
          AND square_customer_id = $4
          AND reward_id IS NULL
          AND quantity > 0
      )
      UPDATE loyalty_purchase_events lpe
      SET reward_id = $1, updated_at = NOW()
      FROM ranked_purchases rp
      WHERE lpe.id = rp.id
        AND rp.cumulative_qty <= $5  -- Only lock rows fully within threshold
      RETURNING lpe.id, lpe.quantity, rp.cumulative_qty
    `, [rewardId, this.merchantId, offerId, squareCustomerId, requiredQuantity]);

    const lockedRows = lockResult.rows || [];
    const totalLockedQty = lockedRows.reduce((sum, row) => sum + (parseInt(row.quantity, 10) || 0), 0);
    const neededFromCrossing = requiredQuantity - totalLockedQty;

    loyaltyLogger.debug({
      action: 'PURCHASES_LOCKED_FULL_ROWS',
      rewardId,
      lockedRows: lockedRows.length,
      totalLockedQty,
      requiredQuantity,
      neededFromCrossing,
      offerId,
      squareCustomerId,
      merchantId: this.merchantId,
    });

    this.tracer?.span('PURCHASES_LOCKED_FULL', {
      rewardId,
      lockedRows: lockedRows.length,
      totalLockedQty,
      neededFromCrossing,
    });

    // Step 2: Handle the crossing row if we need more units
    if (neededFromCrossing > 0) {
      // Find the crossing row (first unlocked row after the locked ones)
      const crossingResult = await client.query(`
        SELECT id, quantity, square_order_id, variation_id, unit_price_cents,
               purchased_at, trace_id, idempotency_key, window_start_date, window_end_date,
               total_price_cents
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND reward_id IS NULL
          AND quantity > 0
        ORDER BY purchased_at ASC, id ASC
        LIMIT 1
      `, [this.merchantId, offerId, squareCustomerId]);

      if (crossingResult.rows.length > 0) {
        const crossingRow = crossingResult.rows[0];
        const crossingQty = parseInt(crossingRow.quantity, 10);
        const excessQty = crossingQty - neededFromCrossing;

        loyaltyLogger.debug({
          action: 'SPLITTING_CROSSING_ROW',
          crossingRowId: crossingRow.id,
          crossingQty,
          neededFromCrossing,
          excessQty,
          offerId,
          squareCustomerId,
          merchantId: this.merchantId,
        });

        // Create the locked partial (the portion that goes to this reward)
        await client.query(`
          INSERT INTO loyalty_purchase_events
            (merchant_id, offer_id, square_customer_id, square_order_id,
             variation_id, quantity, unit_price_cents, total_price_cents,
             purchased_at, trace_id, idempotency_key,
             window_start_date, window_end_date, reward_id, original_event_id,
             created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        `, [
          this.merchantId,
          offerId,
          squareCustomerId,
          crossingRow.square_order_id,
          crossingRow.variation_id,
          neededFromCrossing,  // Only the needed portion
          crossingRow.unit_price_cents,
          crossingRow.unit_price_cents ? crossingRow.unit_price_cents * neededFromCrossing : null,
          crossingRow.purchased_at,
          crossingRow.trace_id,
          crossingRow.idempotency_key + ':split_locked:' + rewardId,
          crossingRow.window_start_date,
          crossingRow.window_end_date,
          rewardId,  // Locked to this reward
          crossingRow.id,  // References original for audit trail
        ]);

        this.tracer?.span('SPLIT_LOCKED_CREATED', {
          crossingRowId: crossingRow.id,
          lockedQty: neededFromCrossing,
        });

        // Create the unlocked excess (the portion for the next cycle)
        // Note: Window dates are set to NULL - the next purchase will establish
        // the new window based on this excess record's purchased_at date.
        // The recordPurchase logic handles this case correctly.
        if (excessQty > 0) {
          await client.query(`
            INSERT INTO loyalty_purchase_events
              (merchant_id, offer_id, square_customer_id, square_order_id,
               variation_id, quantity, unit_price_cents, total_price_cents,
               purchased_at, trace_id, idempotency_key,
               window_start_date, window_end_date, reward_id, original_event_id,
               created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, $12, NOW(), NOW())
          `, [
            this.merchantId,
            offerId,
            squareCustomerId,
            crossingRow.square_order_id,
            crossingRow.variation_id,
            excessQty,  // The excess portion
            crossingRow.unit_price_cents,
            crossingRow.unit_price_cents ? crossingRow.unit_price_cents * excessQty : null,
            crossingRow.purchased_at,
            crossingRow.trace_id,
            crossingRow.idempotency_key + ':split_excess:' + rewardId,
            crossingRow.id,  // References original for audit trail
          ]);

          loyaltyLogger.debug({
            action: 'SPLIT_EXCESS_CREATED',
            crossingRowId: crossingRow.id,
            excessQty,
            offerId,
            squareCustomerId,
            merchantId: this.merchantId,
          });

          this.tracer?.span('SPLIT_EXCESS_CREATED', {
            crossingRowId: crossingRow.id,
            excessQty,
          });
        }
      }
    }

    // Log final state of unlocked purchases (for debugging)
    const remainingResult = await client.query(`
      SELECT COUNT(*) as remaining_count, COALESCE(SUM(quantity), 0) as remaining_qty
      FROM loyalty_purchase_events
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND reward_id IS NULL
        AND quantity > 0
        -- Exclude rows that have been split (have children with original_event_id = this.id)
        AND NOT EXISTS (
          SELECT 1 FROM loyalty_purchase_events child
          WHERE child.original_event_id = loyalty_purchase_events.id
        )
    `, [this.merchantId, offerId, squareCustomerId]);

    const remainingCount = parseInt(remainingResult.rows[0].remaining_count, 10) || 0;
    const remainingQty = parseInt(remainingResult.rows[0].remaining_qty, 10) || 0;

    if (remainingCount > 0) {
      loyaltyLogger.debug({
        action: 'PURCHASES_AVAILABLE_FOR_NEXT_REWARD',
        offerId,
        squareCustomerId,
        remainingPurchases: remainingCount,
        remainingQuantity: remainingQty,
        merchantId: this.merchantId,
      });

      this.tracer?.span('PURCHASES_AVAILABLE_FOR_NEXT', {
        remainingCount,
        remainingQty,
      });
    }

    return rewardId;
  }

  /**
   * Get purchase history for a customer on an offer
   * @param {string} squareCustomerId - Square customer ID
   * @param {number} offerId - Internal offer ID
   * @param {Object} [options] - Options
   * @param {number} [options.limit] - Limit number of results
   * @returns {Promise<Array>} Array of purchase events
   */
  async getPurchaseHistory(squareCustomerId, offerId, options = {}) {
    const { limit = 50 } = options;

    try {
      const result = await db.query(`
        SELECT
          lpe.id,
          lpe.square_order_id,
          lpe.variation_id,
          lpe.quantity,
          lpe.unit_price_cents,
          lpe.total_price_cents,
          lpe.purchased_at,
          lpe.trace_id,
          lpe.created_at,
          lqv.variation_name,
          lqv.item_name
        FROM loyalty_purchase_events lpe
        LEFT JOIN loyalty_qualifying_variations lqv
          ON lpe.variation_id = lqv.variation_id AND lpe.offer_id = lqv.offer_id
        WHERE lpe.merchant_id = $1
          AND lpe.offer_id = $2
          AND lpe.square_customer_id = $3
        ORDER BY lpe.purchased_at DESC
        LIMIT $4
      `, [this.merchantId, offerId, squareCustomerId, limit]);

      return result.rows;
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_PURCHASE_HISTORY_ERROR',
        squareCustomerId,
        offerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Get current progress for a customer on an offer
   * @param {string} squareCustomerId - Square customer ID
   * @param {number} offerId - Internal offer ID
   * @returns {Promise<Object>} Progress information
   */
  async getCurrentProgress(squareCustomerId, offerId) {
    try {
      // Get offer details
      const offerResult = await db.query(`
        SELECT required_quantity, window_months
        FROM loyalty_offers
        WHERE id = $1 AND merchant_id = $2
      `, [offerId, this.merchantId]);

      if (offerResult.rows.length === 0) {
        return null;
      }

      const { required_quantity, window_months } = offerResult.rows[0];

      // Get the window dates from the customer's first unlocked purchase (rolling window)
      const windowResult = await db.query(`
        SELECT
          MIN(window_start_date) as window_start,
          MIN(window_end_date) as window_end
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND reward_id IS NULL
          AND quantity > 0
      `, [this.merchantId, offerId, squareCustomerId]);

      const windowStart = windowResult.rows[0]?.window_start;
      const windowEnd = windowResult.rows[0]?.window_end;

      // If no unlocked purchases exist, no progress
      if (!windowStart) {
        return {
          currentProgress: 0,
          requiredQuantity: required_quantity,
          remaining: required_quantity,
          percentComplete: 0,
          windowStart: null,
          windowEnd: null,
          windowMonths: window_months,
        };
      }

      // Get current progress within the window
      // Include negative quantities (refunds) to properly subtract from progress
      //
      // BUG FIX: Exclude rows that have been "split" (have children with original_event_id
      // pointing to them). When a row crosses the threshold, we create split records and
      // the original should not be counted directly - only the splits should be counted.
      const progressResult = await db.query(`
        SELECT COALESCE(SUM(quantity), 0) as total_quantity
        FROM loyalty_purchase_events lpe
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND purchased_at >= $4
          AND purchased_at < $5
          AND reward_id IS NULL
          -- Exclude rows that have been superseded by split records
          AND NOT EXISTS (
            SELECT 1 FROM loyalty_purchase_events child
            WHERE child.original_event_id = lpe.id
          )
      `, [this.merchantId, offerId, squareCustomerId, windowStart, windowEnd]);

      const currentProgress = parseInt(progressResult.rows[0].total_quantity, 10) || 0;

      return {
        currentProgress,
        requiredQuantity: required_quantity,
        remaining: Math.max(0, required_quantity - currentProgress),
        percentComplete: Math.min(100, Math.round((currentProgress / required_quantity) * 100)),
        windowStart: windowStart,
        windowEnd: windowEnd,
        windowMonths: window_months,
      };
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_CURRENT_PROGRESS_ERROR',
        squareCustomerId,
        offerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }
}

module.exports = { LoyaltyPurchaseService };
