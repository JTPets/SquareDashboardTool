/**
 * Sync Orchestrator Service Tests
 *
 * Unit tests for services/square/sync-orchestrator.js
 * Tests: loggedSync, isSyncNeeded, runSmartSync, getSyncHistory, getSyncStatus
 */

jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../services/square', () => ({
    syncLocations: jest.fn(),
    syncVendors: jest.fn(),
    syncCatalog: jest.fn(),
    syncInventory: jest.fn(),
    syncSalesVelocity: jest.fn(),
    syncSalesVelocityAllPeriods: jest.fn(),
}));
jest.mock('../../../services/webhook-handlers/catalog-handler', () => ({
    reconcileBundleComponents: jest.fn().mockResolvedValue(),
}));
jest.mock('../../../services/catalog/location-service', () => ({
    getActiveLocationCount: jest.fn(),
}));

const db = require('../../../utils/database');
const squareApi = require('../../../services/square');
const { getActiveLocationCount } = require('../../../services/catalog/location-service');
const { loggedSync, isSyncNeeded, runSmartSync, getSyncHistory, getSyncStatus } = require('../../../services/square/sync-orchestrator');

const MID = 42;

beforeEach(() => {
    jest.clearAllMocks();
});

// ── loggedSync ────────────────────────────────────────────────────────────────

describe('loggedSync', () => {
    it('writes running status, calls fn, writes success', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // INSERT running
            .mockResolvedValueOnce({ rows: [] });          // UPDATE success

        const result = await loggedSync('catalog', async () => 50, MID);

        expect(result.success).toBe(true);
        expect(result.recordsSynced).toBe(50);
        expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query.mock.calls[1][0]).toMatch(/status = 'success'/);
    });

    it('writes failed status when syncFn throws, then re-throws', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // INSERT running
            .mockResolvedValueOnce({ rows: [] });          // UPDATE failed

        const err = new Error('Square down');
        await expect(loggedSync('catalog', async () => { throw err; }, MID)).rejects.toThrow('Square down');

        expect(db.query.mock.calls[1][0]).toMatch(/status = 'failed'/);
    });

    it('swallows error when failed-status update itself throws', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 9 }] })  // INSERT running
            .mockRejectedValueOnce(new Error('db gone'));   // UPDATE failed throws

        await expect(loggedSync('catalog', async () => { throw new Error('API fail'); }, MID)).rejects.toThrow('API fail');
    });
});

// ── isSyncNeeded ──────────────────────────────────────────────────────────────

describe('isSyncNeeded', () => {
    it('returns needed=true when no history', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const r = await isSyncNeeded('catalog', 3, MID);
        expect(r).toMatchObject({ needed: true, lastSync: null, nextDue: null });
    });

    it('returns needed=true when last sync is stale', async () => {
        const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
        db.query.mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] });
        const r = await isSyncNeeded('catalog', 3, MID);
        expect(r.needed).toBe(true);
        expect(parseFloat(r.hoursSince)).toBeGreaterThanOrEqual(3);
    });

    it('returns needed=false when sync is fresh', async () => {
        const freshDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
        db.query.mockResolvedValueOnce({ rows: [{ completed_at: freshDate }] });
        const r = await isSyncNeeded('catalog', 3, MID);
        expect(r.needed).toBe(false);
        expect(r.lastSync).toBeInstanceOf(Date);
        expect(r.nextDue).toBeInstanceOf(Date);
    });

    it('uses gmc_sync_history table for gmc_ prefixed types', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await isSyncNeeded('gmc_products', 24, MID);
        expect(db.query.mock.calls[0][0]).toMatch(/gmc_sync_history/);
        expect(db.query.mock.calls[0][1][0]).toBe('products'); // strip gmc_ prefix
    });
});

// ── getSyncHistory ────────────────────────────────────────────────────────────

