'use strict';

/**
 * Feature Gate Middleware
 *
 * Gates route access based on merchant's enabled feature modules.
 * Used in server.js route registrations to enforce per-module access.
 */

const { modules } = require('../config/feature-registry');

/**
 * Returns middleware that requires a specific feature module.
 *
 * Checks:
 * 1. Merchant context must exist (403 if missing)
 * 2. Platform owners bypass all checks
 * 3. Free modules always pass
 * 4. Paid modules require the feature in req.merchantContext.features
 *
 * @param {string} featureKey - The feature module key (e.g. 'cycle_counts')
 * @returns {Function} Express middleware
 */
function requireFeature(featureKey) {
    return (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(403).json({
                success: false,
                error: 'No merchant context',
                code: 'NO_MERCHANT'
            });
        }

        // Platform owner bypasses all feature checks
        if (req.merchantContext.subscriptionStatus === 'platform_owner') {
            return next();
        }

        // Free modules always pass
        const mod = modules[featureKey];
        if (mod && mod.free) {
            return next();
        }

        // Check if merchant has this feature enabled
        const features = req.merchantContext.features || [];
        if (features.includes(featureKey)) {
            return next();
        }

        // Feature not enabled
        const moduleName = mod ? mod.name : featureKey;
        const priceCents = mod ? mod.price_cents : null;

        return res.status(403).json({
            success: false,
            error: `This feature requires the ${moduleName} module`,
            code: 'FEATURE_REQUIRED',
            feature: featureKey,
            module_name: moduleName,
            price_cents: priceCents
        });
    };
}

module.exports = { requireFeature };
