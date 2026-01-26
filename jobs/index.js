/**
 * Jobs Module Index
 *
 * Central export point for all job modules.
 *
 * @module jobs
 */

const backupJob = require('./backup-job');
const cycleCountJob = require('./cycle-count-job');
const webhookRetryJob = require('./webhook-retry-job');
const syncJob = require('./sync-job');
const expiryDiscountJob = require('./expiry-discount-job');
const cronScheduler = require('./cron-scheduler');

module.exports = {
    // Backup job
    runAutomatedBackup: backupJob.runAutomatedBackup,
    runScheduledBackup: backupJob.runScheduledBackup,

    // Cycle count job
    runDailyBatchGeneration: cycleCountJob.runDailyBatchGeneration,
    runScheduledBatchGeneration: cycleCountJob.runScheduledBatchGeneration,
    runStartupBatchCheck: cycleCountJob.runStartupBatchCheck,

    // Webhook retry job
    processWebhookRetries: webhookRetryJob.processWebhookRetries,
    runScheduledWebhookRetry: webhookRetryJob.runScheduledWebhookRetry,
    cleanupOldWebhookEvents: webhookRetryJob.cleanupOldWebhookEvents,
    runScheduledWebhookCleanup: webhookRetryJob.runScheduledWebhookCleanup,

    // Sync job
    runSmartSyncForAllMerchants: syncJob.runSmartSyncForAllMerchants,
    runScheduledSmartSync: syncJob.runScheduledSmartSync,
    runGmcSyncForAllMerchants: syncJob.runGmcSyncForAllMerchants,
    runScheduledGmcSync: syncJob.runScheduledGmcSync,

    // Expiry discount job
    runExpiryDiscountForMerchant: expiryDiscountJob.runExpiryDiscountForMerchant,
    runExpiryDiscountForAllMerchants: expiryDiscountJob.runExpiryDiscountForAllMerchants,
    runScheduledExpiryDiscount: expiryDiscountJob.runScheduledExpiryDiscount,

    // Cron scheduler
    initializeCronJobs: cronScheduler.initializeCronJobs,
    stopCronJobs: cronScheduler.stopCronJobs,
    getCronTasks: cronScheduler.getCronTasks,
    runStartupTasks: cronScheduler.runStartupTasks
};
