/**
 * Cycle Count Job Tests
 *
 * Tests import, no merchants, batch generation, startup with/without existing batch.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(),
}));

jest.mock('../../services/inventory', () => ({
    generateDailyBatch: jest.fn(),
}));

const db = require('../../utils/database');
const emailNotifier = require('../../utils/email-notifier');
const { generateDailyBatch } = require('../../services/inventory');
const logger = require('../../utils/logger');
const {
    runDailyBatchGeneration,
    runScheduledBatchGeneration,
    runStartupBatchCheck,
} = require('../../jobs/cycle-count-job');

describe('Cycle Count Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runDailyBatchGeneration as a function', () => {
            expect(typeof runDailyBatchGeneration).toBe('function');
        });

        it('should export runScheduledBatchGeneration as a function', () => {
            expect(typeof runScheduledBatchGeneration).toBe('function');
        });

        it('should export runStartupBatchCheck as a function', () => {
            expect(typeof runStartupBatchCheck).toBe('function');
        });
    });

    describe('runDailyBatchGeneration', () => {
        it('should handle no merchants gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runDailyBatchGeneration();

            expect(result.merchantCount).toBe(0);
            expect(result.results).toEqual([]);
            expect(generateDailyBatch).not.toHaveBeenCalled();
        });

        it('should call generateDailyBatch with correct merchant_id', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 5, business_name: 'Pet Store' }],
            });
            generateDailyBatch.mockResolvedValueOnce({ itemCount: 10, batchId: 'abc' });

            const result = await runDailyBatchGeneration();

            expect(generateDailyBatch).toHaveBeenCalledWith(5);
            expect(result.merchantCount).toBe(1);
            expect(result.results[0].merchantId).toBe(5);
            expect(result.results[0].itemCount).toBe(10);
        });

        it('should continue processing when one merchant fails', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ],
            });
            generateDailyBatch
                .mockRejectedValueOnce(new Error('No items configured'))
                .mockResolvedValueOnce({ itemCount: 5 });

            const result = await runDailyBatchGeneration();

            expect(result.merchantCount).toBe(2);
            expect(result.results[0].error).toBe('No items configured');
            expect(result.results[1].itemCount).toBe(5);
            expect(logger.error).toHaveBeenCalledWith(
                'Batch generation failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should handle DB query error by throwing', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(runDailyBatchGeneration()).rejects.toThrow('Connection refused');
        });
    });

    describe('runScheduledBatchGeneration', () => {
        it('should catch errors and send alert email', async () => {
            db.query.mockRejectedValueOnce(new Error('DB down'));

            await runScheduledBatchGeneration();

            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled batch generation failed',
                expect.objectContaining({ error: 'DB down' })
            );
            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'Cycle Count Batch Generation Failed',
                expect.stringContaining('DB down')
            );
        });

        it('should not throw even on failure', async () => {
            db.query.mockRejectedValueOnce(new Error('fail'));

            await expect(runScheduledBatchGeneration()).resolves.toBeUndefined();
        });
    });

    describe('runStartupBatchCheck', () => {
        it('should handle no merchants gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runStartupBatchCheck();

            expect(logger.info).toHaveBeenCalledWith(
                'No merchants for startup batch check'
            );
            expect(generateDailyBatch).not.toHaveBeenCalled();
        });

        it('should skip batch generation when today batch already exists', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 1, business_name: 'Store A' }],
                })
                .mockResolvedValueOnce({
                    rows: [{ count: '15' }],
                });

            await runStartupBatchCheck();

            expect(generateDailyBatch).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                "Today's batch already exists",
                expect.objectContaining({ merchantId: 1, items_count: 15 })
            );
        });

        it('should generate batch when no batch exists for today', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 2, business_name: 'Store B' }],
                })
                .mockResolvedValueOnce({
                    rows: [{ count: '0' }],
                });
            generateDailyBatch.mockResolvedValueOnce({ itemCount: 8 });

            await runStartupBatchCheck();

            expect(generateDailyBatch).toHaveBeenCalledWith(2);
            expect(logger.info).toHaveBeenCalledWith(
                'No batch found for today - generating startup batch',
                expect.objectContaining({ merchantId: 2 })
            );
        });

        it('should use merchant_id in batch_date query', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 99, business_name: 'Store X' }],
                })
                .mockResolvedValueOnce({
                    rows: [{ count: '0' }],
                });
            generateDailyBatch.mockResolvedValueOnce({});

            await runStartupBatchCheck();

            // Second query should include merchant_id parameter
            const batchQuery = db.query.mock.calls[1];
            expect(batchQuery[0]).toContain('merchant_id = $1');
            expect(batchQuery[1]).toEqual([99]);
        });

        it('should not throw on error', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runStartupBatchCheck()).resolves.toBeUndefined();

            expect(logger.error).toHaveBeenCalledWith(
                'Startup batch check failed',
                expect.objectContaining({ error: 'DB error' })
            );
        });

        it('should continue with other merchants if one fails', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        { id: 1, business_name: 'Store A' },
                        { id: 2, business_name: 'Store B' },
                    ],
                })
                .mockRejectedValueOnce(new Error('Query failed'))
                .mockResolvedValueOnce({ rows: [{ count: '0' }] });
            generateDailyBatch.mockResolvedValueOnce({ itemCount: 3 });

            await runStartupBatchCheck();

            expect(logger.error).toHaveBeenCalledWith(
                'Startup batch check failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
            expect(generateDailyBatch).toHaveBeenCalledWith(2);
        });
    });
});
