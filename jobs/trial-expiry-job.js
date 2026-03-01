/**
 * Trial Expiry Notification Job
 *
 * Runs daily at 7:00 AM ET. Queries merchants whose trial expires within
 * 14 days and sends email notifications. Also logs warnings for trials
 * that expired in the last 24 hours.
 *
 * Does NOT auto-deactivate — notification only.
 *
 * @module jobs/trial-expiry-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');

/**
 * Query merchants with expiring or recently expired trials
 * @returns {Promise<{expiring: Array, recentlyExpired: Array}>}
 */
async function getTrialExpiryMerchants() {
    // Merchants whose trial expires within 14 days (still active)
    const expiringResult = await db.query(`
        SELECT id, business_name, trial_ends_at, subscription_status, business_email
        FROM merchants
        WHERE is_active = TRUE
          AND subscription_status = 'trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at > NOW()
          AND trial_ends_at <= NOW() + INTERVAL '14 days'
        ORDER BY trial_ends_at ASC
    `);

    // Merchants whose trial expired in the last 24 hours
    const recentlyExpiredResult = await db.query(`
        SELECT id, business_name, trial_ends_at, subscription_status, business_email
        FROM merchants
        WHERE is_active = TRUE
          AND subscription_status = 'trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at <= NOW()
          AND trial_ends_at > NOW() - INTERVAL '24 hours'
        ORDER BY trial_ends_at ASC
    `);

    return {
        expiring: expiringResult.rows,
        recentlyExpired: recentlyExpiredResult.rows
    };
}

/**
 * Format a date for display
 * @param {string|Date} date
 * @returns {string}
 */
function formatDate(date) {
    return new Date(date).toLocaleDateString('en-CA', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/Toronto'
    });
}

/**
 * Calculate days until a date
 * @param {string|Date} date
 * @returns {number}
 */
function daysUntil(date) {
    const now = new Date();
    const target = new Date(date);
    return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

/**
 * Run trial expiry notifications
 */
async function runTrialExpiryNotifications() {
    logger.info('Trial expiry notification job started');

    try {
        const { expiring, recentlyExpired } = await getTrialExpiryMerchants();

        // Log recently expired trials as warnings
        for (const merchant of recentlyExpired) {
            logger.warn('Merchant trial expired in last 24 hours', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                trialEndsAt: merchant.trial_ends_at
            });
        }

        // Send notification for expiring trials
        if (expiring.length > 0 || recentlyExpired.length > 0) {
            const expiringLines = expiring.map(m =>
                `- ${m.business_name} (ID: ${m.id}): expires ${formatDate(m.trial_ends_at)} (${daysUntil(m.trial_ends_at)} days)`
            ).join('\n');

            const expiredLines = recentlyExpired.map(m =>
                `- ${m.business_name} (ID: ${m.id}): expired ${formatDate(m.trial_ends_at)}`
            ).join('\n');

            const body = [
                expiring.length > 0 ? `EXPIRING SOON (${expiring.length}):\n${expiringLines}` : '',
                recentlyExpired.length > 0 ? `RECENTLY EXPIRED (${recentlyExpired.length}):\n${expiredLines}` : ''
            ].filter(Boolean).join('\n\n');

            await emailNotifier.sendAlert(
                `Trial Expiry Report — ${expiring.length} expiring, ${recentlyExpired.length} expired`,
                body
            );

            logger.info('Trial expiry notifications sent', {
                expiringCount: expiring.length,
                recentlyExpiredCount: recentlyExpired.length
            });
        } else {
            logger.info('No expiring or recently expired trials');
        }

        return { expiring: expiring.length, recentlyExpired: recentlyExpired.length };
    } catch (error) {
        logger.error('Trial expiry notification job failed', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Scheduled wrapper (called by cron)
 */
async function runScheduledTrialExpiryNotifications() {
    try {
        await runTrialExpiryNotifications();
    } catch (error) {
        // Logged inside runTrialExpiryNotifications, swallow to not crash cron
    }
}

module.exports = {
    runTrialExpiryNotifications,
    runScheduledTrialExpiryNotifications,
    getTrialExpiryMerchants,
    // Exported for testing
    formatDate,
    daysUntil
};
