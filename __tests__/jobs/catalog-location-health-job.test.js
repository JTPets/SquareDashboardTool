/**
 * Catalog Location Health Job Tests
 *
 * Tests import, service called correctly, and error handling.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/catalog/location-health-service', () => ({
    checkAndRecordHealth: jest.fn(),
}));

const logger = require('../../utils/logger');
const { checkAndRecordHealth } = require('../../services/catalog/location-health-service');
const { runScheduledLocationHealthCheck } = require('../../jobs/catalog-location-health-job');

describe('Catalog Location Health Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runScheduledLocationHealthCheck as a function', () => {
            expect(typeof runScheduledLocationHealthCheck).toBe('function');
        });
    });

    describe('runScheduledLocationHealthCheck', () => {
        it('should call checkAndRecordHealth with merchant_id 3', async () => {
            checkAndRecordHealth.mockResolvedValueOnce({
                totalItems: 50,
                mismatches: 2,
            });

            await runScheduledLocationHealthCheck();

            expect(checkAndRecordHealth).toHaveBeenCalledTimes(1);
            expect(checkAndRecordHealth).toHaveBeenCalledWith(3);
        });

        it('should return service result on success', async () => {
            const mockResult = { totalItems: 100, mismatches: 0, durationMs: 300 };
            checkAndRecordHealth.mockResolvedValueOnce(mockResult);

            const result = await runScheduledLocationHealthCheck();

            expect(result).toEqual(mockResult);
            expect(logger.info).toHaveBeenCalledWith(
                'Scheduled catalog location health check complete',
                expect.objectContaining({ merchantId: 3 })
            );
        });

        it('should handle service errors gracefully', async () => {
            checkAndRecordHealth.mockRejectedValueOnce(new Error('Square API timeout'));

            const result = await runScheduledLocationHealthCheck();

            expect(result).toEqual({ error: 'Square API timeout' });
            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled catalog location health check failed',
                expect.objectContaining({
                    merchantId: 3,
                    error: 'Square API timeout',
                })
            );
        });

        it('should not throw on error', async () => {
            checkAndRecordHealth.mockRejectedValueOnce(new Error('fail'));

            await expect(runScheduledLocationHealthCheck()).resolves.toBeDefined();
        });
    });
});
