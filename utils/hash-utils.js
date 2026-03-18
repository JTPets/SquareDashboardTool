/**
 * Hash Utilities
 *
 * Shared cryptographic hashing functions.
 * Extracted from routes/auth.js and routes/subscriptions.js (CQ-6).
 */

const crypto = require('crypto');

/**
 * Hash a password reset token with SHA-256 for secure storage (SEC-7).
 * The plaintext token is sent to the user; only the hash is stored in the DB.
 * @param {string} token - Plaintext reset token
 * @returns {string} SHA-256 hex digest
 */
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashResetToken };
