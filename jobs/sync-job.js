/**
 * Sync Job
 *
 * Handles scheduled database sync and Google Merchant Center (GMC) sync.
 * Iterates through all active merchants and runs appropriate sync operations.
 *
 * @module jobs/sync-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const emailNotifier = require('../utils/email-notifier');
const gmcApi = require('../utils/merchant-center-api');
const { runSmartSync } = require('../routes/sync');

/**
 * Run smart sync for all active merchants
 *
 * @returns {Promise<Object>} Results of sync operation for each merchant
 */
async function runSmartSyncForAllMerchants() {
    logger.info('Running scheduled smart sync for all merchants');

    // Get all active merchants
    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No merchants to sync');
        return { merchantCount: 0, results: [], errors: [] };
    }

    const allErrors = [];
    const results = [];

    for (const merchant of merchants) {
        try {
            logger.info('Running smart sync for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name
            });
            const result = await runSmartSync({ merchantId: merchant.id });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                ...result
            });
            logger.info('Scheduled smart sync completed for merchant', {
                merchantId: merchant.id,
                synced: result.synced,
                skipped: Object.keys(result.skipped).length,
                errors: result.errors?.length || 0
            });

            if (result.errors && result.errors.length > 0) {
                allErrors.push({
                    merchantId: merchant.id,
                    businessName: merchant.business_name,
                    errors: result.errors
                });
            }
        } catch (error) {
            logger.error('Smart sync failed for merchant', {
                merchantId: merchant.id,
                error: error.message
            });
            allErrors.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                errors: [{ type: 'general', error: error.message }]
            });
        }
    }

    return {
        merchantCount: merchants.length,
        results,
        errors: allErrors
    };
}

/**
 * Cron job handler for scheduled smart sync
 * Wraps runSmartSyncForAllMerchants with error handling and email alerts
 *
 * @returns {Promise<void>}
 */
async function runScheduledSmartSync() {
    try {
        const { errors } = await runSmartSyncForAllMerchants();

        // Send alert if there were errors for any merchant
        if (errors.length > 0) {
            const errorDetails = errors.map(m =>
                `Merchant ${m.businessName} (${m.merchantId}):\n${m.errors.map(e => `  - ${e.type}: ${e.error}`).join('\n')}`
            ).join('\n\n');
            await emailNotifier.sendAlert(
                'Database Sync Partial Failure',
                `Some sync operations failed:\n\n${errorDetails}`
            );
        }
    } catch (error) {
        logger.error('Scheduled smart sync failed', { error: error.message, stack: error.stack });
        await emailNotifier.sendAlert(
            'Database Sync Failed',
            `Failed to run scheduled database sync:\n\n${error.message}\n\nStack: ${error.stack}`
        );
    }
}

/**
 * Run GMC (Google Merchant Center) product sync for all active merchants
 *
 * @returns {Promise<Object>} Results for each merchant
 */
async function runGmcSyncForAllMerchants() {
    logger.info('Running scheduled GMC product sync for all merchants');

    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No merchants for GMC sync');
        return { total: 0, results: [], failures: [] };
    }

    const results = [];
    for (const merchant of merchants) {
        try {
            logger.info('Running GMC product sync for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name
            });
            const gmcResult = await gmcApi.syncProductCatalog(merchant.id);
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                success: true,
                total: gmcResult.total,
                synced: gmcResult.synced,
                failed: gmcResult.failed
            });
            logger.info('GMC product sync completed for merchant', {
                merchantId: merchant.id,
                total: gmcResult.total,
                synced: gmcResult.synced,
                failed: gmcResult.failed
            });
        } catch (merchantError) {
            logger.error('GMC sync failed for merchant', {
                merchantId: merchant.id,
                error: merchantError.message
            });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                success: false,
                error: merchantError.message
            });
        }
    }

    const failures = results.filter(r => !r.success);

    logger.info('Scheduled GMC sync completed for all merchants', {
        total: merchants.length,
        successful: results.filter(r => r.success).length,
        failed: failures.length
    });

    return {
        total: merchants.length,
        results,
        failures
    };
}

/**
 * Cron job handler for scheduled GMC sync
 * Wraps runGmcSyncForAllMerchants with error handling and email alerts
 *
 * @returns {Promise<void>}
 */
async function runScheduledGmcSync() {
    try {
        const { failures } = await runGmcSyncForAllMerchants();

        // Send alert if any syncs failed
        if (failures.length > 0) {
            const errorDetails = failures.map(f =>
                `${f.businessName} (${f.merchantId}): ${f.error}`
            ).join('\n');
            await emailNotifier.sendAlert(
                'GMC Sync Partial Failure',
                `GMC sync failed for some merchants:\n\n${errorDetails}`
            );
        }
    } catch (error) {
        logger.error('Scheduled GMC sync failed', { error: error.message, stack: error.stack });
        await emailNotifier.sendAlert(
            'GMC Sync Failed',
            `Failed to run scheduled GMC sync:\n\n${error.message}\n\nStack: ${error.stack}`
        );
    }
}

module.exports = {
    runSmartSyncForAllMerchants,
    runScheduledSmartSync,
    runGmcSyncForAllMerchants,
    runScheduledGmcSync
};
