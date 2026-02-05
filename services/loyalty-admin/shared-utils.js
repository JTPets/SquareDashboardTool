/**
 * Loyalty Admin Shared Utilities
 *
 * Common utility functions used across loyalty admin services.
 * Includes Square API helpers and token management.
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const { decryptToken, isEncryptedToken } = require('../../utils/token-encryption');

/**
 * Fetch with timeout wrapper to prevent hanging on Square API calls
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default 15000)
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    }
}

/**
 * Get Square API access token for a merchant
 * @param {number} merchantId - Internal merchant ID
 * @returns {Promise<string|null>} Access token or null
 */
async function getSquareAccessToken(merchantId) {
    const tokenResult = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
        return null;
    }

    const rawToken = tokenResult.rows[0].square_access_token;
    return isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;
}

// Lazy-load square-api to avoid circular dependency
let squareApi = null;
function getSquareApi() {
    if (!squareApi) {
        squareApi = require('../../utils/square-api');
    }
    return squareApi;
}

module.exports = {
    fetchWithTimeout,
    getSquareAccessToken,
    getSquareApi
};
