/**
 * Log Sanitizer — strips PII from log metadata
 *
 * LOGIC CHANGE: strip PII from request logs (audit 8.x)
 *
 * Redacts email addresses, customer names, and phone numbers
 * from log entries while preserving merchantId and userId
 * needed for debugging.
 *
 * @module utils/log-sanitizer
 */

const crypto = require('crypto');

// Fields that contain PII and should be redacted
const PII_FIELDS = new Set([
    'email',
    'customerName',
    'customer_name',
    'customerEmail',
    'customer_email',
    'phone',
    'customerPhone',
    'customer_phone',
    'previousName',
    'newName',
    'givenName',
    'familyName',
    'displayName',
]);

// Fields to preserve (debugging identifiers, not customer PII)
const SAFE_FIELDS = new Set([
    'merchantId',
    'merchant_id',
    'userId',
    'user_id',
    'squareCustomerId',
    'square_customer_id',
    'customerId',
    'customer_id',
    'orderId',
    'order_id',
    'ip',
]);

/**
 * Hash a PII value to a short, non-reversible token for log correlation.
 * Returns first 8 chars of SHA-256 hex digest.
 * @param {string} value - The PII value to hash
 * @returns {string} - Hashed token like "a1b2c3d4"
 */
function hashPii(value) {
    if (!value || typeof value !== 'string') return '[redacted]';
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Redact a single email address — preserves domain for debugging.
 * "user@example.com" → "***@example.com"
 * @param {string} email
 * @returns {string}
 */
function redactEmail(email) {
    if (!email || typeof email !== 'string') return '[redacted]';
    const atIndex = email.indexOf('@');
    if (atIndex < 0) return '[redacted]';
    return `***@${email.slice(atIndex + 1)}`;
}

/**
 * Sanitize a metadata object, redacting PII fields in place.
 * Shallow — does not recurse into nested objects (log metadata is flat).
 * @param {Object} meta - Winston log metadata
 * @returns {Object} - Sanitized copy (original not mutated)
 */
function sanitize(meta) {
    if (!meta || typeof meta !== 'object') return meta;

    const sanitized = {};
    for (const [key, value] of Object.entries(meta)) {
        if (PII_FIELDS.has(key)) {
            if (key.includes('email') || key.includes('Email')) {
                sanitized[key] = redactEmail(value);
            } else if (key.includes('phone') || key.includes('Phone')) {
                sanitized[key] = value ? `***${String(value).slice(-4)}` : '[redacted]';
            } else {
                // Names — hash for correlation
                sanitized[key] = value ? `[redacted:${hashPii(String(value))}]` : '[redacted]';
            }
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

module.exports = {
    sanitize,
    redactEmail,
    hashPii,
    PII_FIELDS,
};
