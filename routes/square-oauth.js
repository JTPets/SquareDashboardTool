/**
 * Square OAuth Routes
 * Handles Square OAuth flow for multi-tenant merchant connections
 *
 * Endpoints:
 *   GET  /api/square/oauth/connect   - Initiate OAuth flow
 *   GET  /api/square/oauth/callback  - Handle OAuth callback from Square
 *   POST /api/square/oauth/revoke    - Revoke/disconnect merchant
 *   POST /api/square/oauth/refresh   - Manually refresh token (admin)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { SquareClient, SquareEnvironment } = require('square');
const db = require('../utils/database');
const logger = require('../utils/logger');
const { encryptToken, decryptToken } = require('../utils/token-encryption');
const { requireAuth, requireAdmin, logAuthEvent, getClientIp } = require('../middleware/auth');

// OAuth configuration
const SQUARE_APPLICATION_ID = process.env.SQUARE_APPLICATION_ID;
const SQUARE_APPLICATION_SECRET = process.env.SQUARE_APPLICATION_SECRET;
const SQUARE_OAUTH_REDIRECT_URI = process.env.SQUARE_OAUTH_REDIRECT_URI;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || 'production';

// OAuth state expiry (10 minutes)
const STATE_EXPIRY_MINUTES = 10;

// Required OAuth scopes for the application
const REQUIRED_SCOPES = [
    'MERCHANT_PROFILE_READ',
    'ITEMS_READ',
    'ITEMS_WRITE',
    'INVENTORY_READ',
    'INVENTORY_WRITE',
    'ORDERS_READ',
    'VENDOR_READ',
    'LOYALTY_READ',
    'CUSTOMERS_READ'
];

/**
 * Validate OAuth configuration
 */
function validateOAuthConfig() {
    const missing = [];
    if (!SQUARE_APPLICATION_ID) missing.push('SQUARE_APPLICATION_ID');
    if (!SQUARE_APPLICATION_SECRET) missing.push('SQUARE_APPLICATION_SECRET');
    if (!SQUARE_OAUTH_REDIRECT_URI) missing.push('SQUARE_OAUTH_REDIRECT_URI');

    if (missing.length > 0) {
        throw new Error(`Missing Square OAuth configuration: ${missing.join(', ')}`);
    }
}

/**
 * GET /api/square/oauth/connect
 * Initiate Square OAuth flow
 * Requires authenticated user
 */
router.get('/connect', requireAuth, async (req, res) => {
    try {
        validateOAuthConfig();

        // Generate cryptographically secure state parameter
        const state = crypto.randomBytes(32).toString('hex');
        const redirectAfter = req.query.redirect || '/dashboard.html';

        // Store state in database with expiry
        await db.query(`
            INSERT INTO oauth_states (state, user_id, redirect_uri, expires_at)
            VALUES ($1, $2, $3, NOW() + INTERVAL '${STATE_EXPIRY_MINUTES} minutes')
        `, [state, req.session.user.id, redirectAfter]);

        logger.info('OAuth flow initiated', {
            userId: req.session.user.id,
            redirect: redirectAfter
        });

        // Build Square authorization URL
        const baseUrl = SQUARE_ENVIRONMENT === 'sandbox'
            ? 'https://connect.squareupsandbox.com'
            : 'https://connect.squareup.com';

        const authUrl = new URL(`${baseUrl}/oauth2/authorize`);
        authUrl.searchParams.set('client_id', SQUARE_APPLICATION_ID);
        authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
        authUrl.searchParams.set('session', 'false');
        authUrl.searchParams.set('state', state);

        res.redirect(authUrl.toString());

    } catch (error) {
        logger.error('OAuth connect error:', error);
        res.redirect('/dashboard.html?error=' + encodeURIComponent('Failed to start Square connection'));
    }
});

/**
 * GET /api/square/oauth/callback
 * Handle OAuth callback from Square
 * This is called after user authorizes on Square's site
 */
