/**
 * Square API Client — Shared Infrastructure
 *
 * Low-level HTTP client for Square API requests with retry/rate-limit handling,
 * merchant token resolution, and shared utilities. All other square-* modules
 * depend on this module.
 *
 * Endpoint convention: the base URL is `https://connect.squareup.com`; every
 * endpoint passed to `makeSquareRequest` must start with `/v2/...` (e.g.
 * `/v2/locations`, `/v2/customers/search`). Callers are responsible for
 * including the `/v2` prefix.
 *
 * Exports:
 *   getMerchantToken(merchantId)          — decrypt per-merchant access token
 *   makeSquareRequest(endpoint, options)  — HTTP client with retry + rate-limit
 *   SquareApiError                        — typed error with status/endpoint/details/nonRetryable
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

// LOGIC CHANGE: use centralized retry config from constants (C-1)
const { SQUARE: { API_VERSION: SQUARE_API_VERSION }, RETRY: { MAX_ATTEMPTS: MAX_RETRIES, BASE_DELAY_MS: RETRY_DELAY_MS } } = require('../../config/constants');

/**
 * Typed error thrown by `makeSquareRequest` for non-2xx responses.
 *
 * Fields:
 *   status        — HTTP status code returned by Square
 *   endpoint      — request path (e.g. `/v2/customers/search`)
 *   details       — array of Square error objects (from `data.errors`)
 *   nonRetryable  — true for 400/401/409 and non-retryable error codes
 *
 * `squareErrors` is kept as an alias of `details` for backward compatibility
 * with existing callers that key off the legacy field name.
 */
class SquareApiError extends Error {
    constructor(message, { status, endpoint, details = [], nonRetryable = false } = {}) {
        super(message);
        this.name = 'SquareApiError';
        this.status = status;
        this.endpoint = endpoint;
        this.details = details;
        this.nonRetryable = nonRetryable;
        // Backward-compat alias (existing callers use err.squareErrors)
        this.squareErrors = details;
    }
}

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
 * @param {string} endpoint - API endpoint path (must start with `/v2/...`)
 * @param {Object} options - Fetch options (can include accessToken for multi-tenant)
 * @param {string} [options.accessToken] - Required. Per-merchant access token.
 * @param {number} [options.timeout=30000] - Per-request timeout in milliseconds.
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
    // Extract timeout (default 30_000 ms) so it isn't passed to fetch
    const timeout = typeof options.timeout === 'number' ? options.timeout : 30000;
    delete options.timeout;

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers,
                signal: AbortSignal.timeout(timeout)
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
                    throw new SquareApiError('Square API authentication failed. Check your access token.', {
                        status: 401,
                        endpoint,
                        details: data.errors || [],
                        nonRetryable: true
                    });
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
                    throw new SquareApiError(
                        `Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`,
                        {
                            status: response.status,
                            endpoint,
                            details: data.errors || [],
                            nonRetryable: true
                        }
                    );
                }

                throw new SquareApiError(
                    `Square API error: ${response.status} - ${JSON.stringify(data.errors || data)}`,
                    {
                        status: response.status,
                        endpoint,
                        details: data.errors || [],
                        nonRetryable: false
                    }
                );
            }

            return data;
        } catch (error) {
            // Convert AbortError to a descriptive timeout error
            if (error.name === 'AbortError') {
                lastError = new Error(`Square API request timed out after ${timeout}ms: ${endpoint}`);
                logger.warn('Square API request timed out', { endpoint, attempt: attempt + 1, timeout });
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
    SquareApiError,
    sleep,
    generateIdempotencyKey,
    // Constants (used by other square modules)
    SQUARE_BASE_URL,
    MAX_RETRIES,
    RETRY_DELAY_MS
};
