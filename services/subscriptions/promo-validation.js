/**
 * Promo Code Validation Service
 *
 * Shared promo code validation logic used by both the promo/validate
 * endpoint and the subscription create endpoint.
 *
 * Extracted from routes/subscriptions.js (BACKLOG-74).
 *
 * Supported discount_type values:
 *   'percent'     — discount_value is a percentage (e.g. 20 = 20% off)
 *   'fixed'       — discount_value is cents off (e.g. 500 = $5.00 off)
 *   'fixed_price' — fixed_price_cents is the flat monthly rate (e.g. 99 = $0.99/mo)
 *
 * Platform-owner fallback: codes owned by the platform_owner merchant are
 * visible to all merchants (used for site-wide beta promos).
 */

const db = require('../../utils/database');

/**
 * Validate a promo code and calculate discount.
 *
 * Looks up the code in promo_codes, checking:
 *   1. The merchant's own codes (merchant_id = merchantId)
 *   2. Platform-owner codes (subscription_status = 'platform_owner')
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
        SELECT pc.* FROM promo_codes pc
        JOIN merchants m ON m.id = pc.merchant_id
        WHERE UPPER(pc.code) = UPPER($1)
          AND (pc.merchant_id = $2 OR m.subscription_status = 'platform_owner')
          AND pc.is_active = TRUE
          AND (pc.valid_from IS NULL OR pc.valid_from <= NOW())
          AND (pc.valid_until IS NULL OR pc.valid_until >= NOW())
          AND (pc.max_uses IS NULL OR pc.times_used < pc.max_uses)
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
    let finalPrice = priceCents || 0;

    if (promo.discount_type === 'fixed_price') {
        // fixed_price: subscriber pays a flat rate instead of the normal price
        const flatRate = promo.fixed_price_cents || 0;
        discountCents = Math.max(0, (priceCents || 0) - flatRate);
        finalPrice = flatRate;
    } else if (promo.discount_type === 'percent') {
        discountCents = Math.floor((priceCents || 0) * promo.discount_value / 100);
        finalPrice = (priceCents || 0) - discountCents;
    } else {
        // 'fixed' — cents off
        discountCents = promo.discount_value;
        // Don't let discount exceed price
        if (priceCents && discountCents > priceCents) {
            discountCents = priceCents;
        }
        finalPrice = (priceCents || 0) - discountCents;
    }

    return {
        valid: true,
        discount: discountCents,
        finalPrice,
        promo
    };
}

/**
 * Check a platform-owner promo code for the public pricing page.
 * Only looks up codes owned by the platform_owner merchant (site-wide promos).
 *
 * @param {string} code - Promo code to check
 * @returns {Promise<Object>} { valid: false } or { valid: true, code, description, discountType, discountDisplay, durationMonths }
 */
async function checkPublicPromo(code) {
    const result = await db.query(`
        SELECT pc.code, pc.description, pc.discount_type, pc.discount_value,
               pc.fixed_price_cents, pc.duration_months
        FROM promo_codes pc
        JOIN merchants m ON m.id = pc.merchant_id
        WHERE UPPER(pc.code) = UPPER($1)
          AND m.subscription_status = 'platform_owner'
          AND pc.is_active = TRUE
          AND (pc.valid_from IS NULL OR pc.valid_from <= NOW())
          AND (pc.valid_until IS NULL OR pc.valid_until >= NOW())
          AND (pc.max_uses IS NULL OR pc.times_used < pc.max_uses)
    `, [code]);

    if (result.rows.length === 0) {
        return { valid: false };
    }

    const promo = result.rows[0];
    let discountDisplay;
    if (promo.discount_type === 'fixed_price') {
        discountDisplay = `$${(promo.fixed_price_cents / 100).toFixed(2)}/mo`;
    } else if (promo.discount_type === 'percent') {
        discountDisplay = `${promo.discount_value}% off`;
    } else {
        discountDisplay = `$${(promo.discount_value / 100).toFixed(2)} off`;
    }

    return {
        valid: true,
        code: promo.code,
        description: promo.description,
        discountType: promo.discount_type,
        discountDisplay,
        durationMonths: promo.duration_months || null
    };
}

module.exports = { validatePromoCode, checkPublicPromo };
