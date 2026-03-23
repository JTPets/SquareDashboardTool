/**
 * Catalog Health Job Tests
 *
 * Tests multi-tenant iteration, per-merchant health checks, and error handling.
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

jest.mock('../../services/catalog/catalog-health-service', () => ({
    runFullHealthCheck: jest.fn(),
}));

const db = require('../../utils/database');
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

    describe('multi-tenant iteration', () => {
        it('should query all active merchants', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledHealthCheck();

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('is_active = TRUE')
            );
        });

        it('should not contain hardcoded merchant IDs', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledHealthCheck();

            // The SQL query should not contain a literal merchant ID
            const queryCall = db.query.mock.calls[0][0];
            expect(queryCall).not.toMatch(/merchant_id\s*=\s*\d+/);
        });

        it('should return early when no merchants found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runScheduledHealthCheck();

            expect(result).toEqual({ merchantCount: 0, results: [] });
            expect(runFullHealthCheck).not.toHaveBeenCalled();
        });

        it('should run health check for each active merchant', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ]
            });
            runFullHealthCheck
                .mockResolvedValueOnce({ newIssues: [], resolved: [], existingOpen: 0, durationMs: 100 })
                .mockResolvedValueOnce({ newIssues: [{ id: 1 }], resolved: [], existingOpen: 2, durationMs: 200 });

            const result = await runScheduledHealthCheck();

            expect(runFullHealthCheck).toHaveBeenCalledTimes(2);
            expect(runFullHealthCheck).toHaveBeenCalledWith(1);
            expect(runFullHealthCheck).toHaveBeenCalledWith(2);
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
            runFullHealthCheck
                .mockRejectedValueOnce(new Error('Service unavailable'))
                .mockResolvedValueOnce({ newIssues: [], resolved: [], existingOpen: 0, durationMs: 100 });

            const result = await runScheduledHealthCheck();

            expect(runFullHealthCheck).toHaveBeenCalledTimes(2);
            expect(result.results).toHaveLength(2);
            expect(result.results[0].error).toBe('Service unavailable');
            expect(result.results[1].existingOpen).toBe(0);
        });
    });
});
