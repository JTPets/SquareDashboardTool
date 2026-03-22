/**
 * Request Correlation ID Middleware (Audit 8.x)
 *
 * Generates a unique requestId (UUID) for each incoming request.
 * - Attaches to req.requestId for use in handlers
 * - Creates a child logger with requestId in default metadata
 * - Returned in error responses so users can reference in support requests
 *
 * LOGIC CHANGE: enables end-to-end request tracing across logs
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Middleware that assigns a unique correlation ID to each request.
 * If the client sends an X-Request-ID header, it is reused (truncated to 36 chars).
 * Otherwise a new UUID v4 is generated.
 *
 * Also attaches req.log — a child logger with requestId baked into every entry.
 */
function requestId(req, res, next) {
    // Reuse client-supplied ID if present (e.g. from load balancer), else generate
    const id = (req.headers['x-request-id'] || '').slice(0, 36) || crypto.randomUUID();
    req.requestId = id;

    // Child logger carries requestId in every log entry automatically
    req.log = logger.child({ requestId: id });

    // Echo back in response header for client-side correlation
    res.setHeader('X-Request-ID', id);

    next();
}

module.exports = requestId;
