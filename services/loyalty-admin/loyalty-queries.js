/**
 * Shared Loyalty Queries
 *
 * Canonical SQL queries for offer and variation lookups used by both
 * the webhook service layer (services/loyalty/) and the admin layer
 * (services/loyalty-admin/).
 *
 * Created to resolve DEDUP L-5 — overlapping query implementations
 * with divergent WHERE clauses (missing is_active filters in webhook layer).
 *
 * RULES:
 * - Every query MUST filter by merchant_id (tenant isolation)
 * - Every variation query MUST filter is_active = TRUE unless explicitly noted
 * - Do NOT add business logic here — queries only
 *
 * @module services/loyalty-admin/loyalty-queries
 */

const db = require('../../utils/database');

/**
 * Get qualifying variations for an offer (active only)
 *
 * @param {number} offerId - Offer ID
 * @param {number} merchantId - Merchant ID (tenant isolation)
 * @returns {Promise<Array>} Array of qualifying variation rows
 */
async function queryQualifyingVariations(offerId, merchantId) {
    const result = await db.query(`
        SELECT lqv.id, lqv.variation_id, lqv.variation_name,
               lqv.item_name, lqv.item_id, lqv.sku,
               lqv.is_active, lqv.created_at, lqv.updated_at,
               lqv.offer_id, lqv.merchant_id
        FROM loyalty_qualifying_variations lqv
        WHERE lqv.offer_id = $1
          AND lqv.merchant_id = $2
          AND lqv.is_active = TRUE
        ORDER BY lqv.item_name, lqv.variation_name
    `, [offerId, merchantId]);

    return result.rows;
}

/**
 * Get the active offer that a variation qualifies for
 *
 * Returns the offer + variation_id for a single variation.
 * Both the offer and the variation link must be active.
 *
 * @param {string} variationId - Square catalog variation ID
 * @param {number} merchantId - Merchant ID (tenant isolation)
 * @returns {Promise<Object|null>} Offer row with variation_id, or null
 */
async function queryOfferForVariation(variationId, merchantId) {
    const result = await db.query(`
        SELECT o.*, qv.variation_id
        FROM loyalty_offers o
        JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id
        WHERE qv.variation_id = $1
          AND qv.merchant_id = $2
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
    `, [variationId, merchantId]);

    return result.rows[0] || null;
}

/**
 * Get all active offers that include a specific variation
 *
 * Similar to queryOfferForVariation but returns ALL matching offers
 * (a variation could theoretically match multiple, though business rules
 * currently enforce one-to-one via conflict checks).
 *
 * @param {string} variationId - Square catalog variation ID
 * @param {number} merchantId - Merchant ID (tenant isolation)
 * @returns {Promise<Array>} Array of offer rows with variation details
 */
async function queryOffersForVariation(variationId, merchantId) {
    const result = await db.query(`
        SELECT
            o.id,
            o.offer_name,
            o.description,
            o.required_quantity,
            o.reward_quantity,
            o.window_months,
            o.is_active,
            qv.variation_id,
            qv.variation_name,
            qv.item_name
        FROM loyalty_offers o
        INNER JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id
        WHERE o.merchant_id = $1
          AND o.is_active = TRUE
          AND qv.is_active = TRUE
          AND qv.variation_id = $2
    `, [merchantId, variationId]);

    return result.rows;
}

/**
 * Get all distinct qualifying variation IDs for a merchant
 *
 * Both the offer and the variation link must be active.
 *
 * @param {number} merchantId - Merchant ID (tenant isolation)
 * @returns {Promise<Array<string>>} Array of variation ID strings
 */
async function queryAllQualifyingVariationIds(merchantId) {
    const result = await db.query(`
        SELECT DISTINCT lqv.variation_id
        FROM loyalty_qualifying_variations lqv
        INNER JOIN loyalty_offers lo ON lqv.offer_id = lo.id
        WHERE lo.merchant_id = $1
          AND lo.is_active = TRUE
          AND lqv.is_active = TRUE
    `, [merchantId]);

    return result.rows.map(r => r.variation_id);
}

module.exports = {
    queryQualifyingVariations,
    queryOfferForVariation,
    queryOffersForVariation,
    queryAllQualifyingVariationIds
};
