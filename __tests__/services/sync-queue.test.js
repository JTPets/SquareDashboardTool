/**
 * Tests for sync-queue service
 */

const syncQueue = require('../../services/sync-queue');

// Mock logger to avoid console noise during tests
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

describe('SyncQueue', () => {
    beforeEach(() => {
        // Clear all state before each test
        syncQueue.clear();
    });

    describe('Catalog Sync State', () => {
        it('should return false for unset merchant', () => {
            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(false);
            expect(syncQueue.isCatalogSyncPending(1)).toBe(false);
        });

        it('should set and get in-progress state', () => {
            syncQueue.setCatalogSyncInProgress(1, true);
            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(true);

            syncQueue.setCatalogSyncInProgress(1, false);
            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(false);
        });

        it('should set and get pending state', () => {
            syncQueue.setCatalogSyncPending(1, true);
            expect(syncQueue.isCatalogSyncPending(1)).toBe(true);

            syncQueue.setCatalogSyncPending(1, false);
            expect(syncQueue.isCatalogSyncPending(1)).toBe(false);
        });

        it('should isolate state between merchants', () => {
            syncQueue.setCatalogSyncInProgress(1, true);
            syncQueue.setCatalogSyncPending(2, true);

            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(true);
            expect(syncQueue.isCatalogSyncInProgress(2)).toBe(false);
            expect(syncQueue.isCatalogSyncPending(1)).toBe(false);
            expect(syncQueue.isCatalogSyncPending(2)).toBe(true);
        });
    });

    describe('Inventory Sync State', () => {
        it('should return false for unset merchant', () => {
            expect(syncQueue.isInventorySyncInProgress(1)).toBe(false);
            expect(syncQueue.isInventorySyncPending(1)).toBe(false);
        });

        it('should set and get in-progress state', () => {
            syncQueue.setInventorySyncInProgress(1, true);
            expect(syncQueue.isInventorySyncInProgress(1)).toBe(true);

            syncQueue.setInventorySyncInProgress(1, false);
            expect(syncQueue.isInventorySyncInProgress(1)).toBe(false);
        });

        it('should set and get pending state', () => {
            syncQueue.setInventorySyncPending(1, true);
            expect(syncQueue.isInventorySyncPending(1)).toBe(true);

            syncQueue.setInventorySyncPending(1, false);
            expect(syncQueue.isInventorySyncPending(1)).toBe(false);
        });

        it('should isolate state between catalog and inventory', () => {
            syncQueue.setCatalogSyncInProgress(1, true);
            syncQueue.setInventorySyncPending(1, true);

            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(true);
            expect(syncQueue.isInventorySyncInProgress(1)).toBe(false);
            expect(syncQueue.isCatalogSyncPending(1)).toBe(false);
            expect(syncQueue.isInventorySyncPending(1)).toBe(true);
        });
    });

    describe('executeWithQueue', () => {
        it('should execute sync function and return result', async () => {
            const syncFn = jest.fn().mockResolvedValue({ items: 10 });

            const result = await syncQueue.executeWithQueue('catalog', 1, syncFn);

            expect(syncFn).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ result: { items: 10 } });
            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(false);
        });

        it('should queue sync if already in progress', async () => {
            // Simulate a sync already running
            syncQueue.setCatalogSyncInProgress(1, true);

            const syncFn = jest.fn().mockResolvedValue({ items: 10 });
            const result = await syncQueue.executeWithQueue('catalog', 1, syncFn);

            expect(syncFn).not.toHaveBeenCalled();
            expect(result).toEqual({ queued: true });
            expect(syncQueue.isCatalogSyncPending(1)).toBe(true);
        });

        it('should fire follow-up sync async if webhooks arrived during sync', async () => {
            const syncFn = jest.fn()
                .mockImplementationOnce(async () => {
                    // Simulate webhook arriving during first sync
                    syncQueue.setCatalogSyncPending(1, true);
                    return { items: 10, firstRun: true };
                })
                .mockResolvedValueOnce({ items: 15, secondRun: true });

            const result = await syncQueue.executeWithQueue('catalog', 1, syncFn);

            // Follow-up fires async (non-blocking), so result only contains first run
            expect(result).toEqual({
                result: { items: 10, firstRun: true }
            });

            // Wait a tick for the async follow-up to fire
            await new Promise(resolve => setImmediate(resolve));
            expect(syncFn).toHaveBeenCalledTimes(2);
            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(false);
            expect(syncQueue.isCatalogSyncPending(1)).toBe(false);
        });

        it('should handle sync function errors', async () => {
            const syncFn = jest.fn().mockRejectedValue(new Error('Sync failed'));

            const result = await syncQueue.executeWithQueue('catalog', 1, syncFn);

            expect(result).toEqual({ error: 'Sync failed' });
            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(false);
        });

        it('should clear in-progress flag even on error', async () => {
            const syncFn = jest.fn().mockRejectedValue(new Error('Sync failed'));

            await syncQueue.executeWithQueue('inventory', 1, syncFn);

            expect(syncQueue.isInventorySyncInProgress(1)).toBe(false);
        });

        it('should work with inventory type', async () => {
            const syncFn = jest.fn().mockResolvedValue({ counts: 50 });

            const result = await syncQueue.executeWithQueue('inventory', 1, syncFn);

            expect(result).toEqual({ result: { counts: 50 } });
            expect(syncQueue.isInventorySyncInProgress(1)).toBe(false);
        });

        it('should queue inventory sync if already in progress', async () => {
            syncQueue.setInventorySyncInProgress(1, true);

            const syncFn = jest.fn();
            const result = await syncQueue.executeWithQueue('inventory', 1, syncFn);

            expect(syncFn).not.toHaveBeenCalled();
            expect(result).toEqual({ queued: true });
            expect(syncQueue.isInventorySyncPending(1)).toBe(true);
        });
    });

    describe('getStatus', () => {
        it('should return empty status for fresh queue', () => {
            const status = syncQueue.getStatus();

            expect(status).toEqual({
                catalog: { inProgress: [], pending: [] },
                inventory: { inProgress: [], pending: [] }
            });
        });

        it('should include merchants with active flags', () => {
            syncQueue.setCatalogSyncInProgress(1, true);
            syncQueue.setCatalogSyncPending(2, true);
            syncQueue.setInventorySyncInProgress(3, true);
            syncQueue.setInventorySyncPending(1, true);

            const status = syncQueue.getStatus();

            expect(status.catalog.inProgress).toContain(1);
            expect(status.catalog.pending).toContain(2);
            expect(status.inventory.inProgress).toContain(3);
            expect(status.inventory.pending).toContain(1);
        });

        it('should exclude merchants with false flags', () => {
            syncQueue.setCatalogSyncInProgress(1, true);
            syncQueue.setCatalogSyncInProgress(1, false);

            const status = syncQueue.getStatus();

            expect(status.catalog.inProgress).not.toContain(1);
        });
    });

    describe('clear', () => {
        it('should clear all state', () => {
            syncQueue.setCatalogSyncInProgress(1, true);
            syncQueue.setCatalogSyncPending(2, true);
            syncQueue.setInventorySyncInProgress(3, true);
            syncQueue.setInventorySyncPending(4, true);

            syncQueue.clear();

            expect(syncQueue.isCatalogSyncInProgress(1)).toBe(false);
            expect(syncQueue.isCatalogSyncPending(2)).toBe(false);
            expect(syncQueue.isInventorySyncInProgress(3)).toBe(false);
            expect(syncQueue.isInventorySyncPending(4)).toBe(false);
        });
    });
});
