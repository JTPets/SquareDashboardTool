/**
 * Tests for GET /api/vendor-catalog/merchant-taxes
 *
 * Previously had zero coverage. The handler is in
 * routes/vendor-catalog/vendors.js and delegates to
 * vendorQueryService.getMerchantTaxes.
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({ query: jest.fn() }));

const mockGetMerchantTaxes = jest.fn();
jest.mock('../../services/vendor/vendor-query-service', () => ({
    listVendors: jest.fn(),
    lookupOurItemByUPC: jest.fn(),
    verifyVariationsBelongToMerchant: jest.fn(),
    getMerchantTaxes: mockGetMerchantTaxes,
    confirmVendorLinks: jest.fn(),
}));

// Stub out the other services consumed by sibling sub-routers
jest.mock('../../services/vendor', () => ({
    importVendorCatalog: jest.fn(), previewFile: jest.fn(), importWithMappings: jest.fn(),
    FIELD_TYPES: {}, searchVendorCatalog: jest.fn(), lookupByUPC: jest.fn(),
    getImportBatches: jest.fn(), archiveImportBatch: jest.fn(), unarchiveImportBatch: jest.fn(),
    deleteImportBatch: jest.fn(), regeneratePriceReport: jest.fn(), getStats: jest.fn(),
    deduplicateVendorCatalog: jest.fn(),
}));
jest.mock('../../services/square', () => ({ batchUpdateVariationPrices: jest.fn() }));
jest.mock('../../services/vendor/vendor-dashboard', () => ({
    getVendorDashboard: jest.fn(), updateVendorSettings: jest.fn(),
}));
jest.mock('../../services/vendor/catalog-create-service', () => ({ bulkCreateSquareItems: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        next();
    },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' });
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
        if (authenticated) req.session.user = { id: 1 };
        if (hasMerchant) req.merchantContext = { id: merchantId };
        next();
    });
    app.use('/api', require('../../routes/vendor-catalog'));
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
    return app;
}

// ============================================================================
// TESTS
// ============================================================================

describe('GET /api/vendor-catalog/merchant-taxes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('returns tax list from service', async () => {
        mockGetMerchantTaxes.mockResolvedValueOnce([
            { id: 'TAX1', name: 'HST', percentage: '13', enabled: true }
        ]);

        const res = await request(app).get('/api/vendor-catalog/merchant-taxes');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.taxes).toHaveLength(1);
        expect(res.body.taxes[0].name).toBe('HST');
    });

    it('returns empty array when service returns none', async () => {
        mockGetMerchantTaxes.mockResolvedValueOnce([]);

        const res = await request(app).get('/api/vendor-catalog/merchant-taxes');

        expect(res.status).toBe(200);
        expect(res.body.taxes).toEqual([]);
    });

    it('passes merchantId from context to service', async () => {
        mockGetMerchantTaxes.mockResolvedValueOnce([]);
        app = createTestApp({ merchantId: 42 });

        await request(app).get('/api/vendor-catalog/merchant-taxes');

        expect(mockGetMerchantTaxes).toHaveBeenCalledWith(42);
    });

    it('returns 401 for unauthenticated request', async () => {
        app = createTestApp({ authenticated: false });
        const res = await request(app).get('/api/vendor-catalog/merchant-taxes');
        expect(res.status).toBe(401);
    });

    it('returns 400 when merchant context is missing', async () => {
        app = createTestApp({ hasMerchant: false });
        const res = await request(app).get('/api/vendor-catalog/merchant-taxes');
        expect(res.status).toBe(400);
    });
});
