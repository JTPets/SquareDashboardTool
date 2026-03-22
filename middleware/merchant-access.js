/**
 * Merchant Access Middleware (Audit 2.6.1)
 *
 * Verifies that an admin user has access to the merchant specified
 * in req.params.merchantId via the user_merchants table.
 *
 * Platform owners (subscription_status = 'platform_owner') are granted
 * cross-merchant access without a user_merchants row.
 *
 * LOGIC CHANGE: prevents admin users from acting on merchants they don't own
 *
 * Usage:
 *   router.post('/:merchantId/action', requireAuth, requireAdmin, requireMerchantAccess, handler);
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

/**
 * Middleware that checks whether the authenticated admin user has access
 * to the merchant specified by req.params.merchantId.
 *
 * Pass-through rules:
 *   1. Platform owner → allowed for any merchant
 *   2. Admin with user_merchants row for this merchant → allowed
 *   3. Otherwise → 403
 */
async function requireMerchantAccess(req, res, next) {
    const merchantId = parseInt(req.params.merchantId, 10);
    if (!merchantId || isNaN(merchantId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid merchant ID',
            code: 'VALIDATION_ERROR'
        });
    }

    const userId = req.session.user.id;

    try {
        // Check if user is a platform owner (cross-merchant access)
        const ownerCheck = await db.query(`
            SELECT 1 FROM user_merchants um
            JOIN merchants m ON m.id = um.merchant_id
            WHERE um.user_id = $1 AND m.subscription_status = 'platform_owner'
            LIMIT 1
        `, [userId]);

        if (ownerCheck.rows.length > 0) {
            return next();
        }

        // Check if admin has a user_merchants association for this specific merchant
        const accessCheck = await db.query(`
            SELECT 1 FROM user_merchants
            WHERE user_id = $1 AND merchant_id = $2
        `, [userId, merchantId]);

        if (accessCheck.rows.length > 0) {
            return next();
        }

        logger.warn('Admin merchant access denied', {
            userId,
            targetMerchantId: merchantId,
            path: req.path
        });

        return res.status(403).json({
            success: false,
            error: 'You do not have access to this merchant',
            code: 'FORBIDDEN'
        });
    } catch (error) {
        logger.error('Merchant access check failed', {
            error: error.message,
            userId,
            merchantId
        });
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
}

module.exports = { requireMerchantAccess };
