/**
 * Webhook Retry Job
 *
 * Handles retry processing for failed webhook events.
 * Uses exponential backoff to re-trigger appropriate syncs.
 * Also handles cleanup of old webhook events.
 *
 * @module jobs/webhook-retry-job
 */

const db = require('../utils/database');
const logger = require('../utils/logger');
const webhookRetry = require('../utils/webhook-retry');
const squareApi = require('../utils/square-api');

/**
 * Process webhook retries - retries failed webhook events with exponential backoff
 *
 * @param {number} [batchSize=10] - Number of events to process per run
 * @returns {Promise<Object>} Results of retry processing
 */
async function processWebhookRetries(batchSize = 10) {
    // Get events due for retry
    const events = await webhookRetry.getEventsForRetry(batchSize);

    if (events.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
    }

    logger.info('Processing webhook retries', { count: events.length });

    let succeeded = 0;
    let failed = 0;

    for (const event of events) {
        const startTime = Date.now();
        try {
            logger.info('Retrying webhook event', {
                webhookEventId: event.id,
                eventType: event.event_type,
                retryCount: event.retry_count,
                squareEventId: event.square_event_id
            });

            // Look up internal merchant ID from Square merchant ID
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE square_merchant_id = $1 AND is_active = TRUE',
                [event.merchant_id]
            );

            if (merchantResult.rows.length === 0) {
                await webhookRetry.incrementRetry(event.id, 'Merchant not found or inactive');
                failed++;
                continue;
            }

            const internalMerchantId = merchantResult.rows[0].id;
            let syncResult = null;

            // Re-trigger appropriate sync based on event type
            switch (event.event_type) {
                case 'catalog.version.updated':
                    syncResult = await squareApi.syncCatalog(internalMerchantId);
                    break;

                case 'inventory.count.updated':
                    syncResult = await squareApi.syncInventory(internalMerchantId);
                    break;

                case 'order.created':
                case 'order.updated':
                case 'order.fulfillment.updated':
                    syncResult = await squareApi.syncCommittedInventory(internalMerchantId);
                    break;

                case 'vendor.created':
                case 'vendor.updated':
                    syncResult = await squareApi.syncVendors(internalMerchantId);
                    break;

                case 'location.created':
                case 'location.updated':
                    syncResult = await squareApi.syncLocations(internalMerchantId);
                    break;

                default:
                    // For event types without a sync handler, mark as completed
                    // (the original webhook was received, just processing failed)
                    logger.info('No retry handler for event type', { eventType: event.event_type });
                    syncResult = { skipped: true, reason: 'No retry handler for event type' };
            }

            // Mark as successful
            const processingTime = Date.now() - startTime;
            await webhookRetry.markSuccess(event.id, syncResult || {}, processingTime);

            logger.info('Webhook retry succeeded', {
                webhookEventId: event.id,
                eventType: event.event_type,
                processingTimeMs: processingTime
            });

            succeeded++;
        } catch (retryError) {
            logger.error('Webhook retry failed', {
                webhookEventId: event.id,
                eventType: event.event_type,
                retryCount: event.retry_count,
                error: retryError.message
            });
            await webhookRetry.incrementRetry(event.id, retryError.message);
            failed++;
        }
    }

    return { processed: events.length, succeeded, failed };
}

/**
 * Cron job handler for scheduled webhook retry processing
 * Wraps processWebhookRetries with error handling
 *
 * @returns {Promise<void>}
 */
async function runScheduledWebhookRetry() {
    try {
        await processWebhookRetries(10);
    } catch (error) {
        logger.error('Webhook retry processor error', { error: error.message, stack: error.stack });
    }
}

/**
 * Cleanup old webhook events
 *
 * @param {number} [successfulRetentionDays=14] - Days to keep successful events
 * @param {number} [failedRetentionDays=30] - Days to keep failed events
 * @returns {Promise<number>} Number of deleted events
 */
async function cleanupOldWebhookEvents(successfulRetentionDays = 14, failedRetentionDays = 30) {
    try {
        const deletedCount = await webhookRetry.cleanupOldEvents(successfulRetentionDays, failedRetentionDays);
        if (deletedCount > 0) {
            logger.info('Webhook cleanup completed', { deletedCount });
        }
        return deletedCount;
    } catch (error) {
        logger.error('Webhook cleanup error', { error: error.message });
        throw error;
    }
}

/**
 * Cron job handler for scheduled webhook cleanup
 *
 * @returns {Promise<void>}
 */
async function runScheduledWebhookCleanup() {
    try {
        await cleanupOldWebhookEvents(14, 30);
    } catch (error) {
        logger.error('Webhook cleanup error', { error: error.message });
    }
}

module.exports = {
    processWebhookRetries,
    runScheduledWebhookRetry,
    cleanupOldWebhookEvents,
    runScheduledWebhookCleanup
};
