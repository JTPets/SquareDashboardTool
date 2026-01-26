/**
 * Catalog Item Service
 *
 * Business logic for basic catalog queries:
 * - Locations
 * - Categories
 * - Items
 *
 * Extracted from routes/catalog.js as part of P1-2 (fat routes service extraction).
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

/**
 * Get store locations for a merchant
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - { count, locations }
 */
async function getLocations(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getLocations');
    }

    const result = await db.query(`
        SELECT id, name, active, address, timezone
        FROM locations
        WHERE merchant_id = $1
        ORDER BY name
    `, [merchantId]);

    logger.info('Catalog service: getLocations', { count: result.rows.length, merchantId });

    return {
        count: result.rows.length,
        locations: result.rows
    };
}

/**
 * Get distinct categories from items
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<string[]>} - Array of category names
 */
async function getCategories(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getCategories');
    }

    const result = await db.query(`
        SELECT DISTINCT i.category_name
        FROM items i
        WHERE i.category_name IS NOT NULL
          AND i.category_name != ''
          AND COALESCE(i.is_deleted, FALSE) = FALSE
          AND i.merchant_id = $1
        ORDER BY i.category_name
    `, [merchantId]);

    logger.info('Catalog service: getCategories', { count: result.rows.length, merchantId });

    return result.rows.map(row => row.category_name);
}

/**
 * Get items with optional filtering
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @param {Object} filters - Optional filters { name, category }
 * @returns {Promise<Object>} - { count, items }
 */
async function getItems(merchantId, filters = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required for getItems');
    }

    const { name, category } = filters;

    let query = `
        SELECT i.*, c.name as category_name
        FROM items i
        LEFT JOIN categories c ON i.category_id = c.id AND c.merchant_id = $1
        WHERE i.merchant_id = $1
    `;
    const params = [merchantId];

    if (name) {
        params.push(`%${name}%`);
        query += ` AND i.name ILIKE $${params.length}`;
    }

    if (category) {
        params.push(`%${category}%`);
        query += ` AND c.name ILIKE $${params.length}`;
    }

    query += ' ORDER BY i.name';

    const result = await db.query(query, params);

    logger.info('Catalog service: getItems', { count: result.rows.length, merchantId });

    return {
        count: result.rows.length,
        items: result.rows || []
    };
}

module.exports = {
    getLocations,
    getCategories,
    getItems
};
