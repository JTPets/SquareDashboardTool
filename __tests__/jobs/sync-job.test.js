/**
 * Sync Job Tests
 *
 * Tests structural coverage: import, empty data, DB errors, sync error handling.
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(),
}));

jest.mock('../../routes/sync', () => ({
    runSmartSync: jest.fn(),
}));

jest.mock('../../services/gmc/merchant-service', () => ({
    syncProductCatalog: jest.fn(),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const emailNotifier = require('../../utils/email-notifier');
const { runSmartSync } = require('../../routes/sync');
const gmcApi = require('../../services/gmc/merchant-service');
const {
    runSmartSyncForAllMerchants,
    runScheduledSmartSync,
    runGmcSyncForAllMerchants,
    runScheduledGmcSync,
} = require('../../jobs/sync-job');

describe('Sync Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export all expected functions', () => {
            expect(typeof runSmartSyncForAllMerchants).toBe('function');
            expect(typeof runScheduledSmartSync).toBe('function');
            expect(typeof runGmcSyncForAllMerchants).toBe('function');
            expect(typeof runScheduledGmcSync).toBe('function');
        });
    });

    describe('runSmartSyncForAllMerchants', () => {
        it('should return empty results when no merchants exist', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runSmartSyncForAllMerchants();

            expect(result.merchantCount).toBe(0);
            expect(result.results).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
            expect(runSmartSync).not.toHaveBeenCalled();
        });

        it('should sync each merchant and collect results', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ],
            });

            runSmartSync
                .mockResolvedValueOnce({ synced: 10, skipped: {}, errors: [] })
                .mockResolvedValueOnce({ synced: 5, skipped: {}, errors: [] });

            const result = await runSmartSyncForAllMerchants();

            expect(result.merchantCount).toBe(2);
            expect(result.results).toHaveLength(2);
            expect(result.errors).toHaveLength(0);
            expect(runSmartSync).toHaveBeenCalledWith({ merchantId: 1 });
            expect(runSmartSync).toHaveBeenCalledWith({ merchantId: 2 });
        });

        it('should collect errors from failing merchants without aborting', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Failing Store' },
                    { id: 2, business_name: 'Working Store' },
                ],
            });

            runSmartSync
                .mockRejectedValueOnce(new Error('Token expired'))
                .mockResolvedValueOnce({ synced: 5, skipped: {}, errors: [] });

            const result = await runSmartSyncForAllMerchants();

            expect(result.results).toHaveLength(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].merchantId).toBe(1);
            expect(result.errors[0].errors[0].error).toContain('Token expired');
        });

        it('should report partial errors from sync results', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Store A' }],
            });

            runSmartSync.mockResolvedValueOnce({
                synced: 8,
                skipped: {},
                errors: [{ type: 'catalog', error: 'Item not found' }],
            });

            const result = await runSmartSyncForAllMerchants();

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].errors[0].type).toBe('catalog');
        });

        it('should query only active merchants with tokens', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runSmartSyncForAllMerchants();

            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('square_access_token IS NOT NULL');
            expect(sql).toContain('is_active = TRUE');
        });
    });

    describe('runScheduledSmartSync', () => {
        it('should not throw even when sync fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledSmartSync()).resolves.toBeUndefined();

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'Database Sync Failed',
                expect.stringContaining('DB error')
            );
        });

        it('should send alert when partial errors exist', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Store A' }],
            });

            runSmartSync.mockRejectedValueOnce(new Error('Sync broken'));

            await runScheduledSmartSync();

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'Database Sync Partial Failure',
                expect.stringContaining('Store A')
            );
        });

        it('should not send alert when all syncs succeed', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Store A' }],
            });

            runSmartSync.mockResolvedValueOnce({ synced: 5, skipped: {}, errors: [] });

            await runScheduledSmartSync();

            expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
        });
    });

    describe('runGmcSyncForAllMerchants', () => {
        it('should return empty results when no merchants exist', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runGmcSyncForAllMerchants();

            expect(result.total).toBe(0);
            expect(result.results).toHaveLength(0);
            expect(result.failures).toHaveLength(0);
        });

        it('should sync each merchant via GMC', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Store A' }],
            });

            gmcApi.syncProductCatalog.mockResolvedValueOnce({
                total: 50, synced: 48, failed: 2,
            });

            const result = await runGmcSyncForAllMerchants();

            expect(result.total).toBe(1);
            expect(result.results[0].success).toBe(true);
            expect(result.results[0].synced).toBe(48);
            expect(result.failures).toHaveLength(0);
            expect(gmcApi.syncProductCatalog).toHaveBeenCalledWith(1);
        });

        it('should collect GMC failures without aborting', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Failing' },
                    { id: 2, business_name: 'Working' },
                ],
            });

            gmcApi.syncProductCatalog
                .mockRejectedValueOnce(new Error('GMC auth failed'))
                .mockResolvedValueOnce({ total: 10, synced: 10, failed: 0 });

            const result = await runGmcSyncForAllMerchants();

            expect(result.results).toHaveLength(2);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].merchantId).toBe(1);
            expect(result.failures[0].error).toContain('GMC auth failed');
        });
    });

    describe('runScheduledGmcSync', () => {
        it('should not throw even when sync fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledGmcSync()).resolves.toBeUndefined();

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'GMC Sync Failed',
                expect.stringContaining('DB error')
            );
        });

        it('should send alert on partial GMC failures', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Store A' }],
            });

            gmcApi.syncProductCatalog.mockRejectedValueOnce(new Error('GMC down'));

            await runScheduledGmcSync();

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'GMC Sync Partial Failure',
                expect.stringContaining('Store A')
            );
        });

        it('should not send alert when all GMC syncs succeed', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Store A' }],
            });

            gmcApi.syncProductCatalog.mockResolvedValueOnce({
                total: 10, synced: 10, failed: 0,
            });

            await runScheduledGmcSync();

            expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
        });
    });
});
