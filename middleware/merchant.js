/**
 * Merchant Context Middleware
 * Loads and manages merchant context for multi-tenant requests
 *
 * Usage:
 *   // In server.js, AFTER auth middleware:
 *   app.use(loadMerchantContext);
 *
 *   // In routes that require merchant:
 *   app.get('/api/items', requireAuth, requireMerchant, handler);
 */

const { SquareClient, SquareEnvironment } = require('square');
const db = require('../utils/database');
const logger = require('../utils/logger');
const { decryptToken } = require('../utils/token-encryption');

// Cache for Square clients (to avoid recreating on every request)
const clientCache = new Map();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load merchant context from session
 * Attaches merchantContext to req object
 * Must be applied AFTER auth middleware
 */
async function loadMerchantContext(req, res, next) {
    // Skip if no authenticated user
    if (!req.session || !req.session.user) {
        return next();
    }

    try {
        // Get active merchant from session or query user's primary merchant
        let merchantId = req.session.activeMerchantId;

        if (!merchantId) {
            // Find user's primary merchant
            const result = await db.query(`
                SELECT um.merchant_id, m.business_name, m.square_merchant_id
                FROM user_merchants um
                JOIN merchants m ON m.id = um.merchant_id
                WHERE um.user_id = $1 AND um.is_primary = TRUE AND m.is_active = TRUE
                LIMIT 1
            `, [req.session.user.id]);

            if (result.rows.length === 0) {
                // User has no merchants - they need to connect one
                req.merchantContext = null;
                return next();
            }

            merchantId = result.rows[0].merchant_id;
            req.session.activeMerchantId = merchantId;
        }

        // Load full merchant context
        const merchant = await db.query(`
            SELECT
                m.id,
                m.square_merchant_id,
                m.business_name,
                m.business_email,
                m.subscription_status,
                m.trial_ends_at,
                m.subscription_ends_at,
                m.timezone,
                m.currency,
                m.settings,
                m.last_sync_at,
                m.square_token_expires_at,
                um.role as user_role
            FROM merchants m
            JOIN user_merchants um ON um.merchant_id = m.id
            WHERE m.id = $1 AND um.user_id = $2 AND m.is_active = TRUE
        `, [merchantId, req.session.user.id]);

        if (merchant.rows.length === 0) {
            // User no longer has access to this merchant
            req.session.activeMerchantId = null;
            req.merchantContext = null;
            return next();
        }

        const m = merchant.rows[0];

        // Build merchant context object
        req.merchantContext = {
            id: m.id,
            squareMerchantId: m.square_merchant_id,
            businessName: m.business_name,
            businessEmail: m.business_email,
            userRole: m.user_role,
            subscriptionStatus: m.subscription_status,
            trialEndsAt: m.trial_ends_at,
            subscriptionEndsAt: m.subscription_ends_at,
            timezone: m.timezone || 'America/New_York',
            currency: m.currency || 'USD',
            settings: m.settings || {},
            lastSyncAt: m.last_sync_at,
            tokenExpiresAt: m.square_token_expires_at
        };

        // Check subscription status
        if (m.subscription_status === 'expired' || m.subscription_status === 'suspended') {
            req.merchantContext.isSubscriptionValid = false;
        } else if (m.subscription_status === 'trial' && m.trial_ends_at) {
            req.merchantContext.isSubscriptionValid = new Date(m.trial_ends_at) > new Date();
        } else {
            req.merchantContext.isSubscriptionValid = true;
        }

        next();

    } catch (error) {
        logger.error('Error loading merchant context:', error);
        // Don't fail the request, just proceed without merchant context
        req.merchantContext = null;
        next();
    }
}

/**
 * Require merchant context middleware
 * Returns 403 if user has no active merchant
 */
function requireMerchant(req, res, next) {
    if (!req.merchantContext) {
        return res.status(403).json({
            success: false,
            error: 'No merchant connected',
            code: 'NO_MERCHANT',
            message: 'Please connect your Square account first',
            redirectTo: '/api/square/oauth/connect'
        });
    }

    next();
}

/**
 * Require valid subscription middleware
 * Returns 402 if subscription has expired
 */
