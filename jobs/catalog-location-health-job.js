/**
 * Catalog Location Health Job
 *
 * Daily check for Square catalog location mismatches.
 * Runs for all active merchants with a Square access token.
 *
 * @module jobs/catalog-location-health-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const { checkAndRecordHealth } = require('../services/catalog/location-health-service');

/**
 * Run scheduled catalog location health check for all active merchants
 */
async function runScheduledLocationHealthCheck() {
    logger.info('Starting scheduled catalog location health check for all merchants');

    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No active merchants for catalog location health check');
        return { merchantCount: 0, results: [] };
    }

    const results = [];

    for (const merchant of merchants) {
        try {
            const result = await checkAndRecordHealth(merchant.id);

            logger.info('Scheduled catalog location health check complete', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });

            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
        } catch (error) {
            logger.error('Scheduled catalog location health check failed', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: error.message,
                stack: error.stack
            });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: error.message
            });
        }
    }

    return { merchantCount: merchants.length, results };
}

module.exports = { runScheduledLocationHealthCheck };
