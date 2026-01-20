/**
 * Google OAuth Module (Multi-Tenant)
 * Handles per-merchant OAuth 2.0 authentication for Google Merchant Center
 *
 * Each merchant connects their own Google account - no shared credentials
 * Used by merchant-center-api.js for product catalog sync to GMC
 */

const { google } = require('googleapis');
const db = require('./database');
const logger = require('./logger');

// OAuth2 client configuration
// Scope: content - Access to Google Merchant Center Content API
const SCOPES = [
    'https://www.googleapis.com/auth/content'
];

// Private IP regex pattern - matches 192.168.x.x, 10.x.x.x, 172.16-31.x.x
const PRIVATE_IP_PATTERN = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;

/**
 * Validate that a redirect URI is safe for Google OAuth
 * @param {string} uri - The redirect URI to validate
 * @returns {Object} Validation result with isValid boolean and error message
 */
function validateRedirectUri(uri) {
    if (!uri) {
        return { isValid: false, error: 'GOOGLE_REDIRECT_URI environment variable is not set' };
    }

    if (PRIVATE_IP_PATTERN.test(uri)) {
        return {
            isValid: false,
            error: `GOOGLE_REDIRECT_URI contains a private IP address (${uri}). Use localhost for local development or a public domain for production.`
        };
    }

    if (!uri.startsWith('http://localhost') && !uri.startsWith('https://')) {
        return {
            isValid: false,
            error: `GOOGLE_REDIRECT_URI must start with 'http://localhost' or 'https://' (got: ${uri})`
        };
    }

    if (!uri.includes('/api/google/callback')) {
        return {
            isValid: false,
            error: `GOOGLE_REDIRECT_URI must end with '/api/google/callback' (got: ${uri})`
        };
    }

    return { isValid: true };
}

/**
 * Get the configured redirect URI from environment
 * @returns {string} The redirect URI
 * @throws {Error} If GOOGLE_REDIRECT_URI is not set or invalid
 */
function getRedirectUri() {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    const validation = validateRedirectUri(redirectUri);

    if (!validation.isValid) {
        throw new Error(validation.error);
    }

    return redirectUri;
}

/**
 * Create a new OAuth2 client instance
 * Each merchant gets their own client instance (not cached globally)
 */
function createOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        logger.warn('Google OAuth credentials not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)');
        return null;
    }

    const redirectUri = getRedirectUri();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generate OAuth authorization URL for a specific merchant
 * @param {number} merchantId - The merchant ID to associate with this auth
 * @returns {string} Authorization URL with merchant state
 */
function getAuthUrl(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for Google OAuth');
    }

    const client = createOAuth2Client();
    if (!client) {
        throw new Error('Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in your environment.');
    }

    // Encode merchant ID in state parameter for callback
    const state = Buffer.from(JSON.stringify({ merchantId })).toString('base64');

    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent', // Force consent to get refresh token
        state: state
    });

    logger.info('Generated Google OAuth URL for merchant', {
        merchantId,
        redirectUri: process.env.GOOGLE_REDIRECT_URI,
        scopes: SCOPES
    });

    return authUrl;
}

/**
 * Parse state parameter from OAuth callback
 * @param {string} state - Base64 encoded state from callback
 * @returns {Object} Parsed state object with merchantId
 */
