/**
 * Cron Scheduler
 *
 * Central initialization for all scheduled cron jobs.
 * Manages cron task lifecycle including registration and graceful shutdown.
 *
 * @module jobs/cron-scheduler
 */

const cron = require('node-cron');
const logger = require('../utils/logger');

// Job handlers
const { runScheduledBackup } = require('./backup-job');
const { runScheduledBatchGeneration, runStartupBatchCheck } = require('./cycle-count-job');
const { runScheduledWebhookRetry, runScheduledWebhookCleanup } = require('./webhook-retry-job');
const { runScheduledSmartSync, runScheduledGmcSync } = require('./sync-job');
const { runScheduledExpiryDiscount } = require('./expiry-discount-job');

// Store cron task references for graceful shutdown
const cronTasks = [];

/**
 * Initialize all cron jobs
 *
 * @returns {Array} Array of cron task references
 */
function initializeCronJobs() {
    logger.info('Initializing cron jobs');

    // 1. Cycle count daily batch generation
    // Runs every day at 1:00 AM
    const cycleCountSchedule = process.env.CYCLE_COUNT_CRON || '0 1 * * *';
    cronTasks.push(cron.schedule(cycleCountSchedule, runScheduledBatchGeneration));
    logger.info('Cycle count cron job scheduled', { schedule: cycleCountSchedule });

    // 2. Webhook retry processor
    // Runs every minute to process failed webhooks with exponential backoff
    const webhookRetrySchedule = process.env.WEBHOOK_RETRY_CRON_SCHEDULE || '* * * * *';
    cronTasks.push(cron.schedule(webhookRetrySchedule, runScheduledWebhookRetry));
    logger.info('Webhook retry cron job scheduled', { schedule: webhookRetrySchedule });

    // 3. Webhook cleanup
    // Runs daily at 3 AM to remove old events
    const webhookCleanupSchedule = process.env.WEBHOOK_CLEANUP_CRON_SCHEDULE || '0 3 * * *';
    cronTasks.push(cron.schedule(webhookCleanupSchedule, runScheduledWebhookCleanup));
    logger.info('Webhook cleanup cron job scheduled', { schedule: webhookCleanupSchedule });

    // 4. Database smart sync
    // Runs hourly by default (configurable via SYNC_CRON_SCHEDULE)
    const syncSchedule = process.env.SYNC_CRON_SCHEDULE || '0 * * * *';
    cronTasks.push(cron.schedule(syncSchedule, runScheduledSmartSync));
    logger.info('Database sync cron job scheduled', { schedule: syncSchedule });

    // 5. GMC (Google Merchant Center) sync
    // Only enabled if GMC_SYNC_CRON_SCHEDULE is configured
    const gmcSyncSchedule = process.env.GMC_SYNC_CRON_SCHEDULE;
    if (gmcSyncSchedule) {
        cronTasks.push(cron.schedule(gmcSyncSchedule, runScheduledGmcSync));
        logger.info('GMC sync cron job scheduled', { schedule: gmcSyncSchedule });
    } else {
        logger.info('GMC sync cron job not configured (set GMC_SYNC_CRON_SCHEDULE to enable)');
    }

    // 6. Database backup
    // Runs every Sunday at 2:00 AM by default
    const backupSchedule = process.env.BACKUP_CRON_SCHEDULE || '0 2 * * 0';
    cronTasks.push(cron.schedule(backupSchedule, runScheduledBackup));
    logger.info('Database backup cron job scheduled', { schedule: backupSchedule });

    // 7. Expiry discount automation
    // Runs daily at 6:00 AM EST by default
    const expirySchedule = process.env.EXPIRY_DISCOUNT_CRON || '0 6 * * *';
    cronTasks.push(cron.schedule(expirySchedule, runScheduledExpiryDiscount, {
        timezone: 'America/Toronto'  // EST timezone
    }));
    logger.info('Expiry discount cron job scheduled', { schedule: expirySchedule, timezone: 'America/Toronto' });

    return cronTasks;
}

/**
 * Stop all cron jobs gracefully
 */
function stopCronJobs() {
    logger.info('Stopping cron jobs', { count: cronTasks.length });
    for (const task of cronTasks) {
        task.stop();
    }
    cronTasks.length = 0;
}

/**
 * Get the list of active cron tasks
 *
 * @returns {Array} Array of cron task references
 */
function getCronTasks() {
    return cronTasks;
}

/**
 * Run startup tasks that should execute when the server starts
 * This handles cases where server was offline during scheduled cron time
 *
 * @returns {Promise<void>}
 */
async function runStartupTasks() {
    // Run startup batch check asynchronously (don't block server startup)
    setImmediate(async () => {
        await runStartupBatchCheck();
    });
}

module.exports = {
    initializeCronJobs,
    stopCronJobs,
    getCronTasks,
    runStartupTasks
};
