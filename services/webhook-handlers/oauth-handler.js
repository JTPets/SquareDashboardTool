/**
 * OAuth Webhook Handler
 *
 * Handles Square webhook events related to OAuth authorization.
 *
 * Event types handled:
 * - oauth.authorization.revoked
 *
 * @module services/webhook-handlers/oauth-handler
 */

const logger = require('../../utils/logger');
const db = require('../../utils/database');

class OAuthHandler {
    /**
     * Handle oauth.authorization.revoked event
     * Marks merchant as disconnected when OAuth access is revoked
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with revoked status
     */
    async handleAuthorizationRevoked(context) {
        const { event } = context;
        const result = { handled: true };

        const revokedMerchantId = event.merchant_id;

        logger.warn('OAuth authorization revoked via webhook', {
            merchantId: revokedMerchantId,
            revokedAt: event.created_at
        });

        result.revoked = true;
        result.merchantId = revokedMerchantId;

        // Mark merchant as disconnected in database
        await db.query(`
            UPDATE merchants
            SET is_active = FALSE,
                square_access_token = 'REVOKED',
                square_refresh_token = NULL,
                updated_at = NOW()
            WHERE square_merchant_id = $1
        `, [revokedMerchantId]);

        logger.error('OAUTH REVOKED - Square access has been disconnected. Re-authorization required.', {
            merchantId: revokedMerchantId
        });

        return result;
    }
}

module.exports = OAuthHandler;
