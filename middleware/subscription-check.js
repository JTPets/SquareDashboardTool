/**
 * Subscription Check Middleware
 * Square Dashboard Addon Tool
 *
 * Middleware to verify subscription status before allowing access to protected routes.
 * Redirects to subscription-expired.html if subscription is not valid.
 */

const { checkSubscriptionStatus } = require('../utils/subscription-handler');
const logger = require('../utils/logger');

// Routes that don't require subscription (public routes)
const PUBLIC_ROUTES = [
    '/api/health',
    '/api/square/payment-config',
    '/api/subscriptions/plans',
    '/api/subscriptions/create',
    '/api/subscriptions/status',
    '/api/webhooks/square',
    '/subscribe.html',
    '/subscription-expired.html',
    '/support.html',
    '/login.html',
    '/favicon.ico'
];

// Static asset extensions that don't need subscription check
const PUBLIC_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf'];

/**
 * Check if a route is public (doesn't require subscription)
 */
function isPublicRoute(path) {
    // Check exact matches
    if (PUBLIC_ROUTES.includes(path)) {
        return true;
    }

    // Check if it's a static asset
    const extension = path.substring(path.lastIndexOf('.'));
    if (PUBLIC_EXTENSIONS.includes(extension.toLowerCase())) {
        return true;
    }

    // Check path prefixes for public routes
    if (path.startsWith('/api/subscriptions/') ||
        path.startsWith('/api/webhooks/') ||
        path === '/api/health') {
        return true;
    }

    return false;
}

/**
 * Extract subscriber email from request
 * This can be enhanced based on your authentication method
 */
function getSubscriberEmail(req) {
    // Check session
    if (req.session && req.session.email) {
        return req.session.email;
    }

    // Check header (for API calls)
    if (req.headers['x-subscriber-email']) {
        return req.headers['x-subscriber-email'];
    }

    // Check query parameter (for simple auth)
    if (req.query.email) {
        return req.query.email;
    }

    // Check cookie
    if (req.cookies && req.cookies.subscriber_email) {
        return req.cookies.subscriber_email;
    }

    return null;
}

/**
 * Subscription check middleware
 *
 * Usage: app.use(subscriptionCheck);
 *
 * This middleware checks if the user has a valid subscription.
 * If not, it redirects HTML requests to subscription-expired.html
 * or returns 403 for API requests.
 */
async function subscriptionCheck(req, res, next) {
    const path = req.path;

    // Skip check for public routes
    if (isPublicRoute(path)) {
        return next();
    }

    try {
        const email = getSubscriberEmail(req);

        if (!email) {
            // No email found - redirect to subscribe page for HTML, 401 for API
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({
                    error: 'Authentication required',
                    message: 'Please subscribe to access this feature',
                    redirectUrl: '/subscribe.html'
                });
            }
            return res.redirect('/subscribe.html');
        }

        // Check subscription status
        const status = await checkSubscriptionStatus(email);

        if (status.isValid) {
            // Valid subscription - attach status to request for use in routes
            req.subscription = status;
            return next();
        }

        // Invalid subscription - handle based on request type
        logger.warn(`Subscription not valid for ${email}: ${status.message}`);

        if (req.path.startsWith('/api/')) {
            return res.status(403).json({
                error: 'Subscription required',
                message: status.message,
                status: status.status,
                redirectUrl: '/subscription-expired.html'
            });
        }

        // Redirect HTML requests to expired page
        return res.redirect('/subscription-expired.html');

    } catch (error) {
        // SECURITY: Fail closed - deny access when subscription status cannot be verified
        logger.error('Subscription check failed - denying access', {
            error: error.message,
            stack: error.stack,
            userId: req.session?.user?.id,
            path: req.path
        });

        if (req.path.startsWith('/api/')) {
            return res.status(503).json({
                success: false,
                error: 'Service temporarily unavailable. Please try again.',
                code: 'SERVICE_UNAVAILABLE'
            });
        }

        // For HTML requests, redirect to a generic error page or subscription page
        return res.redirect('/subscription-expired.html?error=service_unavailable');
    }
}

/**
 * Subscription check middleware for API routes only
 * Use this if you only want to protect API routes
 */
async function apiSubscriptionCheck(req, res, next) {
    if (!req.path.startsWith('/api/')) {
        return next();
    }
    return subscriptionCheck(req, res, next);
}

/**
 * Require specific subscription status
 * Use as: app.get('/route', requireSubscription('active'), handler)
 */
function requireSubscription(requiredStatus = ['trial', 'active']) {
    const statuses = Array.isArray(requiredStatus) ? requiredStatus : [requiredStatus];

    return async (req, res, next) => {
        try {
            const email = getSubscriberEmail(req);

            if (!email) {
                return res.status(401).json({
                    error: 'Authentication required',
                    message: 'Please subscribe to access this feature'
                });
            }

            const status = await checkSubscriptionStatus(email);

            if (status.isValid && statuses.includes(status.status)) {
                req.subscription = status;
                return next();
            }

            return res.status(403).json({
                error: 'Subscription required',
                message: `This feature requires ${statuses.join(' or ')} subscription`,
                currentStatus: status.status
            });

        } catch (error) {
            logger.error('Subscription requirement check error:', error);
            return res.status(500).json({
                error: 'Subscription check failed',
                message: 'Unable to verify subscription status'
            });
        }
    };
}

module.exports = {
    subscriptionCheck,
    apiSubscriptionCheck,
    requireSubscription,
    isPublicRoute,
    getSubscriberEmail
};
