/**
 * Email Heartbeat Job
 *
 * Sends a daily "system healthy" email so that silence becomes a signal.
 * If you stop receiving the heartbeat, your alerting pipeline is broken.
 *
 * Controlled by:
 *   EMAIL_HEARTBEAT_ENABLED=true|false (default: false)
 *   EMAIL_HEARTBEAT_CRON=0 8 * * *    (default: daily at 8 AM)
 *
 * @module jobs/email-heartbeat-job
 */

const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');

/**
 * Check whether the heartbeat feature is enabled
 * @returns {boolean}
 */
function isHeartbeatEnabled() {
    return process.env.EMAIL_HEARTBEAT_ENABLED === 'true';
}

/**
 * Cron handler: send heartbeat email if enabled
 * @returns {Promise<void>}
 */
async function runScheduledHeartbeat() {
    if (!isHeartbeatEnabled()) {
        return;
    }

    logger.info('Running scheduled email heartbeat');
    try {
        await emailNotifier.sendHeartbeat();
        logger.info('Scheduled email heartbeat completed');
    } catch (error) {
        logger.error('Scheduled email heartbeat failed', {
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = {
    runScheduledHeartbeat,
    isHeartbeatEnabled
};
