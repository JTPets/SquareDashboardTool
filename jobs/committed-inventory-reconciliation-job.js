/**
 * Committed Inventory Reconciliation Job (BACKLOG-10)
 *
 * Safety net that runs the full committed inventory sync once daily.
 * Catches edge cases that invoice webhooks might miss:
 * - Webhooks lost during downtime
 * - Invoice status transitions that don't fire webhooks (e.g., FAILED)
 * - Data drift from any source
 *
 * Schedule: Daily at 4:00 AM America/Toronto (configurable via COMMITTED_INVENTORY_RECONCILIATION_CRON)
 *
 * @module jobs/committed-inventory-reconciliation-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const squareApi = require('../utils/square-api');

/**
 * Run committed inventory reconciliation for all active merchants.
 * Uses the existing syncCommittedInventory function which does a full
 * rebuild from Square's Invoice API.
 *
 * @returns {Promise<Object>} Results per merchant
 */
async function runCommittedInventoryReconciliation() {
    logger.info('Starting daily committed inventory reconciliation');

    const merchantsResult = await db.query(
        'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
    );
    const merchants = merchantsResult.rows;

    if (merchants.length === 0) {
        logger.info('No merchants for committed inventory reconciliation');
        return { merchantCount: 0, results: [] };
    }

    const results = [];

    for (const merchant of merchants) {
        try {
            logger.info('Running committed inventory reconciliation for merchant', {
                merchantId: merchant.id,
                businessName: merchant.business_name
            });

            const syncResult = await squareApi.syncCommittedInventory(merchant.id);

            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                success: true,
                result: syncResult
            });

            logger.info('Committed inventory reconciliation complete for merchant', {
                merchantId: merchant.id,
                result: typeof syncResult === 'object' ? syncResult : { records: syncResult }
            });
        } catch (error) {
            logger.error('Committed inventory reconciliation failed for merchant', {
                merchantId: merchant.id,
                error: error.message
            });
            results.push({
                merchantId: merchant.id,
                businessName: merchant.business_name,
                success: false,
                error: error.message
            });
        }
    }

    const failures = results.filter(r => !r.success);
    logger.info('Daily committed inventory reconciliation finished', {
        merchantCount: merchants.length,
        successful: results.filter(r => r.success).length,
        failed: failures.length
    });

    return { merchantCount: merchants.length, results };
}

/**
 * Cron job handler for scheduled committed inventory reconciliation.
 *
 * @returns {Promise<void>}
 */
async function runScheduledReconciliation() {
    try {
        await runCommittedInventoryReconciliation();
    } catch (error) {
        logger.error('Scheduled committed inventory reconciliation failed', {
            error: error.message,
            stack: error.stack
        });
    }
}

module.exports = {
    runCommittedInventoryReconciliation,
    runScheduledReconciliation
};
