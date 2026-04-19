/**
 * Sync Routes Test Suite
 *
 * Tests routes/sync.js endpoints via supertest:
 * - POST /api/sync         - Full synchronization
 * - POST /api/sync-sales   - Sales velocity sync
 * - POST /api/sync-smart   - Smart sync (interval-based)
 * - GET  /api/sync-history  - Sync history
 * - GET  /api/sync-intervals - Configured intervals
 * - GET  /api/sync-status   - Current sync status
 */

jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));
jest.mock('../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../services/square', () => ({
    fullSync: jest.fn(),
    syncSalesVelocityAllPeriods: jest.fn(),
    syncSalesVelocity: jest.fn(),
    syncLocations: jest.fn(),
    syncCatalog: jest.fn(),
    syncInventory: jest.fn(),
    syncVendors: jest.fn(),
}));
jest.mock('../../services/gmc/feed-service', () => ({
    generateFeed: jest.fn().mockResolvedValue({ stats: { total: 10 }, feedUrl: '/feed' }),
}));
jest.mock('../../services/webhook-handlers/catalog-handler', () => ({
    reconcileBundleComponents: jest.fn().mockResolvedValue(),
}));
jest.mock('../../middleware/validators/sync', () => ({
    sync: [(req, res, next) => next()],
    syncSales: [(req, res, next) => next()],
    syncSmart: [(req, res, next) => next()],
    syncHistory: [(req, res, next) => next()],
    syncIntervals: [(req, res, next) => next()],
    syncStatus: [(req, res, next) => next()],
}));

const request = require('supertest');
const express = require('express');
const db = require('../../utils/database');
const squareApi = require('../../services/square');
const feedService = require('../../services/gmc/feed-service');

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true } = opts;
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.session = {};
        if (authenticated) req.session.user = { id: 1, role: 'admin' };
        if (hasMerchant) req.merchantContext = { id: 42, square_access_token: 'tok' };
        next();
    });
    const routes = require('../../routes/sync');
    a.use('/api', routes);
    // Error handler required for asyncHandler to send 500 responses
    a.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return a;
}

const fullSyncResult = {
    success: true,
    locations: 5,
    vendors: 3,
    catalog: { items: 10, variations: 20, categories: 5, images: 3, variationVendors: 2 },
    inventory: 100,
    salesVelocity: { '91d': 50, '182d': 30, '365d': 20 },
    errors: [],
};

describe('POST /api/sync', () => {
    it('returns 401 without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const res = await request(app).post('/api/sync');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        const app = createTestApp({ hasMerchant: false });
        const res = await request(app).post('/api/sync');
        expect(res.status).toBe(400);
    });

    it('succeeds with full sync', async () => {
        squareApi.fullSync.mockResolvedValue(fullSyncResult);
        feedService.generateFeed.mockResolvedValue({ stats: { total: 10 }, feedUrl: '/feed' });

        const app = createTestApp();
        const res = await request(app).post('/api/sync');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(squareApi.fullSync).toHaveBeenCalledWith(42);
    });

    it('succeeds even when GMC feed generation fails', async () => {
        squareApi.fullSync.mockResolvedValue(fullSyncResult);
        feedService.generateFeed.mockRejectedValue(new Error('GMC failure'));

        const app = createTestApp();
        const res = await request(app).post('/api/sync');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
    });

    it('returns errors from fullSync', async () => {
        squareApi.fullSync.mockResolvedValue({
            ...fullSyncResult,
            errors: ['catalog timeout'],
        });
        feedService.generateFeed.mockResolvedValue({ stats: { total: 10 }, feedUrl: '/feed' });

        const app = createTestApp();
        const res = await request(app).post('/api/sync');

        expect(res.status).toBe(200);
        expect(res.body.errors).toContain('catalog timeout');
    });

    it('returns 500 when fullSync throws', async () => {
        squareApi.fullSync.mockRejectedValue(new Error('Square down'));

        const app = createTestApp();
        const res = await request(app).post('/api/sync');

        expect(res.status).toBe(500);
    });
});

describe('POST /api/sync-sales', () => {
    it('returns 401 without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const res = await request(app).post('/api/sync-sales');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        const app = createTestApp({ hasMerchant: false });
        const res = await request(app).post('/api/sync-sales');
        expect(res.status).toBe(400);
    });

    it('succeeds', async () => {
        squareApi.syncSalesVelocityAllPeriods.mockResolvedValue({
            '91d': 50, '182d': 30, '365d': 20,
        });

        const app = createTestApp();
        const res = await request(app).post('/api/sync-sales');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(squareApi.syncSalesVelocityAllPeriods).toHaveBeenCalledWith(42);
    });

    it('returns 500 on error', async () => {
        squareApi.syncSalesVelocityAllPeriods.mockRejectedValue(new Error('fail'));

        const app = createTestApp();
        const res = await request(app).post('/api/sync-sales');

        expect(res.status).toBe(500);
    });
});

