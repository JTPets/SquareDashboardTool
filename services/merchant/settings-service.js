/**
 * Merchant Settings Service
 *
 * Manages merchant-specific configuration settings stored in the database.
 * Provides CRUD operations with automatic defaults and fallback to environment variables.
 *
 * This service was extracted from utils/database.js as part of P1-3 (utils reorganization).
 * For backward compatibility, database.js re-exports these functions.
 *
 * Usage:
 *   const { getMerchantSettings, updateMerchantSettings } = require('../services/merchant');
 *   const settings = await getMerchantSettings(merchantId);
 */

const logger = require('../../utils/logger');

// Import database query function - we use a getter to avoid circular dependency
let _db = null;
function getDb() {
    if (!_db) {
        _db = require('../../utils/database');
    }
    return _db;
}

/**
 * Default merchant settings values (fallback to env vars or hardcoded defaults)
 * These are used when no merchant-specific settings exist
 */
const DEFAULT_MERCHANT_SETTINGS = {
    reorder_safety_days: parseInt(process.env.REORDER_SAFETY_DAYS) || 7,
    default_supply_days: parseInt(process.env.DEFAULT_SUPPLY_DAYS) || 45,
    reorder_priority_urgent_days: parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS) || 0,
    reorder_priority_high_days: parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS) || 7,
    reorder_priority_medium_days: parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS) || 14,
    reorder_priority_low_days: parseInt(process.env.REORDER_PRIORITY_LOW_DAYS) || 30,
    daily_count_target: parseInt(process.env.DAILY_COUNT_TARGET) || 30,
    cycle_count_email_enabled: process.env.CYCLE_COUNT_EMAIL_ENABLED !== 'false',
    cycle_count_report_email: process.env.CYCLE_COUNT_REPORT_EMAIL !== 'false',
    additional_cycle_count_email: process.env.ADDITIONAL_CYCLE_COUNT_REPORT_EMAIL || null,
    notification_email: process.env.EMAIL_TO || null,
    low_stock_alerts_enabled: true
};

/**
 * Allowed fields for updates (whitelist for security)
 */
const ALLOWED_SETTING_FIELDS = [
    'reorder_safety_days',
    'default_supply_days',
    'reorder_priority_urgent_days',
    'reorder_priority_high_days',
    'reorder_priority_medium_days',
    'reorder_priority_low_days',
    'daily_count_target',
    'cycle_count_email_enabled',
    'cycle_count_report_email',
    'additional_cycle_count_email',
    'notification_email',
    'low_stock_alerts_enabled'
];

/**
 * Get merchant settings from database with fallback to env var defaults
 * Creates default settings for merchant if none exist
 *
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object>} Merchant settings object
 */
async function getMerchantSettings(merchantId) {
    if (!merchantId) {
        // No merchant context - return defaults from env vars
        return { ...DEFAULT_MERCHANT_SETTINGS };
    }

    const db = getDb();

    try {
        // Try to get existing settings
        const result = await db.query(`
            SELECT * FROM merchant_settings WHERE merchant_id = $1
        `, [merchantId]);

        if (result.rows.length > 0) {
            // Merge with defaults (in case new columns were added)
            return {
                ...DEFAULT_MERCHANT_SETTINGS,
                ...result.rows[0]
            };
        }

        // No settings exist - create defaults for this merchant
        const insertResult = await db.query(`
            INSERT INTO merchant_settings (
                merchant_id,
                reorder_safety_days,
                default_supply_days,
                reorder_priority_urgent_days,
                reorder_priority_high_days,
                reorder_priority_medium_days,
                reorder_priority_low_days,
                daily_count_target,
                cycle_count_email_enabled,
                cycle_count_report_email,
                additional_cycle_count_email,
                notification_email,
                low_stock_alerts_enabled
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (merchant_id) DO UPDATE SET updated_at = NOW()
            RETURNING *
        `, [
            merchantId,
            DEFAULT_MERCHANT_SETTINGS.reorder_safety_days,
            DEFAULT_MERCHANT_SETTINGS.default_supply_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_urgent_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_high_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_medium_days,
            DEFAULT_MERCHANT_SETTINGS.reorder_priority_low_days,
            DEFAULT_MERCHANT_SETTINGS.daily_count_target,
            DEFAULT_MERCHANT_SETTINGS.cycle_count_email_enabled,
            DEFAULT_MERCHANT_SETTINGS.cycle_count_report_email,
            DEFAULT_MERCHANT_SETTINGS.additional_cycle_count_email,
            DEFAULT_MERCHANT_SETTINGS.notification_email,
            DEFAULT_MERCHANT_SETTINGS.low_stock_alerts_enabled
        ]);

        logger.info('Created default merchant settings', { merchantId });
        return insertResult.rows[0];

    } catch (error) {
        // If table doesn't exist yet (pre-migration), return defaults
        if (error.message.includes('relation "merchant_settings" does not exist')) {
            logger.warn('merchant_settings table does not exist yet, using defaults');
            return { ...DEFAULT_MERCHANT_SETTINGS };
        }
        logger.error('Failed to get merchant settings', { merchantId, error: error.message, stack: error.stack });
        return { ...DEFAULT_MERCHANT_SETTINGS };
    }
}

/**
 * Update merchant settings
 *
 * @param {number} merchantId - The merchant ID
 * @param {Object} settings - Settings to update (only allowed fields will be applied)
 * @returns {Promise<Object>} Updated settings
 */
async function updateMerchantSettings(merchantId, settings) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    const db = getDb();

    // Build dynamic update query based on provided settings
    const updates = [];
    const values = [merchantId];
    let paramIndex = 2;

    for (const field of ALLOWED_SETTING_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(settings, field)) {
            updates.push(`${field} = $${paramIndex}`);
            values.push(settings[field]);
            paramIndex++;
        }
    }

    if (updates.length === 0) {
        // No valid updates - just return current settings
        return getMerchantSettings(merchantId);
    }

    updates.push('updated_at = NOW()');

    const result = await db.query(`
        UPDATE merchant_settings
        SET ${updates.join(', ')}
        WHERE merchant_id = $1
        RETURNING *
    `, values);

    if (result.rows.length === 0) {
        // Settings don't exist - create them first, then update
        await getMerchantSettings(merchantId); // This creates defaults
        return updateMerchantSettings(merchantId, settings); // Retry update
    }

    logger.info('Updated merchant settings', { merchantId, fields: Object.keys(settings) });
    return result.rows[0];
}

/**
 * Get a specific setting value with fallback to default
 *
 * @param {number} merchantId - The merchant ID
 * @param {string} settingKey - The setting key (e.g., 'reorder_safety_days')
 * @returns {Promise<any>} The setting value
 */
async function getMerchantSetting(merchantId, settingKey) {
    const settings = await getMerchantSettings(merchantId);
    return settings[settingKey] ?? DEFAULT_MERCHANT_SETTINGS[settingKey];
}

/**
 * Get all default settings (useful for UI to show defaults)
 *
 * @returns {Object} Copy of default settings
 */
function getDefaultSettings() {
    return { ...DEFAULT_MERCHANT_SETTINGS };
}

module.exports = {
    getMerchantSettings,
    updateMerchantSettings,
    getMerchantSetting,
    getDefaultSettings,
    DEFAULT_MERCHANT_SETTINGS,
    ALLOWED_SETTING_FIELDS
};
