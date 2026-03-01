/**
 * Subscription Bridge Service
 *
 * Bridges System B (Square billing in subscribers table) to System A
 * (merchant subscription enforcement in merchants table).
 *
 * When a payment event occurs in System B, this service updates System A
 * so that the merchant's access is granted/revoked accordingly.
 *
 * @module services/subscription-bridge
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

/**
 * Activate a merchant's subscription after successful payment.
 * Updates both the subscribers record and the merchants record.
 *
 * @param {number} subscriberId - The subscriber ID (System B)
 * @param {number} merchantId - The merchant ID (System A)
 * @returns {Promise<Object>} Updated merchant record
 */
async function activateMerchantSubscription(subscriberId, merchantId) {
    if (!merchantId) {
        logger.warn('Cannot activate merchant subscription: no merchant_id', { subscriberId });
        return null;
    }

    const result = await db.query(`
        UPDATE merchants
        SET subscription_status = 'active',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, subscription_status, business_name
    `, [merchantId]);

    if (result.rows.length === 0) {
        logger.error('Merchant not found for subscription activation', { merchantId, subscriberId });
        return null;
    }

    logger.info('Merchant subscription activated via payment', {
        merchantId,
        subscriberId,
        businessName: result.rows[0].business_name
    });

    return result.rows[0];
}

/**
 * Suspend a merchant's subscription after payment failure.
 *
 * @param {number} subscriberId - The subscriber ID (System B)
 * @param {number} merchantId - The merchant ID (System A)
 * @returns {Promise<Object|null>} Updated merchant record or null
 */
async function suspendMerchantSubscription(subscriberId, merchantId) {
    if (!merchantId) {
        logger.warn('Cannot suspend merchant subscription: no merchant_id', { subscriberId });
        return null;
    }

    // Don't suspend platform owners
    const merchant = await db.query(
        'SELECT id, subscription_status FROM merchants WHERE id = $1',
        [merchantId]
    );

    if (merchant.rows.length === 0) {
        return null;
    }

    if (merchant.rows[0].subscription_status === 'platform_owner') {
        logger.info('Skipping suspension for platform owner', { merchantId });
        return merchant.rows[0];
    }

    const result = await db.query(`
        UPDATE merchants
        SET subscription_status = 'suspended',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, subscription_status, business_name
    `, [merchantId]);

    logger.warn('Merchant subscription suspended due to payment failure', {
        merchantId,
        subscriberId,
        businessName: result.rows[0]?.business_name
    });

    return result.rows[0];
}

/**
 * Cancel a merchant's subscription.
 *
 * @param {number} subscriberId - The subscriber ID (System B)
 * @param {number} merchantId - The merchant ID (System A)
 * @returns {Promise<Object|null>} Updated merchant record or null
 */
async function cancelMerchantSubscription(subscriberId, merchantId) {
    if (!merchantId) {
        logger.warn('Cannot cancel merchant subscription: no merchant_id', { subscriberId });
        return null;
    }

    // Don't cancel platform owners
    const merchant = await db.query(
        'SELECT id, subscription_status FROM merchants WHERE id = $1',
        [merchantId]
    );

    if (merchant.rows.length === 0) {
        return null;
    }

    if (merchant.rows[0].subscription_status === 'platform_owner') {
        logger.info('Skipping cancellation for platform owner', { merchantId });
        return merchant.rows[0];
    }

    const result = await db.query(`
        UPDATE merchants
        SET subscription_status = 'cancelled',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, subscription_status, business_name
    `, [merchantId]);

    logger.info('Merchant subscription cancelled', {
        merchantId,
        subscriberId,
        businessName: result.rows[0]?.business_name
    });

    return result.rows[0];
}

/**
 * Look up merchant_id for a subscriber.
 * First checks subscriber.merchant_id, then attempts email-based match.
 *
 * @param {Object} subscriber - Subscriber record from System B
 * @returns {Promise<number|null>} merchant_id or null
 */
async function resolveMerchantId(subscriber) {
    // Direct link exists
    if (subscriber.merchant_id) {
        return subscriber.merchant_id;
    }

    // Fallback: try to match by email via users → user_merchants
    if (subscriber.email) {
        const result = await db.query(`
            SELECT um.merchant_id
            FROM users u
            JOIN user_merchants um ON um.user_id = u.id
            WHERE u.email = $1 AND um.is_primary = TRUE
            LIMIT 1
        `, [subscriber.email.toLowerCase()]);

        if (result.rows.length > 0) {
            const merchantId = result.rows[0].merchant_id;

            // Backfill the merchant_id on the subscriber for future lookups
            await db.query(
                'UPDATE subscribers SET merchant_id = $1 WHERE id = $2',
                [merchantId, subscriber.id]
            );

            logger.info('Resolved and backfilled merchant_id for subscriber', {
                subscriberId: subscriber.id,
                merchantId,
                email: subscriber.email
            });

            return merchantId;
        }
    }

    return null;
}

module.exports = {
    activateMerchantSubscription,
    suspendMerchantSubscription,
    cancelMerchantSubscription,
    resolveMerchantId
};
