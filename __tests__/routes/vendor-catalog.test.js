/**
 * Vendor Catalog Routes Test Suite
 *
 * Tests routes/vendor-catalog.js endpoints via supertest:
 * - GET    /api/vendors
 * - GET    /api/vendor-dashboard
 * - PATCH  /api/vendors/:id/settings
 * - POST   /api/vendor-catalog/import
 * - POST   /api/vendor-catalog/preview
 * - POST   /api/vendor-catalog/import-mapped
 * - GET    /api/vendor-catalog/field-types
 * - GET    /api/vendor-catalog
 * - GET    /api/vendor-catalog/lookup/:upc
 * - GET    /api/vendor-catalog/batches
 * - POST   /api/vendor-catalog/batches/:batchId/archive
 * - POST   /api/vendor-catalog/batches/:batchId/unarchive
 * - DELETE /api/vendor-catalog/batches/:batchId
 * - GET    /api/vendor-catalog/batches/:batchId/report
 * - GET    /api/vendor-catalog/stats
 * - POST   /api/vendor-catalog/push-price-changes
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const mockVendorCatalog = {
    importVendorCatalog: jest.fn(),
    previewFile: jest.fn(),
    importWithMappings: jest.fn(),
    FIELD_TYPES: { upc: 'UPC/Barcode', product_name: 'Product Name', cost: 'Cost' },
    searchVendorCatalog: jest.fn(),
    lookupByUPC: jest.fn(),
    getImportBatches: jest.fn(),
    archiveImportBatch: jest.fn(),
    unarchiveImportBatch: jest.fn(),
    deleteImportBatch: jest.fn(),
    regeneratePriceReport: jest.fn(),
    getStats: jest.fn(),
};
jest.mock('../../services/vendor', () => mockVendorCatalog);

const mockSquareApi = {
    batchUpdateVariationPrices: jest.fn(),
};
jest.mock('../../services/square', () => mockSquareApi);

const mockVendorDashboard = {
    getVendorDashboard: jest.fn(),
    updateVendorSettings: jest.fn(),
};
jest.mock('../../services/vendor-dashboard', () => mockVendorDashboard);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(400).json({ error: 'Merchant context required' });
        }
        next();
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');

// ============================================================================
// TEST APP SETUP
// ============================================================================

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true, merchantId = 1 } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) {
            req.session.user = { id: 1, email: 'test@test.com', role: 'admin' };
        }
        if (hasMerchant) {
            req.merchantContext = { id: merchantId, businessName: 'Test Store' };
        }
        next();
    });
    const vendorCatalogRoutes = require('../../routes/vendor-catalog');
    app.use('/api', vendorCatalogRoutes);
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Vendor Catalog Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    // ========================================================================
    // Auth & merchant middleware
    // ========================================================================

    describe('Auth and merchant middleware', () => {

        it('returns 401 for unauthenticated request to GET /api/vendors', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/vendors');
            expect(res.status).toBe(401);
        });

        it('returns 400 for missing merchant on GET /api/vendors', async () => {
            app = createTestApp({ hasMerchant: false });
            const res = await request(app).get('/api/vendors');
            expect(res.status).toBe(400);
        });

        it('returns 401 for unauthenticated POST /api/vendor-catalog/import', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).post('/api/vendor-catalog/import').send({ data: 'x' });
            expect(res.status).toBe(401);
        });

        it('returns 400 for missing merchant on POST /api/vendor-catalog/push-price-changes', async () => {
            app = createTestApp({ hasMerchant: false });
            const res = await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({ priceChanges: [{ variationId: 'v1', newPriceCents: 100 }] });
            expect(res.status).toBe(400);
        });
    });

    // ========================================================================
    // GET /api/vendors
    // ========================================================================

    describe('GET /api/vendors', () => {

        it('returns all vendors for merchant', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 'V1', name: 'Vendor A', status: 'ACTIVE' },
                    { id: 'V2', name: 'Vendor B', status: 'ACTIVE' },
                ],
            });

            const res = await request(app).get('/api/vendors');

            expect(res.status).toBe(200);
            expect(res.body.count).toBe(2);
            expect(res.body.vendors).toHaveLength(2);
            // Verify merchant_id scoping
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('merchant_id = $1'),
                expect.arrayContaining([1])
            );
        });

        it('filters by status when provided', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'V1', name: 'Active', status: 'ACTIVE' }] });

            const res = await request(app).get('/api/vendors?status=active');

            expect(res.status).toBe(200);
            // Validator uppercases the status
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[0]).toContain('status = $2');
            expect(queryCall[1]).toContain('ACTIVE');
        });

        it('returns 400 for invalid status', async () => {
            const res = await request(app).get('/api/vendors?status=INVALID');
            expect(res.status).toBe(400);
        });

        it('returns empty list when no vendors', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/vendors');

            expect(res.status).toBe(200);
            expect(res.body.count).toBe(0);
            expect(res.body.vendors).toEqual([]);
        });
    });

    // ========================================================================
    // GET /api/vendor-dashboard
    // ========================================================================

    describe('GET /api/vendor-dashboard', () => {

        it('returns dashboard data from service', async () => {
            mockVendorDashboard.getVendorDashboard.mockResolvedValueOnce({
                vendors: [{ id: 'V1', name: 'Test', total_items: 50 }],
                global_oos_count: 5,
            });

            const res = await request(app).get('/api/vendor-dashboard');

            expect(res.status).toBe(200);
            expect(res.body.vendors).toHaveLength(1);
            expect(res.body.global_oos_count).toBe(5);
            expect(mockVendorDashboard.getVendorDashboard).toHaveBeenCalledWith(1);
        });

        it('passes merchant id to service', async () => {
            app = createTestApp({ merchantId: 42 });
            mockVendorDashboard.getVendorDashboard.mockResolvedValueOnce({ vendors: [], global_oos_count: 0 });

            await request(app).get('/api/vendor-dashboard');

            expect(mockVendorDashboard.getVendorDashboard).toHaveBeenCalledWith(42);
        });
    });

    // ========================================================================
    // PATCH /api/vendors/:id/settings
    // ========================================================================

    describe('PATCH /api/vendors/:id/settings', () => {

        it('updates vendor settings', async () => {
            mockVendorDashboard.updateVendorSettings.mockResolvedValueOnce({
                id: 'V1', schedule_type: 'fixed', order_day: 'Monday', receive_day: 'Wednesday',
            });

            const res = await request(app)
                .patch('/api/vendors/V1/settings')
                .send({ schedule_type: 'fixed', order_day: 'Monday', receive_day: 'Wednesday' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockVendorDashboard.updateVendorSettings).toHaveBeenCalledWith('V1', 1, expect.any(Object));
        });

        it('returns 404 when vendor not found', async () => {
            mockVendorDashboard.updateVendorSettings.mockResolvedValueOnce(null);

            const res = await request(app)
                .patch('/api/vendors/NOPE/settings')
                .send({ notes: 'test' });

            expect(res.status).toBe(404);
        });

        it('returns 400 for invalid schedule_type', async () => {
            const res = await request(app)
                .patch('/api/vendors/V1/settings')
                .send({ schedule_type: 'weekly' });

            expect(res.status).toBe(400);
        });

        it('returns 400 for fixed schedule without order_day', async () => {
            const res = await request(app)
                .patch('/api/vendors/V1/settings')
                .send({ schedule_type: 'fixed', receive_day: 'Monday' });

            expect(res.status).toBe(400);
        });

        it('enforces merchant scoping via service call', async () => {
            app = createTestApp({ merchantId: 99 });
            mockVendorDashboard.updateVendorSettings.mockResolvedValueOnce({ id: 'V1' });

            await request(app)
                .patch('/api/vendors/V1/settings')
                .send({ notes: 'test' });

            expect(mockVendorDashboard.updateVendorSettings).toHaveBeenCalledWith('V1', 99, expect.any(Object));
        });
    });

    // ========================================================================
    // POST /api/vendor-catalog/import
    // ========================================================================

    describe('POST /api/vendor-catalog/import', () => {

        it('returns 400 when data is missing', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/import')
                .send({});

            expect(res.status).toBe(400);
        });

        it('imports CSV data successfully', async () => {
            mockVendorCatalog.importVendorCatalog.mockResolvedValueOnce({
                success: true,
                stats: { imported: 50, matched: 30 },
                batchId: 'batch-1',
                validationErrors: [],
                fieldMap: {},
                duration: 1500,
            });

            const res = await request(app)
                .post('/api/vendor-catalog/import')
                .send({ data: 'csv,data,here', fileType: 'csv' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.stats.imported).toBe(50);
            expect(res.body.batchId).toBe('batch-1');
        });

        it('returns 400 when import fails', async () => {
            mockVendorCatalog.importVendorCatalog.mockResolvedValueOnce({
                success: false,
                error: 'Invalid file format',
                validationErrors: ['Row 2: missing UPC'],
            });

            const res = await request(app)
                .post('/api/vendor-catalog/import')
                .send({ data: 'bad,data' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('passes merchantId to service', async () => {
            app = createTestApp({ merchantId: 77 });
            mockVendorCatalog.importVendorCatalog.mockResolvedValueOnce({ success: true, stats: { imported: 0 } });

            await request(app)
                .post('/api/vendor-catalog/import')
                .send({ data: 'x', fileType: 'csv' });

            expect(mockVendorCatalog.importVendorCatalog).toHaveBeenCalledWith(
                expect.anything(), 'csv',
                expect.objectContaining({ merchantId: 77 })
            );
        });

        it('detects xlsx from fileName', async () => {
            mockVendorCatalog.importVendorCatalog.mockResolvedValueOnce({ success: true, stats: { imported: 0 } });

            await request(app)
                .post('/api/vendor-catalog/import')
                .send({ data: 'base64data', fileName: 'catalog.xlsx' });

            expect(mockVendorCatalog.importVendorCatalog).toHaveBeenCalledWith(
                expect.anything(), 'xlsx', expect.anything()
            );
        });
    });

    // ========================================================================
    // POST /api/vendor-catalog/preview
    // ========================================================================

    describe('POST /api/vendor-catalog/preview', () => {

        it('returns 400 when data is missing', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/preview')
                .send({});

            expect(res.status).toBe(400);
        });

        it('returns preview with auto-mappings', async () => {
            mockVendorCatalog.previewFile.mockResolvedValueOnce({
                totalRows: 100,
                columns: [
                    { originalHeader: 'UPC', suggestedMapping: 'upc', sampleValues: ['123', '456'] },
                    { originalHeader: 'Price', suggestedMapping: 'cost', sampleValues: ['9.99'] },
                ],
                fieldTypes: { upc: 'UPC/Barcode', cost: 'Cost' },
            });

            const res = await request(app)
                .post('/api/vendor-catalog/preview')
                .send({ data: 'csv,content' });

            expect(res.status).toBe(200);
            expect(res.body.totalRows).toBe(100);
            expect(res.body.columns).toEqual(['UPC', 'Price']);
            expect(res.body.autoMappings.UPC).toBe('upc');
            expect(res.body.sampleValues.UPC).toEqual(['123', '456']);
        });
    });

    // ========================================================================
    // POST /api/vendor-catalog/import-mapped
    // ========================================================================

    describe('POST /api/vendor-catalog/import-mapped', () => {

        it('returns 400 when data is missing', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/import-mapped')
                .send({ vendorId: 'V1' });

            expect(res.status).toBe(400);
        });

        it('returns 400 when vendorId is missing', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/import-mapped')
                .send({ data: 'csv,content' });

            expect(res.status).toBe(400);
        });

        it('imports with explicit mappings', async () => {
            mockVendorCatalog.importWithMappings.mockResolvedValueOnce({
                success: true,
                stats: { imported: 25 },
                batchId: 'b2',
                validationErrors: [],
                fieldMap: {},
                duration: 800,
                importName: 'Test Import',
                vendorName: 'ACME',
            });

            const res = await request(app)
                .post('/api/vendor-catalog/import-mapped')
                .send({
                    data: 'csv,content',
                    vendorId: 'V1',
                    vendorName: 'ACME',
                    columnMappings: { col1: 'upc', col2: 'cost' },
                    importName: 'Test Import',
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.importName).toBe('Test Import');
        });

        it('accepts mappings field as alias for columnMappings', async () => {
            mockVendorCatalog.importWithMappings.mockResolvedValueOnce({
                success: true, stats: { imported: 5 }, batchId: 'b3',
            });

            await request(app)
                .post('/api/vendor-catalog/import-mapped')
                .send({
                    data: 'csv,content',
                    vendorId: 'V1',
                    mappings: { col1: 'upc' },
                });

            expect(mockVendorCatalog.importWithMappings).toHaveBeenCalledWith(
                expect.anything(), 'csv',
                expect.objectContaining({ columnMappings: { col1: 'upc' } })
            );
        });
    });

    // ========================================================================
    // GET /api/vendor-catalog/field-types
    // ========================================================================

    describe('GET /api/vendor-catalog/field-types', () => {

        it('returns field types (auth only, no merchant required)', async () => {
            // field-types only requires auth, not merchant
            app = createTestApp({ hasMerchant: false });

            const res = await request(app).get('/api/vendor-catalog/field-types');

            expect(res.status).toBe(200);
            expect(res.body.fieldTypes).toHaveProperty('upc');
        });

        it('returns 401 when not authenticated', async () => {
            app = createTestApp({ authenticated: false });

            const res = await request(app).get('/api/vendor-catalog/field-types');
            expect(res.status).toBe(401);
        });
    });

    // ========================================================================
    // GET /api/vendor-catalog (search)
    // ========================================================================

    describe('GET /api/vendor-catalog', () => {

        it('returns search results', async () => {
            mockVendorCatalog.searchVendorCatalog.mockResolvedValueOnce([
                { id: 1, product_name: 'Dog Food', upc: '123' },
            ]);

            const res = await request(app).get('/api/vendor-catalog?search=dog');

            expect(res.status).toBe(200);
            expect(res.body.count).toBe(1);
            expect(res.body.items[0].product_name).toBe('Dog Food');
        });

        it('passes all query params to service', async () => {
            mockVendorCatalog.searchVendorCatalog.mockResolvedValueOnce([]);

            await request(app).get('/api/vendor-catalog?vendor_id=V1&search=food&matched_only=true&limit=50&offset=10');

            expect(mockVendorCatalog.searchVendorCatalog).toHaveBeenCalledWith(expect.objectContaining({
                vendorId: 'V1',
                search: 'food',
                matchedOnly: true,
                limit: 50,
                offset: 10,
                merchantId: 1,
            }));
        });

        it('defaults limit to 100 and offset to 0', async () => {
            mockVendorCatalog.searchVendorCatalog.mockResolvedValueOnce([]);

            await request(app).get('/api/vendor-catalog');

            expect(mockVendorCatalog.searchVendorCatalog).toHaveBeenCalledWith(expect.objectContaining({
                limit: 100,
                offset: 0,
            }));
        });
    });

    // ========================================================================
    // GET /api/vendor-catalog/lookup/:upc
    // ========================================================================

    describe('GET /api/vendor-catalog/lookup/:upc', () => {

        it('returns vendor items and our catalog item', async () => {
            mockVendorCatalog.lookupByUPC.mockResolvedValueOnce([
                { id: 1, vendor_name: 'ACME', unit_cost: 500 },
            ]);
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'v1', sku: 'SKU001', item_name: 'Dog Food' }],
            });

            const res = await request(app).get('/api/vendor-catalog/lookup/012345678901');

            expect(res.status).toBe(200);
            expect(res.body.upc).toBe('012345678901');
            expect(res.body.vendorItems).toHaveLength(1);
            expect(res.body.ourCatalogItem).toBeTruthy();
        });

        it('returns null for ourCatalogItem when no match', async () => {
            mockVendorCatalog.lookupByUPC.mockResolvedValueOnce([]);
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/vendor-catalog/lookup/999999999999');

            expect(res.status).toBe(200);
            expect(res.body.ourCatalogItem).toBeNull();
        });

        it('scopes our catalog query by merchant_id', async () => {
            app = createTestApp({ merchantId: 42 });
            mockVendorCatalog.lookupByUPC.mockResolvedValueOnce([]);
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app).get('/api/vendor-catalog/lookup/123');

            const catalogQuery = db.query.mock.calls[0];
            expect(catalogQuery[0]).toContain('merchant_id = $2');
            expect(catalogQuery[1]).toContain(42);
        });
    });

    // ========================================================================
    // GET /api/vendor-catalog/batches
    // ========================================================================

    describe('GET /api/vendor-catalog/batches', () => {

        it('returns batches list', async () => {
            mockVendorCatalog.getImportBatches.mockResolvedValueOnce([
                { batch_id: 'b1', vendor_name: 'ACME', imported_count: 50 },
            ]);

            const res = await request(app).get('/api/vendor-catalog/batches');

            expect(res.status).toBe(200);
            expect(res.body.count).toBe(1);
        });

        it('passes include_archived to service', async () => {
            mockVendorCatalog.getImportBatches.mockResolvedValueOnce([]);

            await request(app).get('/api/vendor-catalog/batches?include_archived=true');

            expect(mockVendorCatalog.getImportBatches).toHaveBeenCalledWith(expect.objectContaining({
                includeArchived: true,
                merchantId: 1,
            }));
        });
    });

    // ========================================================================
    // Batch actions: archive, unarchive, delete
    // ========================================================================

    describe('POST /api/vendor-catalog/batches/:batchId/archive', () => {

        it('archives batch', async () => {
            mockVendorCatalog.archiveImportBatch.mockResolvedValueOnce(25);

            const res = await request(app).post('/api/vendor-catalog/batches/b1/archive');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.archivedCount).toBe(25);
            expect(mockVendorCatalog.archiveImportBatch).toHaveBeenCalledWith('b1', 1);
        });
    });

    describe('POST /api/vendor-catalog/batches/:batchId/unarchive', () => {

        it('unarchives batch', async () => {
            mockVendorCatalog.unarchiveImportBatch.mockResolvedValueOnce(25);

            const res = await request(app).post('/api/vendor-catalog/batches/b1/unarchive');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.unarchivedCount).toBe(25);
        });
    });

    describe('DELETE /api/vendor-catalog/batches/:batchId', () => {

        it('deletes batch permanently', async () => {
            mockVendorCatalog.deleteImportBatch.mockResolvedValueOnce(10);

            const res = await request(app).delete('/api/vendor-catalog/batches/b1');

            expect(res.status).toBe(200);
            expect(res.body.deletedCount).toBe(10);
            expect(mockVendorCatalog.deleteImportBatch).toHaveBeenCalledWith('b1', 1);
        });
    });

    // ========================================================================
    // GET /api/vendor-catalog/batches/:batchId/report
    // ========================================================================

    describe('GET /api/vendor-catalog/batches/:batchId/report', () => {

        it('returns price report', async () => {
            mockVendorCatalog.regeneratePriceReport.mockResolvedValueOnce({
                success: true,
                priceChanges: [{ sku: 'S1', oldPrice: 1000, newPrice: 1200 }],
            });

            const res = await request(app).get('/api/vendor-catalog/batches/b1/report');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.priceChanges).toHaveLength(1);
        });

        it('returns 404 when batch not found', async () => {
            mockVendorCatalog.regeneratePriceReport.mockResolvedValueOnce({
                success: false,
                error: 'Batch not found',
            });

            const res = await request(app).get('/api/vendor-catalog/batches/nope/report');

            expect(res.status).toBe(404);
        });
    });

    // ========================================================================
    // GET /api/vendor-catalog/stats
    // ========================================================================

    describe('GET /api/vendor-catalog/stats', () => {

        it('returns stats from service', async () => {
            mockVendorCatalog.getStats.mockResolvedValueOnce({
                totalVendorItems: 500,
                matchedItems: 300,
                unmatchedItems: 200,
            });

            const res = await request(app).get('/api/vendor-catalog/stats');

            expect(res.status).toBe(200);
            expect(res.body.totalVendorItems).toBe(500);
        });
    });

    // ========================================================================
    // POST /api/vendor-catalog/push-price-changes
    // ========================================================================

    describe('POST /api/vendor-catalog/push-price-changes', () => {

        it('returns 400 for empty priceChanges', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({ priceChanges: [] });

            expect(res.status).toBe(400);
        });

        it('returns 400 for missing variationId', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({ priceChanges: [{ newPriceCents: 100 }] });

            expect(res.status).toBe(400);
        });

        it('returns 400 for negative price', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({ priceChanges: [{ variationId: 'v1', newPriceCents: -100 }] });

            expect(res.status).toBe(400);
        });

        it('returns 403 when variations belong to different merchant', async () => {
            // Only 1 of 2 variations found for this merchant
            db.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });

            const res = await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({
                    priceChanges: [
                        { variationId: 'v1', newPriceCents: 1000 },
                        { variationId: 'v2', newPriceCents: 2000 },
                    ],
                });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/do not belong to this merchant/);
        });

        it('pushes prices to Square when all variations verified', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }, { id: 'v2' }] });
            mockSquareApi.batchUpdateVariationPrices.mockResolvedValueOnce({
                success: true,
                updated: 2,
                failed: 0,
                errors: [],
                details: [],
            });

            const res = await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({
                    priceChanges: [
                        { variationId: 'v1', newPriceCents: 1000 },
                        { variationId: 'v2', newPriceCents: 2000 },
                    ],
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.updated).toBe(2);
        });

        it('verifies variations with merchant_id in query', async () => {
            app = createTestApp({ merchantId: 55 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
            mockSquareApi.batchUpdateVariationPrices.mockResolvedValueOnce({
                success: true, updated: 1, failed: 0, errors: [], details: [],
            });

            await request(app)
                .post('/api/vendor-catalog/push-price-changes')
                .send({ priceChanges: [{ variationId: 'v1', newPriceCents: 500 }] });

            const verifyCall = db.query.mock.calls[0];
            expect(verifyCall[0]).toContain('merchant_id');
            expect(verifyCall[1]).toContain(55);
        });
    });

    // ============================================================================
    // BACKLOG-90: Confirm suggested vendor links
    // ============================================================================

    describe('POST /api/vendor-catalog/confirm-links (BACKLOG-90)', () => {
        test('creates variation_vendors rows for confirmed links', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const app = createTestApp();
            const res = await request(app)
                .post('/api/vendor-catalog/confirm-links')
                .send({
                    links: [
                        { variation_id: 'VAR1', vendor_id: 'V1', vendor_code: 'ABC-123', cost_cents: 1500 },
                        { variation_id: 'VAR2', vendor_id: 'V1', vendor_code: 'ABC-456', cost_cents: 2000 }
                    ]
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.created).toBe(2);
            expect(res.body.failed).toBe(0);

            // Verify INSERT INTO variation_vendors was called for each link
            const insertCalls = db.query.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
            );
            expect(insertCalls).toHaveLength(2);
            expect(insertCalls[0][1]).toEqual(['VAR1', 'V1', 'ABC-123', 1500, 1]);
        });

        test('handles partial failures gracefully', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] }) // first link succeeds
                .mockRejectedValueOnce(new Error('FK violation')); // second link fails

            const app = createTestApp();
            const res = await request(app)
                .post('/api/vendor-catalog/confirm-links')
                .send({
                    links: [
                        { variation_id: 'VAR1', vendor_id: 'V1', cost_cents: 1500 },
                        { variation_id: 'INVALID', vendor_id: 'V1', cost_cents: 2000 }
                    ]
                });

            expect(res.status).toBe(200);
            expect(res.body.created).toBe(1);
            expect(res.body.failed).toBe(1);
            expect(res.body.errors).toHaveLength(1);
        });

        test('existing link not re-suggested — ON CONFLICT updates', async () => {
            // ON CONFLICT DO UPDATE means existing links get updated, not duplicated
            db.query.mockResolvedValue({ rows: [] });

            const app = createTestApp();
            const res = await request(app)
                .post('/api/vendor-catalog/confirm-links')
                .send({
                    links: [{ variation_id: 'VAR1', vendor_id: 'V1', vendor_code: 'NEW-CODE', cost_cents: 1800 }]
                });

            expect(res.status).toBe(200);
            expect(res.body.created).toBe(1);

            const insertCall = db.query.mock.calls[0];
            expect(insertCall[0]).toContain('ON CONFLICT');
        });
    });
});
