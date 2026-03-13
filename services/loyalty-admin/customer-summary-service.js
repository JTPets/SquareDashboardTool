/**
 * Customer Summary Service
 *
 * Maintains the denormalized loyalty_customer_summary table.
 * Called after any purchase, refund, or redemption to keep
 * the summary in sync with the source-of-truth tables.
 *
 * Extracted from purchase-service.js as part of file-size compliance split.
 */

const logger = require('../../utils/logger');

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
    // LOGIC CHANGE (MED-4): Combined 6 sequential queries into 2 using CTEs.
    // Previously ran: stats, earned count, redeemed count, total count, offer lookup,
    // and conditional earned reward ID lookup — all sequentially. Now uses a single
    // CTE query for reward counts + offer + earned reward ID, plus the original
    // stats query (kept separate due to its complexity with NOT EXISTS subqueries).

    // Query 1: Purchase event stats — exclude superseded parent rows (rows that have
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

    // Query 2: Reward counts, offer required_quantity, and earliest earned reward ID
    // in a single CTE query (replaces 5 separate queries)
    const rewardStats = await client.query(`
        WITH reward_counts AS (
            SELECT
                COUNT(*) FILTER (WHERE status = 'earned') AS earned_count,
                COUNT(*) FILTER (WHERE status = 'redeemed') AS redeemed_count,
                COUNT(*) FILTER (WHERE status IN ('earned', 'redeemed')) AS total_earned_redeemed,
                (SELECT id FROM loyalty_rewards
                     WHERE merchant_id = $1 AND offer_id = $2 AND square_customer_id = $3
                       AND status = 'earned'
                     ORDER BY created_at ASC LIMIT 1) AS earliest_earned_id
            FROM loyalty_rewards
            WHERE merchant_id = $1
              AND offer_id = $2
              AND square_customer_id = $3
        ),
        offer_info AS (
            SELECT required_quantity FROM loyalty_offers WHERE id = $2
        )
        SELECT
            rc.earned_count,
            rc.redeemed_count,
            rc.total_earned_redeemed,
            rc.earliest_earned_id,
            oi.required_quantity
        FROM reward_counts rc
        LEFT JOIN offer_info oi ON TRUE
    `, [merchantId, offerId, squareCustomerId]);

    const s = stats.rows[0];
    const rs = rewardStats.rows[0];
    const hasEarned = parseInt(rs?.earned_count || 0) > 0;
    const earnedRewardId = rs?.earliest_earned_id || null;

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
        parseInt(rs?.required_quantity) || 0,
        s.window_start, s.window_end,
        hasEarned, earnedRewardId,
        parseInt(s.lifetime_purchases) || 0,
        parseInt(rs?.total_earned_redeemed || 0),
        parseInt(rs?.redeemed_count || 0),
        s.last_purchase
    ]);
}

module.exports = {
    updateCustomerSummary
};
