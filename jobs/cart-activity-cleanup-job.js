/**
 * Cart Activity Cleanup Job
 *
 * Handles automated cleanup of cart activity records:
 * - Marks pending carts as abandoned after 7 days
 * - Purges old records after 30 days
 *
 * @module jobs/cart-activity-cleanup-job
 */

const logger = require('../utils/logger');
const cartActivityService = require('../services/cart/cart-activity-service');

// Configuration
const ABANDON_THRESHOLD_DAYS = 7;
const PURGE_THRESHOLD_DAYS = 30;

/**
 * Run cart activity cleanup
 *
 * @returns {Promise<Object>} Cleanup results with counts
 */
async function runCartActivityCleanup() {
    const startTime = Date.now();

    try {
        logger.info('Starting cart activity cleanup job');

        // Mark pending carts older than 7 days as abandoned
        const abandonedCount = await cartActivityService.markAbandoned(null, ABANDON_THRESHOLD_DAYS);

        // Purge records older than 30 days
        const purgedCount = await cartActivityService.purgeOld(null, PURGE_THRESHOLD_DAYS);

        const duration = Date.now() - startTime;

        logger.info('Cart activity cleanup job completed', {
            abandonedCount,
            purgedCount,
            durationMs: duration
        });

        return {
            success: true,
            abandonedCount,
            purgedCount,
            durationMs: duration
        };
    } catch (err) {
        const duration = Date.now() - startTime;

        logger.error('Cart activity cleanup job failed', {
            error: err.message,
            stack: err.stack,
            durationMs: duration
        });

        return {
            success: false,
            error: err.message,
            durationMs: duration
        };
    }
}

/**
 * Scheduled wrapper for cron execution
 * Logs results and handles errors gracefully
 */
async function runScheduledCartActivityCleanup() {
    try {
        await runCartActivityCleanup();
    } catch (err) {
        // Error already logged in runCartActivityCleanup
        // Cron should continue running even if individual runs fail
    }
}

module.exports = {
    runCartActivityCleanup,
    runScheduledCartActivityCleanup
};
