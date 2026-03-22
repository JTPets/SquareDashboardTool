/**
 * Vendor Catalog Create Items Route Tests
 *
 * Tests POST /api/vendor-catalog/create-items endpoint:
 * - Authentication and authorization
 * - Input validation
 * - Cross-tenant isolation
 * - Successful creation with correct counts
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
    transaction: jest.fn(),
}));

const mockBulkCreateSquareItems = jest.fn();
jest.mock('../../services/vendor/catalog-create-service', () => ({
    bulkCreateSquareItems: mockBulkCreateSquareItems,
}));

// Mock other vendor service dependencies used by existing routes in vendor-catalog.js
jest.mock('../../services/vendor', () => ({
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
}));

jest.mock('../../services/square', () => ({
    batchUpdateVariationPrices: jest.fn(),
}));

jest.mock('../../services/vendor-dashboard', () => ({
    getVendorDashboard: jest.fn(),
    updateVendorSettings: jest.fn(),
}));

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
            return res.status(403).json({ error: 'Merchant context required' });
        }
        next();
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');

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

describe('POST /api/vendor-catalog/create-items', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    // ========================================================================
    // Auth & merchant middleware
    // ========================================================================

    describe('Auth and merchant middleware', () => {
        it('rejects unauthenticated request (401)', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1, 2, 3] });
            expect(res.status).toBe(401);
        });

        it('rejects request without merchant context (403)', async () => {
            app = createTestApp({ hasMerchant: false });
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1, 2, 3] });
            expect(res.status).toBe(403);
        });
    });

    // ========================================================================
    // Input validation
    // ========================================================================

    describe('Input validation', () => {
        it('rejects empty vendorCatalogIds array (400)', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [] });
            expect(res.status).toBe(400);
        });

        it('rejects missing vendorCatalogIds (400)', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({});
            expect(res.status).toBe(400);
        });

        it('rejects non-integer vendorCatalogIds (400)', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: ['abc', 'def'] });
            expect(res.status).toBe(400);
        });

        it('rejects float vendorCatalogIds (400)', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1.5, 2.7] });
            expect(res.status).toBe(400);
        });

        it('rejects negative vendorCatalogIds (400)', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [-1, -2] });
            expect(res.status).toBe(400);
        });

        it('rejects zero vendorCatalogIds (400)', async () => {
            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [0] });
            expect(res.status).toBe(400);
        });
    });

    // ========================================================================
    // Cross-tenant isolation
    // ========================================================================

    describe('Cross-tenant isolation', () => {
        it('passes merchantId from merchantContext, not from body', async () => {
            mockBulkCreateSquareItems.mockResolvedValue({
                created: 2, failed: 0, errors: []
            });

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1, 2], merchantId: 999 });

            expect(res.status).toBe(200);
            // Service should be called with merchantId=1 (from context), not 999 (from body)
            expect(mockBulkCreateSquareItems).toHaveBeenCalledWith([1, 2], 1, {});
        });
    });

    // ========================================================================
    // Successful creation
    // ========================================================================

    describe('Successful creation', () => {
        it('returns correct created/failed counts', async () => {
            mockBulkCreateSquareItems.mockResolvedValue({
                created: 5,
                failed: 1,
                errors: [{ vendorCatalogId: 3, error: 'Missing product name' }]
            });

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1, 2, 3, 4, 5, 6] });

            expect(res.status).toBe(200);
            expect(res.body.created).toBe(5);
            expect(res.body.failed).toBe(1);
            expect(res.body.errors).toHaveLength(1);
            expect(res.body.errors[0].vendorCatalogId).toBe(3);
        });

        it('returns empty errors when all succeed', async () => {
            mockBulkCreateSquareItems.mockResolvedValue({
                created: 3, failed: 0, errors: []
            });

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1, 2, 3] });

            expect(res.status).toBe(200);
            expect(res.body.created).toBe(3);
            expect(res.body.failed).toBe(0);
            expect(res.body.errors).toEqual([]);
        });

        it('returns 500 when service throws', async () => {
            mockBulkCreateSquareItems.mockRejectedValue(new Error('Square API down'));

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1] });

            expect(res.status).toBe(500);
        });

        // BACKLOG-88: Tax selection tests
        it('passes custom tax_ids to bulkCreateSquareItems (BACKLOG-88)', async () => {
            mockBulkCreateSquareItems.mockResolvedValue({ created: 1, failed: 0, errors: [] });

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1], tax_ids: ['TAX_ID_1', 'TAX_ID_2'] });

            expect(res.status).toBe(200);
            // Verify options.tax_ids was passed
            expect(mockBulkCreateSquareItems).toHaveBeenCalledWith(
                [1], 1, { tax_ids: ['TAX_ID_1', 'TAX_ID_2'] }
            );
        });

        it('passes empty tax_ids array (no taxes) (BACKLOG-88)', async () => {
            mockBulkCreateSquareItems.mockResolvedValue({ created: 1, failed: 0, errors: [] });

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1], tax_ids: [] });

            expect(res.status).toBe(200);
            expect(mockBulkCreateSquareItems).toHaveBeenCalledWith(
                [1], 1, { tax_ids: [] }
            );
        });

        it('default (no tax_ids param) uses all taxes (BACKLOG-88)', async () => {
            mockBulkCreateSquareItems.mockResolvedValue({ created: 1, failed: 0, errors: [] });

            const res = await request(app)
                .post('/api/vendor-catalog/create-items')
                .send({ vendorCatalogIds: [1] });

            expect(res.status).toBe(200);
            // No tax_ids in options means service will fetch all active taxes
            expect(mockBulkCreateSquareItems).toHaveBeenCalledWith([1], 1, {});
        });
    });
});
