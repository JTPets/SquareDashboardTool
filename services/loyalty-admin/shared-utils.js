/**
 * Loyalty Admin Shared Utilities
 *
 * Common utility functions used across loyalty admin services.
 * Includes Square API helpers, token management, and retry-enabled
 * Square API request function (ported from services/loyalty/square-client.js
 * as part of L-6 unification).
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const crypto = require('crypto');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { decryptToken, isEncryptedToken } = require('../../utils/token-encryption');

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';
const SQUARE_API_VERSION = '2025-01-16';

/**
 * Custom error class for Square API errors
 */
class SquareApiError extends Error {
    constructor(message, status, endpoint, details = {}) {
        super(message);
        this.name = 'SquareApiError';
        this.status = status;
        this.endpoint = endpoint;
        this.details = details;
    }
}

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
 * Make a Square API request with retry logic for 429 rate limiting.
 * Ported from services/loyalty/square-client.js (L-6 unification).
 *
 * @param {string} accessToken - Square API access token
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} endpoint - API endpoint path (e.g. '/customers/{id}')
 * @param {Object|null} body - Request body for POST/PUT
 * @param {Object} [options] - Additional options
 * @param {number} [options.timeout=15000] - Request timeout in ms
 * @param {string} [options.context=''] - Context label for logging
 * @param {number} [options.maxRetries=3] - Max retry attempts for 429
 * @param {number} [options.merchantId] - Merchant ID for logging
 * @returns {Promise<Object>} Parsed JSON response
 */
async function squareApiRequest(accessToken, method, endpoint, body = null, options = {}) {
    const { timeout = 15000, context = '', maxRetries = 3, merchantId } = options;
    const url = `${SQUARE_API_BASE}${endpoint}`;

    const fetchOptions = {
        method,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': SQUARE_API_VERSION
        }
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        fetchOptions.body = JSON.stringify(body);
    }

    const startTime = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, fetchOptions, timeout);
            const duration = Date.now() - startTime;

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
                logger.warn('[SQUARE:RATE_LIMITED]', {
                    endpoint, method, retryAfter, attempt, maxRetries, merchantId, context,
                });

                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                    continue;
                }

                throw new SquareApiError(
                    `Rate limited after ${maxRetries} attempts`,
                    429, endpoint, { retryAfter, attempts: attempt }
                );
            }

            if (!response.ok) {
                const errorText = await response.text();
                let errorDetails;
                try { errorDetails = JSON.parse(errorText); } catch { errorDetails = { message: errorText }; }

                throw new SquareApiError(
                    `Square API error: ${response.status}`,
                    response.status, endpoint, errorDetails
                );
            }

            return await response.json();
        } catch (error) {
            lastError = error;
            if (error instanceof SquareApiError) throw error;

            logger.error('[SQUARE:REQUEST_ERROR]', {
                endpoint, method, duration: Date.now() - startTime,
                error: error.message, merchantId, context, attempt,
            });

            throw new SquareApiError(
                error.message, 0, endpoint, { originalError: error.message }
            );
        }
    }

    throw lastError || new SquareApiError('Request failed', 0, endpoint);
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

/**
 * Generate a unique idempotency key for Square API requests.
 * Mirrors services/square/api.js:generateIdempotencyKey — kept here
 * to avoid pulling in the full Square API module (which requires node-fetch).
 * @param {string} prefix - Prefix to identify the operation type
 * @returns {string} Unique idempotency key
 */
function generateIdempotencyKey(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
}

module.exports = {
    fetchWithTimeout,
    squareApiRequest,
    getSquareAccessToken,
    getSquareApi,
    generateIdempotencyKey,
    SquareApiError,
    SQUARE_API_BASE,
    SQUARE_API_VERSION
};
