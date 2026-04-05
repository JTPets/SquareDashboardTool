/**
 * Super Admin Middleware
 *
 * Guards endpoints that should only be accessible to platform-level super admins,
 * identified by email address in the SUPER_ADMIN_EMAILS environment variable.
 *
 * Must be used after requireAuth (relies on req.session.user).
 *
 * Usage:
 *   router.post('/admin/setup-plans', requireAuth, requireSuperAdmin, handler);
 */

const logger = require('../utils/logger');

/**
 * Reject requests whose authenticated user is not in SUPER_ADMIN_EMAILS.
 */
function requireSuperAdmin(req, res, next) {
    const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

    const userEmail = req.session?.user?.email?.toLowerCase();

    if (!superAdminEmails.includes(userEmail)) {
        logger.warn('Unauthorized super admin access attempt', { email: userEmail, path: req.path });
        return res.status(403).json({
            success: false,
            error: 'Super admin access required',
            code: 'FORBIDDEN'
        });
    }

    return next();
}

module.exports = requireSuperAdmin;
