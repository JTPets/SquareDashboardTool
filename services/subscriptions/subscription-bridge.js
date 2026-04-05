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

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const subscriptionHandler = require('../../utils/subscription-handler');
const { getPaidModules } = require('../../config/feature-registry');

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

    // Grant all paid feature modules to this merchant
    const moduleKeys = getPaidModules().map(m => m.key);
    await db.query(`
        INSERT INTO merchant_features (merchant_id, feature_key, enabled, enabled_at, source)
        SELECT $1, unnest($2::text[]), TRUE, NOW(), 'subscription'
        ON CONFLICT (merchant_id, feature_key)
        DO UPDATE SET enabled = TRUE, enabled_at = NOW(), disabled_at = NULL, source = 'subscription'
    `, [merchantId, moduleKeys]);

    logger.info('Merchant subscription activated via payment', {
        merchantId,
        subscriberId,
        businessName: result.rows[0].business_name,
        featuresGranted: moduleKeys
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

    // Deactivate all subscription-granted features (mirrors cancel behaviour)
    await db.query(`
        UPDATE merchant_features
        SET enabled = FALSE, disabled_at = NOW()
        WHERE merchant_id = $1 AND source = 'subscription'
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

    // Deactivate all subscription-granted features
    await db.query(`
        UPDATE merchant_features
        SET enabled = FALSE, disabled_at = NOW()
        WHERE merchant_id = $1 AND source = 'subscription'
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

/**
 * Cancel a Square subscription, swallowing errors (best-effort).
 * Use before cancelling locally so a Square API failure doesn't block the user.
 *
 * @param {string} squareSubscriptionId
 */
async function cancelWithSquare(squareSubscriptionId) {
    const squareSubscriptions = require('../../utils/square-subscriptions');
    try {
        await squareSubscriptions.cancelSubscription(squareSubscriptionId);
        logger.info('Square subscription canceled', { squareSubscriptionId });
    } catch (squareError) {
        logger.warn('Failed to cancel Square subscription', {
            error: squareError.message, squareSubscriptionId
        });
    }
}

/**
 * Assemble the combined System A + System B status summary for a merchant.
 * Used by GET /subscriptions/merchant-status.
 *
 * @param {Object} merchantContext - req.merchantContext
 * @returns {Promise<Object>} { subscription, billing, plans, merchantId, businessName }
 */
async function getMerchantStatusSummary(merchantContext) {
    const mc = merchantContext;
    const plans = await subscriptionHandler.getPlans(mc.id);
    const subscriber = await subscriptionHandler.getSubscriberByMerchantId(mc.id);

    let trialDaysRemaining = null;
    if (mc.subscriptionStatus === 'trial' && mc.trialEndsAt) {
        const now = new Date();
        const trialEnd = new Date(mc.trialEndsAt);
        trialDaysRemaining = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    }

    return {
        subscription: {
            status: mc.subscriptionStatus,
            isValid: mc.isSubscriptionValid,
            trialEndsAt: mc.trialEndsAt,
            trialDaysRemaining,
            subscriptionEndsAt: mc.subscriptionEndsAt
        },
        billing: subscriber ? {
            plan: subscriber.subscription_plan,
            priceCents: subscriber.price_cents,
            cardBrand: subscriber.card_brand,
            cardLastFour: subscriber.card_last_four,
            nextBillingDate: subscriber.next_billing_date,
            squareSubscriptionId: subscriber.square_subscription_id
        } : null,
        plans,
        merchantId: mc.id,
        businessName: mc.businessName
    };
}

module.exports = {
    activateMerchantSubscription,
    suspendMerchantSubscription,
    cancelMerchantSubscription,
    resolveMerchantId,
    cancelWithSquare,
    getMerchantStatusSummary
};
