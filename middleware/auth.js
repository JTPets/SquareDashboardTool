/**
 * Authentication Middleware
 * Handles session-based authentication and role-based access control
 */

const logger = require('../utils/logger');

/**
 * Check if user is authenticated (has valid session)
 * Redirects to login page if not authenticated
 */
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        // User is authenticated
        return next();
    }

    // Check if this is an API request or page request
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({
            error: 'Authentication required',
            code: 'UNAUTHORIZED'
        });
    }

    // Redirect to login page for non-API requests
    const returnUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login.html?returnUrl=${returnUrl}`);
}

/**
 * Check if user is authenticated (API version - always returns JSON)
 */
function requireAuthApi(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }

    return res.status(401).json({
        error: 'Authentication required',
        code: 'UNAUTHORIZED'
    });
}

/**
 * Check if user has admin role
 * Must be used after requireAuth
 */
function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({
            error: 'Authentication required',
            code: 'UNAUTHORIZED'
        });
    }

    if (req.session.user.role !== 'admin') {
        logger.warn('Admin access denied', {
            userId: req.session.user.id,
            email: req.session.user.email,
            path: req.path
        });

        return res.status(403).json({
            error: 'Admin access required',
            code: 'FORBIDDEN'
        });
    }

    return next();
}

/**
 * Check if user can modify data (not readonly)
 */
function requireWriteAccess(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({
            error: 'Authentication required',
            code: 'UNAUTHORIZED'
        });
    }

    if (req.session.user.role === 'readonly') {
        return res.status(403).json({
            error: 'Write access required. Your account is read-only.',
            code: 'FORBIDDEN'
        });
    }

    return next();
}

/**
 * Log an authentication event to the audit log
 * @param {Object} db - Database connection
 * @param {Object} params - Event parameters
 */
async function logAuthEvent(db, { userId, email, eventType, ipAddress, userAgent, details }) {
    try {
        await db.query(`
            INSERT INTO auth_audit_log (user_id, email, event_type, ip_address, user_agent, details)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [userId, email, eventType, ipAddress, userAgent, details ? JSON.stringify(details) : null]);
    } catch (error) {
        logger.error('Failed to log auth event', { error: error.message, eventType });
    }
}

/**
 * Get client IP address from request
 */
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'unknown';
}

module.exports = {
    requireAuth,
    requireAuthApi,
    requireAdmin,
    requireWriteAccess,
    logAuthEvent,
    getClientIp
};
