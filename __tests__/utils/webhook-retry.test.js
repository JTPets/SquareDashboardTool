/**
 * Tests for webhook retry processor
 */

// Mock modules BEFORE requiring the module under test
jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const db = require('../../utils/database');
const webhookRetry = require('../../utils/webhook-retry');

const {
    calculateBackoffDelay,
    DEFAULT_MAX_RETRIES,
    BASE_DELAY_MS,
    MAX_DELAY_MS
} = webhookRetry;

describe('webhook-retry', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('calculateBackoffDelay', () => {
        it('should calculate delay for first retry (count 0)', () => {
            const delay = calculateBackoffDelay(0);
            expect(delay).toBe(BASE_DELAY_MS); // 60000ms = 1 minute
        });

        it('should double delay for each retry', () => {
            expect(calculateBackoffDelay(0)).toBe(60000);  // 1 min
            expect(calculateBackoffDelay(1)).toBe(120000); // 2 min
            expect(calculateBackoffDelay(2)).toBe(240000); // 4 min
            expect(calculateBackoffDelay(3)).toBe(480000); // 8 min
            expect(calculateBackoffDelay(4)).toBe(960000); // 16 min
        });

        it('should cap delay at MAX_DELAY_MS', () => {
            const delay = calculateBackoffDelay(10); // Would be 60000 * 2^10 = 61,440,000ms
            expect(delay).toBe(MAX_DELAY_MS); // 1,800,000ms = 30 min
        });

        it('should handle edge case of very high retry count', () => {
            const delay = calculateBackoffDelay(100);
            expect(delay).toBe(MAX_DELAY_MS);
        });
    });

    describe('markForRetry', () => {
        it('should update webhook event with retry state', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    retry_count: 0,
                    next_retry_at: new Date(),
                    max_retries: 5
                }]
            });

            const result = await webhookRetry.markForRetry(1, 'Test error');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE webhook_events'),
                expect.arrayContaining(['Test error', 5, 1])
            );
            expect(result).toHaveProperty('id', 1);
            expect(result).toHaveProperty('retry_count', 0);
        });

        it('should return null if webhook event not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await webhookRetry.markForRetry(999, 'Test error');

            expect(result).toBeNull();
        });

        it('should use custom max retries when provided', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, retry_count: 0, next_retry_at: new Date(), max_retries: 3 }]
            });

            await webhookRetry.markForRetry(1, 'Test error', 3);

            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining(['Test error', 3, 1])
            );
        });
    });

    describe('incrementRetry', () => {
        it('should increment retry count and schedule next retry', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    retry_count: 1,
                    max_retries: 5,
                    next_retry_at: new Date(),
                    status: 'failed'
                }]
            });

            const result = await webhookRetry.incrementRetry(1, 'Retry error');

            expect(db.query).toHaveBeenCalled();
            expect(result).toHaveProperty('retry_count', 1);
            expect(result).toHaveProperty('next_retry_at');
        });

        it('should return null for non-existent event', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await webhookRetry.incrementRetry(999, 'Error');

            expect(result).toBeNull();
        });
    });

    describe('markSuccess', () => {
        it('should update event status to completed', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await webhookRetry.markSuccess(1, { items: 10 }, 150);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('status = \'completed\''),
                expect.arrayContaining([JSON.stringify({ items: 10 }), 150, 1])
            );
        });

        it('should clear retry state on success', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await webhookRetry.markSuccess(1, {}, 100);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('next_retry_at = NULL'),
                expect.any(Array)
            );
        });
    });

    describe('getEventsForRetry', () => {
        it('should fetch events ready for retry', async () => {
            const mockEvents = [
                { id: 1, event_type: 'catalog.version.updated', retry_count: 0 },
                { id: 2, event_type: 'inventory.count.updated', retry_count: 1 }
            ];
            db.query.mockResolvedValueOnce({ rows: mockEvents });

            const result = await webhookRetry.getEventsForRetry(50);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('WHERE status = \'failed\''),
                expect.arrayContaining([DEFAULT_MAX_RETRIES, 50])
            );
            expect(result).toHaveLength(2);
        });

        it('should use default limit when not specified', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await webhookRetry.getEventsForRetry();

            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([DEFAULT_MAX_RETRIES, 50])
            );
        });

        it('should return empty array when no events ready', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await webhookRetry.getEventsForRetry();

            expect(result).toEqual([]);
        });
    });

    describe('getRetryStats', () => {
        it('should return retry statistics', async () => {
            const mockStats = {
                pending_retries: '5',
                scheduled_retries: '3',
                exhausted_retries: '1',
                completed: '100',
                failed_total: '9',
                avg_retries_to_success: '1.5'
            };
            db.query.mockResolvedValueOnce({ rows: [mockStats] });

            const result = await webhookRetry.getRetryStats();

            expect(result).toEqual(mockStats);
        });
    });

    describe('cleanupOldEvents', () => {
        it('should delete old events based on retention policy', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1 }, { id: 2 }, { id: 3 }]
            });

            const result = await webhookRetry.cleanupOldEvents(14, 30);

            expect(result).toBe(3);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM webhook_events'),
                [14, 30]
            );
        });

        it('should use default retention days', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await webhookRetry.cleanupOldEvents();

            expect(db.query).toHaveBeenCalledWith(
                expect.any(String),
                [14, 30]
            );
        });
    });

    describe('resetForRetry', () => {
        it('should reset retry state for manual retry', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, retry_count: 0, next_retry_at: new Date() }]
            });

            const result = await webhookRetry.resetForRetry(1);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('retry_count = 0'),
                [1]
            );
            expect(result).toHaveProperty('id', 1);
        });

        it('should return null for non-existent event', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await webhookRetry.resetForRetry(999);

            expect(result).toBeNull();
        });
    });

    describe('constants', () => {
        it('should have expected default values', () => {
            expect(DEFAULT_MAX_RETRIES).toBe(5);
            expect(BASE_DELAY_MS).toBe(60000); // 1 minute
            expect(MAX_DELAY_MS).toBe(1800000); // 30 minutes
        });
    });
});