function requireValidSubscription(req, res, next) {
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
            redirectTo: '/subscribe.html'
        });
    }

    next();
}

/**
 * Require specific merchant role middleware
 * @param {...string} roles - Allowed roles (owner, admin, user, readonly)
 */
function requireMerchantRole(...roles) {
    return (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(403).json({
                success: false,
                error: 'No merchant connected',
                code: 'NO_MERCHANT'
            });
        }

        if (!roles.includes(req.merchantContext.userRole)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions',
                code: 'INSUFFICIENT_ROLE',
                message: `This action requires one of these roles: ${roles.join(', ')}`,
                currentRole: req.merchantContext.userRole
            });
        }

        next();
    };
}

/**
 * Get Square client for the current merchant
 * Automatically handles token refresh
 * @param {number} merchantId - The merchant ID
 * @returns {Client} Square API client
 */
async function getSquareClientForMerchant(merchantId) {
    // Check cache first
    const cached = clientCache.get(merchantId);
    if (cached && Date.now() - cached.timestamp < CLIENT_CACHE_TTL) {
        return cached.client;
    }

    const merchant = await db.query(
        'SELECT * FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (merchant.rows.length === 0) {
        throw new Error('Merchant not found or inactive');
    }

    const m = merchant.rows[0];

    // Check if token needs refresh (within 1 hour of expiry)
    const expiresAt = new Date(m.square_token_expires_at);
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

    let accessToken;
    if (expiresAt < oneHourFromNow && m.square_refresh_token) {
        // Token needs refresh - import the refresh function to avoid circular deps
        const { refreshMerchantToken } = require('../routes/square-oauth');
        const refreshResult = await refreshMerchantToken(merchantId);
        accessToken = refreshResult.accessToken;
    } else {
        accessToken = decryptToken(m.square_access_token);
    }

    const environment = process.env.SQUARE_ENVIRONMENT === 'sandbox'
        ? SquareEnvironment.Sandbox
        : SquareEnvironment.Production;

    const client = new SquareClient({
        environment,
        token: accessToken
    });

    // Cache the client
    clientCache.set(merchantId, {
        client,
        timestamp: Date.now()
    });

    return client;
}

/**
 * Clear cached Square client for a merchant
 * Call this when tokens are refreshed or merchant is disconnected
 * @param {number} merchantId - The merchant ID
 */
function clearClientCache(merchantId) {
    clientCache.delete(merchantId);
}

/**
 * Get list of merchants the current user has access to
 * @param {number} userId - The user ID
 * @returns {Array} List of merchant summaries
 */
async function getUserMerchants(userId) {
    const result = await db.query(`
        SELECT
            m.id,
            m.business_name,
            m.square_merchant_id,
            m.subscription_status,
            m.last_sync_at,
            um.role,
            um.is_primary
        FROM user_merchants um
        JOIN merchants m ON m.id = um.merchant_id
        WHERE um.user_id = $1 AND m.is_active = TRUE
        ORDER BY um.is_primary DESC, m.business_name ASC
    `, [userId]);

    return result.rows;
}

/**
 * Switch the active merchant for a user's session
 * @param {Object} session - Express session object
 * @param {number} userId - The user ID
 * @param {number} merchantId - The merchant ID to switch to
 * @returns {boolean} True if switch was successful
 */
async function switchActiveMerchant(session, userId, merchantId) {
    // Verify user has access to this merchant
    const access = await db.query(`
        SELECT um.role, m.business_name
        FROM user_merchants um
        JOIN merchants m ON m.id = um.merchant_id
        WHERE um.user_id = $1 AND um.merchant_id = $2 AND m.is_active = TRUE
    `, [userId, merchantId]);

    if (access.rows.length === 0) {
        return false;
    }

    session.activeMerchantId = merchantId;

    logger.info('Switched active merchant', {
        userId,
        merchantId,
        businessName: access.rows[0].business_name
    });

    return true;
}

module.exports = {
    loadMerchantContext,
    requireMerchant,
    requireValidSubscription,
    requireMerchantRole,
    getSquareClientForMerchant,
    clearClientCache,
    getUserMerchants,
    switchActiveMerchant
};
