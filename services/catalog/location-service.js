/**
 * Shared location lookup service.
 * BACKLOG-25: Extracted from 6+ routes and services with duplicate location queries.
 *
 * All queries enforce merchant_id isolation for multi-tenant security.
 */

const db = require('../../utils/database');

/**
 * Check if a merchant has any locations synced.
 * @param {number} merchantId
 * @returns {Promise<boolean>}
 */
async function hasLocations(merchantId) {
  const result = await db.query(
    'SELECT id FROM locations WHERE merchant_id = $1 LIMIT 1',
    [merchantId]
  );
  return result.rows.length > 0;
}

/**
 * Get a location by ID, verified to belong to the merchant.
 * @param {number} merchantId
 * @param {number} locationId
 * @returns {Promise<Object|null>} Location row or null
 */
async function getLocationById(merchantId, locationId) {
  const result = await db.query(
    'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
    [locationId, merchantId]
  );
  return result.rows[0] || null;
}

/**
 * Get all active location IDs for a merchant.
 * @param {number} merchantId
 * @returns {Promise<number[]>} Array of location IDs
 */
async function getActiveLocationIds(merchantId) {
  const result = await db.query(
    'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
    [merchantId]
  );
  return result.rows.map(r => r.id);
}

/**
 * Count active locations for a merchant.
 * @param {number} merchantId
 * @returns {Promise<number>}
 */
async function getActiveLocationCount(merchantId) {
  const result = await db.query(
    'SELECT COUNT(*) FROM locations WHERE active = TRUE AND merchant_id = $1',
    [merchantId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Get the first active location for a merchant (by name).
 * @param {number} merchantId
 * @returns {Promise<Object|null>} Location row or null
 */
async function getFirstActiveLocation(merchantId) {
  const result = await db.query(
    'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1 ORDER BY name LIMIT 1',
    [merchantId]
  );
  return result.rows[0] || null;
}

module.exports = {
  hasLocations,
  getLocationById,
  getActiveLocationIds,
  getActiveLocationCount,
  getFirstActiveLocation
};
