/**
 * POD Cleanup Job
 *
 * LOGIC CHANGE (BUG-008): Created missing cron job for expired POD photo cleanup.
 * The cleanupExpiredPods() function existed but was never called.
 *
 * Runs daily at 3:30 AM ET by default.
 *
 * @module jobs/pod-cleanup-job
 */

const logger = require('../utils/logger');
const { cleanupExpiredPods } = require('../services/delivery');

/**
 * Run POD cleanup for all merchants.
 * cleanupExpiredPods() already queries across all merchants via JOIN.
 *
 * @returns {Promise<Object>} Cleanup stats { deleted, errors }
 */
async function runPodCleanup() {
    logger.info('Starting POD cleanup job');

    try {
        const result = await cleanupExpiredPods();
        logger.info('POD cleanup job completed', result);
        return result;
    } catch (err) {
        logger.error('POD cleanup job failed', { error: err.message, stack: err.stack });
        return { deleted: 0, errors: 1 };
    }
}

/**
 * Scheduled wrapper for cron execution
 */
async function runScheduledPodCleanup() {
    await runPodCleanup();
}

module.exports = {
    runPodCleanup,
    runScheduledPodCleanup
};
