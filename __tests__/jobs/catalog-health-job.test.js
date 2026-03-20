/**
 * Catalog Health Job Tests
 *
 * Tests import, health check called with correct merchantId, and error handling.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/catalog/catalog-health-service', () => ({
    runFullHealthCheck: jest.fn(),
}));

const logger = require('../../utils/logger');
const { runFullHealthCheck } = require('../../services/catalog/catalog-health-service');
const { runScheduledHealthCheck } = require('../../jobs/catalog-health-job');

describe('Catalog Health Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runScheduledHealthCheck as a function', () => {
            expect(typeof runScheduledHealthCheck).toBe('function');
        });
    });

    describe('runScheduledHealthCheck', () => {
        it('should call runFullHealthCheck with merchant_id 3', async () => {
            runFullHealthCheck.mockResolvedValueOnce({
                newIssues: [],
                resolved: [],
                existingOpen: 0,
                durationMs: 150,
            });

            await runScheduledHealthCheck();

            expect(runFullHealthCheck).toHaveBeenCalledTimes(1);
            expect(runFullHealthCheck).toHaveBeenCalledWith(3);
        });

        it('should return health check result on success', async () => {
            const mockResult = {
                newIssues: [{ id: 1, type: 'missing_image' }],
                resolved: [{ id: 2 }],
                existingOpen: 5,
                durationMs: 200,
            };
            runFullHealthCheck.mockResolvedValueOnce(mockResult);

            const result = await runScheduledHealthCheck();

            expect(result).toEqual(mockResult);
            expect(logger.info).toHaveBeenCalledWith(
                'Scheduled catalog health check complete',
                expect.objectContaining({
                    merchantId: 3,
                    newIssues: 1,
                    resolved: 1,
                    existingOpen: 5,
                })
            );
        });

        it('should handle service errors gracefully', async () => {
            runFullHealthCheck.mockRejectedValueOnce(new Error('Service unavailable'));

            const result = await runScheduledHealthCheck();

            expect(result).toEqual({ error: 'Service unavailable' });
            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled catalog health check failed',
                expect.objectContaining({
                    merchantId: 3,
                    error: 'Service unavailable',
                })
            );
        });

        it('should not throw on error', async () => {
            runFullHealthCheck.mockRejectedValueOnce(new Error('fail'));

            await expect(runScheduledHealthCheck()).resolves.toBeDefined();
        });
    });
});
