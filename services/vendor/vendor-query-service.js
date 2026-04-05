/**
 * Vendor Query Service
 *
 * Extracted from inline route handlers in routes/vendor-catalog.js.
 * Handles simple DB queries and Square API calls that do not belong
 * in the heavier catalog-service.js (1,620 lines).
 *
 * Functions:
 *   listVendors            – list vendors with optional status filter
 *   lookupOurItemByUPC     – find our catalog item by UPC
 *   verifyVariationsBelongToMerchant – tenant-safety check before price push
 *   getMerchantTaxes       – fetch Square tax objects for a merchant
 *   confirmVendorLinks     – upsert variation_vendors rows from import review
 *
 * Multi-tenant: every function requires merchantId.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

/**
 * List vendors for a merchant, optionally filtered by status.
 * @returns {Promise<object[]>}
 */
async function listVendors(merchantId, status) {
    let sql = 'SELECT * FROM vendors WHERE merchant_id = $1';
    const params = [merchantId];
    if (status) {
        params.push(status);
        sql += ` AND status = $${params.length}`;
    }
    sql += ' ORDER BY name';
    const result = await db.query(sql, params);
    return result.rows;
}

/**
 * Look up our catalog item (variation + item) by UPC for a merchant.
 * @returns {Promise<object|null>}
 */
async function lookupOurItemByUPC(merchantId, upc) {
    const result = await db.query(`
        SELECT
            v.id, v.sku, v.name AS variation_name, v.upc, v.price_money,
            i.name AS item_name, i.category_name,
            vv.unit_cost_money AS current_cost_cents,
            vv.vendor_id AS current_vendor_id
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
        WHERE v.upc = $1
          AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
          AND v.merchant_id = $2
        LIMIT 1
    `, [upc, merchantId]);
    return result.rows[0] || null;
}

/**
 * Verify all variationIds belong to the given merchant.
 * Returns true when all IDs are verified, false otherwise.
 * @returns {Promise<boolean>}
 */
async function verifyVariationsBelongToMerchant(merchantId, variationIds) {
    const placeholders = variationIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await db.query(
        `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${variationIds.length + 1}`,
        [...variationIds, merchantId]
    );
    return result.rows.length === variationIds.length;
}

/**
 * Fetch active tax objects from Square for a merchant.
 * Returns an empty array on Square API errors (non-fatal).
 * @returns {Promise<object[]>}
 */
async function getMerchantTaxes(merchantId) {
    const { getMerchantToken, makeSquareRequest } = require('../square/square-client');
    try {
        const accessToken = await getMerchantToken(merchantId);
        const data = await makeSquareRequest('/v2/catalog/list?types=TAX', { accessToken });
        return (data.objects || [])
            .filter(obj => !obj.is_deleted)
            .map(obj => ({
                id: obj.id,
                name: obj.tax_data?.name || 'Unknown Tax',
                percentage: obj.tax_data?.percentage || null,
                enabled: obj.tax_data?.enabled !== false
            }));
    } catch (error) {
        logger.warn('Failed to fetch merchant taxes', { merchantId, error: error.message });
        return [];
    }
}

/**
 * Upsert variation_vendors rows from an import review confirmation.
 * Partial failures are logged and returned; they do not abort the batch.
 * @returns {Promise<{ created: number, failed: number, errors: object[] }>}
 */
async function confirmVendorLinks(merchantId, links) {
    let created = 0;
    const errors = [];
    for (const link of links) {
        try {
            await db.query(`
                INSERT INTO variation_vendors
                    (variation_id, vendor_id, vendor_code, unit_cost_money, currency, merchant_id, updated_at)
                VALUES ($1, $2, $3, $4, 'CAD', $5, CURRENT_TIMESTAMP)
                ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
                    vendor_code = EXCLUDED.vendor_code,
                    unit_cost_money = EXCLUDED.unit_cost_money,
                    updated_at = CURRENT_TIMESTAMP
            `, [link.variation_id, link.vendor_id, link.vendor_code || null, link.cost_cents || null, merchantId]);
            created++;
        } catch (error) {
            errors.push({ variation_id: link.variation_id, error: error.message });
            logger.error('Failed to create vendor link', {
                variation_id: link.variation_id, error: error.message, merchantId
            });
        }
    }
    return { created, failed: errors.length, errors };
}

module.exports = {
    listVendors,
    lookupOurItemByUPC,
    verifyVariationsBelongToMerchant,
    getMerchantTaxes,
    confirmVendorLinks
};
