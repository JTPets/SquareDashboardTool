/**
 * Tests for cron-scheduler job module
 */

// Mock node-cron before importing the module
jest.mock('node-cron', () => ({
    schedule: jest.fn().mockReturnValue({
        stop: jest.fn()
    })
}));

// Mock all job handlers to prevent actual execution
jest.mock('../../jobs/backup-job', () => ({
    runAutomatedBackup: jest.fn(),
    runScheduledBackup: jest.fn()
}));

jest.mock('../../jobs/cycle-count-job', () => ({
    runDailyBatchGeneration: jest.fn(),
    runScheduledBatchGeneration: jest.fn(),
    runStartupBatchCheck: jest.fn().mockResolvedValue()
}));

jest.mock('../../jobs/webhook-retry-job', () => ({
    processWebhookRetries: jest.fn(),
    runScheduledWebhookRetry: jest.fn(),
    cleanupOldWebhookEvents: jest.fn(),
    runScheduledWebhookCleanup: jest.fn()
}));

jest.mock('../../jobs/sync-job', () => ({
    runSmartSyncForAllMerchants: jest.fn(),
    runScheduledSmartSync: jest.fn(),
    runGmcSyncForAllMerchants: jest.fn(),
    runScheduledGmcSync: jest.fn()
}));

jest.mock('../../jobs/expiry-discount-job', () => ({
    runExpiryDiscountForMerchant: jest.fn(),
    runExpiryDiscountForAllMerchants: jest.fn(),
    runScheduledExpiryDiscount: jest.fn()
}));

const cron = require('node-cron');
const {
    initializeCronJobs,
    stopCronJobs,
    getCronTasks
} = require('../../jobs/cron-scheduler');

describe('CronScheduler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Clear the internal cronTasks array by stopping any previous jobs
        stopCronJobs();
    });

    describe('initializeCronJobs', () => {
        it('should schedule all default cron jobs', () => {
            initializeCronJobs();

            // Should schedule at least 6 jobs (without GMC which is optional)
            expect(cron.schedule).toHaveBeenCalledTimes(6);
        });

        it('should use environment variable schedules when provided', () => {
            process.env.CYCLE_COUNT_CRON = '0 2 * * *';

            initializeCronJobs();

            expect(cron.schedule).toHaveBeenCalledWith('0 2 * * *', expect.any(Function));

            delete process.env.CYCLE_COUNT_CRON;
        });

        it('should schedule GMC sync when GMC_SYNC_CRON_SCHEDULE is set', () => {
            process.env.GMC_SYNC_CRON_SCHEDULE = '0 4 * * *';

            initializeCronJobs();

            // Should schedule 7 jobs including GMC
            expect(cron.schedule).toHaveBeenCalledTimes(7);
            expect(cron.schedule).toHaveBeenCalledWith('0 4 * * *', expect.any(Function));

            delete process.env.GMC_SYNC_CRON_SCHEDULE;
        });

        it('should return array of cron task references', () => {
            const tasks = initializeCronJobs();

            expect(Array.isArray(tasks)).toBe(true);
            expect(tasks.length).toBeGreaterThan(0);
        });

        it('should schedule expiry discount with Toronto timezone', () => {
            initializeCronJobs();

            expect(cron.schedule).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Function),
                expect.objectContaining({ timezone: 'America/Toronto' })
            );
        });
    });

    describe('stopCronJobs', () => {
        it('should stop all scheduled cron jobs', () => {
            const mockStop = jest.fn();
            cron.schedule.mockReturnValue({ stop: mockStop });

            initializeCronJobs();
            stopCronJobs();

            // Each task's stop() should have been called
            expect(mockStop).toHaveBeenCalled();
        });

        it('should clear the cron tasks array', () => {
            initializeCronJobs();
            expect(getCronTasks().length).toBeGreaterThan(0);

            stopCronJobs();
            expect(getCronTasks().length).toBe(0);
        });
    });

    describe('getCronTasks', () => {
        it('should return empty array before initialization', () => {
            const tasks = getCronTasks();
            expect(tasks).toEqual([]);
        });

        it('should return tasks after initialization', () => {
            initializeCronJobs();
            const tasks = getCronTasks();

            expect(tasks.length).toBeGreaterThan(0);
        });
    });
});

describe('Jobs Index', () => {
    const jobs = require('../../jobs');

    it('should export backup job functions', () => {
        expect(jobs.runAutomatedBackup).toBeDefined();
        expect(jobs.runScheduledBackup).toBeDefined();
    });

    it('should export cycle count job functions', () => {
        expect(jobs.runDailyBatchGeneration).toBeDefined();
        expect(jobs.runScheduledBatchGeneration).toBeDefined();
        expect(jobs.runStartupBatchCheck).toBeDefined();
    });

    it('should export webhook retry job functions', () => {
        expect(jobs.processWebhookRetries).toBeDefined();
        expect(jobs.runScheduledWebhookRetry).toBeDefined();
        expect(jobs.cleanupOldWebhookEvents).toBeDefined();
        expect(jobs.runScheduledWebhookCleanup).toBeDefined();
    });

    it('should export sync job functions', () => {
        expect(jobs.runSmartSyncForAllMerchants).toBeDefined();
        expect(jobs.runScheduledSmartSync).toBeDefined();
        expect(jobs.runGmcSyncForAllMerchants).toBeDefined();
        expect(jobs.runScheduledGmcSync).toBeDefined();
    });

    it('should export expiry discount job functions', () => {
        expect(jobs.runExpiryDiscountForMerchant).toBeDefined();
        expect(jobs.runExpiryDiscountForAllMerchants).toBeDefined();
        expect(jobs.runScheduledExpiryDiscount).toBeDefined();
    });

    it('should export cron scheduler functions', () => {
        expect(jobs.initializeCronJobs).toBeDefined();
        expect(jobs.stopCronJobs).toBeDefined();
        expect(jobs.getCronTasks).toBeDefined();
        expect(jobs.runStartupTasks).toBeDefined();
    });
});
