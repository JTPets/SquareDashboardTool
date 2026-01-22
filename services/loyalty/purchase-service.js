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
    } = purchaseData;

    // Check if this order+variation was already recorded (idempotency)
    const existingResult = await db.query(`
      SELECT id FROM loyalty_purchase_events
      WHERE merchant_id = $1
        AND square_order_id = $2
        AND variation_id = $3
    `, [this.merchantId, squareOrderId, variationId]);

    if (existingResult.rows.length > 0) {
      this.tracer?.span('PURCHASE_DUPLICATE', { squareOrderId, variationId });
      loyaltyLogger.debug({
        action: 'PURCHASE_ALREADY_RECORDED',
        squareOrderId,
        variationId,
        existingId: existingResult.rows[0].id,
        merchantId: this.merchantId,
      });
      return {
        recorded: false,
        reason: 'duplicate',
        existingId: existingResult.rows[0].id,
      };
    }

    // Get offers for this variation
    const offersResult = await db.query(`
      SELECT
        lo.id as offer_id,
        lo.name as offer_name,
        lo.required_quantity,
        lo.time_window_days
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

        // Insert purchase event
        const insertResult = await client.query(`
          INSERT INTO loyalty_purchase_events
            (merchant_id, offer_id, square_customer_id, square_order_id,
             variation_id, quantity, unit_price_cents, total_price_cents,
             purchased_at, trace_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
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
        ]);

        const purchaseEventId = insertResult.rows[0].id;

        // Update reward progress
        const progressResult = await this.updateRewardProgress(
          client,
          squareCustomerId,
          offer.offer_id,
          offer.required_quantity,
          offer.time_window_days,
          traceId
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

    return {
      recorded: true,
      results,
    };
  }

  /**
   * Update reward progress for a customer on an offer
   * @private
   */
  async updateRewardProgress(client, squareCustomerId, offerId, requiredQuantity, timeWindowDays, traceId) {
    // Calculate current progress within time window
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - (timeWindowDays || 365));

    const progressResult = await client.query(`
      SELECT COALESCE(SUM(quantity), 0) as total_quantity
      FROM loyalty_purchase_events
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND purchased_at >= $4
        AND quantity > 0
        AND locked_to_reward_id IS NULL
    `, [this.merchantId, offerId, squareCustomerId, windowStart.toISOString()]);

    const currentProgress = parseInt(progressResult.rows[0].total_quantity) || 0;

    // Check if customer has earned a reward
    const rewardEarned = currentProgress >= requiredQuantity;

    if (rewardEarned) {
      // Create or update reward status
      await this.createOrUpdateReward(
        client,
        squareCustomerId,
        offerId,
        currentProgress,
        requiredQuantity,
        traceId
      );
    }

    return {
      currentProgress,
      requiredQuantity,
      rewardEarned,
      windowDays: timeWindowDays,
    };
  }

  /**
   * Create or update reward when threshold is reached
   * @private
   */
  async createOrUpdateReward(client, squareCustomerId, offerId, currentProgress, requiredQuantity, traceId) {
    // Check for existing in_progress reward
    const existingResult = await client.query(`
      SELECT id, status FROM loyalty_rewards
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND status = 'in_progress'
      FOR UPDATE
    `, [this.merchantId, offerId, squareCustomerId]);

    if (existingResult.rows.length > 0) {
      // Update existing reward to earned
      await client.query(`
        UPDATE loyalty_rewards
        SET status = 'earned',
            earned_at = NOW(),
            progress_quantity = $1,
            trace_id = $2,
            updated_at = NOW()
        WHERE id = $3
      `, [currentProgress, traceId, existingResult.rows[0].id]);

      this.tracer?.span('REWARD_EARNED', { rewardId: existingResult.rows[0].id });

      loyaltyLogger.reward({
        action: 'REWARD_EARNED',
        rewardId: existingResult.rows[0].id,
        offerId,
        squareCustomerId,
        progress: currentProgress,
        required: requiredQuantity,
        merchantId: this.merchantId,
      });

      return existingResult.rows[0].id;
    }

    // Create new reward in earned status (if no existing in_progress)
    // First check if there's already an earned reward
    const earnedCheck = await client.query(`
      SELECT id FROM loyalty_rewards
      WHERE merchant_id = $1
        AND offer_id = $2
        AND square_customer_id = $3
        AND status = 'earned'
        AND redeemed_at IS NULL
    `, [this.merchantId, offerId, squareCustomerId]);

    if (earnedCheck.rows.length > 0) {
      // Already has an unredeemed earned reward, don't create another
      return earnedCheck.rows[0].id;
    }

    // Create new earned reward
    const newRewardResult = await client.query(`
      INSERT INTO loyalty_rewards
        (merchant_id, offer_id, square_customer_id, status,
         progress_quantity, earned_at, trace_id, created_at, updated_at)
      VALUES ($1, $2, $3, 'earned', $4, NOW(), $5, NOW(), NOW())
      RETURNING id
    `, [this.merchantId, offerId, squareCustomerId, currentProgress, traceId]);

    const rewardId = newRewardResult.rows[0].id;

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
        SELECT required_quantity, time_window_days
        FROM loyalty_offers
        WHERE id = $1 AND merchant_id = $2
      `, [offerId, this.merchantId]);

      if (offerResult.rows.length === 0) {
        return null;
      }

      const { required_quantity, time_window_days } = offerResult.rows[0];

      // Calculate window start
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - (time_window_days || 365));

      // Get current progress
      const progressResult = await db.query(`
        SELECT COALESCE(SUM(quantity), 0) as total_quantity
        FROM loyalty_purchase_events
        WHERE merchant_id = $1
          AND offer_id = $2
          AND square_customer_id = $3
          AND purchased_at >= $4
          AND quantity > 0
          AND locked_to_reward_id IS NULL
      `, [this.merchantId, offerId, squareCustomerId, windowStart.toISOString()]);

      const currentProgress = parseInt(progressResult.rows[0].total_quantity) || 0;

      return {
        currentProgress,
        requiredQuantity: required_quantity,
        remaining: Math.max(0, required_quantity - currentProgress),
        percentComplete: Math.min(100, Math.round((currentProgress / required_quantity) * 100)),
        windowStart: windowStart.toISOString(),
        windowDays: time_window_days,
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
