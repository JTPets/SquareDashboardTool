/**
 * Promo Expiry Job
 *
 * Runs weekly. Finds active subscribers whose promotional pricing period
 * (promo_expires_at) has elapsed. Logs a warning for each — does NOT
 * auto-cancel or auto-revert billing. Flagged records require manual
 * review to adjust Square subscription pricing or notify the merchant.
 *
 * @module jobs/promo-expiry-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

/**
 * Query subscribers whose promo has expired but subscription is still active.
 * @returns {Promise<Array>}
 */
async function getExpiredPromoSubscribers() {
    const result = await db.query(`
        SELECT id, email, business_name, promo_expires_at, subscription_plan, merchant_id
        FROM subscribers
        WHERE subscription_status = 'active'
          AND promo_expires_at IS NOT NULL
          AND promo_expires_at < NOW()
        ORDER BY promo_expires_at ASC
    `);
    return result.rows;
}

/**
 * Core expiry check logic — exported for direct invocation in tests.
 * @returns {Promise<{ flagged: number }>}
 */
async function runPromoExpiryCheck() {
    const expired = await getExpiredPromoSubscribers();

    if (expired.length === 0) {
        logger.info('Promo expiry check: no expired promos found');
        return { flagged: 0 };
    }

    for (const sub of expired) {
        logger.warn('Promotional pricing has expired — manual review required', {
            subscriberId: sub.id,
            merchantId: sub.merchant_id,
            promoExpiresAt: sub.promo_expires_at,
            plan: sub.subscription_plan
        });
    }

    logger.info(`Promo expiry check complete: ${expired.length} subscriber(s) flagged for review`);
    return { flagged: expired.length };
}

/**
 * Scheduled entry point — catches errors so cron keeps running.
 */
async function runScheduledPromoExpiryCheck() {
    try {
        return await runPromoExpiryCheck();
    } catch (error) {
        logger.error('Promo expiry job failed', { error: error.message });
        return { flagged: 0 };
    }
}

module.exports = { runPromoExpiryCheck, runScheduledPromoExpiryCheck, getExpiredPromoSubscribers };