describe('getSyncHistory', () => {
    it('returns rows with count', async () => {
        const rows = [{ id: 1, sync_type: 'catalog', status: 'success' }];
        db.query.mockResolvedValueOnce({ rows });
        const r = await getSyncHistory(MID, { limit: 10 });
        expect(r.count).toBe(1);
        expect(r.history).toEqual(rows);
        expect(db.query.mock.calls[0][1]).toEqual([MID, 10]);
    });

    it('defaults limit to 20', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await getSyncHistory(MID);
        expect(db.query.mock.calls[0][1][1]).toBe(20);
    });

    it('returns empty history', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const r = await getSyncHistory(MID);
        expect(r).toEqual({ count: 0, history: [] });
    });
});

// ── getSyncStatus ─────────────────────────────────────────────────────────────

describe('getSyncStatus', () => {
    it('returns aggregated status for all 6 types', async () => {
        const recentDate = new Date().toISOString();
        // isSyncNeeded + detail query for each of 6 types = 12 calls
        for (let i = 0; i < 6; i++) {
            db.query
                .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] })
                .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 10, duration_seconds: 2 }] });
        }

        const status = await getSyncStatus(MID);
        const keys = ['catalog', 'vendors', 'inventory', 'sales_91d', 'sales_182d', 'sales_365d'];
        for (const k of keys) {
            expect(status[k]).toHaveProperty('needs_sync');
            expect(status[k]).toHaveProperty('interval_hours');
            expect(status[k].last_status).toBe('success');
        }
    });

    it('handles types with no history', async () => {
        // 6 types, no history rows for any
        for (let i = 0; i < 6; i++) {
            db.query.mockResolvedValueOnce({ rows: [] }); // isSyncNeeded returns no rows
        }
        const status = await getSyncStatus(MID);
        for (const k of Object.keys(status)) {
            expect(status[k].needs_sync).toBe(true);
            expect(status[k].last_sync).toBeNull();
        }
    });
});

// ── runSmartSync ──────────────────────────────────────────────────────────────

