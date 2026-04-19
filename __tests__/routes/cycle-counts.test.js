jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));
jest.mock('../../utils/database', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../../services/square', () => ({
    getSquareInventoryCount: jest.fn(),
    setSquareInventoryCount: jest.fn(),
}));
jest.mock('../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../../services/inventory', () => ({
    generateDailyBatch: jest.fn(),
    sendCycleCountReport: jest.fn(),
    getPinnedGroup: jest.fn(),
    addPinnedVariations: jest.fn(),
    deletePinnedVariation: jest.fn(),
    sendPinnedGroupToQueue: jest.fn(),
}));
jest.mock('../../middleware/validators/cycle-counts', () => ({
    complete: [(req, res, next) => next()],
    syncToSquare: [(req, res, next) => next()],
    sendNow: [(req, res, next) => next()],
    getStats: [(req, res, next) => next()],
    getHistory: [(req, res, next) => next()],
    emailReport: [(req, res, next) => next()],
    generateBatch: [(req, res, next) => next()],
    reset: [(req, res, next) => next()],
    generateCategoryBatch: [(req, res, next) => next()],
    previewCategoryBatch: [(req, res, next) => next()],
    getPinned: [(req, res, next) => next()],
    addPinned: [(req, res, next) => next()],
    deletePinned: [(req, res, next) => next()],
    sendPinned: [(req, res, next) => next()],
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const squareApi = require('../../services/square');
const inventoryService = require('../../services/inventory');

let app;

function createApp(opts = {}) {
    const { authenticated = false, hasMerchant = false } = opts;
    const testApp = express();
    testApp.use(express.json());
    testApp.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    testApp.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, role: 'admin' };
        if (hasMerchant) req.merchantContext = { id: 42, square_access_token: 'tok' };
        next();
    });
    const routes = require('../../routes/cycle-counts');
    testApp.use('/api', routes);
    testApp.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return testApp;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('GET /api/cycle-counts/pending', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).get('/api/cycle-counts/pending');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        app = createApp({ authenticated: true });
        const res = await request(app).get('/api/cycle-counts/pending');
        expect(res.status).toBe(400);
    });

    it('returns pending items on success', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        // Mock session insert, priority query, daily batch query
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // insert session
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // priority items
            .mockResolvedValueOnce({ rows: [{ id: 10, sku: 'SKU1', item_name: 'Item 1', variation_name: 'Default', variation_id: 'v1', square_variation_id: 'sv1' }], rowCount: 1 }); // daily batch

        const res = await request(app).get('/api/cycle-counts/pending');

        expect(res.status).toBe(200);
    });
});

describe('POST /api/cycle-counts/:id/complete', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).post('/api/cycle-counts/1/complete');
        expect(res.status).toBe(401);
    });

    it('returns 400 with invalid id', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        const res = await request(app)
            .post('/api/cycle-counts/null/complete')
            .send({ counted_quantity: 5 });

        expect(res.status).toBe(400);
    });

    it('returns 404 when variation not found', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/cycle-counts/999/complete')
            .send({ counted_quantity: 5 });

        expect(res.status).toBe(404);
    });

    it('succeeds with valid data', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({
            rows: [{ id: 1, sku: 'SKU1', square_variation_id: 'sv1', item_name: 'Item', variation_name: 'Default' }],
            rowCount: 1,
        });

        db.transaction.mockImplementation(async (fn) => {
            const client = {
                query: jest.fn().mockResolvedValue({ rows: [{ pending_count: 0, total_count: 1 }], rowCount: 1 }),
            };
            return fn(client);
        });

        inventoryService.sendCycleCountReport.mockResolvedValue({ sent: true });

        const res = await request(app)
            .post('/api/cycle-counts/1/complete')
            .send({ counted_quantity: 5 });

        expect(res.status).toBe(200);
    });
});

describe('POST /api/cycle-counts/:id/sync-to-square', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).post('/api/cycle-counts/1/sync-to-square');
        expect(res.status).toBe(401);
    });

    it('returns 404 when variation not found', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/cycle-counts/1/sync-to-square')
            .send({ actual_quantity: 10 });

        expect(res.status).toBe(404);
    });

    it('returns 409 on inventory mismatch', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({
                rows: [{ id: 1, sku: 'SKU1', name: 'Default', item_id: 10, item_name: 'Item', track_inventory: true }],
                rowCount: 1,
            }) // variation lookup
            .mockResolvedValueOnce({ rows: [{ id: 'loc1' }], rowCount: 1 }) // location lookup
            .mockResolvedValueOnce({ rows: [{ quantity: 5, updated_at: '2026-03-15' }], rowCount: 1 }); // inventory_counts

        squareApi.getSquareInventoryCount.mockResolvedValue(8);

        const res = await request(app)
            .post('/api/cycle-counts/1/sync-to-square')
            .send({ actual_quantity: 10 });

        expect(res.status).toBe(409);
    });

    it('succeeds when inventory matches', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({
                rows: [{ id: 1, sku: 'SKU1', name: 'Default', item_id: 10, item_name: 'Item', track_inventory: true }],
                rowCount: 1,
            }) // variation lookup
            .mockResolvedValueOnce({ rows: [{ id: 'loc1' }], rowCount: 1 }) // location lookup
            .mockResolvedValueOnce({ rows: [{ quantity: 10, updated_at: '2026-03-15' }], rowCount: 1 }); // inventory_counts

        squareApi.getSquareInventoryCount.mockResolvedValue(10);
        squareApi.setSquareInventoryCount.mockResolvedValue({ success: true });

        db.transaction.mockImplementation(async (fn) => {
            const client = {
                query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            };
            return fn(client);
        });

        const res = await request(app)
            .post('/api/cycle-counts/1/sync-to-square')
            .send({ actual_quantity: 12 });

        expect(res.status).toBe(200);
        expect(squareApi.setSquareInventoryCount).toHaveBeenCalled();
    });
});

