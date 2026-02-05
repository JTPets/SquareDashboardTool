/**
 * Loyalty Settings Service
 *
 * Manages loyalty program settings per merchant.
 * Settings control behavior like auto-detection and notifications.
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');

/**
 * Get a loyalty setting value
 * @param {string} key - Setting key
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<string|null>} Setting value or null if not set
 */
async function getSetting(key, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getSetting - tenant isolation required');
    }

    const result = await db.query(`
        SELECT setting_value FROM loyalty_settings
        WHERE merchant_id = $1 AND setting_key = $2
    `, [merchantId, key]);

    return result.rows[0]?.setting_value || null;
}

/**
 * Update a loyalty setting value
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 * @param {number} merchantId - REQUIRED: Merchant ID
 */
async function updateSetting(key, value, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for updateSetting - tenant isolation required');
    }

    await db.query(`
        INSERT INTO loyalty_settings (merchant_id, setting_key, setting_value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (merchant_id, setting_key) DO UPDATE
        SET setting_value = $3, updated_at = NOW()
    `, [merchantId, key, value]);
}

/**
 * Initialize default settings for a merchant
 * @param {number} merchantId - REQUIRED: Merchant ID
 */
async function initializeDefaultSettings(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for initializeDefaultSettings');
    }

    const defaults = [
        { key: 'auto_detect_redemptions', value: 'true', desc: 'Automatically detect redemptions from orders' },
        { key: 'send_receipt_messages', value: 'true', desc: 'Send reward messages via Square receipts' },
        { key: 'loyalty_enabled', value: 'true', desc: 'Master switch for loyalty processing' }
    ];

    for (const setting of defaults) {
        await db.query(`
            INSERT INTO loyalty_settings (merchant_id, setting_key, setting_value, description)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (merchant_id, setting_key) DO NOTHING
        `, [merchantId, setting.key, setting.value, setting.desc]);
    }
}

/**
 * Get all settings for a merchant
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Object with setting key-value pairs
 */
async function getAllSettings(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getAllSettings - tenant isolation required');
    }

    const result = await db.query(`
        SELECT setting_key, setting_value, description
        FROM loyalty_settings
        WHERE merchant_id = $1
        ORDER BY setting_key
    `, [merchantId]);

    // Convert to key-value object
    const settings = {};
    for (const row of result.rows) {
        settings[row.setting_key] = {
            value: row.setting_value,
            description: row.description
        };
    }

    return settings;
}

module.exports = {
    getSetting,
    updateSetting,
    initializeDefaultSettings,
    getAllSettings
};