router.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors from Square
    if (error) {
        logger.warn('OAuth error from Square:', { error, error_description });
        return res.redirect('/dashboard.html?error=' + encodeURIComponent(error_description || error));
    }

    if (!code || !state) {
        logger.warn('OAuth callback missing code or state');
        return res.redirect('/dashboard.html?error=' + encodeURIComponent('Invalid OAuth response'));
    }

    try {
        // Verify state parameter
        const stateResult = await db.query(`
            SELECT * FROM oauth_states
            WHERE state = $1 AND expires_at > NOW() AND used_at IS NULL
        `, [state]);

        if (stateResult.rows.length === 0) {
            logger.warn('OAuth state validation failed', { state: state.substring(0, 10) + '...' });
            return res.redirect('/dashboard.html?error=' + encodeURIComponent('OAuth session expired. Please try again.'));
        }

        const stateRecord = stateResult.rows[0];

        // Mark state as used (prevent replay)
        await db.query(
            'UPDATE oauth_states SET used_at = NOW() WHERE state = $1',
            [state]
        );

        // Exchange authorization code for tokens
        const squareEnv = SQUARE_ENVIRONMENT === 'sandbox'
            ? SquareEnvironment.Sandbox
            : SquareEnvironment.Production;

        const client = new SquareClient({ environment: squareEnv });

        const tokenResponse = await client.oAuth.obtainToken({
            clientId: SQUARE_APPLICATION_ID,
            clientSecret: SQUARE_APPLICATION_SECRET,
            grantType: 'authorization_code',
            code: code
        });

        const {
            accessToken,
            refreshToken,
            expiresAt,
            merchantId,
            tokenType
        } = tokenResponse;

        logger.info('OAuth tokens obtained', {
            merchantId,
            expiresAt,
            tokenType
        });

        // Get merchant info from Square
        const merchantClient = new SquareClient({
            environment: squareEnv,
            token: accessToken
        });

        const merchantResponse = await merchantClient.merchants.get({ merchantId });
        const merchantInfo = merchantResponse.merchant;

        // Encrypt tokens before storage
        const encryptedAccessToken = encryptToken(accessToken);
        const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;

        // Generate GMC feed token for new merchants
        const gmcFeedToken = crypto.randomBytes(32).toString('hex');

        // Create or update merchant record
        const merchantResult = await db.query(`
            INSERT INTO merchants (
                square_merchant_id,
                business_name,
                business_email,
                square_access_token,
                square_refresh_token,
                square_token_expires_at,
                square_token_scopes,
                timezone,
                currency,
                last_sync_at,
                gmc_feed_token
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10)
            ON CONFLICT (square_merchant_id) DO UPDATE SET
                business_name = EXCLUDED.business_name,
                square_access_token = EXCLUDED.square_access_token,
                square_refresh_token = EXCLUDED.square_refresh_token,
                square_token_expires_at = EXCLUDED.square_token_expires_at,
                square_token_scopes = EXCLUDED.square_token_scopes,
                is_active = TRUE,
                updated_at = NOW(),
                gmc_feed_token = COALESCE(merchants.gmc_feed_token, EXCLUDED.gmc_feed_token)
            RETURNING id, business_name
        `, [
            merchantId,
            merchantInfo.businessName || 'Unknown Business',
            merchantInfo.mainLocationId || null,  // Square doesn't return email directly
            encryptedAccessToken,
            encryptedRefreshToken,
            expiresAt,
            REQUIRED_SCOPES,
            merchantInfo.languageCode || 'en',
            merchantInfo.currency || 'USD',
            gmcFeedToken
        ]);

        const newMerchantId = merchantResult.rows[0].id;
        const businessName = merchantResult.rows[0].business_name;

        // Link user to merchant as owner
        await db.query(`
            INSERT INTO user_merchants (user_id, merchant_id, role, is_primary, accepted_at)
            VALUES ($1, $2, 'owner', true, NOW())
            ON CONFLICT (user_id, merchant_id) DO UPDATE SET
                role = CASE
                    WHEN user_merchants.role = 'owner' THEN 'owner'
                    ELSE EXCLUDED.role
                END,
                is_primary = EXCLUDED.is_primary
        `, [stateRecord.user_id, newMerchantId]);

        // Set this as the active merchant in session if user has session
        if (req.session) {
            req.session.activeMerchantId = newMerchantId;
        }

        // Log the successful connection
        await logAuthEvent(db, {
            userId: stateRecord.user_id,
            eventType: 'merchant_connected',
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent'],
            details: {
                merchantId: newMerchantId,
                squareMerchantId: merchantId,
                businessName: businessName
            }
        });

        logger.info('Merchant connected successfully', {
            userId: stateRecord.user_id,
            merchantId: newMerchantId,
            businessName: businessName
        });

        // Redirect to original destination
        const redirectUri = stateRecord.redirect_uri || '/dashboard.html';
        res.redirect(redirectUri + '?connected=true&merchant=' + encodeURIComponent(businessName));

    } catch (error) {
        logger.error('OAuth callback error:', error);

        // Build detailed error message
        let errorMessage = 'Failed to connect Square account.';
        let errorDetail = error.message || 'Unknown error';

        // Handle specific Square API errors (SDK v43+ uses error.errors directly)
        if (error.errors && error.errors.length > 0) {
            const squareError = error.errors[0];
            logger.error('Square API error:', squareError);
            errorDetail = squareError.detail || squareError.code || errorDetail;
        }

        // Always show error details for OAuth errors (not sensitive)
        res.redirect('/dashboard.html?error=' + encodeURIComponent(errorMessage + ' (' + errorDetail + ')'));
    }
});

/**
 * POST /api/square/oauth/revoke
 * Disconnect a merchant's Square account
 * Revokes OAuth tokens and deactivates merchant
 */