function parseAuthState(state) {
    try {
        const decoded = Buffer.from(state, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (error) {
        logger.error('Failed to parse Google OAuth state', { error: error.message, stack: error.stack });
        throw new Error('Invalid OAuth state parameter');
    }
}

/**
 * Exchange authorization code for tokens and save for merchant
 * @param {string} code - Authorization code from callback
 * @param {number} merchantId - Merchant ID to save tokens for
 * @returns {Promise<Object>} Token object
 */
async function exchangeCodeForTokens(code, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    const client = createOAuth2Client();
    if (!client) {
        throw new Error('Google OAuth not configured');
    }

    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Store tokens in database for this merchant
    await saveTokens(merchantId, tokens);
    logger.info('Google OAuth tokens obtained and saved for merchant', { merchantId });

    return tokens;
}

/**
 * Save tokens to database for a specific merchant
 * @param {number} merchantId - Merchant ID
 * @param {Object} tokens - OAuth tokens
 */
async function saveTokens(merchantId, tokens) {
    await db.query(`
        INSERT INTO google_oauth_tokens (merchant_id, access_token, refresh_token, token_type, expiry_date, scope)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (merchant_id) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(EXCLUDED.refresh_token, google_oauth_tokens.refresh_token),
            token_type = EXCLUDED.token_type,
            expiry_date = EXCLUDED.expiry_date,
            scope = EXCLUDED.scope,
            updated_at = CURRENT_TIMESTAMP
    `, [
        merchantId,
        tokens.access_token,
        tokens.refresh_token,
        tokens.token_type,
        tokens.expiry_date,
        tokens.scope
    ]);
}

/**
 * Load tokens from database for a specific merchant
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Token object or null
 */
async function loadTokens(merchantId) {
    if (!merchantId) {
        return null;
    }

    const result = await db.query(
        'SELECT access_token, refresh_token, token_type, expiry_date, scope FROM google_oauth_tokens WHERE merchant_id = $1',
        [merchantId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const row = result.rows[0];
    return {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_type: row.token_type,
        expiry_date: parseInt(row.expiry_date),
        scope: row.scope
    };
}

/**
 * Check if a merchant has valid authentication
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<boolean>} True if authenticated
 */
async function isAuthenticated(merchantId) {
    const tokens = await loadTokens(merchantId);
    return tokens !== null && tokens.refresh_token !== null;
}

/**
 * Get authenticated OAuth client for a specific merchant
 * Used by merchant-center-api.js for GMC API calls
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Authenticated OAuth2 client
 */
async function getAuthenticatedClient(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    const client = createOAuth2Client();
    if (!client) {
        throw new Error('Google OAuth not configured');
    }

    const tokens = await loadTokens(merchantId);
    if (!tokens) {
        throw new Error('Not authenticated with Google. Please connect your Google Merchant Center account first.');
    }

    client.setCredentials(tokens);

    // Handle token refresh
    client.on('tokens', async (newTokens) => {
        logger.info('Google OAuth tokens refreshed for merchant', { merchantId });
        await saveTokens(merchantId, {
            ...tokens,
            ...newTokens
        });
    });

    return client;
}

/**
 * Disconnect Google OAuth for a merchant (remove tokens)
 * @param {number} merchantId - Merchant ID
 */
async function disconnect(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    await db.query('DELETE FROM google_oauth_tokens WHERE merchant_id = $1', [merchantId]);
    logger.info('Google OAuth disconnected for merchant', { merchantId });
}

/**
 * Get authentication status for a merchant
 * @param {number} merchantId - Merchant ID (optional - returns config status if not provided)
 */
async function getAuthStatus(merchantId) {
    const tokens = merchantId ? await loadTokens(merchantId) : null;
    const hasClientCredentials = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    const redirectValidation = validateRedirectUri(redirectUri);

    return {
        configured: hasClientCredentials && redirectValidation.isValid,
        hasClientCredentials,
        redirectUriConfigured: !!redirectUri,
        redirectUriValid: redirectValidation.isValid,
        redirectUriError: redirectValidation.isValid ? null : redirectValidation.error,
        authenticated: tokens !== null && tokens.refresh_token !== null,
        hasAccessToken: tokens?.access_token !== null,
        tokenExpiry: tokens?.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
    };
}

module.exports = {
    getAuthUrl,
    parseAuthState,
    exchangeCodeForTokens,
    isAuthenticated,
    getAuthStatus,
    getAuthenticatedClient,
    disconnect
};
