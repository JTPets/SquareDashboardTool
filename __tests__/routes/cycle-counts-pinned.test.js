/**
 * Cycle Count Pinned Group Endpoint Tests
 *
 * Covers:
 *   GET    /api/cycle-counts/pinned
 *   POST   /api/cycle-counts/pinned
 *   DELETE /api/cycle-counts/pinned/:variationId
 *   POST   /api/cycle-counts/pinned/send
 */

jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    requireWriteAccess: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        if (req.session.user.role === 'readonly') return res.status(403).json({ error: 'Write access required', code: 'FORBIDDEN' });
        next();
    },
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));

jest.mock('../../utils/database', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../../utils/image-utils', () => ({ batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()) }));
jest.mock('../../services/square', () => ({ getSquareInventoryCount: jest.fn(), setSquareInventoryCount: jest.fn() }));
jest.mock('../../services/catalog/location-service', () => ({ getFirstActiveLocation: jest.fn() }));

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
const inventoryService = require('../../services/inventory');

function createApp(opts = {}) {
    const { authenticated = false, hasMerchant = false, role = 'admin', merchantId = 42 } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, role };
        if (hasMerchant) req.merchantContext = { id: merchantId };
        next();
    });
    const routes = require('../../routes/cycle-counts');
    app.use('/api', routes);
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── GET /api/cycle-counts/pinned ──────────────────────────────────────────

describe('GET /api/cycle-counts/pinned', () => {
    it('returns empty array for new merchant with no pins', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.getPinnedGroup.mockResolvedValue([]);

        const res = await request(app).get('/api/cycle-counts/pinned');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
        expect(res.body.variations).toEqual([]);
    });

    it('returns saved variations for merchant with pins', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        const fixtures = [
            { variation_id: 'v1', variation_name: 'Large', item_name: 'Dog Food', sku: 'DF-L' },
            { variation_id: 'v2', variation_name: 'Small', item_name: 'Cat Treats', sku: 'CT-S' },
        ];
        inventoryService.getPinnedGroup.mockResolvedValue(fixtures);

        const res = await request(app).get('/api/cycle-counts/pinned');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.variations).toHaveLength(2);
        expect(res.body.variations[0].variation_id).toBe('v1');
    });

    it('is scoped to merchant — getPinnedGroup called with correct merchantId', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true, merchantId: 99 });
        inventoryService.getPinnedGroup.mockResolvedValue([]);

        await request(app).get('/api/cycle-counts/pinned');

        expect(inventoryService.getPinnedGroup).toHaveBeenCalledWith(99);
    });

    it('returns 401 without auth', async () => {
        const app = createApp();
        const res = await request(app).get('/api/cycle-counts/pinned');
        expect(res.status).toBe(401);
    });
});

// ─── POST /api/cycle-counts/pinned ─────────────────────────────────────────

describe('POST /api/cycle-counts/pinned', () => {
    it('adds variations and returns added count', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.addPinnedVariations.mockResolvedValue({ added: 2 });

        const res = await request(app)
            .post('/api/cycle-counts/pinned')
            .send({ variations: [
                { variation_id: 'v1', item_name: 'Dog Food', variation_name: 'Large', sku: 'DF-L' },
                { variation_id: 'v2', item_name: 'Cat Treats', variation_name: 'Small', sku: 'CT-S' },
            ] });

        expect(res.status).toBe(200);
        expect(res.body.added).toBe(2);
    });

    it('ignores duplicates (upsert behavior) — returns 0 added for already-pinned', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.addPinnedVariations.mockResolvedValue({ added: 0 });

        const res = await request(app)
            .post('/api/cycle-counts/pinned')
            .send({ variations: [{ variation_id: 'v1', item_name: 'Dog Food', variation_name: 'Large', sku: 'DF-L' }] });

        expect(res.status).toBe(200);
        expect(res.body.added).toBe(0);
    });

    it('returns 403 for readonly user', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true, role: 'readonly' });

        const res = await request(app)
            .post('/api/cycle-counts/pinned')
            .send({ variations: [{ variation_id: 'v1' }] });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
    });
});

// ─── DELETE /api/cycle-counts/pinned/:variationId ──────────────────────────

describe('DELETE /api/cycle-counts/pinned/:variationId', () => {
    it('removes variation and returns deleted:true', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.deletePinnedVariation.mockResolvedValue(true);

        const res = await request(app).delete('/api/cycle-counts/pinned/v1');

        expect(res.status).toBe(200);
        expect(res.body.deleted).toBe(true);
        expect(inventoryService.deletePinnedVariation).toHaveBeenCalledWith(42, 'v1');
    });

    it('returns 404 for non-existent variation', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.deletePinnedVariation.mockResolvedValue(false);

        const res = await request(app).delete('/api/cycle-counts/pinned/nonexistent');

        expect(res.status).toBe(404);
    });

    it('returns 403 for readonly user', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true, role: 'readonly' });

        const res = await request(app).delete('/api/cycle-counts/pinned/v1');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
    });
});

// ─── POST /api/cycle-counts/pinned/send ────────────────────────────────────

describe('POST /api/cycle-counts/pinned/send', () => {
    it('pushes all pinned variations to priority queue and returns count', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.sendPinnedGroupToQueue.mockResolvedValue({ pushed: 3 });

        const res = await request(app).post('/api/cycle-counts/pinned/send');

        expect(res.status).toBe(200);
        expect(res.body.pushed).toBe(3);
    });

    it('returns 400 when pinned group is empty', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.sendPinnedGroupToQueue.mockResolvedValue({ pushed: 0 });
        inventoryService.getPinnedGroup.mockResolvedValue([]);

        const res = await request(app).post('/api/cycle-counts/pinned/send');

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PINNED_GROUP_EMPTY');
    });

    it('returns success with message when all already queued (pushed 0 but group non-empty)', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true });
        inventoryService.sendPinnedGroupToQueue.mockResolvedValue({ pushed: 0 });
        inventoryService.getPinnedGroup.mockResolvedValue([
            { variation_id: 'v1', item_name: 'Dog Food', variation_name: 'Large', sku: 'DF-L' },
        ]);

        const res = await request(app).post('/api/cycle-counts/pinned/send');

        expect(res.status).toBe(200);
        expect(res.body.pushed).toBe(0);
        expect(res.body.message).toMatch(/already in the count queue/i);
    });

    it('returns 403 for readonly user', async () => {
        const app = createApp({ authenticated: true, hasMerchant: true, role: 'readonly' });

        const res = await request(app).post('/api/cycle-counts/pinned/send');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
    });
});