router.post('/revoke', requireAuth, async (req, res) => {
    const { merchantId } = req.body;

    if (!merchantId) {
        return res.status(400).json({
            success: false,
            error: 'Merchant ID is required'
        });
    }

    try {
        // Verify user has access to this merchant
        const accessCheck = await db.query(`
            SELECT um.role, m.square_access_token, m.square_merchant_id
            FROM user_merchants um
            JOIN merchants m ON m.id = um.merchant_id
            WHERE um.user_id = $1 AND um.merchant_id = $2 AND m.is_active = TRUE
        `, [req.session.user.id, merchantId]);

        if (accessCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Merchant not found'
            });
        }

        // Only owners can revoke
        if (accessCheck.rows[0].role !== 'owner') {
            return res.status(403).json({
                success: false,
                error: 'Only the account owner can disconnect Square'
            });
        }

        // Attempt to revoke token with Square (best effort)
        try {
            const accessToken = decryptToken(accessCheck.rows[0].square_access_token);
            const squareEnv = SQUARE_ENVIRONMENT === 'sandbox'
                ? SquareEnvironment.Sandbox
                : SquareEnvironment.Production;

            const client = new SquareClient({ environment: squareEnv });
            await client.oAuth.revokeToken({
                clientId: SQUARE_APPLICATION_ID,
                clientSecret: SQUARE_APPLICATION_SECRET,
                accessToken: accessToken
            });

            logger.info('Square token revoked successfully', { merchantId });
        } catch (revokeError) {
            // Log but don't fail - token may already be invalid
            logger.warn('Failed to revoke Square token:', revokeError.message);
        }

        // Deactivate merchant (soft delete)
        await db.query(`
            UPDATE merchants SET
                is_active = FALSE,
                square_access_token = 'REVOKED',
                square_refresh_token = NULL,
                updated_at = NOW()
            WHERE id = $1
        `, [merchantId]);

        // Clear session if this was the active merchant
        if (req.session.activeMerchantId === parseInt(merchantId)) {
            req.session.activeMerchantId = null;
        }

        // Log the disconnection
        await logAuthEvent(db, {
            userId: req.session.user.id,
            eventType: 'merchant_disconnected',
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent'],
            merchantId: merchantId,
            details: {
                squareMerchantId: accessCheck.rows[0].square_merchant_id
            }
        });

        res.json({
            success: true,
            message: 'Square account disconnected successfully'
        });

    } catch (error) {
        logger.error('Revoke error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to disconnect Square account'
        });
    }
});

/**
 * POST /api/square/oauth/refresh
 * Manually refresh a merchant's token (admin only)
 */
router.post('/refresh', requireAuth, requireAdmin, async (req, res) => {
    const { merchantId } = req.body;

    if (!merchantId) {
        return res.status(400).json({
            success: false,
            error: 'Merchant ID is required'
        });
    }

    try {
        const result = await refreshMerchantToken(merchantId);
        res.json({
            success: true,
            message: 'Token refreshed successfully',
            expiresAt: result.expiresAt
        });
    } catch (error) {
        logger.error('Token refresh error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Refresh a merchant's Square OAuth token
 * @param {number} merchantId - The merchant ID
 * @returns {Object} New token info
 */
async function refreshMerchantToken(merchantId) {
    const merchant = await db.query(
        'SELECT * FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (merchant.rows.length === 0) {
        throw new Error('Merchant not found or inactive');
    }

    const refreshToken = decryptToken(merchant.rows[0].square_refresh_token);

    if (!refreshToken) {
        throw new Error('No refresh token available');
    }

    const squareEnv = SQUARE_ENVIRONMENT === 'sandbox'
        ? SquareEnvironment.Sandbox
        : SquareEnvironment.Production;

    const client = new SquareClient({ environment: squareEnv });

    const response = await client.oAuth.obtainToken({
        clientId: SQUARE_APPLICATION_ID,
        clientSecret: SQUARE_APPLICATION_SECRET,
        grantType: 'refresh_token',
        refreshToken: refreshToken
    });

    const {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresAt
    } = response;

    // Encrypt and store new tokens
    await db.query(`
        UPDATE merchants SET
            square_access_token = $1,
            square_refresh_token = $2,
            square_token_expires_at = $3,
            updated_at = NOW()
        WHERE id = $4
    `, [
        encryptToken(newAccessToken),
        newRefreshToken ? encryptToken(newRefreshToken) : merchant.rows[0].square_refresh_token,
        expiresAt,
        merchantId
    ]);

    logger.info('Token refreshed for merchant', { merchantId, expiresAt });

    return {
        accessToken: newAccessToken,
        expiresAt
    };
}

/**
 * Get a valid access token for a merchant
 * Automatically refreshes if within 1 hour of expiry
 * @param {number} merchantId - The merchant ID
 * @returns {string} Valid access token
 */
async function getValidAccessToken(merchantId) {
    const merchant = await db.query(
        'SELECT * FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (merchant.rows.length === 0) {
        throw new Error('Merchant not found or inactive');
    }

    const expiresAt = new Date(merchant.rows[0].square_token_expires_at);
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

    // Refresh if token expires within 1 hour
    if (expiresAt < oneHourFromNow) {
        logger.info('Token expiring soon, refreshing', { merchantId, expiresAt });
        const result = await refreshMerchantToken(merchantId);
        return result.accessToken;
    }

    return decryptToken(merchant.rows[0].square_access_token);
}

// Export helper functions for use in other modules
module.exports = router;
module.exports.refreshMerchantToken = refreshMerchantToken;
module.exports.getValidAccessToken = getValidAccessToken;
