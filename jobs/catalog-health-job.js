/**
 * Catalog Health Job
 *
 * Daily full catalog health check across all check types.
 * Debug-only: hard-coded to merchant_id = 3.
 *
 * @module jobs/catalog-health-job
 */

const logger = require('../utils/logger');
const { runFullHealthCheck } = require('../services/catalog/catalog-health-service');

const DEBUG_MERCHANT_ID = 3;

/**
 * Run scheduled catalog health check
 * Only runs for merchant_id = 3 (debug tool)
 */
async function runScheduledHealthCheck() {
    logger.info('Starting scheduled catalog health check', {
        merchantId: DEBUG_MERCHANT_ID
    });

    try {
        const result = await runFullHealthCheck(DEBUG_MERCHANT_ID);

        logger.info('Scheduled catalog health check complete', {
            merchantId: DEBUG_MERCHANT_ID,
            newIssues: result.newIssues.length,
            resolved: result.resolved.length,
            existingOpen: result.existingOpen,
            durationMs: result.durationMs
        });

        return result;
    } catch (error) {
        logger.error('Scheduled catalog health check failed', {
            merchantId: DEBUG_MERCHANT_ID,
            error: error.message,
            stack: error.stack
        });
        return { error: error.message };
    }
}

module.exports = { runScheduledHealthCheck };
