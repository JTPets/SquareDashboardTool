jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
    getSquareClientForMerchant: jest.fn(),
}));
jest.mock('../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../services/gmc/taxonomy-service', () => ({
    listTaxonomies: jest.fn(),
    getMappings: jest.fn(),
    setMapping: jest.fn(),
    deleteMapping: jest.fn(),
    fetchGoogleTaxonomy: jest.fn(),
    setMappingByName: jest.fn(),
    deleteMappingByName: jest.fn(),
}));
jest.mock('../../services/gmc/feed-service', () => ({
    generateFeedData: jest.fn(),
    generateTsvContent: jest.fn(() => 'tsv-content'),
    getSettings: jest.fn(),
    saveSettings: jest.fn(),
    importBrands: jest.fn(),
    importGoogleTaxonomy: jest.fn(),
    generateLocalInventoryFeed: jest.fn(),
    generateLocalInventoryTsvContent: jest.fn(() => 'local-tsv'),
    saveLocationSettings: jest.fn(),
}));
jest.mock('../../services/gmc/merchant-service', () => ({
    getGmcApiSettings: jest.fn(),
    saveGmcApiSettings: jest.fn(),
    testConnection: jest.fn(),
    getDataSourceInfo: jest.fn(),
    syncProductCatalog: jest.fn(),
    getLastSyncStatus: jest.fn(),
    getSyncHistory: jest.fn(),
    registerDeveloper: jest.fn(),
}));
jest.mock('../../services/square', () => ({
    updateCustomAttributeValues: jest.fn(),
    batchUpdateCustomAttributeValues: jest.fn(),
}));
jest.mock('../../middleware/security', () => ({
    configureSensitiveOperationRateLimit: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('../../middleware/validators/gmc', () => ({
    getFeed: [(req, res, next) => next()],
    updateSettings: [(req, res, next) => next()],
    importBrands: [(req, res, next) => next()],
    createBrand: [(req, res, next) => next()],
    assignItemBrand: [(req, res, next) => next()],
    autoDetectBrands: [(req, res, next) => next()],
    bulkAssignBrands: [(req, res, next) => next()],
    listTaxonomy: [(req, res, next) => next()],
    importTaxonomy: [(req, res, next) => next()],
    mapCategoryTaxonomy: [(req, res, next) => next()],
    deleteCategoryTaxonomy: [(req, res, next) => next()],
    mapCategoryTaxonomyByName: [(req, res, next) => next()],
    deleteCategoryTaxonomyByName: [(req, res, next) => next()],
    updateLocationSettings: [(req, res, next) => next()],
    getLocalInventoryFeed: [(req, res, next) => next()],
    updateApiSettings: [(req, res, next) => next()],
    getSyncHistory: [(req, res, next) => next()],
    registerDeveloper: [(req, res, next) => next()],
}));

const request = require('supertest');
const express = require('express');
const db = require('../../utils/database');
const feedService = require('../../services/gmc/feed-service');
const merchantService = require('../../services/gmc/merchant-service');
const taxonomyService = require('../../services/gmc/taxonomy-service');
const squareService = require('../../services/square');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { user: { id: 1, role: 'admin' } };
        req.merchantContext = { id: 10, square_access_token: 'tok' };
        next();
    });
    app.use('/api/gmc', require('../../routes/gmc'));
    app.use((err, req, res, _next) => {
        res.status(err.status || 500).json({ success: false, error: err.message });
    });
    return app;
}

let app;
beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
});

// ---------- GET /feed ----------
describe('GET /api/gmc/feed', () => {
    it('returns feed data', async () => {
        feedService.generateFeedData.mockResolvedValue({ items: [{ id: 1, title: 'Dog Food' }] });
        const res = await request(app).get('/api/gmc/feed');
        expect(res.status).toBe(200);
        expect(feedService.generateFeedData).toHaveBeenCalled();
    });
});

