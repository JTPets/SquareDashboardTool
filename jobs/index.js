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
const loyaltyCatchupJob = require('./loyalty-catchup-job');
const seniorsDayJob = require('./seniors-day-job');
const committedInventoryJob = require('./committed-inventory-reconciliation-job');
const trialExpiryJob = require('./trial-expiry-job');
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

    // Loyalty catchup job
    runLoyaltyCatchup: loyaltyCatchupJob.runLoyaltyCatchup,
    runScheduledLoyaltyCatchup: loyaltyCatchupJob.runScheduledLoyaltyCatchup,
    processMerchantCatchup: loyaltyCatchupJob.processMerchantCatchup,
    getMerchantsWithLoyalty: loyaltyCatchupJob.getMerchantsWithLoyalty,

    // Seniors day job
    runSeniorsDiscountForMerchant: seniorsDayJob.runSeniorsDiscountForMerchant,
    runSeniorsDiscountForAllMerchants: seniorsDayJob.runSeniorsDiscountForAllMerchants,
    runScheduledSeniorsDiscount: seniorsDayJob.runScheduledSeniorsDiscount,
    verifyStateOnStartup: seniorsDayJob.verifyStateOnStartup,

    // Committed inventory reconciliation job (BACKLOG-10)
    runCommittedInventoryReconciliation: committedInventoryJob.runCommittedInventoryReconciliation,
    runScheduledReconciliation: committedInventoryJob.runScheduledReconciliation,

    // Trial expiry notification job
    runTrialExpiryNotifications: trialExpiryJob.runTrialExpiryNotifications,
    runScheduledTrialExpiryNotifications: trialExpiryJob.runScheduledTrialExpiryNotifications,

    // Cron scheduler
    initializeCronJobs: cronScheduler.initializeCronJobs,
    stopCronJobs: cronScheduler.stopCronJobs,
    getCronTasks: cronScheduler.getCronTasks,
    runStartupTasks: cronScheduler.runStartupTasks
};
