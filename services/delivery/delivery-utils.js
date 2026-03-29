/**
 * Delivery Utility Functions
 * Shared constants and helpers used across delivery modules.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 */

const path = require('path');
const crypto = require('crypto');

// Customer lookup for fallback when fulfillment recipient data is missing
const { getCustomerDetails: getSquareCustomerDetails } = require('../loyalty-admin/customer-details-service');

// POD storage directory (relative to app root)
const POD_STORAGE_DIR = process.env.POD_STORAGE_DIR || 'storage/pod';

// OpenRouteService configuration
const ORS_BASE_URL = 'https://api.openrouteservice.org';
const ORS_API_KEY = process.env.OPENROUTESERVICE_API_KEY;

// UUID validation regex (for security - validate IDs before use)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Safely stringify objects containing BigInt values
 * Square SDK returns BigInt for money amounts which JSON.stringify can't handle
 * @param {*} obj - Object to stringify
 * @returns {string} JSON string
 */
function safeJsonStringify(obj) {
    return JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? Number(value) : value
    );
}

/**
 * Validate UUID format
 * @param {string} id - ID to validate
 * @param {string} fieldName - Field name for error message
 * @throws {Error} If ID is not a valid UUID
 */
function validateUUID(id, fieldName = 'ID') {
    if (!id || !UUID_REGEX.test(id)) {
        throw new Error(`Invalid ${fieldName} format`);
    }
}

module.exports = {
    POD_STORAGE_DIR,
    ORS_BASE_URL,
    ORS_API_KEY,
    UUID_REGEX,
    safeJsonStringify,
    validateUUID,
    getSquareCustomerDetails
};
