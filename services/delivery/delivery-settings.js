/**
 * Delivery Settings Service
 * Manages merchant delivery settings including ORS API key encryption.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { encryptToken, decryptToken, isEncryptedToken } = require('../../utils/token-encryption');

/**
 * Get delivery settings for a merchant
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object|null>} Settings or null
 */
async function getSettings(merchantId) {
    const result = await db.query(
        `SELECT * FROM delivery_settings WHERE merchant_id = $1`,
        [merchantId]
    );
    const settings = result.rows[0] || null;
    if (settings) {
        settings.openrouteservice_api_key = _decryptOrsKey(settings);
    }
    return settings;
}

/**
 * Decrypt the ORS API key from delivery settings.
 * Handles migration from plaintext (openrouteservice_api_key) to encrypted (ors_api_key_encrypted).
 * If a plaintext key exists but no encrypted key, encrypts it in place (encrypt-on-read).
 * @param {Object} settings - Raw delivery_settings row
 * @returns {string|null} Decrypted API key or null
 */
function _decryptOrsKey(settings) {
    // Prefer encrypted column
    if (settings.ors_api_key_encrypted) {
        try {
            return decryptToken(settings.ors_api_key_encrypted);
        } catch (err) {
            // LOGIC CHANGE: Log decryption error with downstream impact context.
            // Previously the error was logged but callers had no idea why geocoding
            // silently failed (null key → geocodeAddress returns null → no coordinates).
            logger.error('Failed to decrypt ORS API key — geocoding will be unavailable', {
                merchantId: settings.merchant_id,
                error: err.message,
                impact: 'geocoding_disabled'
            });
            return null;
        }
    }

    // Migrate plaintext key to encrypted on read
    if (settings.openrouteservice_api_key) {
        const plaintext = settings.openrouteservice_api_key;
        try {
            const encrypted = encryptToken(plaintext);
            // Fire-and-forget migration update
            db.query(
                `UPDATE delivery_settings
                 SET ors_api_key_encrypted = $1, openrouteservice_api_key = NULL, updated_at = NOW()
                 WHERE merchant_id = $2`,
                [encrypted, settings.merchant_id]
            ).catch(err => {
                logger.warn('Failed to migrate ORS key to encrypted storage', {
                    merchantId: settings.merchant_id,
                    error: err.message
                });
            });
            return plaintext;
        } catch (err) {
            logger.error('Failed to encrypt ORS API key during migration', {
                merchantId: settings.merchant_id,
                error: err.message
            });
            return plaintext;
        }
    }

    return null;
}

/**
 * Update delivery settings for a merchant
 * @param {number} merchantId - The merchant ID
 * @param {Object} settings - Settings to update
 * @returns {Promise<Object>} Updated settings
 */
async function updateSettings(merchantId, settings) {
    const {
        startAddress = null,
        startAddressLat = null,
        startAddressLng = null,
        endAddress = null,
        endAddressLat = null,
        endAddressLng = null,
        sameDayCutoff = null,
        podRetentionDays = null,
        autoIngestReadyOrders = null,
        openrouteserviceApiKey = null
    } = settings;

    // Encrypt ORS API key before storage
    const encryptedOrsKey = openrouteserviceApiKey ? encryptToken(openrouteserviceApiKey) : null;

    const result = await db.query(
        `INSERT INTO delivery_settings (
            merchant_id, start_address, start_address_lat, start_address_lng,
            end_address, end_address_lat, end_address_lng,
            same_day_cutoff, pod_retention_days, auto_ingest_ready_orders,
            ors_api_key_encrypted
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (merchant_id) DO UPDATE SET
            start_address = COALESCE($2, delivery_settings.start_address),
            start_address_lat = COALESCE($3, delivery_settings.start_address_lat),
            start_address_lng = COALESCE($4, delivery_settings.start_address_lng),
            end_address = COALESCE($5, delivery_settings.end_address),
            end_address_lat = COALESCE($6, delivery_settings.end_address_lat),
            end_address_lng = COALESCE($7, delivery_settings.end_address_lng),
            same_day_cutoff = COALESCE($8, delivery_settings.same_day_cutoff),
            pod_retention_days = COALESCE($9, delivery_settings.pod_retention_days),
            auto_ingest_ready_orders = COALESCE($10, delivery_settings.auto_ingest_ready_orders),
            ors_api_key_encrypted = COALESCE($11, delivery_settings.ors_api_key_encrypted),
            updated_at = NOW()
        RETURNING *`,
        [
            merchantId, startAddress, startAddressLat, startAddressLng,
            endAddress, endAddressLat, endAddressLng,
            sameDayCutoff, podRetentionDays, autoIngestReadyOrders,
            encryptedOrsKey
        ]
    );

    const updatedSettings = result.rows[0];
    // Decrypt ORS key in returned settings for consistency
    if (updatedSettings) {
        updatedSettings.openrouteservice_api_key = _decryptOrsKey(updatedSettings);
    }

    logger.info('Updated delivery settings', { merchantId });
    return updatedSettings;
}

module.exports = {
    getSettings,
    _decryptOrsKey,
    updateSettings
};