describe('runSmartSync', () => {
    // All syncs stale → runs all, returns success
    it('syncs all types when all are stale', async () => {
        const staleDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();
        getActiveLocationCount.mockResolvedValue(1);

        squareApi.syncLocations.mockResolvedValue(3);
        squareApi.syncVendors.mockResolvedValue(2);
        squareApi.syncCatalog.mockResolvedValue({ items: 10, variations: 5 });
        squareApi.syncInventory.mockResolvedValue(100);
        squareApi.syncSalesVelocityAllPeriods.mockResolvedValue({ '91d': 50, '182d': 30, '365d': 20 });

        db.query
            // locations isSyncNeeded
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            // loggedSync locations: INSERT + UPDATE
            .mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [] })
            // vendors isSyncNeeded
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            // loggedSync vendors: INSERT + UPDATE
            .mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({ rows: [] })
            // item count
            .mockResolvedValueOnce({ rows: [{ count: '50' }] })
            // catalog isSyncNeeded
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            // loggedSync catalog: INSERT + UPDATE
            .mockResolvedValueOnce({ rows: [{ id: 3 }] }).mockResolvedValueOnce({ rows: [] })
            // inventory count
            .mockResolvedValueOnce({ rows: [{ count: '50' }] })
            // inventory isSyncNeeded
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            // loggedSync inventory: INSERT + UPDATE
            .mockResolvedValueOnce({ rows: [{ id: 4 }] }).mockResolvedValueOnce({ rows: [] })
            // sales 91d/182d/365d isSyncNeeded (all stale)
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })
            // _writeSalesHistoryRows: 3 upserts
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const r = await runSmartSync({ merchantId: MID });
        expect(r.status).toBe('success');
        expect(r.synced).toContain('locations');
        expect(r.synced).toContain('catalog');
        expect(r.synced).toContain('inventory');
        expect(r.synced).toContain('sales_365d');
        expect(r.errors).toBeUndefined();
    });

    it('all types fresh → returns success with all skipped', async () => {
        const recentDate = new Date().toISOString();
        getActiveLocationCount.mockResolvedValue(5);

        db.query
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // locations
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // vendors
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // item count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // catalog
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // inv count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // inventory
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_91d
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_182d
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_365d
            .mockResolvedValueOnce({ rows: [{ records_synced: 50 }] });      // force365 check

        const r = await runSmartSync({ merchantId: MID });
        expect(r.status).toBe('success');
        expect(r.synced).toHaveLength(0);
        expect(Object.keys(r.skipped).length).toBeGreaterThan(0);
    });

    it('error in one type does not block others; status = partial', async () => {
        const recentDate = new Date().toISOString();
        const staleDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();
        getActiveLocationCount.mockResolvedValue(1);

        // locations stale but squareApi throws
        squareApi.syncLocations.mockRejectedValue(new Error('locations failed'));
        squareApi.syncVendors.mockResolvedValue(2);
        squareApi.syncSalesVelocityAllPeriods.mockResolvedValue({ '91d': 50, '182d': 30, '365d': 20 });

        db.query
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })  // locations isSyncNeeded
            .mockResolvedValueOnce({ rows: [{ id: 1 }] })                    // loggedSync INSERT
            .mockRejectedValueOnce(new Error('locations failed'))             // loggedSync UPDATE fails after fn error
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })  // vendors isSyncNeeded
            .mockResolvedValueOnce({ rows: [{ id: 2 }] })                    // loggedSync INSERT
            .mockResolvedValueOnce({ rows: [] })                              // loggedSync UPDATE
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // item count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // catalog fresh
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // inv count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // inventory fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })  // sales_91d
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })  // sales_182d
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })  // sales_365d
            .mockResolvedValueOnce({ rows: [] })                              // upsert 91d
            .mockResolvedValueOnce({ rows: [] })                              // upsert 182d
            .mockResolvedValueOnce({ rows: [] });                             // upsert 365d

        const r = await runSmartSync({ merchantId: MID });
        expect(r.status).toBe('partial');
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0].type).toBe('locations');
        expect(r.synced).toContain('vendors');
    });

    it('uses tier 3 (91d only) when only 91d is stale', async () => {
        const recentDate = new Date().toISOString();
        const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h (>3h interval)
        getActiveLocationCount.mockResolvedValue(5);
        squareApi.syncSalesVelocity.mockResolvedValue(30);

        db.query
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // locations fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // vendors fresh
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // item count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // catalog fresh
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // inv count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // inventory fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: staleDate }] })  // sales_91d stale (5h>3h)
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_182d fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_365d fresh
            .mockResolvedValueOnce({ rows: [{ records_synced: 20 }] })       // force365 check
            // loggedSync for sales_91d
            .mockResolvedValueOnce({ rows: [{ id: 5 }] })
            .mockResolvedValueOnce({ rows: [] });

        const r = await runSmartSync({ merchantId: MID });
        expect(r.synced).toContain('sales_91d');
        expect(r.synced).not.toContain('sales_182d');
        expect(r.synced).not.toContain('sales_365d');
        expect(r.summary.salesVelocityOptimization).toBe('tier3_91d_minimal_fetch');
    });

    it('force-syncs locations when locationCount is 0', async () => {
        getActiveLocationCount.mockResolvedValue(0);
        squareApi.syncLocations.mockResolvedValue(2);

        const recentDate = new Date().toISOString();
        db.query
            // No isSyncNeeded check needed — location count=0 forces it
            // But isSyncNeeded IS still called; let it return fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // locations isSyncNeeded (fresh but forced)
            .mockResolvedValueOnce({ rows: [{ id: 1 }] })                    // loggedSync INSERT
            .mockResolvedValueOnce({ rows: [] })                              // loggedSync UPDATE
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // vendors fresh
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // item count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // catalog fresh
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })             // inv count
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // inventory fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_91d fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_182d fresh
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate }] }) // sales_365d fresh
            .mockResolvedValueOnce({ rows: [{ records_synced: 10 }] });      // force365 check

        const r = await runSmartSync({ merchantId: MID });
        expect(r.synced).toContain('locations');
        expect(squareApi.syncLocations).toHaveBeenCalledWith(MID);
    });
});
