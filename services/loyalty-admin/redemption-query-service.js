/**
 * Redemption Query Service
 *
 * Complex queries for redemption history and reward listings.
 *
 * Extracted from routes/loyalty/rewards.js (A-15) — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - GET /redemptions query is 90 lines with LATERAL JOIN across 5 tables
 * - GET /rewards has dynamic WHERE clause built with string concatenation
 *   (safe — uses parameterized $N, but pattern could use a query builder)
 * - PATCH /rewards/:rewardId/vendor-credit has inline SQL (SELECT + UPDATE)
 *   that could also be here, but left in route per extraction scope
 */

const db = require('../../utils/database');

/**
 * Get redemption history with filtering.
 * Complex query joining rewards, offers, customers, redemptions, and purchase events.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} [params.offerId] - Filter by offer
 * @param {string} [params.customerId] - Filter by customer
 * @param {string} [params.startDate] - Filter by start date
 * @param {string} [params.endDate] - Filter by end date
 * @param {number} [params.limit=100] - Result limit
 * @param {number} [params.offset=0] - Result offset
 * @returns {Promise<Array>} Redemption records
 */
async function getRedemptions({ merchantId, offerId, customerId, startDate, endDate, limit = 100, offset = 0 }) {
    if (!merchantId) {
        throw new Error('merchantId is required for getRedemptions - tenant isolation required');
    }

    let query = `
        SELECT
            r.id,
            r.merchant_id,
            r.offer_id,
            r.square_customer_id,
            r.redeemed_at,
            r.redemption_order_id as square_order_id,
            -- Vendor credit tracking
            r.vendor_credit_status,
            r.vendor_credit_submitted_at,
            r.vendor_credit_resolved_at,
            o.offer_name,
            o.brand_name,
            o.size_group,
            lc.phone_number as customer_phone,
            lc.display_name as customer_name,
            -- Redeemed item: prefer redemption record, fall back to purchase events
            COALESCE(lr.redeemed_item_name, pe_info.item_name) as redeemed_item_name,
            COALESCE(lr.redeemed_variation_name, pe_info.variation_name) as redeemed_variation_name,
            COALESCE(lr.redeemed_variation_id, pe_info.variation_id) as redeemed_variation_id,
            COALESCE(lr.redeemed_value_cents, pe_info.avg_price) as redeemed_value_cents,
            -- Get source from processed orders (WEBHOOK, CATCHUP_JOB, BACKFILL)
            COALESCE(lpo.source, 'WEBHOOK') as redemption_type
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        LEFT JOIN loyalty_redemptions lr
            ON r.redemption_id = lr.id
        LEFT JOIN LATERAL (
            SELECT
                lqv.item_name,
                lqv.variation_name,
                pe.variation_id,
                AVG(pe.unit_price_cents) FILTER (WHERE pe.unit_price_cents > 0) as avg_price
            FROM loyalty_purchase_events pe
            LEFT JOIN loyalty_qualifying_variations lqv
                ON pe.variation_id = lqv.variation_id AND pe.offer_id = lqv.offer_id
            WHERE pe.reward_id = r.id
            GROUP BY lqv.item_name, lqv.variation_name, pe.variation_id
            LIMIT 1
        ) pe_info ON true
        LEFT JOIN loyalty_processed_orders lpo
            ON r.redemption_order_id = lpo.square_order_id
            AND r.merchant_id = lpo.merchant_id
        WHERE r.merchant_id = $1
          AND r.status = 'redeemed'
    `;
    const params = [merchantId];

    if (offerId) {
        params.push(offerId);
        query += ` AND r.offer_id = $${params.length}`;
    }

    if (customerId) {
        params.push(customerId);
        query += ` AND r.square_customer_id = $${params.length}`;
    }

    if (startDate) {
        params.push(startDate);
        query += ` AND r.redeemed_at >= $${params.length}`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND r.redeemed_at <= $${params.length}`;
    }

    query += ` ORDER BY r.redeemed_at DESC`;

    params.push(parseInt(limit) || 100);
    query += ` LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Get rewards with filtering (earned, redeemed, etc.)
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {string} [params.status] - Filter by status
 * @param {number} [params.offerId] - Filter by offer
 * @param {string} [params.customerId] - Filter by customer
 * @param {number} [params.limit=100] - Result limit
 * @param {number} [params.offset=0] - Result offset
 * @returns {Promise<Array>} Reward records
 */
async function getRewards({ merchantId, status, offerId, customerId, limit = 100, offset = 0 }) {
    if (!merchantId) {
        throw new Error('merchantId is required for getRewards - tenant isolation required');
    }

    let query = `
        SELECT r.*, o.offer_name, o.brand_name, o.size_group,
               lc.phone_number as customer_phone, lc.display_name as customer_name
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        LEFT JOIN loyalty_customers lc ON r.square_customer_id = lc.square_customer_id AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
    `;
    const params = [merchantId];

    if (status) {
        params.push(status);
        query += ` AND r.status = $${params.length}`;
    }

    if (offerId) {
        params.push(offerId);
        query += ` AND r.offer_id = $${params.length}`;
    }

    if (customerId) {
        params.push(customerId);
        query += ` AND r.square_customer_id = $${params.length}`;
    }

    query += ` ORDER BY r.created_at DESC`;

    params.push(parseInt(limit) || 100);
    query += ` LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Update vendor credit status for a redeemed reward.
 *
 * @param {Object} params
 * @param {number} params.merchantId - REQUIRED: Merchant ID
 * @param {number} params.rewardId - Reward ID
 * @param {string} params.status - SUBMITTED, CREDITED, or DENIED
 * @param {string} [params.notes] - Optional notes
 * @returns {Promise<Object>} Updated vendor credit record
 */
async function updateVendorCreditStatus({ merchantId, rewardId, status, notes }) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateVendorCreditStatus - tenant isolation required');
    }

    // Verify reward exists and is redeemed
    const rewardResult = await db.query(`
        SELECT id, status, vendor_credit_status
        FROM loyalty_rewards
        WHERE id = $1 AND merchant_id = $2
    `, [rewardId, merchantId]);

    if (rewardResult.rows.length === 0) {
        const error = new Error('Reward not found');
        error.statusCode = 404;
        error.code = 'NOT_FOUND';
        throw error;
    }

    const reward = rewardResult.rows[0];

    if (reward.status !== 'redeemed') {
        const error = new Error('Only redeemed rewards can have vendor credit status');
        error.statusCode = 400;
        error.code = 'INVALID_REWARD_STATUS';
        throw error;
    }

    // Build update query based on status transition
    let updateQuery;
    let updateParams;

    if (status === 'SUBMITTED') {
        updateQuery = `
            UPDATE loyalty_rewards
            SET vendor_credit_status = $1,
                vendor_credit_submitted_at = NOW(),
                vendor_credit_notes = $2,
                updated_at = NOW()
            WHERE id = $3 AND merchant_id = $4
            RETURNING id, vendor_credit_status, vendor_credit_submitted_at, vendor_credit_notes
        `;
        updateParams = [status, notes || null, rewardId, merchantId];
    } else {
        updateQuery = `
            UPDATE loyalty_rewards
            SET vendor_credit_status = $1,
                vendor_credit_resolved_at = NOW(),
                vendor_credit_notes = COALESCE($2, vendor_credit_notes),
                updated_at = NOW()
            WHERE id = $3 AND merchant_id = $4
            RETURNING id, vendor_credit_status, vendor_credit_submitted_at, vendor_credit_resolved_at, vendor_credit_notes
        `;
        updateParams = [status, notes || null, rewardId, merchantId];
    }

    const result = await db.query(updateQuery, updateParams);
    return result.rows[0];
}

module.exports = {
    getRedemptions,
    getRewards,
    updateVendorCreditStatus
};