describe('POST /api/cycle-counts/send-now', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).post('/api/cycle-counts/send-now');
        expect(res.status).toBe(401);
    });

    it('returns 400 with no skus', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        const res = await request(app)
            .post('/api/cycle-counts/send-now')
            .send({});

        expect(res.status).toBe(400);
    });

    it('returns 404 when no matching skus found', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/cycle-counts/send-now')
            .send({ skus: ['NONEXISTENT'] });

        expect(res.status).toBe(404);
    });

    it('succeeds with valid skus', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({
                rows: [{ id: 1, sku: 'SKU1', square_variation_id: 'sv1' }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 }); // insert priority

        const res = await request(app)
            .post('/api/cycle-counts/send-now')
            .send({ skus: ['SKU1'] });

        expect(res.status).toBe(200);
    });
});

describe('GET /api/cycle-counts/stats', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).get('/api/cycle-counts/stats');
        expect(res.status).toBe(401);
    });

    it('returns stats on success', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, started_at: '2026-03-15', completed_count: 5 }], rowCount: 1 }) // sessions
            .mockResolvedValueOnce({ rows: [{ total_items_counted: '50', most_recent_count: '2026-03-15', oldest_count: '2026-02-15', counted_last_30_days: '40' }], rowCount: 1 }) // overall stats
            .mockResolvedValueOnce({ rows: [{ total_variations: '200' }], rowCount: 1 }); // total variations

        const res = await request(app).get('/api/cycle-counts/stats');

        expect(res.status).toBe(200);
    });
});

describe('GET /api/cycle-counts/history', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).get('/api/cycle-counts/history');
        expect(res.status).toBe(401);
    });

    it('returns history on success', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, sku: 'SKU1', counted_quantity: 10, system_quantity: 8, counted_at: '2026-03-15T10:00:00Z', is_accurate: true, variance: 2, variance_value: 5.00 },
            ],
            rowCount: 1,
        });

        const res = await request(app).get('/api/cycle-counts/history');

        expect(res.status).toBe(200);
    });
});

describe('POST /api/cycle-counts/email-report', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).post('/api/cycle-counts/email-report');
        expect(res.status).toBe(401);
    });

    it('succeeds when report is sent', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.sendCycleCountReport.mockResolvedValue({ sent: true });

        const res = await request(app).post('/api/cycle-counts/email-report');

        expect(res.status).toBe(200);
        expect(inventoryService.sendCycleCountReport).toHaveBeenCalled();
    });

    it('returns 400 when email reporting is disabled', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.sendCycleCountReport.mockResolvedValue({ sent: false, reason: 'disabled' });

        const res = await request(app).post('/api/cycle-counts/email-report');

        expect(res.status).toBe(400);
    });
});

describe('POST /api/cycle-counts/generate-batch', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).post('/api/cycle-counts/generate-batch');
        expect(res.status).toBe(401);
    });

    it('succeeds', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.generateDailyBatch.mockResolvedValue({ batch_size: 20, generated: true });

        const res = await request(app).post('/api/cycle-counts/generate-batch');

        expect(res.status).toBe(200);
        expect(inventoryService.generateDailyBatch).toHaveBeenCalled();
    });
});

describe('GET /api/cycle-counts/preview-category-batch', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).get('/api/cycle-counts/preview-category-batch?type=category&id=Dogs');
        expect(res.status).toBe(401);
    });

    it('returns count for category without inserting', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 'v1', sku: 'SKU1', item_name: 'Dog Food', variation_name: 'Large' },
                { id: 'v2', sku: 'SKU2', item_name: 'Dog Treats', variation_name: 'Small' },
            ],
            rowCount: 2,
        });

        const res = await request(app).get('/api/cycle-counts/preview-category-batch?type=category&id=Dogs');

        expect(res.status).toBe(200);
        expect(res.body.total_found).toBe(2);
        expect(res.body.name).toBe('Dogs');
        // Must not have triggered any INSERT
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('returns 0 for empty category', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app).get('/api/cycle-counts/preview-category-batch?type=category&id=EmptyCat');

        expect(res.status).toBe(200);
        expect(res.body.total_found).toBe(0);
    });

    it('returns count for vendor preview', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({ rows: [{ name: 'Acme Supplies' }], rowCount: 1 }) // vendor name lookup
            .mockResolvedValueOnce({
                rows: [{ id: 'v1', sku: 'SKU1', item_name: 'Widget', variation_name: 'Default' }],
                rowCount: 1,
            });

        const res = await request(app).get('/api/cycle-counts/preview-category-batch?type=vendor&id=vendor-123');

        expect(res.status).toBe(200);
        expect(res.body.total_found).toBe(1);
        expect(res.body.name).toBe('Acme Supplies');
    });

    it('returns 0 for empty vendor', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({ rows: [{ name: 'Empty Vendor' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app).get('/api/cycle-counts/preview-category-batch?type=vendor&id=vendor-empty');

        expect(res.status).toBe(200);
        expect(res.body.total_found).toBe(0);
    });
});

