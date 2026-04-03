/**
 * Delivery Geocoding Service
 * Handles address geocoding via OpenRouteService.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getSettings, updateSettings } = require('./delivery-settings');
const { ORS_BASE_URL, ORS_API_KEY } = require('./delivery-utils');
const { updateOrder } = require('./delivery-orders');

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
            // LOGIC CHANGE (SEC-1): Added merchant_id guard for defense in depth
            await db.query(
                `UPDATE delivery_orders
                 SET address_lat = $1, address_lng = $2, geocoded_at = NOW()
                 WHERE id = $3 AND merchant_id = $4`,
                [coords.lat, coords.lng, order.id, merchantId]
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

/**
 * Geocode an address and update the delivery order's coordinates.
 * Fetches the merchant's ORS key automatically.
 * @param {number} merchantId
 * @param {string} orderId
 * @param {string} address
 * @returns {Promise<{lat, lng}|null>} Coordinates if geocoding succeeded, else null
 */
async function geocodeAndPatchOrder(merchantId, orderId, address) {
    const settings = await getSettings(merchantId);
    const coords = await geocodeAddress(address, settings?.openrouteservice_api_key);
    if (!coords) {
        logger.warn('Geocoding failed for address, coordinates not updated', { merchantId, orderId, address });
        return null;
    }
    await updateOrder(merchantId, orderId, { addressLat: coords.lat, addressLng: coords.lng, geocodedAt: new Date() });
    return coords;
}

/**
 * Geocode start/end addresses in settings body then persist the full settings update.
 * @param {number} merchantId
 * @param {Object} body - Body from PUT /settings (camelCase field names)
 * @returns {Promise<Object>} Updated settings row
 */
async function updateSettingsWithGeocode(merchantId, body) {
    const {
        startAddress, endAddress, sameDayCutoff, podRetentionDays,
        autoIngestReadyOrders, openrouteserviceApiKey
    } = body;

    let startLat = null, startLng = null, endLat = null, endLng = null;

    if (startAddress || endAddress) {
        const currentSettings = await getSettings(merchantId);
        const apiKey = currentSettings?.openrouteservice_api_key || openrouteserviceApiKey;

        if (startAddress) {
            const coords = await geocodeAddress(startAddress, apiKey);
            if (coords) { startLat = coords.lat; startLng = coords.lng; }
        }
        if (endAddress) {
            const coords = await geocodeAddress(endAddress, apiKey);
            if (coords) { endLat = coords.lat; endLng = coords.lng; }
        }
    }

    return updateSettings(merchantId, {
        startAddress,
        startAddressLat: startLat,
        startAddressLng: startLng,
        endAddress,
        endAddressLat: endLat,
        endAddressLng: endLng,
        sameDayCutoff,
        podRetentionDays,
        autoIngestReadyOrders,
        openrouteserviceApiKey
    });
}

module.exports = {
    geocodeAddress,
    geocodePendingOrders,
    geocodeAndPatchOrder,
    updateSettingsWithGeocode
};
