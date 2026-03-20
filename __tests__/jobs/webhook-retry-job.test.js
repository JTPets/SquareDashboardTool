/**
 * Webhook Retry Job Tests
 *
 * Tests structural coverage: import, empty data, event type routing, cleanup, errors.
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

jest.mock('../../utils/webhook-retry', () => ({
    getEventsForRetry: jest.fn(),
    markSuccess: jest.fn().mockResolvedValue(),
    incrementRetry: jest.fn().mockResolvedValue(),
    cleanupOldEvents: jest.fn(),
}));

jest.mock('../../services/square', () => ({
    syncCatalog: jest.fn(),
    syncInventory: jest.fn(),
    syncVendors: jest.fn(),
    syncLocations: jest.fn(),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const webhookRetry = require('../../utils/webhook-retry');
const squareApi = require('../../services/square');
const {
    processWebhookRetries,
    runScheduledWebhookRetry,
    cleanupOldWebhookEvents,
    runScheduledWebhookCleanup,
} = require('../../jobs/webhook-retry-job');

describe('Webhook Retry Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export all expected functions', () => {
            expect(typeof processWebhookRetries).toBe('function');
            expect(typeof runScheduledWebhookRetry).toBe('function');
            expect(typeof cleanupOldWebhookEvents).toBe('function');
            expect(typeof runScheduledWebhookCleanup).toBe('function');
        });
    });

    describe('processWebhookRetries', () => {
        it('should return zeros when no events to retry', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([]);

            const result = await processWebhookRetries();

            expect(result.processed).toBe(0);
            expect(result.succeeded).toBe(0);
            expect(result.failed).toBe(0);
        });

        it('should pass batchSize to getEventsForRetry', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([]);

            await processWebhookRetries(25);

            expect(webhookRetry.getEventsForRetry).toHaveBeenCalledWith(25);
        });

        it('should route catalog.version.updated to syncCatalog', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 1,
                event_type: 'catalog.version.updated',
                merchant_id: 10,
                retry_count: 0,
                square_event_id: 'evt-1',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
            squareApi.syncCatalog.mockResolvedValueOnce({ synced: 5 });

            const result = await processWebhookRetries();

            expect(result.succeeded).toBe(1);
            expect(squareApi.syncCatalog).toHaveBeenCalledWith(10);
            expect(webhookRetry.markSuccess).toHaveBeenCalledWith(
                1,
                expect.objectContaining({ synced: 5 }),
                expect.any(Number)
            );
        });

        it('should route inventory.count.updated to syncInventory', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 2,
                event_type: 'inventory.count.updated',
                merchant_id: 10,
                retry_count: 1,
                square_event_id: 'evt-2',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
            squareApi.syncInventory.mockResolvedValueOnce({ synced: 3 });

            const result = await processWebhookRetries();

            expect(squareApi.syncInventory).toHaveBeenCalledWith(10);
            expect(result.succeeded).toBe(1);
        });

        it('should route vendor events to syncVendors', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 3,
                event_type: 'vendor.updated',
                merchant_id: 10,
                retry_count: 0,
                square_event_id: 'evt-3',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
            squareApi.syncVendors.mockResolvedValueOnce({ synced: 1 });

            await processWebhookRetries();

            expect(squareApi.syncVendors).toHaveBeenCalledWith(10);
        });

        it('should route location events to syncLocations', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 4,
                event_type: 'location.created',
                merchant_id: 10,
                retry_count: 0,
                square_event_id: 'evt-4',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
            squareApi.syncLocations.mockResolvedValueOnce({ synced: 1 });

            await processWebhookRetries();

            expect(squareApi.syncLocations).toHaveBeenCalledWith(10);
        });

        it('should skip order events (BACKLOG-10)', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 5,
                event_type: 'order.created',
                merchant_id: 10,
                retry_count: 0,
                square_event_id: 'evt-5',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });

            const result = await processWebhookRetries();

            expect(result.succeeded).toBe(1);
            expect(squareApi.syncCatalog).not.toHaveBeenCalled();
            expect(squareApi.syncInventory).not.toHaveBeenCalled();
        });

        it('should handle unknown event types gracefully', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 6,
                event_type: 'unknown.event.type',
                merchant_id: 10,
                retry_count: 0,
                square_event_id: 'evt-6',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });

            const result = await processWebhookRetries();

            expect(result.succeeded).toBe(1);
            expect(webhookRetry.markSuccess).toHaveBeenCalled();
        });

        it('should fail when merchant is not found or inactive', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 7,
                event_type: 'catalog.version.updated',
                merchant_id: 99,
                retry_count: 0,
                square_event_id: 'evt-7',
            }]);

            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await processWebhookRetries();

            expect(result.failed).toBe(1);
            expect(webhookRetry.incrementRetry).toHaveBeenCalledWith(7, 'Merchant not found or inactive');
        });

        it('should fall back to square_merchant_id lookup when merchant_id is null', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 8,
                event_type: 'catalog.version.updated',
                merchant_id: null,
                square_merchant_id: 'sq-merchant-1',
                retry_count: 0,
                square_event_id: 'evt-8',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
            squareApi.syncCatalog.mockResolvedValueOnce({ synced: 1 });

            const result = await processWebhookRetries();

            expect(result.succeeded).toBe(1);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('square_merchant_id = $1'),
                ['sq-merchant-1']
            );
        });

        it('should fail when no merchant ID is available at all', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 9,
                event_type: 'catalog.version.updated',
                merchant_id: null,
                square_merchant_id: null,
                retry_count: 0,
                square_event_id: 'evt-9',
            }]);

            const result = await processWebhookRetries();

            expect(result.failed).toBe(1);
            expect(webhookRetry.incrementRetry).toHaveBeenCalledWith(9, 'No merchant ID available');
        });

        it('should handle sync errors and increment retry', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 10,
                event_type: 'catalog.version.updated',
                merchant_id: 1,
                retry_count: 2,
                square_event_id: 'evt-10',
            }]);

            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
            squareApi.syncCatalog.mockRejectedValueOnce(new Error('Square rate limited'));

            const result = await processWebhookRetries();

            expect(result.failed).toBe(1);
            expect(webhookRetry.incrementRetry).toHaveBeenCalledWith(10, 'Square rate limited');
        });

        it('should force-clear retries when incrementRetry itself fails', async () => {
            webhookRetry.getEventsForRetry.mockResolvedValueOnce([{
                id: 11,
                event_type: 'catalog.version.updated',
                merchant_id: 1,
                retry_count: 5,
                square_event_id: 'evt-11',
            }]);

            db.query
                .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // merchant lookup
                .mockResolvedValueOnce({}); // force-clear UPDATE

            squareApi.syncCatalog.mockRejectedValueOnce(new Error('Sync error'));
            webhookRetry.incrementRetry.mockRejectedValueOnce(new Error('Constraint violation'));

            const result = await processWebhookRetries();

            expect(result.failed).toBe(1);
            // Should have called db.query to force-clear next_retry_at
            const forceClearCall = db.query.mock.calls[1];
            expect(forceClearCall[0]).toContain('next_retry_at = NULL');
            expect(forceClearCall[1][1]).toBe(11);
        });
    });

    describe('cleanupOldWebhookEvents', () => {
        it('should call cleanupOldEvents with default retention days', async () => {
            webhookRetry.cleanupOldEvents.mockResolvedValueOnce(42);

            const result = await cleanupOldWebhookEvents();

            expect(result).toBe(42);
            expect(webhookRetry.cleanupOldEvents).toHaveBeenCalledWith(14, 30);
        });

        it('should accept custom retention days', async () => {
            webhookRetry.cleanupOldEvents.mockResolvedValueOnce(10);

            await cleanupOldWebhookEvents(7, 60);

            expect(webhookRetry.cleanupOldEvents).toHaveBeenCalledWith(7, 60);
        });

        it('should propagate cleanup errors', async () => {
            webhookRetry.cleanupOldEvents.mockRejectedValueOnce(new Error('Cleanup failed'));

            await expect(cleanupOldWebhookEvents()).rejects.toThrow('Cleanup failed');
        });

        it('should log when events are deleted', async () => {
            webhookRetry.cleanupOldEvents.mockResolvedValueOnce(15);

            await cleanupOldWebhookEvents();

            expect(logger.info).toHaveBeenCalledWith(
                'Webhook cleanup completed',
                expect.objectContaining({ deletedCount: 15 })
            );
        });

        it('should not log when no events deleted', async () => {
            webhookRetry.cleanupOldEvents.mockResolvedValueOnce(0);

            await cleanupOldWebhookEvents();

            expect(logger.info).not.toHaveBeenCalled();
        });
    });

    describe('runScheduledWebhookRetry', () => {
        it('should not throw even when retry fails', async () => {
            webhookRetry.getEventsForRetry.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledWebhookRetry()).resolves.toBeUndefined();

            expect(logger.error).toHaveBeenCalledWith(
                'Webhook retry processor error',
                expect.objectContaining({ error: 'DB error' })
            );
        });
    });

    describe('runScheduledWebhookCleanup', () => {
        it('should not throw even when cleanup fails', async () => {
            webhookRetry.cleanupOldEvents.mockRejectedValueOnce(new Error('Cleanup error'));

            await expect(runScheduledWebhookCleanup()).resolves.toBeUndefined();

            expect(logger.error).toHaveBeenCalledWith(
                'Webhook cleanup error',
                expect.objectContaining({ error: 'Cleanup error' })
            );
        });

        it('should call cleanupOldWebhookEvents with defaults', async () => {
            webhookRetry.cleanupOldEvents.mockResolvedValueOnce(0);

            await runScheduledWebhookCleanup();

            expect(webhookRetry.cleanupOldEvents).toHaveBeenCalledWith(14, 30);
        });
    });
});
