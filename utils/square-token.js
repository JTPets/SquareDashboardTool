/**
 * Square Token Management
 *
 * Handles Square OAuth token refresh for merchants.
 * Extracted from routes/square-oauth.js to eliminate circular dependency
 * between middleware/merchant.js and routes/square-oauth.js (A-3).
 */

const { SquareClient, SquareEnvironment } = require('square');
const db = require('./database');
const logger = require('./logger');
const { encryptToken, decryptToken } = require('./token-encryption');

const SQUARE_APPLICATION_ID = process.env.SQUARE_APPLICATION_ID;
const SQUARE_APPLICATION_SECRET = process.env.SQUARE_APPLICATION_SECRET;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || 'production';

/**
 * Refresh a merchant's Square OAuth token
 * @param {number} merchantId - The merchant ID
 * @returns {Object} New token info { accessToken, expiresAt }
 */
async function refreshMerchantToken(merchantId) {
    const merchant = await db.query(
        'SELECT id, square_refresh_token FROM merchants WHERE id = $1 AND is_active = TRUE',
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

module.exports = { refreshMerchantToken };
