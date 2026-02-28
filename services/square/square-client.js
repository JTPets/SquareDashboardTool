/**
 * Square API Client — Shared Infrastructure
 *
 * Low-level HTTP client for Square API requests with retry/rate-limit handling,
 * merchant token resolution, and shared utilities. All other square-* modules
 * depend on this module.
 *
 * Exports:
 *   getMerchantToken(merchantId)          — decrypt per-merchant access token
 *   makeSquareRequest(endpoint, options)  — HTTP client with retry + rate-limit
 *   sleep(ms)                             — delay utility
 *   generateIdempotencyKey(prefix)        — re-export from utils/idempotency
 *
 * Usage:
 *   const { getMerchantToken, makeSquareRequest } = require('./square-client');
 */

const fetch = require('node-fetch');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { decryptToken, isEncryptedToken, encryptToken } = require('../../utils/token-encryption');
const { generateIdempotencyKey } = require('../../utils/idempotency');

// Square API configuration
const SQUARE_BASE_URL = 'https://connect.squareup.com';

// Rate limiting and retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const { SQUARE: { API_VERSION: SQUARE_API_VERSION } } = require('../../config/constants');

/**
 * Get decrypted access token for a merchant
 * @param {number} merchantId - The merchant ID (REQUIRED)
 * @returns {Promise<string>} Decrypted access token
 */
async function getMerchantToken(merchantId) {
    // NOTE: Legacy single-tenant fallback removed (2026-01-05)
    // merchantId is now required - no more fallback to ACCESS_TOKEN env var
    if (!merchantId) {
        throw new Error('merchantId is required - legacy single-tenant mode removed');
    }

    const result = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (result.rows.length === 0) {
        throw new Error(`Merchant ${merchantId} not found or inactive`);
    }

    const token = result.rows[0].square_access_token;

    if (!token) {
        throw new Error(`Merchant ${merchantId} has no access token configured`);
    }

    // Check if token is encrypted - if not, it's a legacy unencrypted token
    if (!isEncryptedToken(token)) {
        logger.warn('Found unencrypted legacy token, encrypting for future use', { merchantId });
        // Token is not encrypted - this is a legacy token
        // Encrypt it and save for next time, but return the raw token for this request
        try {
            const encryptedToken = encryptToken(token);
            await db.query(
                'UPDATE merchants SET square_access_token = $1 WHERE id = $2',
                [encryptedToken, merchantId]
            );
            logger.info('Legacy token encrypted and saved', { merchantId });
        } catch (encryptError) {
            logger.error('Failed to encrypt legacy token', { merchantId, error: encryptError.message });
        }
        return token; // Return the raw token for this request
    }

    return decryptToken(token);
}

/**
 * Make a Square API request with error handling and retry logic
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options (can include accessToken for multi-tenant)
 * @returns {Promise<Object>} Response data
 */
async function makeSquareRequest(endpoint, options = {}) {
    const url = `${SQUARE_BASE_URL}${endpoint}`;
    // NOTE: Legacy single-tenant fallback removed (2026-01-05)
    // accessToken is now required for all requests
    const token = options.accessToken;
    if (!token) {
        throw new Error('accessToken is required in options - legacy single-tenant mode removed');
    }
    const headers = {
        'Square-Version': SQUARE_API_VERSION,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    // Remove accessToken from options so it doesn't get passed to fetch
    delete options.accessToken;

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url, {
                ...options,
                headers,
                signal: controller.signal
            });

            const data = await response.json();

            if (!response.ok) {
                // Handle rate limiting - this is retryable
                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '5');
                    logger.warn(`Rate limited. Retrying after ${retryAfter} seconds`);
                    await sleep(retryAfter * 1000);
                    continue;
                }

                // Handle auth errors - don't retry
                if (response.status === 401) {
                    throw new Error('Square API authentication failed. Check your access token.');
                }

                // Check for non-retryable errors (idempotency conflicts, version conflicts, validation errors)
                const errorCodes = (data.errors || []).map(e => e.code);
                const nonRetryableErrors = [
                    'IDEMPOTENCY_KEY_REUSED',
                    'VERSION_MISMATCH',
                    'CONFLICT',
                    'INVALID_REQUEST_ERROR'
                ];
                const hasNonRetryableError = errorCodes.some(code => nonRetryableErrors.includes(code));

                // Don't retry 400/409 errors or specific non-retryable error codes
                if (response.status === 400 || response.status === 409 || hasNonRetryableError) {
                    // Throw immediately without retry by breaking out of the loop
                    const err = new Error(`Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`);
                    err.nonRetryable = true;
                    err.squareErrors = data.errors || [];
                    throw err;
                }

                const err = new Error(`Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`);
                err.squareErrors = data.errors || [];
                throw err;
            }

            return data;
        } catch (error) {
            // Convert AbortError to a descriptive timeout error
            if (error.name === 'AbortError') {
                lastError = new Error(`Square API request timed out after 30s: ${endpoint}`);
                logger.warn('Square API request timed out', { endpoint, attempt: attempt + 1 });
                if (attempt < MAX_RETRIES - 1) {
                    const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                    await sleep(delay);
                }
                continue;
            }

            lastError = error;

            // Don't retry non-retryable errors
            if (error.nonRetryable) {
                throw error;
            }

            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                logger.warn(`Request failed, retrying in ${delay}ms`, { attempt: attempt + 1, max_retries: MAX_RETRIES });
                await sleep(delay);
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError;
}

/**
 * Sleep utility for delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    getMerchantToken,
    makeSquareRequest,
    sleep,
    generateIdempotencyKey,
    // Constants (used by other square modules)
    SQUARE_BASE_URL,
    MAX_RETRIES,
    RETRY_DELAY_MS
};
