'use strict';

/**
 * Plugin Feature Gate Middleware
 *
 * Guards plugin routes based on merchant subscription features.
 * Similar to middleware/feature-gate.js but designed for plugin-registered routes.
 *
 * Usage in a plugin's init():
 *   const { requirePluginFeature } = require('../../src/plugins/featureGate');
 *   app.use('/api/plugins/retail-automation', requirePluginFeature('retail_automation'), routes);
 */

const { sendError, ErrorCodes } = require('../../utils/response-helper');

/**
 * Returns Express middleware that checks if the merchant's subscription
 * includes the given plugin feature.
 *
 * @param {string} featureName - The plugin feature key (e.g. 'retail_automation')
 * @returns {Function} Express middleware
 */
function requirePluginFeature(featureName) {
    return (req, res, next) => {
        // Must have merchant context (set by loadMerchantContext middleware)
        if (!req.merchantContext) {
            return sendError(res, 'No merchant context', 403, ErrorCodes.FORBIDDEN);
        }

        // Platform owner bypasses all feature checks
        if (req.merchantContext.subscriptionStatus === 'platform_owner') {
            return next();
        }

        // Check merchant's enabled features
        const features = req.merchantContext.features || [];
        if (features.includes(featureName)) {
            return next();
        }

        return sendError(
            res,
            `Feature '${featureName}' is not enabled for this account`,
            403,
            'PLUGIN_FEATURE_REQUIRED'
        );
    };
}

module.exports = { requirePluginFeature };