// ---------- GET /feed.tsv ----------
describe('GET /api/gmc/feed.tsv', () => {
    it('returns TSV with valid token', async () => {
        db.query.mockResolvedValue({ rows: [{ feed_token: 'valid-token', id: 10 }] });
        feedService.generateFeedData.mockResolvedValue({ items: [{ id: 1 }] });
        const res = await request(app).get('/api/gmc/feed.tsv?token=valid-token');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/tab-separated-values/);
    });

    it('returns 401 without token', async () => {
        // Build app without session to simulate unauthenticated TSV access
        const noAuthApp = express();
        noAuthApp.use(express.json());
        noAuthApp.use((req, res, next) => { req.session = {}; next(); });
        noAuthApp.use('/api/gmc', require('../../routes/gmc'));
        db.query.mockResolvedValue({ rows: [] });
        const res = await request(noAuthApp).get('/api/gmc/feed.tsv');
        expect(res.status).toBe(401);
    });

    it('returns 401 for an invalid feed token', async () => {
        const noAuthApp = express();
        noAuthApp.use(express.json());
        noAuthApp.use((req, res, next) => { req.session = {}; next(); });
        noAuthApp.use('/api/gmc', require('../../routes/gmc'));
        noAuthApp.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, error: err.message }));
        db.query.mockResolvedValueOnce({ rows: [] }); // token not found in DB
        const res = await request(noAuthApp).get('/api/gmc/feed.tsv?token=bad-token');
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid|expired/i);
    });

    it('returns 401 for invalid Basic Auth credentials', async () => {
        const noAuthApp = express();
        noAuthApp.use(express.json());
        noAuthApp.use((req, res, next) => { req.session = {}; next(); });
        noAuthApp.use('/api/gmc', require('../../routes/gmc'));
        noAuthApp.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, error: err.message }));
        db.query.mockResolvedValueOnce({ rows: [] }); // token not found in DB
        const basicAuth = Buffer.from('ignored:wrong-token').toString('base64');
        const res = await request(noAuthApp)
            .get('/api/gmc/feed.tsv')
            .set('Authorization', `Basic ${basicAuth}`);
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/Basic/);
    });
});

// ---------- GET /feed-url ----------
describe('GET /api/gmc/feed-url', () => {
    it('returns feed URL when token exists', async () => {
        db.query.mockResolvedValue({ rows: [{ gmc_feed_token: 'abc-123' }] });
        const res = await request(app).get('/api/gmc/feed-url');
        expect(res.status).toBe(200);
    });

    it('returns 404 when no token', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const res = await request(app).get('/api/gmc/feed-url');
        expect(res.status).toBe(404);
    });
});

// ---------- POST /regenerate-token ----------
describe('POST /api/gmc/regenerate-token', () => {
    it('regenerates feed token', async () => {
        db.query.mockResolvedValue({ rows: [{ feed_token: 'new-token' }] });
        const res = await request(app).post('/api/gmc/regenerate-token');
        expect(res.status).toBe(200);
    });
});

// ---------- GET /settings ----------
describe('GET /api/gmc/settings', () => {
    it('returns settings', async () => {
        feedService.getSettings.mockResolvedValue({ store_name: 'JTPets', currency: 'CAD' });
        const res = await request(app).get('/api/gmc/settings');
        expect(res.status).toBe(200);
    });
});

// ---------- PUT /settings ----------
describe('PUT /api/gmc/settings', () => {
    it('updates settings', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }] });
        feedService.getSettings.mockResolvedValue({ store_name: 'JTPets Updated', currency: 'CAD' });
        const res = await request(app)
            .put('/api/gmc/settings')
            .send({ settings: { store_name: 'JTPets Updated' } });
        expect(res.status).toBe(200);
    });
});

// ---------- GET /brands ----------
describe('GET /api/gmc/brands', () => {
    it('returns brands list', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1, name: 'Acana' }, { id: 2, name: 'Orijen' }] });
        const res = await request(app).get('/api/gmc/brands');
        expect(res.status).toBe(200);
    });
});

// ---------- POST /brands ----------
describe('POST /api/gmc/brands', () => {
    it('creates a new brand', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'Royal Canin' }] }); // insert RETURNING *
        const res = await request(app)
            .post('/api/gmc/brands')
            .send({ name: 'Royal Canin' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.brand.name).toBe('Royal Canin');
    });

    it('returns 409 for duplicate brand', async () => {
        const dupError = new Error('duplicate key value violates unique constraint');
        dupError.code = '23505';
        db.query.mockRejectedValueOnce(dupError);
        const res = await request(app)
            .post('/api/gmc/brands')
            .send({ name: 'Acana' });
        expect(res.status).toBe(409);
    });
});

