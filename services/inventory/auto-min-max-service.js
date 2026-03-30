/**
 * Auto Min/Max Stock Recommendation Service
 *
 * Generates conservative min-stock recommendations based on velocity and inventory.
 * RECOMMENDATION ONLY — does not auto-apply without merchant approval.
 *
 * Rules (Rule 3 wins over all):
 *   Rule 1 (OVERSTOCKED):       days_of_stock > 90 AND min > 0 → recommend min - 1
 *   Rule 2 (SOLDOUT_FAST_MOVER): qty=0, velocity>=0.15, min < ceil(vel*14) → min + 1
 *   Rule 3 (EXPIRING):          tier IN (AUTO25, AUTO50, EXPIRED) → recommend 0
 *
 * Note: sales_velocity has no last_sold_at column.
 * Recent-sales check uses loyalty_purchase_events.purchased_at (most recent non-refund sale).
 * Items with no loyalty data are considered "not recently sold" for the safety check.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

const EXPIRY_TIERS = new Set(['AUTO25', 'AUTO50', 'EXPIRED']);

// ==================== DATA QUERY ====================

const DATA_QUERY = `
    SELECT
        sv.variation_id,
        sv.location_id,
        v.name AS variation_name,
        i.name AS item_name,
        v.sku,
        sv.daily_avg_quantity AS velocity_91d,
        COALESCE(ic.quantity, 0) AS quantity,
        CASE
            WHEN sv.daily_avg_quantity > 0
            THEN COALESCE(ic.quantity, 0)::numeric / sv.daily_avg_quantity
            ELSE 999999
        END AS days_of_stock,
        COALESCE(vls.stock_alert_min, 0) AS current_min,
        edt.tier_code AS expiry_tier,
        (
            SELECT MAX(lpe.purchased_at)
            FROM loyalty_purchase_events lpe
            WHERE lpe.variation_id = sv.variation_id
              AND lpe.merchant_id = $1
              AND lpe.is_refund = FALSE
        ) AS last_sold_at
    FROM sales_velocity sv
    JOIN variations v ON v.id = sv.variation_id AND v.merchant_id = sv.merchant_id
    JOIN items i ON i.id = v.item_id AND i.merchant_id = sv.merchant_id
    LEFT JOIN inventory_counts ic
        ON ic.catalog_object_id = sv.variation_id
        AND ic.location_id = sv.location_id
        AND ic.state = 'IN_STOCK'
        AND ic.merchant_id = sv.merchant_id
    LEFT JOIN variation_location_settings vls
        ON vls.variation_id = sv.variation_id
        AND vls.location_id = sv.location_id
    LEFT JOIN variation_discount_status vds
        ON vds.variation_id = sv.variation_id
        AND vds.merchant_id = sv.merchant_id
    LEFT JOIN expiry_discount_tiers edt
        ON edt.id = vds.current_tier_id
    WHERE sv.merchant_id = $1
      AND sv.period_days = 91
      AND v.is_deleted = FALSE
      AND i.is_deleted = FALSE
`;

// ==================== PUBLIC API ====================

/**
 * Generate min-stock recommendations for all variations.
 * Read-only — does not apply changes.
 *
 * @param {number} merchantId
 * @returns {Promise<Array>} recommendations (includges skipped items with recommendedMin=null)
 */
async function generateRecommendations(merchantId) {
    if (!merchantId) throw new Error('merchantId is required');

    const result = await db.query(DATA_QUERY, [merchantId]);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    return result.rows
        .map(row => _evaluateRules(row, thirtyDaysAgo))
        .filter(Boolean);
}

/**
 * Apply a single recommendation — updates variation_location_settings and logs audit.
 *
 * @param {number} merchantId
 * @param {string} variationId
 * @param {string} locationId
 * @param {number} newMin - non-negative integer
 */
async function applyRecommendation(merchantId, variationId, locationId, newMin) {
    _validateApplyArgs(merchantId, variationId, locationId, newMin);
    return db.transaction(async (client) => {
        return _applyOne(client, merchantId, variationId, locationId, newMin,
            'MANUAL_APPLY', 'Applied via API', null, null, null);
    });
}

/**
 * Apply all passed recommendations in a single transaction.
 *
 * @param {number} merchantId
 * @param {Array<{variationId, locationId, newMin, rule, reason, velocity91d, daysOfStock, quantity}>} recommendations
 * @returns {Promise<{applied: number, failed: number, errors: Array}>}
 */
