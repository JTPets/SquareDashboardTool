/**
 * Loyalty Sync Retry Job Tests
 *
 * Tests structural coverage: import, empty data, DB errors, retry logic.
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

jest.mock('../../services/loyalty-admin/square-sync-retry-service', () => ({
    retryPendingSquareSyncs: jest.fn(),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { retryPendingSquareSyncs } = require('../../services/loyalty-admin/square-sync-retry-service');
const {
    runLoyaltySyncRetry,
    runScheduledLoyaltySyncRetry,
    getMerchantsWithPendingSyncs,
} = require('../../jobs/loyalty-sync-retry-job');

describe('Loyalty Sync Retry Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export all expected functions', () => {
            expect(typeof runLoyaltySyncRetry).toBe('function');
            expect(typeof runScheduledLoyaltySyncRetry).toBe('function');
            expect(typeof getMerchantsWithPendingSyncs).toBe('function');
        });
    });

    describe('getMerchantsWithPendingSyncs', () => {
        it('should return merchants with pending syncs', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1 }, { id: 2 }],
            });

            const result = await getMerchantsWithPendingSyncs();

            expect(result).toHaveLength(2);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('square_sync_pending = TRUE');
            expect(sql).toContain('is_active = TRUE');
        });

        it('should return empty array when no pending syncs', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getMerchantsWithPendingSyncs();

            expect(result).toHaveLength(0);
        });

        it('should propagate database errors', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(getMerchantsWithPendingSyncs()).rejects.toThrow('Connection refused');
        });
    });

    describe('runLoyaltySyncRetry', () => {
        it('should return empty results when no pending syncs', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runLoyaltySyncRetry();

            expect(result.merchantsProcessed).toBe(0);
            expect(result.totalRetried).toBe(0);
            expect(result.totalSucceeded).toBe(0);
            expect(result.totalFailed).toBe(0);
            expect(retryPendingSquareSyncs).not.toHaveBeenCalled();
        });

        it('should process merchants and aggregate retry results', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1 }, { id: 2 }],
            });

            retryPendingSquareSyncs
                .mockResolvedValueOnce({ retried: 3, succeeded: 2, failed: 1 })
                .mockResolvedValueOnce({ retried: 1, succeeded: 1, failed: 0 });

            const result = await runLoyaltySyncRetry();

            expect(result.merchantsProcessed).toBe(2);
            expect(result.totalRetried).toBe(4);
            expect(result.totalSucceeded).toBe(3);
            expect(result.totalFailed).toBe(1);
            expect(retryPendingSquareSyncs).toHaveBeenCalledWith(1);
            expect(retryPendingSquareSyncs).toHaveBeenCalledWith(2);
        });

        it('should isolate merchant errors without aborting other merchants', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1 }, { id: 2 }],
            });

            retryPendingSquareSyncs
                .mockRejectedValueOnce(new Error('Square API failed'))
                .mockResolvedValueOnce({ retried: 1, succeeded: 1, failed: 0 });

            const result = await runLoyaltySyncRetry();

            // Second merchant was still processed
            expect(result.merchantsProcessed).toBe(1);
            expect(result.totalSucceeded).toBe(1);
            expect(logger.error).toHaveBeenCalledWith(
                'Loyalty sync retry failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should handle top-level database errors gracefully', async () => {
            db.query.mockRejectedValueOnce(new Error('DB connection lost'));

            // Job catches top-level errors internally
            const result = await runLoyaltySyncRetry();

            expect(result.merchantsProcessed).toBe(0);
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('runScheduledLoyaltySyncRetry', () => {
        it('should not throw even when retry fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledLoyaltySyncRetry()).resolves.toBeUndefined();
        });

        it('should call runLoyaltySyncRetry', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledLoyaltySyncRetry();

            expect(db.query).toHaveBeenCalled();
        });
    });
});
