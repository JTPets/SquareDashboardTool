'use strict';

/**
 * Permission Enforcement Middleware — BACKLOG-41
 *
 * Gates route access based on user role and feature permission level.
 * Uses the permission matrix from config/permissions.js.
 *
 * Must run AFTER loadMerchantContext (needs req.merchantContext.userRole).
 */

const { hasPermission } = require('../config/permissions');
const { sendError } = require('../utils/response-helper');
const logger = require('../utils/logger');

/**
 * Returns middleware that requires a specific permission level on a feature.
 *
 * @param {string} featureKey - Feature module key (e.g. 'loyalty', 'cycle_counts')
 * @param {string} level - Permission level: 'read', 'write', or 'admin'
 * @returns {Function} Express middleware
 */
function requirePermission(featureKey, level) {
    return (req, res, next) => {
        if (!req.merchantContext) {
            return sendError(res, 'No merchant context', 403, 'NO_MERCHANT');
        }

        const role = req.merchantContext.userRole;

        // Platform owners bypass all permission checks
        if (req.merchantContext.subscriptionStatus === 'platform_owner') {
            return next();
        }

        if (hasPermission(role, featureKey, level)) {
            return next();
        }

        logger.warn('Permission denied', {
            role,
            feature: featureKey,
            level,
            path: req.originalUrl,
            method: req.method,
            merchantId: req.merchantContext.id
        });

        return sendError(res, 'Insufficient permissions', 403, 'PERMISSION_DENIED');
    };
}

module.exports = { requirePermission };