describe('POST /api/cycle-counts/generate-category-batch', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app)
            .post('/api/cycle-counts/generate-category-batch')
            .send({ type: 'category', id: 'Dogs' });
        expect(res.status).toBe(401);
    });

    it('inserts category variations and returns correct counts', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({
                rows: [
                    { id: 'v1', sku: 'SKU1', item_name: 'Dog Food', variation_name: 'Large' },
                    { id: 'v2', sku: 'SKU2', item_name: 'Dog Treats', variation_name: 'Small' },
                ],
                rowCount: 2,
            }) // variations query
            .mockResolvedValueOnce({ rowCount: 1 }) // insert v1 — new
            .mockResolvedValueOnce({ rowCount: 0 }); // insert v2 — already queued (dedup)

        const res = await request(app)
            .post('/api/cycle-counts/generate-category-batch')
            .send({ type: 'category', id: 'Dogs' });

        expect(res.status).toBe(200);
        expect(res.body.items_added).toBe(1);
        expect(res.body.items_skipped).toBe(1);
        expect(res.body.total_found).toBe(2);
        expect(res.body.name).toBe('Dogs');
    });

    it('inserts vendor variations (any vendor assignment)', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({ rows: [{ name: 'Acme Supplies' }], rowCount: 1 }) // vendor name
            .mockResolvedValueOnce({
                rows: [{ id: 'v1', sku: 'SKU1', item_name: 'Widget', variation_name: 'Default' }],
                rowCount: 1,
            }) // variations
            .mockResolvedValueOnce({ rowCount: 1 }); // insert

        const res = await request(app)
            .post('/api/cycle-counts/generate-category-batch')
            .send({ type: 'vendor', id: 'vendor-123' });

        expect(res.status).toBe(200);
        expect(res.body.items_added).toBe(1);
        expect(res.body.items_skipped).toBe(0);
        expect(res.body.name).toBe('Acme Supplies');
    });

    it('returns 0 counts for empty category without inserting', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await request(app)
            .post('/api/cycle-counts/generate-category-batch')
            .send({ type: 'category', id: 'EmptyCat' });

        expect(res.status).toBe(200);
        expect(res.body.items_added).toBe(0);
        expect(res.body.items_skipped).toBe(0);
        expect(res.body.total_found).toBe(0);
        // No INSERT calls — only the one variations query
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('dedup: skips variations already in queue', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.query
            .mockResolvedValueOnce({
                rows: [
                    { id: 'v1', sku: 'S1', item_name: 'A', variation_name: 'Default' },
                    { id: 'v2', sku: 'S2', item_name: 'B', variation_name: 'Default' },
                    { id: 'v3', sku: 'S3', item_name: 'C', variation_name: 'Default' },
                ],
                rowCount: 3,
            })
            .mockResolvedValueOnce({ rowCount: 0 }) // v1 already queued
            .mockResolvedValueOnce({ rowCount: 0 }) // v2 already queued
            .mockResolvedValueOnce({ rowCount: 1 }); // v3 inserted

        const res = await request(app)
            .post('/api/cycle-counts/generate-category-batch')
            .send({ type: 'category', id: 'Pets' });

        expect(res.status).toBe(200);
        expect(res.body.items_added).toBe(1);
        expect(res.body.items_skipped).toBe(2);
    });
});

describe('POST /api/cycle-counts/reset', () => {
    it('returns 401 without auth', async () => {
        app = createApp();
        const res = await request(app).post('/api/cycle-counts/reset');
        expect(res.status).toBe(401);
    });

    it('succeeds with full reset', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.transaction.mockImplementation(async (fn) => {
            const client = {
                query: jest.fn().mockResolvedValue({ rows: [{ count: 5 }], rowCount: 1 }),
            };
            return fn(client);
        });

        const res = await request(app)
            .post('/api/cycle-counts/reset')
            .send({ preserve_history: false });

        expect(res.status).toBe(200);
    });

    it('succeeds with preserve_history', async () => {
        app = createApp({ authenticated: true, hasMerchant: true });
        db.transaction.mockImplementation(async (fn) => {
            const client = {
                query: jest.fn().mockResolvedValue({ rows: [{ count: 5 }], rowCount: 1 }),
            };
            return fn(client);
        });

        const res = await request(app)
            .post('/api/cycle-counts/reset')
            .send({ preserve_history: true });

        expect(res.status).toBe(200);
    });
});
