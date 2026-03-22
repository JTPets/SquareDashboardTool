/**
 * Cron Scheduler
 *
 * Central initialization for all scheduled cron jobs.
 * Manages cron task lifecycle including registration and graceful shutdown.
 *
 * OSS: All cron schedules use a single server timezone (America/Toronto) for
 * job execution timing. Per-merchant timezone handling is done inside each
 * job's handler function, not in the cron schedule itself.
 *
 * BACKLOG-79: Cron Schedule Audit (2026-03-22)
 * Daily batch jobs rescheduled to 2:00–6:00 AM ET window so failures appear
 * in morning logs before the store opens (typically 9–10 AM).
 *
 * @module jobs/cron-scheduler
 */

// Schedule Map (Current):
// | #  | Job                         | Default Schedule       | Window | Notes                              |
// |----|-----------------------------|-----------------------|--------|-------------------------------------|
// |  1 | Cycle count                 | 0 3 * * *  (3:00 AM)  | Batch  | Moved from 1 AM                    |
// |  2 | Webhook retry               | */5 * * * * (5 min)   | Freq   | Must run frequently                |
// |  3 | Webhook cleanup             | 0 4 * * *  (4:00 AM)  | Batch  | No change                          |
// |  4 | Database smart sync         | 0 * * * *  (hourly)   | Freq   | Must run frequently                |
// |  5 | GMC sync                    | (env only)            | Batch  | User-configured, typically 11 PM   |
// |  6 | Database backup             | 0 2 * * 0  (Sun 2AM)  | Batch  | No change                          |
// |  7 | Expiry discount             | 0 5 * * *  (5:00 AM)  | Batch  | Moved from 6 AM to avoid overlap   |
// |  8 | Loyalty catchup             | */30 * * * * (30 min) | Freq   | Must run frequently                |
// |  9 | Loyalty audit               | 0 2 * * *  (2:00 AM)  | Batch  | No change                          |
// | 10 | Cart activity cleanup       | 0 3 * * *  (3:00 AM)  | Batch  | No change                          |
// | 11 | Seniors discount            | 30 2 * * * (2:30 AM)  | Batch  | Moved from 12:30 AM                |
// | 12 | Committed inv reconciliation| 0 */2 * * * (2 hr)    | Freq   | Must run frequently                |
// | 13 | Trial expiry notifications  | 0 5 * * *  (5:00 AM)  | Batch  | Moved from midnight                |
// | 14 | Loyalty sync retry          | */15 * * * * (15 min) | Freq   | Must run frequently                |
// | 15 | Catalog health              | 0 4 * * *  (4:00 AM)  | Batch  | Moved from 2 AM to avoid overlap   |
// | 16 | Email heartbeat             | 0 6 * * *  (6:00 AM)  | Batch  | Moved from 8 AM to catch AM issues |

const cron = require('node-cron');
const logger = require('../utils/logger');

