/**
 * Require Active Subscription Middleware
 *
 * Write-lock for expired-trial merchants. GET requests pass through so
 * merchants can still read their data (catalog, inventory, etc.) after
 * trial expiry. All mutating methods (POST/PUT/PATCH/DELETE) are blocked
 * with 402 until the subscription is renewed.
 *
 * Platform owners are always exempt — loadMerchantContext sets
 * isSubscriptionValid=true when subscription_status='platform_owner'.
 *
 * @module middleware/require-active-subscription
 */

/**
 * Block write operations for merchants with expired subscriptions.
 * Read-only (GET) requests pass through to preserve data visibility.
 *
 * @param {object} req
 * @param {object} res
 * @param {Function} next
 */
function requireActiveSubscription(req, res, next) {
    if (req.method === 'GET') {
        return next();
    }

    if (!req.merchantContext) {
        return res.status(403).json({
            success: false,
            error: 'No merchant connected',
            code: 'NO_MERCHANT'
        });
    }

    if (!req.merchantContext.isSubscriptionValid) {
        return res.status(402).json({
            success: false,
            error: 'Subscription expired',
            code: 'SUBSCRIPTION_EXPIRED',
            message: 'Your subscription has expired. Please renew to continue.',
            subscriptionStatus: req.merchantContext.subscriptionStatus,
            redirectTo: '/subscription-expired.html'
        });
    }

    return next();
}

module.exports = { requireActiveSubscription };