describe('POST /api/sync-smart', () => {
    it('returns 401 without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const res = await request(app).post('/api/sync-smart');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        const app = createTestApp({ hasMerchant: false });
        const res = await request(app).post('/api/sync-smart');
        expect(res.status).toBe(400);
    });

    it('reports skipped types when all syncs are recent', async () => {
        const recentDate = new Date().toISOString();

        // runSmartSync makes many db.query calls in sequence:
        // 1. location count query
        // 2. isSyncNeeded('locations') query
        // 3. isSyncNeeded('vendors') query
        // 4. item count query
        // 5. isSyncNeeded('catalog') query
        // 6. inventory count query
        // 7. isSyncNeeded('inventory') query
        // 8. isSyncNeeded('sales_91d') query
        // 9. isSyncNeeded('sales_182d') query
        // 10. isSyncNeeded('sales_365d') query
        db.query
            // location count - has locations, no force sync
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })
            // isSyncNeeded('locations') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // isSyncNeeded('vendors') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // item count - has items, no force sync
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })
            // isSyncNeeded('catalog') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // inventory count - has inventory, no force sync
            .mockResolvedValueOnce({ rows: [{ count: '100' }] })
            // isSyncNeeded('inventory') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // isSyncNeeded('sales_91d') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // isSyncNeeded('sales_182d') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // isSyncNeeded('sales_365d') - recently synced
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // force365dSync check: SELECT records_synced FROM sync_history WHERE sync_type = 'sales_365d'
            // records_synced > 0 means no force sync needed
            .mockResolvedValueOnce({ rows: [{ records_synced: 50 }] });

        const app = createTestApp();
        const res = await request(app).post('/api/sync-smart');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.synced).toEqual([]);
        expect(res.body.skipped).toBeDefined();
    });

    it('returns 500 on error', async () => {
        db.query.mockRejectedValue(new Error('db down'));

        const app = createTestApp();
        const res = await request(app).post('/api/sync-smart');

        expect(res.status).toBe(500);
    });
});

describe('GET /api/sync-history', () => {
    it('returns 401 without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/sync-history');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        const app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/sync-history');
        expect(res.status).toBe(400);
    });

    it('returns history on success', async () => {
        db.query.mockResolvedValue({
            rows: [
                { id: 1, sync_type: 'full', status: 'completed', completed_at: '2026-03-15T00:00:00Z' },
                { id: 2, sync_type: 'catalog', status: 'completed', completed_at: '2026-03-14T00:00:00Z' },
            ],
            rowCount: 2,
        });

        const app = createTestApp();
        const res = await request(app).get('/api/sync-history');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.history).toHaveLength(2);
    });

    it('returns 500 on db error', async () => {
        db.query.mockRejectedValue(new Error('db fail'));

        const app = createTestApp();
        const res = await request(app).get('/api/sync-history');

        expect(res.status).toBe(500);
    });
});

describe('GET /api/sync-intervals', () => {
    it('returns 401 without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/sync-intervals');
        expect(res.status).toBe(401);
    });

    it('returns interval defaults', async () => {
        const app = createTestApp();
        const res = await request(app).get('/api/sync-intervals');

        expect(res.status).toBe(200);
        expect(res.body.intervals).toHaveProperty('locations');
        expect(res.body.intervals).toHaveProperty('catalog');
        expect(res.body.intervals).toHaveProperty('inventory');
    });
});

describe('GET /api/sync-status', () => {
    it('returns 401 without auth', async () => {
        const app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/sync-status');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        const app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/sync-status');
        expect(res.status).toBe(400);
    });

    it('returns sync status per type', async () => {
        const recentDate = new Date().toISOString();
        // sync-status calls isSyncNeeded for each sync type (6 types),
        // then for each type with lastSync, queries last status details.
        // With recent data, that's 6 isSyncNeeded queries + 6 detail queries = 12 total
        db.query
            // isSyncNeeded('catalog')
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // detail for catalog
            .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 10, duration_seconds: 5 }] })
            // isSyncNeeded('vendors')
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // detail for vendors
            .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 3, duration_seconds: 2 }] })
            // isSyncNeeded('inventory')
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // detail for inventory
            .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 100, duration_seconds: 10 }] })
            // isSyncNeeded('sales_91d')
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // detail for sales_91d
            .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 50, duration_seconds: 8 }] })
            // isSyncNeeded('sales_182d')
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // detail for sales_182d
            .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 30, duration_seconds: 6 }] })
            // isSyncNeeded('sales_365d')
            .mockResolvedValueOnce({ rows: [{ completed_at: recentDate, status: 'success' }] })
            // detail for sales_365d
            .mockResolvedValueOnce({ rows: [{ status: 'success', records_synced: 20, duration_seconds: 15 }] });

        const app = createTestApp();
        const res = await request(app).get('/api/sync-status');

        expect(res.status).toBe(200);
    });

    it('returns 500 on db error', async () => {
        db.query.mockRejectedValue(new Error('db fail'));

        const app = createTestApp();
        const res = await request(app).get('/api/sync-status');

        expect(res.status).toBe(500);
    });
});