// ---------- PUT /items/:itemId/brand ----------
describe('PUT /api/gmc/items/:itemId/brand', () => {
    it('assigns brand to item', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] }) // item exists
            .mockResolvedValueOnce({ rows: [{ name: 'Acana' }] }) // brand lookup
            .mockResolvedValueOnce({ rows: [] }); // insert item_brands
        squareService.updateCustomAttributeValues.mockResolvedValue({});
        const res = await request(app)
            .put('/api/gmc/items/item-1/brand')
            .send({ brand_id: 1 });
        expect(res.status).toBe(200);
    });

    it('returns 404 for missing item', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // item not found
        const res = await request(app)
            .put('/api/gmc/items/item-999/brand')
            .send({ brand_id: 1 });
        expect(res.status).toBe(404);
    });

    it('removes brand from item when brand_id is null', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] }) // item exists
            .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // update
        squareService.updateCustomAttributeValues.mockResolvedValue({});
        const res = await request(app)
            .put('/api/gmc/items/item-1/brand')
            .send({ brand_id: null });
        expect(res.status).toBe(200);
    });
});

// ---------- POST /brands/auto-detect ----------
describe('POST /api/gmc/brands/auto-detect', () => {
    it('auto-detects brands successfully', async () => {
        // Mock: ensure brands in DB, get brand rows, get items without brands
        db.query
            .mockResolvedValueOnce({ rows: [] }) // INSERT brand 'Acana' ON CONFLICT
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] }) // SELECT brands
            .mockResolvedValueOnce({ rows: [{ id: 'item-1', name: 'Acana Dog Food', category_name: 'Pet Food' }] }); // items without brands
        const res = await request(app)
            .post('/api/gmc/brands/auto-detect')
            .send({ brands: ['Acana'] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.detected_count).toBe(1);
    });

    it('returns 400 when no valid brands provided', async () => {
        const res = await request(app)
            .post('/api/gmc/brands/auto-detect')
            .send({ brands: ['', '  '] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/No valid brand/);
    });
});

// ---------- GET /taxonomy ----------
describe('GET /api/gmc/taxonomy', () => {
    it('returns taxonomy with search', async () => {
        taxonomyService.listTaxonomies.mockResolvedValue({ count: 1, taxonomy: [{ id: 1, name: 'Animals & Pet Supplies' }] });
        const res = await request(app).get('/api/gmc/taxonomy?search=pet');
        expect(res.status).toBe(200);
        expect(taxonomyService.listTaxonomies).toHaveBeenCalledWith({ search: 'pet', limit: undefined });
    });
});

// ---------- GET /category-mappings ----------
describe('GET /api/gmc/category-mappings', () => {
    it('returns category mappings', async () => {
        taxonomyService.getMappings.mockResolvedValue({ count: 1, mappings: [{ category_id: 'cat-1', taxonomy_id: 100 }] });
        const res = await request(app).get('/api/gmc/category-mappings');
        expect(res.status).toBe(200);
        expect(taxonomyService.getMappings).toHaveBeenCalledWith(10);
    });
});

// ---------- GET /location-settings ----------
describe('GET /api/gmc/location-settings', () => {
    it('returns location settings', async () => {
        db.query.mockResolvedValue({ rows: [{ location_id: 'loc-1', store_code: 'MAIN' }] });
        const res = await request(app).get('/api/gmc/location-settings');
        expect(res.status).toBe(200);
    });
});

// ---------- PUT /location-settings/:locationId ----------
describe('PUT /api/gmc/location-settings/:locationId', () => {
    it('updates location settings', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 'loc-1' }] }); // location check
        feedService.saveLocationSettings.mockResolvedValue({});
        const res = await request(app)
            .put('/api/gmc/location-settings/loc-1')
            .send({ google_store_code: 'MAIN', enabled: true });
        expect(res.status).toBe(200);
    });

    it('returns 404 for unknown location', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // location not found
        const res = await request(app)
            .put('/api/gmc/location-settings/loc-999')
            .send({ google_store_code: 'UNKNOWN', enabled: true });
        expect(res.status).toBe(404);
    });
});

// ---------- GET /api-settings ----------
describe('GET /api/gmc/api-settings', () => {
    it('returns GMC API settings', async () => {
        merchantService.getGmcApiSettings.mockResolvedValue({ merchant_id: '12345', configured: true });
        const res = await request(app).get('/api/gmc/api-settings');
        expect(res.status).toBe(200);
    });
});

