/**
 * Promo Code Validation Service
 *
 * Shared promo code validation logic used by both the promo/validate
 * endpoint and the subscription create endpoint.
 *
 * Extracted from routes/subscriptions.js (BACKLOG-74).
 */

const db = require('../utils/database');

/**
 * Validate a promo code and calculate discount.
 *
 * @param {Object} params
 * @param {string} params.code - Promo code to validate
 * @param {number} params.merchantId - Internal merchant ID
 * @param {string} [params.plan] - Subscription plan key (for plan restriction check)
 * @param {number} [params.priceCents] - Price in cents (for discount calculation)
 * @returns {Promise<Object>} { valid, discount, finalPrice, error, promo }
 */
async function validatePromoCode({ code, merchantId, plan, priceCents }) {
    if (!code || !merchantId) {
        return { valid: false, error: 'Code and merchant are required' };
    }

    const result = await db.query(`
        SELECT * FROM promo_codes
        WHERE UPPER(code) = UPPER($1)
          AND merchant_id = $2
          AND is_active = TRUE
          AND (valid_from IS NULL OR valid_from <= NOW())
          AND (valid_until IS NULL OR valid_until >= NOW())
          AND (max_uses IS NULL OR times_used < max_uses)
    `, [code.trim(), merchantId]);

    if (result.rows.length === 0) {
        return { valid: false, error: 'Invalid or expired promo code' };
    }

    const promo = result.rows[0];

    // Check plan restriction
    if (promo.applies_to_plans && promo.applies_to_plans.length > 0 && plan) {
        if (!promo.applies_to_plans.includes(plan)) {
            return { valid: false, error: 'This code does not apply to the selected plan' };
        }
    }

    // Check minimum purchase
    if (promo.min_purchase_cents && priceCents && priceCents < promo.min_purchase_cents) {
        return {
            valid: false,
            error: `Minimum purchase of $${(promo.min_purchase_cents / 100).toFixed(2)} required`
        };
    }

    // Calculate discount
    let discountCents = 0;
    if (promo.discount_type === 'percent') {
        discountCents = Math.floor((priceCents || 0) * promo.discount_value / 100);
    } else {
        discountCents = promo.discount_value;
    }

    // Don't let discount exceed price
    if (priceCents && discountCents > priceCents) {
        discountCents = priceCents;
    }

    const finalPrice = (priceCents || 0) - discountCents;

    return {
        valid: true,
        discount: discountCents,
        finalPrice,
        promo
    };
}

module.exports = { validatePromoCode };