async function applyAllRecommendations(merchantId, recommendations) {
    if (!merchantId) throw new Error('merchantId is required');
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
        return { applied: 0, failed: 0, errors: [] };
    }

    let applied = 0;
    await db.transaction(async (client) => {
        for (const rec of recommendations) {
            await _applyOne(
                client, merchantId,
                rec.variationId, rec.locationId, rec.newMin,
                rec.rule || 'UNKNOWN', rec.reason || '',
                rec.velocity91d ?? null,
                rec.daysOfStock ?? null,
                rec.quantity ?? null
            );
            applied++;
        }
    });

    logger.info('Applied all min stock recommendations', { merchantId, applied });
    return { applied, failed: 0, errors: [] };
}

// ==================== INTERNALS ====================

/**
 * Evaluate business rules for a single data row.
 * Returns a recommendation object or null if no change is needed.
 */
function _evaluateRules(row, thirtyDaysAgo) {
    const vel = parseFloat(row.velocity_91d) || 0;
    const qty = parseInt(row.quantity) || 0;
    // Use isNaN check — parseFloat(null)=NaN, parseFloat('0')=0 (must not use || here)
    const rawDos = parseFloat(row.days_of_stock);
    const dos = isNaN(rawDos) ? 999999 : rawDos;
    const min = parseInt(row.current_min) || 0;

    // Rule 3 (highest priority): active expiry discount → min = 0
    if (row.expiry_tier && EXPIRY_TIERS.has(row.expiry_tier)) {
        if (min === 0) return null;
        return _buildRec(row, 0, 'EXPIRING',
            `Active expiry discount (${row.expiry_tier}) — do not reorder`);
    }

    // Rule 1: overstocked slow mover → min - 1
    if (dos > 90 && min > 0) {
        return _buildRec(row, min - 1, 'OVERSTOCKED',
            `Overstocked — ${Math.round(dos)} days of stock at current velocity`);
    }

    // Rule 2: sold out fast mover → min + 1 (capped)
    if (qty === 0 && vel >= 0.15) {
        const targetMin = Math.ceil(vel * 14);
        if (min >= targetMin) return null;

        const recentlySold = row.last_sold_at &&
            new Date(row.last_sold_at) >= thirtyDaysAgo;

        if (!recentlySold) {
            return _buildRec(row, null, 'SOLDOUT_FAST_MOVER',
                'Sold out but no recent sales — possible supplier issue');
        }

        const cap = Math.ceil(vel * 30);
        const recommended = Math.min(min + 1, cap);
        if (recommended <= min) return null;

        return _buildRec(row, recommended, 'SOLDOUT_FAST_MOVER',
            `Sold out with ${vel.toFixed(2)} daily sales — increase to prevent stockout`);
    }

    return null;
}

function _buildRec(row, recommendedMin, rule, reason) {
    return {
        variationId: row.variation_id,
        locationId: row.location_id,
        variationName: row.variation_name,
        itemName: row.item_name,
        sku: row.sku,
        currentMin: parseInt(row.current_min) || 0,
        recommendedMin,
        rule,
        reason,
        velocity91d: parseFloat(row.velocity_91d) || 0,
        daysOfStock: row.days_of_stock != null ? parseFloat(row.days_of_stock) : null,
        quantity: parseInt(row.quantity) || 0,
    };
}

async function _applyOne(client, merchantId, variationId, locationId, newMin,
    rule, reason, velocity91d, daysOfStock, quantity) {
    const current = await client.query(
        `SELECT COALESCE(stock_alert_min, 0) AS stock_alert_min
         FROM variation_location_settings
         WHERE variation_id = $1 AND location_id = $2 AND merchant_id = $3`,
        [variationId, locationId, merchantId]
    );
    const previousMin = current.rows.length > 0
        ? parseInt(current.rows[0].stock_alert_min) || 0
        : 0;

    await client.query(
        `INSERT INTO variation_location_settings
             (variation_id, location_id, merchant_id, stock_alert_min, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (variation_id, location_id, merchant_id)
         DO UPDATE SET stock_alert_min = $4, updated_at = NOW()`,
        [variationId, locationId, merchantId, newMin]
    );

    await client.query(
        `INSERT INTO min_stock_audit
             (merchant_id, variation_id, location_id, previous_min, new_min,
              rule, reason, velocity_91d, days_of_stock, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [merchantId, variationId, locationId, previousMin, newMin,
            rule, reason, velocity91d, daysOfStock, quantity]
    );

    return { variationId, locationId, previousMin, newMin };
}

function _validateApplyArgs(merchantId, variationId, locationId, newMin) {
    if (!merchantId || !variationId || !locationId) {
        throw new Error('merchantId, variationId, and locationId are required');
    }
    if (!Number.isInteger(newMin) || newMin < 0) {
        throw new Error('newMin must be a non-negative integer');
    }
}

module.exports = { generateRecommendations, applyRecommendation, applyAllRecommendations };
