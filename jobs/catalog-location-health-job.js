/**
 * Catalog Location Health Job
 *
 * Daily check for Square catalog location mismatches.
 * Debug-only: hard-coded to merchant_id = 3.
 *
 * @module jobs/catalog-location-health-job
 */

const logger = require('../utils/logger');
const { checkAndRecordHealth } = require('../services/catalog/location-health-service');

const DEBUG_MERCHANT_ID = 3;

/**
 * Run scheduled catalog location health check
 * Only runs for merchant_id = 3 (debug tool)
 */
async function runScheduledLocationHealthCheck() {
    logger.info('Starting scheduled catalog location health check', {
        merchantId: DEBUG_MERCHANT_ID
    });

    try {
        const result = await checkAndRecordHealth(DEBUG_MERCHANT_ID);

        logger.info('Scheduled catalog location health check complete', {
            merchantId: DEBUG_MERCHANT_ID,
            ...result
        });

        return result;
    } catch (error) {
        logger.error('Scheduled catalog location health check failed', {
            merchantId: DEBUG_MERCHANT_ID,
            error: error.message,
            stack: error.stack
        });
        return { error: error.message };
    }
}

module.exports = { runScheduledLocationHealthCheck };
