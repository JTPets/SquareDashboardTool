/**
 * Cycle Count Job
 *
 * Handles daily batch generation for cycle counting.
 * Iterates through all active merchants and generates daily count batches.
 * Also handles startup check to generate today's batch if server was offline.
 *
 * @module jobs/cycle-count-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');
const { generateDailyBatch } = require('../utils/cycle-count-utils');

/**
 * Run daily batch generation for all active merchants
 *
 * @returns {Promise<Object>} Results for each merchant
 */
async function runDailyBatchGeneration() {
    logger.info('Running scheduled daily batch generation for all merchants');

    // Get all active merchants
    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No merchants for batch generation');
        return { merchantCount: 0, results: [] };
    }

    const results = [];
    for (const merchant of merchants) {
        try {
            const result = await generateDailyBatch(merchant.id);
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
            logger.info('Batch generation completed for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
        } catch (merchantError) {
            logger.error('Batch generation failed for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: merchantError.message
            });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                error: merchantError.message
            });
        }
    }

    logger.info('Scheduled batch generation completed for all merchants', {
        merchantCount: merchants.length,
        results
    });

    return { merchantCount: merchants.length, results };
}

/**
 * Cron job handler for scheduled batch generation
 * Wraps runDailyBatchGeneration with error handling and email alerts
 *
 * @returns {Promise<void>}
 */
async function runScheduledBatchGeneration() {
    try {
        await runDailyBatchGeneration();
    } catch (error) {
        logger.error('Scheduled batch generation failed', { error: error.message, stack: error.stack });
        await emailNotifier.sendAlert(
            'Cycle Count Batch Generation Failed',
            `Failed to generate daily cycle count batch:\n\n${error.message}\n\nStack: ${error.stack}`
        );
    }
}

/**
 * Startup check: Generate today's batch if it doesn't exist yet for each merchant
 * This handles cases where server was offline during scheduled cron time
 *
 * @returns {Promise<void>}
 */
async function runStartupBatchCheck() {
    try {
        // Get all active merchants
        const merchantsResult = await db.query(
            'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
        );
        const merchants = merchantsResult.rows;

        if (merchants.length === 0) {
            logger.info('No merchants for startup batch check');
            return;
        }

        for (const merchant of merchants) {
            try {
                // Check if any items have been added to today's batch for this merchant
                const batchCheck = await db.query(`
                    SELECT COUNT(*) as count
                    FROM count_queue_daily
                    WHERE batch_date = CURRENT_DATE AND merchant_id = $1
                `, [merchant.id]);

                const todaysBatchCount = parseInt(batchCheck.rows[0]?.count || 0);

                if (todaysBatchCount === 0) {
                    logger.info('No batch found for today - generating startup batch', {
                        merchantId: merchant.id,
                        businessName: merchant.business_name
                    });
                    const result = await generateDailyBatch(merchant.id);
                    logger.info('Startup batch generation completed', {
                        merchantId: merchant.id,
                        businessName: merchant.business_name,
                        ...result
                    });
                } else {
                    logger.info("Today's batch already exists", {
                        merchantId: merchant.id,
                        businessName: merchant.business_name,
                        items_count: todaysBatchCount
                    });
                }
            } catch (merchantError) {
                logger.error('Startup batch check failed for merchant', {
                    merchantId: merchant.id,
                    businessName: merchant.business_name,
                    error: merchantError.message
                });
            }
        }
    } catch (error) {
        logger.error('Startup batch check failed', { error: error.message });
    }
}

module.exports = {
    runDailyBatchGeneration,
    runScheduledBatchGeneration,
    runStartupBatchCheck
};