// ---------- POST /api/test-connection ----------
describe('POST /api/gmc/api/test-connection', () => {
    it('tests connection successfully', async () => {
        merchantService.testConnection.mockResolvedValue({ success: true, account_name: 'JTPets' });
        const res = await request(app).post('/api/gmc/api/test-connection');
        expect(res.status).toBe(200);
    });
});

// ---------- GET /api/sync-status ----------
describe('GET /api/gmc/api/sync-status', () => {
    it('returns last sync status', async () => {
        merchantService.getLastSyncStatus.mockResolvedValue({ last_sync: '2026-03-15', items_synced: 100 });
        const res = await request(app).get('/api/gmc/api/sync-status');
        expect(res.status).toBe(200);
    });
});

// ---------- GET /api/sync-history ----------
describe('GET /api/gmc/api/sync-history', () => {
    it('returns sync history', async () => {
        merchantService.getSyncHistory.mockResolvedValue([{ id: 1, synced_at: '2026-03-15' }]);
        const res = await request(app).get('/api/gmc/api/sync-history');
        expect(res.status).toBe(200);
    });
});

// ---------- POST /api/sync ----------
describe('POST /api/gmc/api/sync-products', () => {
    it('triggers product sync', async () => {
        merchantService.syncProductCatalog.mockResolvedValue({ synced: 50, errors: 0 });
        const res = await request(app).post('/api/gmc/api/sync-products');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.async).toBe(true);
    });
});

// ---------- POST /api/register-developer ----------
describe('POST /api/gmc/api/register-developer', () => {
    it('registers developer successfully', async () => {
        merchantService.registerDeveloper.mockResolvedValue({ success: true, gcpIds: { projectId: 'my-project' } });
        const res = await request(app)
            .post('/api/gmc/api/register-developer')
            .send({ email: 'dev@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.gcpIds).toBeDefined();
        expect(merchantService.registerDeveloper).toHaveBeenCalledWith(10, 'dev@example.com');
    });

    it('returns 400 on registration failure', async () => {
        merchantService.registerDeveloper.mockResolvedValue({ success: false, error: 'GCP project not registered' });
        const res = await request(app)
            .post('/api/gmc/api/register-developer')
            .send({ email: 'dev@example.com' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('not registered');
    });
});

// ---------- POST /api/test-connection needsRegistration ----------
describe('POST /api/gmc/api/test-connection - needsRegistration', () => {
    it('includes needsRegistration when error contains not registered', async () => {
        merchantService.testConnection.mockResolvedValue({
            success: false,
            error: 'GCP project not registered with Merchant Center',
            needsRegistration: true
        });
        const res = await request(app).post('/api/gmc/api/test-connection');
        expect(res.status).toBe(200);
        expect(res.body.needsRegistration).toBe(true);
    });
});

// ---------- POST /brands/bulk-assign tenant isolation (SEC-GMC-3) ----------
describe('POST /api/gmc/brands/bulk-assign', () => {
    it('includes merchant_id in brand query', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] }) // brand lookup
            .mockResolvedValueOnce({ rows: [] }); // insert item_brands
        squareService.batchUpdateCustomAttributeValues.mockResolvedValue({ updated: 1, errors: [] });

        const res = await request(app)
            .post('/api/gmc/brands/bulk-assign')
            .send({ assignments: [{ item_id: 'item-1', brand_id: 1 }] });

        expect(res.status).toBe(200);
        // Verify the brand SELECT includes merchant_id filter
        const brandQuery = db.query.mock.calls[0];
        expect(brandQuery[0]).toContain('merchant_id');
        expect(brandQuery[1]).toEqual([[1], 10]); // 10 is the merchantContext.id from buildApp
    });
});

// ---------- GET /taxonomy/fetch-google ----------
describe('GET /api/gmc/taxonomy/fetch-google', () => {
    it('returns imported count on success', async () => {
        taxonomyService.fetchGoogleTaxonomy.mockResolvedValue({ imported: 42 });
        const res = await request(app).get('/api/gmc/taxonomy/fetch-google');
        expect(res.status).toBe(200);
        expect(res.body.imported).toBe(42);
    });

    it('returns 500 when HTTP fetch fails', async () => {
        taxonomyService.fetchGoogleTaxonomy.mockRejectedValue(new Error('Failed to fetch taxonomy: 503 Service Unavailable'));
        const res = await request(app).get('/api/gmc/taxonomy/fetch-google');
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/503/);
    });
});

