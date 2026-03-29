/**
 * POD Cleanup Job Tests (BUG-008)
 *
 * Tests module exports, successful cleanup, and error handling.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/delivery', () => ({
    cleanupExpiredPods: jest.fn(),
}));

const deliveryApi = require('../../services/delivery');
const logger = require('../../utils/logger');
const {
    runPodCleanup,
    runScheduledPodCleanup,
} = require('../../jobs/pod-cleanup-job');

describe('POD Cleanup Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runPodCleanup as a function', () => {
            expect(typeof runPodCleanup).toBe('function');
        });

        it('should export runScheduledPodCleanup as a function', () => {
            expect(typeof runScheduledPodCleanup).toBe('function');
        });
    });

    describe('runPodCleanup', () => {
        it('calls cleanupExpiredPods and returns results', async () => {
            deliveryApi.cleanupExpiredPods.mockResolvedValueOnce({ deleted: 5, errors: 0 });

            const result = await runPodCleanup();

            expect(deliveryApi.cleanupExpiredPods).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ deleted: 5, errors: 0 });
            expect(logger.info).toHaveBeenCalledWith('Starting POD cleanup job');
            expect(logger.info).toHaveBeenCalledWith('POD cleanup job completed', { deleted: 5, errors: 0 });
        });

        it('handles errors gracefully', async () => {
            deliveryApi.cleanupExpiredPods.mockRejectedValueOnce(new Error('DB connection lost'));

            const result = await runPodCleanup();

            expect(result).toEqual({ deleted: 0, errors: 1 });
            expect(logger.error).toHaveBeenCalledWith('POD cleanup job failed', expect.objectContaining({
                error: 'DB connection lost'
            }));
        });

        it('returns zero stats when no expired pods', async () => {
            deliveryApi.cleanupExpiredPods.mockResolvedValueOnce({ deleted: 0, errors: 0 });

            const result = await runPodCleanup();

            expect(result).toEqual({ deleted: 0, errors: 0 });
        });
    });

    describe('runScheduledPodCleanup', () => {
        it('delegates to runPodCleanup', async () => {
            deliveryApi.cleanupExpiredPods.mockResolvedValueOnce({ deleted: 2, errors: 0 });

            await runScheduledPodCleanup();

            expect(deliveryApi.cleanupExpiredPods).toHaveBeenCalledTimes(1);
        });
    });
});
