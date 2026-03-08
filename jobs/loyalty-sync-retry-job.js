/**
 * Loyalty Square Sync Retry Job (LA-4 fix)
 *
 * Periodically retries Square discount creation for earned rewards
 * where the initial async call failed. Runs alongside the loyalty
 * catchup job (every 15 min past the hour).
 *
 * @module jobs/loyalty-sync-retry-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const { retryPendingSquareSyncs } = require('../services/loyalty-admin/square-sync-retry-service');

/**
 * Get all merchants with pending Square sync rewards
 *
 * @returns {Promise<Array<{id: number}>>} Merchant IDs
 */
async function getMerchantsWithPendingSyncs() {
    const result = await db.query(`
        SELECT DISTINCT r.merchant_id as id
        FROM loyalty_rewards r
        INNER JOIN merchants m ON r.merchant_id = m.id AND m.is_active = TRUE
        WHERE r.status = 'earned'
          AND r.square_sync_pending = TRUE
    `);
    return result.rows;
}

/**
 * Run the sync retry job for all merchants with pending syncs
 *
 * @returns {Promise<Object>} Aggregated results
 */
async function runLoyaltySyncRetry() {
    const startTime = Date.now();
    const aggregate = {
        merchantsProcessed: 0,
        totalRetried: 0,
        totalSucceeded: 0,
        totalFailed: 0
    };

    try {
        const merchants = await getMerchantsWithPendingSyncs();

        if (merchants.length === 0) {
            return aggregate;
        }

        logger.info('Starting loyalty sync retry job', {
            merchantCount: merchants.length
        });

        for (const merchant of merchants) {
            try {
                const result = await retryPendingSquareSyncs(merchant.id);
                aggregate.merchantsProcessed++;
                aggregate.totalRetried += result.retried;
                aggregate.totalSucceeded += result.succeeded;
                aggregate.totalFailed += result.failed;
            } catch (err) {
                logger.error('Loyalty sync retry failed for merchant', {
                    merchantId: merchant.id,
                    error: err.message
                });
            }
        }

        const duration = Date.now() - startTime;
        if (aggregate.totalRetried > 0) {
            logger.info('Loyalty sync retry job completed', {
                ...aggregate,
                durationMs: duration
            });
        }
    } catch (error) {
        logger.error('Loyalty sync retry job failed', {
            error: error.message,
            stack: error.stack
        });
    }

    return aggregate;
}

/**
 * Cron-safe wrapper for scheduled execution
 */
async function runScheduledLoyaltySyncRetry() {
    try {
        await runLoyaltySyncRetry();
    } catch (error) {
        logger.error('Scheduled loyalty sync retry error', {
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = {
    runLoyaltySyncRetry,
    runScheduledLoyaltySyncRetry,
    getMerchantsWithPendingSyncs
};
