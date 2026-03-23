/**
 * Catalog Health Job
 *
 * Daily full catalog health check across all check types.
 * Runs for all active merchants with a Square access token.
 *
 * @module jobs/catalog-health-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const { runFullHealthCheck } = require('../services/catalog/catalog-health-service');

/**
 * Run scheduled catalog health check for all active merchants
 */
async function runScheduledHealthCheck() {
    logger.info('Starting scheduled catalog health check for all merchants');

    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No active merchants for catalog health check');
        return { merchantCount: 0, results: [] };
    }

    const results = [];

    for (const merchant of merchants) {
        try {
            const result = await runFullHealthCheck(merchant.id);

            logger.info('Scheduled catalog health check complete', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                newIssues: result.newIssues.length,
                resolved: result.resolved.length,
                existingOpen: result.existingOpen,
                durationMs: result.durationMs
            });

            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
        } catch (error) {
            logger.error('Scheduled catalog health check failed', {
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

module.exports = { runScheduledHealthCheck };
