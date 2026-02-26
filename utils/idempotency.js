/**
 * Idempotency Key Generator
 *
 * Shared utility for generating unique idempotency keys for Square API requests.
 * Used by services/square/api.js and services/loyalty-admin/shared-utils.js.
 */

const crypto = require('crypto');

/**
 * Generate a unique idempotency key for Square API requests.
 * Uses crypto.randomUUID() for guaranteed uniqueness.
 * @param {string} prefix - Prefix to identify the operation type
 * @returns {string} Unique idempotency key
 */
function generateIdempotencyKey(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
}

module.exports = { generateIdempotencyKey };
