/**
 * Square Locations Service
 *
 * Syncs location data from Square API to the local database.
 *
 * Exports:
 *   syncLocations(merchantId) — fetch and upsert all Square locations
 *
 * Usage:
 *   const { syncLocations } = require('./services/square');
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest } = require('./square-client');

/**
 * Sync locations from Square
 * @param {number} merchantId - The merchant ID to sync for
 * @returns {Promise<number>} Number of locations synced
 */
async function syncLocations(merchantId) {
    logger.info('Starting location sync', { merchantId });

    try {
        // Get merchant-specific token
        const accessToken = await getMerchantToken(merchantId);
        const data = await makeSquareRequest('/v2/locations', { accessToken });
        const locations = data.locations || [];

        let synced = 0;
        for (const loc of locations) {
            await db.query(`
                INSERT INTO locations (id, name, square_location_id, active, address, timezone, phone_number, business_email, merchant_id, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    square_location_id = EXCLUDED.square_location_id,
                    active = EXCLUDED.active,
                    address = EXCLUDED.address,
                    timezone = EXCLUDED.timezone,
                    phone_number = EXCLUDED.phone_number,
                    business_email = EXCLUDED.business_email,
                    merchant_id = EXCLUDED.merchant_id,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                loc.id,
                loc.name,
                loc.id,
                loc.status === 'ACTIVE',
                loc.address ? JSON.stringify(loc.address) : null,
                loc.timezone,
                loc.phoneNumber || null,
                loc.businessEmail || null,
                merchantId
            ]);
            synced++;
        }

        logger.info('Location sync complete', { merchantId, count: synced });
        return synced;
    } catch (error) {
        logger.error('Location sync failed', { error: error.message, stack: error.stack });
        throw error;
    }
}

module.exports = {
    syncLocations
};
