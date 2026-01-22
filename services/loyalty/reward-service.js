/**
 * Loyalty Reward Service
 *
 * Handles reward status management, redemption, and expiration:
 * - Get earned rewards for a customer
 * - Redeem rewards
 * - Check reward eligibility
 * - Handle reward expiration
 */

const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');

/**
 * LoyaltyRewardService - Manages rewards and redemptions
 */
class LoyaltyRewardService {
  /**
   * @param {number} merchantId - Internal merchant ID
   * @param {Object} [tracer] - Optional tracer instance for correlation
   */
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
  }

  /**
   * Get all earned (available) rewards for a customer
   * @param {string} squareCustomerId - Square customer ID
   * @param {Object} [options] - Options
   * @param {boolean} [options.includeRedeemed] - Include already redeemed rewards
   * @returns {Promise<Array>} Array of rewards
   */
  async getCustomerRewards(squareCustomerId, options = {}) {
    const { includeRedeemed = false } = options;

    try {
      let query = `
        SELECT
          lr.id,
          lr.offer_id,
          lr.status,
          lr.current_quantity,
          lr.earned_at,
          lr.redeemed_at,
          lr.expires_at,
          lr.trace_id,
          lr.created_at,
          lo.offer_name as offer_name,
          lo.reward_type,
          lo.reward_value,
          lo.reward_description
        FROM loyalty_rewards lr
        INNER JOIN loyalty_offers lo ON lr.offer_id = lo.id
        WHERE lr.merchant_id = $1
          AND lr.square_customer_id = $2
      `;

      if (!includeRedeemed) {
        query += ` AND lr.status = 'earned' AND lr.redeemed_at IS NULL`;
      }

      query += ` ORDER BY lr.earned_at DESC`;

      const result = await db.query(query, [this.merchantId, squareCustomerId]);

      return result.rows.map(row => ({
        id: row.id,
        offerId: row.offer_id,
        offerName: row.offer_name,
        status: row.status,
        progressQuantity: row.current_quantity,
        rewardType: row.reward_type,
        rewardValue: row.reward_value,
        rewardDescription: row.reward_description,
        earnedAt: row.earned_at,
        redeemedAt: row.redeemed_at,
        expiresAt: row.expires_at,
        traceId: row.trace_id,
      }));
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_CUSTOMER_REWARDS_ERROR',
        squareCustomerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Get a specific reward by ID
   * @param {number} rewardId - Internal reward ID
   * @returns {Promise<Object|null>} Reward object or null
   */
  async getRewardById(rewardId) {
    try {
      const result = await db.query(`
        SELECT
          lr.id,
          lr.offer_id,
          lr.square_customer_id,
          lr.status,
          lr.current_quantity,
          lr.earned_at,
          lr.redeemed_at,
          lr.redemption_order_id,
          lr.expires_at,
          lr.trace_id,
          lr.created_at,
          lo.offer_name as offer_name,
          lo.reward_type,
          lo.reward_value,
          lo.reward_description
        FROM loyalty_rewards lr
        INNER JOIN loyalty_offers lo ON lr.offer_id = lo.id
        WHERE lr.id = $1 AND lr.merchant_id = $2
      `, [rewardId, this.merchantId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        offerId: row.offer_id,
        squareCustomerId: row.square_customer_id,
        offerName: row.offer_name,
        status: row.status,
        progressQuantity: row.current_quantity,
        rewardType: row.reward_type,
        rewardValue: row.reward_value,
        rewardDescription: row.reward_description,
        earnedAt: row.earned_at,
        redeemedAt: row.redeemed_at,
        redeemedOrderId: row.redemption_order_id,
        expiresAt: row.expires_at,
        traceId: row.trace_id,
      };
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_REWARD_BY_ID_ERROR',
        rewardId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Redeem a reward
   * @param {number} rewardId - Internal reward ID
   * @param {Object} redemptionData - Redemption data
   * @param {string} [redemptionData.squareOrderId] - Order where reward was applied
   * @param {string} [redemptionData.traceId] - Correlation trace ID
   * @returns {Promise<Object>} Result of redemption
   */
  async redeemReward(rewardId, redemptionData = {}) {
    const { squareOrderId, traceId } = redemptionData;

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Get reward with lock
      const rewardResult = await client.query(`
        SELECT
          lr.id,
          lr.status,
          lr.square_customer_id,
          lr.offer_id,
          lr.redeemed_at,
          lr.expires_at,
          lo.offer_name as offer_name
        FROM loyalty_rewards lr
        INNER JOIN loyalty_offers lo ON lr.offer_id = lo.id
        WHERE lr.id = $1 AND lr.merchant_id = $2
        FOR UPDATE
      `, [rewardId, this.merchantId]);

      if (rewardResult.rows.length === 0) {
        await client.query('ROLLBACK');
        this.tracer?.span('REDEMPTION_NOT_FOUND', { rewardId });
        return {
          success: false,
          reason: 'reward_not_found',
        };
      }

      const reward = rewardResult.rows[0];

      // Check if already redeemed
      if (reward.redeemed_at) {
        await client.query('ROLLBACK');
        this.tracer?.span('REDEMPTION_ALREADY_REDEEMED', { rewardId });
        return {
          success: false,
          reason: 'already_redeemed',
          redeemedAt: reward.redeemed_at,
        };
      }

      // Check if expired
      if (reward.expires_at && new Date(reward.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        this.tracer?.span('REDEMPTION_EXPIRED', { rewardId, expiresAt: reward.expires_at });
        return {
          success: false,
          reason: 'expired',
          expiresAt: reward.expires_at,
        };
      }

      // Check if status is 'earned'
      if (reward.status !== 'earned') {
        await client.query('ROLLBACK');
        this.tracer?.span('REDEMPTION_INVALID_STATUS', { rewardId, status: reward.status });
        return {
          success: false,
          reason: 'invalid_status',
          currentStatus: reward.status,
        };
      }

      // Perform redemption
      await client.query(`
        UPDATE loyalty_rewards
        SET status = 'redeemed',
            redeemed_at = NOW(),
            redemption_order_id = $1,
            trace_id = $2,
            updated_at = NOW()
        WHERE id = $3
      `, [squareOrderId, traceId, rewardId]);

      await client.query('COMMIT');

      this.tracer?.span('REWARD_REDEEMED', {
        rewardId,
        offerId: reward.offer_id,
        squareOrderId,
      });

      loyaltyLogger.redemption({
        action: 'REWARD_REDEEMED',
        rewardId,
        offerId: reward.offer_id,
        offerName: reward.offer_name,
        squareCustomerId: reward.square_customer_id,
        squareOrderId,
        merchantId: this.merchantId,
      });

      return {
        success: true,
        rewardId,
        offerId: reward.offer_id,
        offerName: reward.offer_name,
        squareCustomerId: reward.square_customer_id,
        redeemedAt: new Date().toISOString(),
      };

    } catch (error) {
      await client.query('ROLLBACK');
      loyaltyLogger.error({
        action: 'REDEEM_REWARD_ERROR',
        rewardId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check if a customer has a redeemable reward for an offer
   * @param {string} squareCustomerId - Square customer ID
   * @param {number} offerId - Offer ID
   * @returns {Promise<Object|null>} Redeemable reward or null
   */
  async getRedeemableReward(squareCustomerId, offerId) {
    try {
      const result = await db.query(`
        SELECT
          lr.id,
          lr.status,
          lr.earned_at,
          lr.expires_at,
          lo.offer_name as offer_name,
          lo.reward_type,
          lo.reward_value,
          lo.reward_description
        FROM loyalty_rewards lr
        INNER JOIN loyalty_offers lo ON lr.offer_id = lo.id
        WHERE lr.merchant_id = $1
          AND lr.square_customer_id = $2
          AND lr.offer_id = $3
          AND lr.status = 'earned'
          AND lr.redeemed_at IS NULL
          AND (lr.expires_at IS NULL OR lr.expires_at > NOW())
        ORDER BY lr.earned_at ASC
        LIMIT 1
      `, [this.merchantId, squareCustomerId, offerId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        offerName: row.offer_name,
        rewardType: row.reward_type,
        rewardValue: row.reward_value,
        rewardDescription: row.reward_description,
        earnedAt: row.earned_at,
        expiresAt: row.expires_at,
      };
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_REDEEMABLE_REWARD_ERROR',
        squareCustomerId,
        offerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Count earned rewards for a customer
   * @param {string} squareCustomerId - Square customer ID
   * @returns {Promise<number>} Number of earned rewards
   */
  async countEarnedRewards(squareCustomerId) {
    try {
      const result = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND square_customer_id = $2
          AND status = 'earned'
          AND redeemed_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
      `, [this.merchantId, squareCustomerId]);

      return parseInt(result.rows[0].count) || 0;
    } catch (error) {
      loyaltyLogger.error({
        action: 'COUNT_EARNED_REWARDS_ERROR',
        squareCustomerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Expire rewards past their expiration date
   * @returns {Promise<Object>} Result with count of expired rewards
   */
  async expireRewards() {
    try {
      const result = await db.query(`
        UPDATE loyalty_rewards
        SET status = 'expired',
            updated_at = NOW()
        WHERE merchant_id = $1
          AND status = 'earned'
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
        RETURNING id, offer_id, square_customer_id, expires_at
      `, [this.merchantId]);

      if (result.rows.length > 0) {
        this.tracer?.span('REWARDS_EXPIRED', {
          count: result.rows.length,
          rewardIds: result.rows.map(r => r.id),
        });

        loyaltyLogger.reward({
          action: 'REWARDS_EXPIRED',
          count: result.rows.length,
          expiredRewards: result.rows,
          merchantId: this.merchantId,
        });
      }

      return {
        expiredCount: result.rows.length,
        expiredRewards: result.rows.map(row => ({
          id: row.id,
          offerId: row.offer_id,
          squareCustomerId: row.square_customer_id,
          expiresAt: row.expires_at,
        })),
      };
    } catch (error) {
      loyaltyLogger.error({
        action: 'EXPIRE_REWARDS_ERROR',
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Get reward statistics for a customer
   * @param {string} squareCustomerId - Square customer ID
   * @returns {Promise<Object>} Reward statistics
   */
  async getRewardStats(squareCustomerId) {
    try {
      const result = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'earned' AND redeemed_at IS NULL) as available,
          COUNT(*) FILTER (WHERE status = 'redeemed') as redeemed,
          COUNT(*) FILTER (WHERE status = 'expired') as expired,
          COUNT(*) as total
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND square_customer_id = $2
      `, [this.merchantId, squareCustomerId]);

      const row = result.rows[0];
      return {
        available: parseInt(row.available) || 0,
        redeemed: parseInt(row.redeemed) || 0,
        expired: parseInt(row.expired) || 0,
        total: parseInt(row.total) || 0,
      };
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_REWARD_STATS_ERROR',
        squareCustomerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }
}

module.exports = { LoyaltyRewardService };
