/**
 * Merchant Service Layer
 *
 * Public API for merchant-related services. This module provides:
 * - Merchant settings management
 *
 * Usage:
 *   const { getMerchantSettings, updateMerchantSettings } = require('./services/merchant');
 *
 *   const settings = await getMerchantSettings(merchantId);
 *   const updated = await updateMerchantSettings(merchantId, { daily_count_target: 50 });
 *
 * For defaults:
 *   const { DEFAULT_MERCHANT_SETTINGS, getDefaultSettings } = require('./services/merchant');
 */

const {
    getMerchantSettings,
    updateMerchantSettings,
    getMerchantSetting,
    getDefaultSettings,
    DEFAULT_MERCHANT_SETTINGS,
    ALLOWED_SETTING_FIELDS
} = require('./settings-service');

module.exports = {
    // Settings functions
    getMerchantSettings,
    updateMerchantSettings,
    getMerchantSetting,
    getDefaultSettings,

    // Constants
    DEFAULT_MERCHANT_SETTINGS,
    ALLOWED_SETTING_FIELDS
};
