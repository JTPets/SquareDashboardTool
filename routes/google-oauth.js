/**
 * Google OAuth Routes
 *
 * Handles Google OAuth authentication flow for Google Merchant Center:
 * - Check authentication status
 * - Start OAuth flow
 * - Handle OAuth callback (with CSRF-safe state validation)
 * - Disconnect Google account
 *
 * Endpoints:
 * - GET  /api/google/status     - Check Google OAuth status
 * - GET  /api/google/auth       - Start Google OAuth flow
 * - GET  /api/google/callback   - Google OAuth callback
 * - POST /api/google/disconnect - Disconnect Google account
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const googleAuth = require('../utils/google-auth');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/google-oauth');

/**
 * Get the public app URL for redirects
 * Uses PUBLIC_APP_URL env var or constructs from request
 */
function getPublicAppUrl(req) {
    if (process.env.PUBLIC_APP_URL) {
        return process.env.PUBLIC_APP_URL.replace(/\/$/, '');
    }
    return `${req.protocol}://${req.get('host')}`;
}

/**
 * GET /api/google/status
 * Check Google OAuth authentication status for current merchant
 */
router.get('/google/status', requireAuth, requireMerchant, validators.status, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const status = await googleAuth.getAuthStatus(merchantId);
    res.json(status);
}));

/**
 * GET /api/google/auth
 * Start Google OAuth flow for current merchant - redirects to Google consent screen
 * Uses GOOGLE_REDIRECT_URI from environment (not request hostname) to prevent private IP issues
 */
router.get('/google/auth', requireAuth, requireMerchant, validators.auth, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const userId = req.session.user.id;
    const authUrl = await googleAuth.getAuthUrl(merchantId, userId);
    logger.info('Redirecting to Google OAuth', {
        merchantId,
        userId,
        redirectUri: process.env.GOOGLE_REDIRECT_URI
    });
    res.redirect(authUrl);
}));

/**
 * GET /api/google/callback
 * Google OAuth callback - validates state and exchanges code for tokens
 *
 * State parameter is validated against the database:
 * - Must exist (prevents forged states)
 * - Must not be expired (10-minute window)
 * - Must not have been used before (prevents replay attacks)
 * - Merchant ID is retrieved from the DB record (not from the state value)
 *
 * IMPORTANT: After OAuth, we redirect to PUBLIC_APP_URL (not relative path).
 * This ensures the browser goes to the correct host (e.g., LAN IP) instead of
 * staying on localhost (which Google redirected to for the OAuth callback).
 */
router.get('/google/callback', validators.callback, async (req, res) => {
    // Get the public URL for post-OAuth redirects
    // This may differ from the OAuth callback URL (e.g., LAN IP vs localhost)
    const publicUrl = getPublicAppUrl(req);

    try {
        const { code, state, error: oauthError } = req.query;

        if (oauthError) {
            logger.error('Google OAuth error', { error: oauthError });
            return res.redirect(`${publicUrl}/gmc-feed.html?google_error=${encodeURIComponent(oauthError)}`);
        }

        if (!code || !state) {
            return res.redirect(`${publicUrl}/gmc-feed.html?google_error=missing_code_or_state`);
        }

        // Validate state against database (CSRF protection)
        // This also marks the state as used to prevent replay attacks
        const stateRecord = await googleAuth.validateAuthState(state);
        const { merchantId } = stateRecord;

        if (!merchantId) {
            return res.redirect(`${publicUrl}/gmc-feed.html?google_error=invalid_state`);
        }

        await googleAuth.exchangeCodeForTokens(code, merchantId);
        logger.info('Google OAuth successful for merchant', { merchantId, publicUrl });
        res.redirect(`${publicUrl}/gmc-feed.html?google_connected=true`);
    } catch (error) {
        logger.error('Google OAuth callback error', {
            error: error.message,
            stack: error.stack
        });
        // Don't expose internal error details in URL - use generic error code
        res.redirect(`${publicUrl}/gmc-feed.html?google_error=oauth_failed`);
    }
});

/**
 * POST /api/google/disconnect
 * Disconnect Google OAuth for current merchant (remove tokens)
 */
router.post('/google/disconnect', requireAuth, requireMerchant, validators.disconnect, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    await googleAuth.disconnect(merchantId);
    res.json({ success: true, message: 'Google account disconnected' });
}));

module.exports = router;
