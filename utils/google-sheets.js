/**
 * Google Sheets Integration Module (Multi-Tenant)
 * Handles per-merchant OAuth 2.0 authentication and writing GMC feed data to Google Sheets
 *
 * Each merchant connects their own Google account - no shared credentials
 */

const { google } = require('googleapis');
const db = require('./database');
const logger = require('./logger');

// OAuth2 client configuration
// Using only drive.file scope - limits access to files user explicitly opens/shares with this app
// (removes broad 'spreadsheets' scope that gave access to ALL user spreadsheets)
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

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
        authUrlPrefix: authUrl.substring(0, 80) + '...'
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
        logger.error('Failed to parse Google OAuth state', { error: error.message });
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
        throw new Error('Not authenticated with Google. Please authorize first.');
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
 * Get Google Sheets API instance for a merchant
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Sheets API instance
 */
async function getSheetsApi(merchantId) {
    const auth = await getAuthenticatedClient(merchantId);
    return google.sheets({ version: 'v4', auth });
}

/**
 * Get Google Drive API instance for a merchant
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Drive API instance
 */
async function getDriveApi(merchantId) {
    const auth = await getAuthenticatedClient(merchantId);
    return google.drive({ version: 'v3', auth });
}

/**
 * Write GMC feed data to Google Sheet
 * @param {number} merchantId - Merchant ID
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {Array} products - Array of product objects
 * @param {Object} options - Options (sheetName, clearFirst)
 * @returns {Promise<Object>} Update result
 */
async function writeFeedToSheet(merchantId, spreadsheetId, products, options = {}) {
    const sheetName = options.sheetName || 'GMC Feed';
    const clearFirst = options.clearFirst !== false;

    logger.info('Writing GMC feed to Google Sheet', {
        merchantId,
        spreadsheetId,
        productCount: products.length,
        sheetName
    });

    const sheets = await getSheetsApi(merchantId);

    // Header row matching GMC format
    const headers = [
        'id',
        'title',
        'link',
        'description',
        'gtin',
        'category',
        'image_link',
        'additional_image_link',
        'additional_image_link',
        'condition',
        'availability',
        'quantity',
        'brand',
        'google_product_category',
        'price',
        'adult',
        'is_bundle'
    ];

    // Convert products to rows
    const rows = products.map(p => [
        p.id || '',
        p.title || '',
        p.link || '',
        p.description || '',
        p.gtin || '',
        p.category || '',
        p.image_link || '',
        p.additional_image_link_1 || '',
        p.additional_image_link_2 || '',
        p.condition || '',
        p.availability || '',
        p.quantity || 0,
        p.brand || '',
        p.google_product_category || '',
        p.price || '',
        p.adult || '',
        p.is_bundle || ''
    ]);

    // Combine headers and data
    const values = [headers, ...rows];
    const range = `${sheetName}!A1`;

    try {
        // First, ensure the sheet exists
        await ensureSheetExists(sheets, spreadsheetId, sheetName);

        // Clear existing data if requested
        if (clearFirst) {
            try {
                await sheets.spreadsheets.values.clear({
                    spreadsheetId,
                    range: `${sheetName}!A:Z`
                });
            } catch (clearError) {
                logger.warn('Could not clear sheet (may be empty)', { error: clearError.message });
            }
        }

        // Write new data
        const result = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            requestBody: { values }
        });

        logger.info('GMC feed written to Google Sheet', {
            merchantId,
            updatedCells: result.data.updatedCells,
            updatedRows: result.data.updatedRows
        });

        return {
            success: true,
            updatedCells: result.data.updatedCells,
            updatedRows: result.data.updatedRows,
            spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        };
    } catch (error) {
        logger.error('Failed to write to Google Sheet', {
            merchantId,
            error: error.message,
            spreadsheetId
        });
        throw error;
    }
}

/**
 * Ensure a sheet with the given name exists in the spreadsheet
 */
async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
    try {
        // Get spreadsheet metadata
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties.title'
        });

        // Check if sheet exists
        const sheetExists = spreadsheet.data.sheets.some(
            sheet => sheet.properties.title === sheetName
        );

        if (!sheetExists) {
            // Create the sheet
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: { title: sheetName }
                        }
                    }]
                }
            });
            logger.info('Created new sheet in spreadsheet', { sheetName });
        }
    } catch (error) {
        logger.warn('Could not check/create sheet', { error: error.message });
    }
}

/**
 * Read data from a Google Sheet
 * @param {number} merchantId - Merchant ID
 * @param {string} spreadsheetId - Spreadsheet ID
 * @param {string} range - Range to read (e.g., 'Sheet1!A1:Z1000')
 * @returns {Promise<Array>} Array of row arrays
 */
async function readFromSheet(merchantId, spreadsheetId, range) {
    const sheets = await getSheetsApi(merchantId);

    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
    });

    return result.data.values || [];
}

/**
 * Get spreadsheet metadata
 * @param {number} merchantId - Merchant ID
 * @param {string} spreadsheetId - Spreadsheet ID
 * @returns {Promise<Object>} Spreadsheet metadata
 */
async function getSpreadsheetInfo(merchantId, spreadsheetId) {
    const sheets = await getSheetsApi(merchantId);

    const result = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties.title,sheets.properties'
    });

    return {
        title: result.data.properties.title,
        sheets: result.data.sheets.map(s => ({
            title: s.properties.title,
            sheetId: s.properties.sheetId,
            index: s.properties.index
        }))
    };
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

/**
 * Create a new Google Spreadsheet in the merchant's Drive
 * @param {number} merchantId - Merchant ID
 * @param {string} title - Spreadsheet title
 * @returns {Promise<Object>} Created spreadsheet info
 */
async function createSpreadsheet(merchantId, title) {
    const sheets = await getSheetsApi(merchantId);

    const result = await sheets.spreadsheets.create({
        requestBody: {
            properties: {
                title: title || 'GMC Product Feed'
            },
            sheets: [{
                properties: {
                    title: 'GMC Feed'
                }
            }]
        }
    });

    logger.info('Created new spreadsheet for merchant', {
        merchantId,
        spreadsheetId: result.data.spreadsheetId,
        title: result.data.properties.title
    });

    return {
        spreadsheetId: result.data.spreadsheetId,
        spreadsheetUrl: result.data.spreadsheetUrl,
        title: result.data.properties.title
    };
}

module.exports = {
    getAuthUrl,
    parseAuthState,
    exchangeCodeForTokens,
    isAuthenticated,
    getAuthStatus,
    writeFeedToSheet,
    readFromSheet,
    getSpreadsheetInfo,
    disconnect,
    getSheetsApi,
    getDriveApi,
    createSpreadsheet
};
