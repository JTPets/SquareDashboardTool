/**
 * Audit Stats Service
 *
 * Dashboard statistics and audit findings queries.
 *
 * Extracted from routes/loyalty/audit.js (A-16) — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - GET /stats runs 5 sequential SQL queries — could be combined into
 *   a single query with CTEs for better performance
 * - GET /audit-findings duplicates count query pattern (main query + count query)
 * - POST /audit-findings/resolve has inline SQL UPDATE
 */

const db = require('../../utils/database');

/**
 * Get loyalty program statistics for dashboard.
 * Runs 5 queries: offer counts, reward counts by status,
 * recent earned, recent redeemed, total redemption value.
 *
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Stats object
 */
async function getLoyaltyStats(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getLoyaltyStats - tenant isolation required');
    }

    // Get offer counts
    const offerStats = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE is_active = TRUE) as active_offers,
            COUNT(*) as total_offers
        FROM loyalty_offers
        WHERE merchant_id = $1
    `, [merchantId]);

    // Get reward counts by status
    const rewardStats = await db.query(`
        SELECT status, COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
        GROUP BY status
    `, [merchantId]);

    // Get recent activity
    const recentEarned = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status IN ('earned', 'redeemed')
          AND earned_at >= NOW() - INTERVAL '30 days'
    `, [merchantId]);

    // Query loyalty_rewards for redeemed count
    const recentRedeemed = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'redeemed'
          AND redeemed_at >= NOW() - INTERVAL '30 days'
    `, [merchantId]);

    // Calculate total redemption value from purchase events linked to redeemed rewards
    const totalValue = await db.query(`
        SELECT COALESCE(SUM(reward_value), 0) as total_cents
        FROM (
            SELECT r.id, AVG(pe.unit_price_cents) as reward_value
            FROM loyalty_rewards r
            INNER JOIN loyalty_purchase_events pe ON pe.reward_id = r.id
            WHERE r.merchant_id = $1
              AND r.status = 'redeemed'
              AND pe.unit_price_cents > 0
            GROUP BY r.id
        ) reward_values
    `, [merchantId]);

    return {
        offers: {
            active: parseInt(offerStats.rows[0]?.active_offers || 0),
            total: parseInt(offerStats.rows[0]?.total_offers || 0)
        },
        rewards: rewardStats.rows.reduce((acc, row) => {
            acc[row.status] = parseInt(row.count);
            return acc;
        }, {}),
        last30Days: {
            earned: parseInt(recentEarned.rows[0]?.count || 0),
            redeemed: parseInt(recentRedeemed.rows[0]?.count || 0)
        },
        totalRedemptionValueCents: parseInt(totalValue.rows[0]?.total_cents || 0)
    };
}

/**
 * Get audit findings with filtering and pagination.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {boolean} [params.resolved=false] - Filter resolved/unresolved
 * @param {string} [params.issueType] - Filter by issue type
 * @param {number} [params.limit=50] - Result limit
 * @param {number} [params.offset=0] - Result offset
 * @returns {Promise<Object>} { findings, pagination }
 */
async function getAuditFindings({ merchantId, resolved = false, issueType, limit = 50, offset = 0 }) {
    if (!merchantId) {
        throw new Error('merchantId is required for getAuditFindings - tenant isolation required');
    }

    let query = `
        SELECT id, square_customer_id, order_id, reward_id, issue_type,
               details, resolved, resolved_at, created_at
        FROM loyalty_audit_log
        WHERE merchant_id = $1
          AND resolved = $2
    `;
    const params = [merchantId, resolved];

    if (issueType) {
        query += ` AND issue_type = $${params.length + 1}`;
        params.push(issueType);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get total count for pagination
    let countQuery = `
        SELECT COUNT(*) as total
        FROM loyalty_audit_log
        WHERE merchant_id = $1 AND resolved = $2
    `;
    const countParams = [merchantId, resolved];
    if (issueType) {
        countQuery += ` AND issue_type = $3`;
        countParams.push(issueType);
    }
    const countResult = await db.query(countQuery, countParams);

    return {
        findings: result.rows,
        pagination: {
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        }
    };
}

/**
 * Resolve an audit finding by ID.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} params.findingId - Finding ID
 * @returns {Promise<Object|null>} Resolved finding or null if not found
 */
async function resolveAuditFinding({ merchantId, findingId }) {
    if (!merchantId) {
        throw new Error('merchantId is required for resolveAuditFinding - tenant isolation required');
    }

    const result = await db.query(`
        UPDATE loyalty_audit_log
        SET resolved = TRUE, resolved_at = NOW()
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, resolved, resolved_at
    `, [findingId, merchantId]);

    return result.rows[0] || null;
}

module.exports = {
    getLoyaltyStats,
    getAuditFindings,
    resolveAuditFinding
};
