/**
 * Delivery Geocoding Service
 * Handles address geocoding via OpenRouteService.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getSettings } = require('./delivery-settings');
const { ORS_BASE_URL, ORS_API_KEY } = require('./delivery-utils');

/**
 * Geocode an address using OpenRouteService
 * @param {string} address - The address to geocode
 * @param {string} apiKey - Optional API key override
 * @returns {Promise<Object|null>} Coordinates { lat, lng } or null
 */
async function geocodeAddress(address, apiKey = null) {
    const key = apiKey || ORS_API_KEY;

    if (!key) {
        logger.warn('OpenRouteService API key not configured for geocoding');
        return null;
    }

    try {
        const encodedAddress = encodeURIComponent(address);
        const response = await fetch(
            `${ORS_BASE_URL}/geocode/search?api_key=${key}&text=${encodedAddress}&size=1`,
            { method: 'GET' }
        );

        if (!response.ok) {
            logger.error('Geocoding API error', { status: response.status, address });
            return null;
        }

        const result = await response.json();

        if (result.features && result.features.length > 0) {
            const coords = result.features[0].geometry.coordinates;
            return {
                lng: coords[0],
                lat: coords[1],
                confidence: result.features[0].properties.confidence
            };
        }

        return null;

    } catch (err) {
        logger.error('Geocoding error', { error: err.message, address });
        return null;
    }
}

/**
 * Geocode pending orders that don't have coordinates
 * @param {number} merchantId - The merchant ID
 * @param {number} limit - Max orders to geocode in one batch
 * @returns {Promise<Object>} Geocoding results
 */
async function geocodePendingOrders(merchantId, limit = 10) {
    const settings = await getSettings(merchantId);
    const apiKey = settings?.openrouteservice_api_key || ORS_API_KEY;

    const ordersResult = await db.query(
        `SELECT id, address FROM delivery_orders
         WHERE merchant_id = $1 AND geocoded_at IS NULL
         ORDER BY created_at ASC
         LIMIT $2`,
        [merchantId, limit]
    );

    const results = { success: 0, failed: 0, orders: [] };

    for (const order of ordersResult.rows) {
        const coords = await geocodeAddress(order.address, apiKey);

        if (coords && coords.lat && coords.lng) {
            await db.query(
                `UPDATE delivery_orders
                 SET address_lat = $1, address_lng = $2, geocoded_at = NOW()
                 WHERE id = $3`,
                [coords.lat, coords.lng, order.id]
            );
            results.success++;
            results.orders.push({ id: order.id, status: 'success', coords });
        } else {
            results.failed++;
            results.orders.push({ id: order.id, status: 'failed', address: order.address });
        }

        // Rate limit: wait 100ms between requests
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
}

module.exports = {
    geocodeAddress,
    geocodePendingOrders
};
