/**
 * Customer Profile Service (Modern)
 *
 * Reads customer loyalty progress from source of truth (loyalty_purchase_events)
 * rather than cached summary table.
 *
 * Part of monolith extraction from services/loyalty-admin/loyalty-service.js
 *
 * @module services/loyalty/customer-profile-service
 */

const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');

/**
 * Get customer's progress on all active offers
 * Calculates current progress from purchase_events, not summary cache
 *
 * @param {Object} params
 * @param {string} params.squareCustomerId - Square customer ID
 * @param {number} params.merchantId - Merchant ID
 * @returns {Promise<Object>} Customer profile with offer progress
 */
async function getCustomerOfferProgress({ squareCustomerId, merchantId }) {
  if (!merchantId) {
    throw new Error('merchantId is required');
  }
  if (!squareCustomerId) {
    throw new Error('squareCustomerId is required');
  }

  // Query active offers with progress calculated from purchase_events
  // This is the source of truth, not the summary cache
  const result = await db.query(`
    WITH customer_progress AS (
      SELECT
        lpe.offer_id,
        -- Current window purchases (unlocked, not refunded, window still valid)
        COALESCE(SUM(
          CASE WHEN lpe.reward_id IS NULL
               AND lpe.quantity > 0
               AND lpe.window_end_date >= CURRENT_DATE
          THEN lpe.quantity ELSE 0 END
        ), 0) as current_quantity,
        -- Window dates from most recent purchase
        MAX(lpe.window_start_date) as window_start_date,
        MAX(lpe.window_end_date) as window_end_date,
        -- Lifetime stats
        COALESCE(SUM(CASE WHEN lpe.quantity > 0 THEN lpe.quantity ELSE 0 END), 0) as total_lifetime_purchases,
        MAX(lpe.purchased_at) as last_purchase_at
      FROM loyalty_purchase_events lpe
      WHERE lpe.merchant_id = $1
        AND lpe.square_customer_id = $2
      GROUP BY lpe.offer_id
    ),
    customer_rewards AS (
      SELECT
        lr.offer_id,
        COUNT(*) FILTER (WHERE lr.status IN ('earned', 'redeemed')) as total_rewards_earned,
        COUNT(*) FILTER (WHERE lr.status = 'redeemed') as total_rewards_redeemed,
        -- Check for currently earned (unredeemed) reward
        bool_or(lr.status = 'earned') as has_earned_reward,
        -- Use array_agg since MAX() doesn't support UUID type
        (array_agg(lr.id ORDER BY lr.earned_at DESC) FILTER (WHERE lr.status = 'earned'))[1] as earned_reward_id
      FROM loyalty_rewards lr
      WHERE lr.merchant_id = $1
        AND lr.square_customer_id = $2
      GROUP BY lr.offer_id
    )
    SELECT
      o.id as offer_id,
      o.offer_name,
      o.brand_name,
      o.size_group,
      o.required_quantity,
      o.window_months,
      COALESCE(cp.current_quantity, 0)::int as current_quantity,
      cp.window_start_date,
      cp.window_end_date,
      COALESCE(cr.has_earned_reward, false) as has_earned_reward,
      cr.earned_reward_id,
      COALESCE(cp.total_lifetime_purchases, 0)::int as total_lifetime_purchases,
      COALESCE(cr.total_rewards_earned, 0)::int as total_rewards_earned,
      COALESCE(cr.total_rewards_redeemed, 0)::int as total_rewards_redeemed,
      cp.last_purchase_at
    FROM loyalty_offers o
    LEFT JOIN customer_progress cp ON o.id = cp.offer_id
    LEFT JOIN customer_rewards cr ON o.id = cr.offer_id
    WHERE o.merchant_id = $1
      AND o.is_active = TRUE
    ORDER BY o.brand_name, o.size_group
  `, [merchantId, squareCustomerId]);

  loyaltyLogger.debug({
    action: 'CUSTOMER_PROFILE_LOADED',
    squareCustomerId,
    merchantId,
    offerCount: result.rows.length,
    offersWithProgress: result.rows.filter(r => r.current_quantity > 0).length
  });

  return {
    squareCustomerId,
    offers: result.rows
  };
}

module.exports = {
  getCustomerOfferProgress
};