// ---------- PUT /categories/:categoryId/taxonomy ----------
describe('PUT /api/gmc/categories/:categoryId/taxonomy', () => {
    it('returns 404 when category not found', async () => {
        taxonomyService.setMapping.mockResolvedValue({ notFound: 'category' });
        const res = await request(app).put('/api/gmc/categories/cat-x/taxonomy').send({ google_taxonomy_id: 5 });
        expect(res.status).toBe(404);
    });

    it('maps category to taxonomy', async () => {
        taxonomyService.setMapping.mockResolvedValue({});
        const res = await request(app).put('/api/gmc/categories/cat-1/taxonomy').send({ google_taxonomy_id: 5 });
        expect(res.status).toBe(200);
    });

    it('removes mapping when taxonomy_id is falsy', async () => {
        taxonomyService.setMapping.mockResolvedValue({ removed: true });
        const res = await request(app).put('/api/gmc/categories/cat-1/taxonomy').send({ google_taxonomy_id: null });
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/removed/i);
    });
});

// ---------- DELETE /categories/:categoryId/taxonomy ----------
describe('DELETE /api/gmc/categories/:categoryId/taxonomy', () => {
    it('removes mapping', async () => {
        taxonomyService.deleteMapping.mockResolvedValue(undefined);
        const res = await request(app).delete('/api/gmc/categories/cat-1/taxonomy');
        expect(res.status).toBe(200);
        expect(taxonomyService.deleteMapping).toHaveBeenCalledWith(10, 'cat-1');
    });
});

// ---------- PUT /category-taxonomy ----------
describe('PUT /api/gmc/category-taxonomy', () => {
    it('maps category by name', async () => {
        taxonomyService.setMappingByName.mockResolvedValue({ category_id: 'cat-1' });
        const res = await request(app).put('/api/gmc/category-taxonomy').send({ category_name: 'Dogs', google_taxonomy_id: 7 });
        expect(res.status).toBe(200);
        expect(res.body.category_id).toBe('cat-1');
    });
});

// ---------- DELETE /category-taxonomy ----------
describe('DELETE /api/gmc/category-taxonomy', () => {
    it('removes mapping by category name', async () => {
        taxonomyService.deleteMappingByName.mockResolvedValue({});
        const res = await request(app).delete('/api/gmc/category-taxonomy').send({ category_name: 'Dogs' });
        expect(res.status).toBe(200);
    });

    it('returns 404 when category not found', async () => {
        taxonomyService.deleteMappingByName.mockResolvedValue({ notFound: 'category' });
        const res = await request(app).delete('/api/gmc/category-taxonomy').send({ category_name: 'Unknown' });
        expect(res.status).toBe(404);
    });
});

// ---------- GET /local-inventory-feed.tsv — auth failures ----------
describe('GET /api/gmc/local-inventory-feed.tsv auth', () => {
    function buildNoAuthApp() {
        const a = express();
        a.use(express.json());
        a.use((req, res, next) => { req.session = {}; next(); });
        a.use('/api/gmc', require('../../routes/gmc'));
        a.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, error: err.message }));
        return a;
    }

    it('returns 401 with WWW-Authenticate when no auth provided', async () => {
        const res = await request(buildNoAuthApp()).get('/api/gmc/local-inventory-feed.tsv');
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/Basic/);
    });

    it('returns 401 for an invalid feed token', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // token lookup fails
        const res = await request(buildNoAuthApp()).get('/api/gmc/local-inventory-feed.tsv?token=bad-token');
        expect(res.status).toBe(401);
    });
});

// ---------- Auth guard ----------
describe('auth guard', () => {
    it('returns 401 without session user', async () => {
        const noAuthApp = express();
        noAuthApp.use(express.json());
        noAuthApp.use((req, res, next) => { req.session = {}; next(); });
        noAuthApp.use('/api/gmc', require('../../routes/gmc'));
        const res = await request(noAuthApp).get('/api/gmc/settings');
        expect(res.status).toBe(401);
    });

    it('returns 400 without merchant context', async () => {
        const noMerchantApp = express();
        noMerchantApp.use(express.json());
        noMerchantApp.use((req, res, next) => {
            req.session = { user: { id: 1, role: 'admin' } };
            next();
        });
        noMerchantApp.use('/api/gmc', require('../../routes/gmc'));
        const res = await request(noMerchantApp).get('/api/gmc/settings');
        expect(res.status).toBe(400);
    });
});
