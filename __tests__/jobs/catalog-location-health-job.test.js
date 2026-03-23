/**
 * Catalog Location Health Job Tests
 *
 * Tests multi-tenant iteration, per-merchant checks, and error handling.
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

jest.mock('../../services/catalog/location-health-service', () => ({
    checkAndRecordHealth: jest.fn(),
}));

const db = require('../../utils/database');
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

    describe('multi-tenant iteration', () => {
        it('should query all active merchants', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledLocationHealthCheck();

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('is_active = TRUE')
            );
        });

        it('should not contain hardcoded merchant IDs', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledLocationHealthCheck();

            const queryCall = db.query.mock.calls[0][0];
            expect(queryCall).not.toMatch(/merchant_id\s*=\s*\d+/);
        });

        it('should return early when no merchants found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runScheduledLocationHealthCheck();

            expect(result).toEqual({ merchantCount: 0, results: [] });
            expect(checkAndRecordHealth).not.toHaveBeenCalled();
        });

        it('should run check for each active merchant', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 5, business_name: 'Store B' },
                ]
            });
            checkAndRecordHealth
                .mockResolvedValueOnce({ totalItems: 50, mismatches: 2 })
                .mockResolvedValueOnce({ totalItems: 100, mismatches: 0 });

            const result = await runScheduledLocationHealthCheck();

            expect(checkAndRecordHealth).toHaveBeenCalledTimes(2);
            expect(checkAndRecordHealth).toHaveBeenCalledWith(1);
            expect(checkAndRecordHealth).toHaveBeenCalledWith(5);
            expect(result.merchantCount).toBe(2);
            expect(result.results).toHaveLength(2);
        });

        it('should continue processing other merchants when one fails', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ]
            });
            checkAndRecordHealth
                .mockRejectedValueOnce(new Error('Square API timeout'))
                .mockResolvedValueOnce({ totalItems: 100, mismatches: 0 });

            const result = await runScheduledLocationHealthCheck();

            expect(checkAndRecordHealth).toHaveBeenCalledTimes(2);
            expect(result.results).toHaveLength(2);
            expect(result.results[0].error).toBe('Square API timeout');
            expect(result.results[1].totalItems).toBe(100);
        });
    });
});