// Job handlers
const { runScheduledBackup } = require('./backup-job');
const { runScheduledBatchGeneration, runStartupBatchCheck } = require('./cycle-count-job');
const { runScheduledWebhookRetry, runScheduledWebhookCleanup } = require('./webhook-retry-job');
const { runScheduledSmartSync, runScheduledGmcSync } = require('./sync-job');
const { runScheduledExpiryDiscount } = require('./expiry-discount-job');
const { runScheduledLoyaltyCatchup } = require('./loyalty-catchup-job');
const { runScheduledLoyaltyAudit } = require('./loyalty-audit-job');
const { runScheduledCartActivityCleanup } = require('./cart-activity-cleanup-job');
const { runScheduledSeniorsDiscount, verifyStateOnStartup } = require('./seniors-day-job');
const { runScheduledReconciliation } = require('./committed-inventory-reconciliation-job');
const { runScheduledTrialExpiryNotifications } = require('./trial-expiry-job');
const { runScheduledLoyaltySyncRetry } = require('./loyalty-sync-retry-job');
const { runScheduledHealthCheck } = require('./catalog-health-job');
const { runScheduledHeartbeat } = require('./email-heartbeat-job');
const syncQueue = require('../services/sync-queue');

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
    // LOGIC CHANGE: moved from 1 AM to 3 AM (BACKLOG-79 — 2-6 AM window)
    const cycleCountSchedule = process.env.CYCLE_COUNT_CRON || '0 3 * * *';
    cronTasks.push(cron.schedule(cycleCountSchedule, runScheduledBatchGeneration));
    logger.info('Cycle count cron job scheduled', { schedule: cycleCountSchedule });

    // 2. Webhook retry processor
    // Runs every 5 minutes to process failed webhooks with exponential backoff
    const webhookRetrySchedule = process.env.WEBHOOK_RETRY_CRON_SCHEDULE || '*/5 * * * *';
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
    // LOGIC CHANGE: moved from 6 AM to 5 AM (BACKLOG-79 — 2-6 AM window, avoid overlap with heartbeat)
    const expirySchedule = process.env.EXPIRY_DISCOUNT_CRON || '0 5 * * *';
    cronTasks.push(cron.schedule(expirySchedule, runScheduledExpiryDiscount, {
        timezone: 'America/Toronto'  // EST timezone
    }));
    logger.info('Expiry discount cron job scheduled', { schedule: expirySchedule, timezone: 'America/Toronto' });

    // 8. Loyalty catchup job
    // Runs hourly to catch orders missed by webhook race conditions
    // Processes orders from the last 6 hours to ensure overlap
    const loyaltyCatchupSchedule = process.env.LOYALTY_CATCHUP_CRON || '15 * * * *';
    cronTasks.push(cron.schedule(loyaltyCatchupSchedule, runScheduledLoyaltyCatchup, {
        timezone: 'America/Toronto'
    }));
    logger.info('Loyalty catchup cron job scheduled', { schedule: loyaltyCatchupSchedule, timezone: 'America/Toronto' });

    // 9. Loyalty audit job
    // Runs daily at 2 AM to detect orphaned rewards (redeemed in Square but missing from DB)
    // Detection only - logs findings to loyalty_audit_log for manual review
    const loyaltyAuditSchedule = process.env.LOYALTY_AUDIT_CRON || '0 2 * * *';
    cronTasks.push(cron.schedule(loyaltyAuditSchedule, runScheduledLoyaltyAudit, {
        timezone: 'America/Toronto'
    }));
    logger.info('Loyalty audit cron job scheduled', { schedule: loyaltyAuditSchedule, timezone: 'America/Toronto' });

    // 10. Cart activity cleanup job
    // Runs daily at 3 AM to mark abandoned carts (7+ days) and purge old records (30+ days)
    const cartActivityCleanupSchedule = process.env.CART_ACTIVITY_CLEANUP_CRON || '0 3 * * *';
    cronTasks.push(cron.schedule(cartActivityCleanupSchedule, runScheduledCartActivityCleanup, {
        timezone: 'America/Toronto'
    }));
    logger.info('Cart activity cleanup cron job scheduled', { schedule: cartActivityCleanupSchedule, timezone: 'America/Toronto' });

    // 11. Seniors Day discount management
    // LOGIC CHANGE: moved from 12:30 AM to 2:30 AM (BACKLOG-79 — 2-6 AM window)
    // 1st of month: enable + local age sweep, 2nd: disable, other days: verify state
    const seniorsSchedule = process.env.SENIORS_DISCOUNT_CRON || '30 2 * * *';
    cronTasks.push(cron.schedule(seniorsSchedule, runScheduledSeniorsDiscount, {
        timezone: 'America/Toronto'
    }));
    logger.info('Seniors discount cron job scheduled', { schedule: seniorsSchedule, timezone: 'America/Toronto' });

    // 12. Committed inventory reconciliation (BACKLOG-10)
    // Runs daily at 4:00 AM as a safety net for invoice-driven committed inventory
    // Catches missed webhooks, FAILED status transitions, and data drift
    const committedInvSchedule = process.env.COMMITTED_INVENTORY_RECONCILIATION_CRON || '0 4 * * *';
    cronTasks.push(cron.schedule(committedInvSchedule, runScheduledReconciliation, {
        timezone: 'America/Toronto'
    }));
    logger.info('Committed inventory reconciliation cron job scheduled', { schedule: committedInvSchedule, timezone: 'America/Toronto' });

    // 13. Trial expiry notifications (subscription enforcement)
    // LOGIC CHANGE: moved from 7 AM to 5 AM (BACKLOG-79 — 2-6 AM window)
    const trialExpirySchedule = process.env.TRIAL_EXPIRY_CRON || '0 5 * * *';
    cronTasks.push(cron.schedule(trialExpirySchedule, runScheduledTrialExpiryNotifications, {
        timezone: 'America/Toronto'
    }));
    logger.info('Trial expiry notification cron job scheduled', { schedule: trialExpirySchedule, timezone: 'America/Toronto' });

    // 14. Loyalty Square sync retry (LA-4 fix)
    // Runs every 15 minutes to retry failed Square discount creation
    const loyaltySyncRetrySchedule = process.env.LOYALTY_SYNC_RETRY_CRON || '*/15 * * * *';
    cronTasks.push(cron.schedule(loyaltySyncRetrySchedule, runScheduledLoyaltySyncRetry, {
        timezone: 'America/Toronto'
    }));
    logger.info('Loyalty sync retry cron job scheduled', { schedule: loyaltySyncRetrySchedule, timezone: 'America/Toronto' });

    // 15. Catalog health check (debug — merchant 3 only)
    // LOGIC CHANGE: moved from 2 AM to 4 AM (BACKLOG-79 — avoid overlap with loyalty audit at 2 AM)
    const catalogHealthSchedule = process.env.CATALOG_HEALTH_CRON || '0 4 * * *';
    cronTasks.push(cron.schedule(catalogHealthSchedule, runScheduledHealthCheck, {
        timezone: 'America/Toronto'
    }));
    logger.info('Catalog health cron job scheduled', { schedule: catalogHealthSchedule, timezone: 'America/Toronto' });

    // 16. Email heartbeat — daily "system alive" email
    // LOGIC CHANGE: moved from 8 AM to 6 AM (BACKLOG-79 — catch AM issues before store opens)
    const heartbeatSchedule = process.env.EMAIL_HEARTBEAT_CRON || '0 6 * * *';
    cronTasks.push(cron.schedule(heartbeatSchedule, runScheduledHeartbeat, {
        timezone: 'America/Toronto'
    }));
    logger.info('Email heartbeat cron job scheduled', { schedule: heartbeatSchedule, timezone: 'America/Toronto' });

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
    // Initialize sync queue (clean up stale entries, restore state)
    setImmediate(async () => {
        await syncQueue.initialize();
    });

    // Run startup batch check asynchronously (don't block server startup)
    setImmediate(async () => {
        await runStartupBatchCheck();
    });

    // Verify seniors pricing rule state on startup
    // Corrects if server was offline during a scheduled enable/disable
    setImmediate(async () => {
        await verifyStateOnStartup();
    });
}

module.exports = {
    initializeCronJobs,
    stopCronJobs,
    getCronTasks,
    runStartupTasks
};
