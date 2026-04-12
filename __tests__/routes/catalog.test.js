/**
 * Catalog Routes Test Suite
 *
 * Tests for 19 endpoints in routes/catalog.js.
 * All routes delegate to catalogService — tests verify:
 * - Auth/merchant middleware integration
 * - Validator enforcement
 * - Success/error response shaping
 * - Correct service delegation
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

const mockCatalogService = {
    getLocations: jest.fn(),
    getCategories: jest.fn(),
    getItems: jest.fn(),
    getVariations: jest.fn(),
    getVariationsWithCosts: jest.fn(),
    updateExtendedFields: jest.fn(),
    updateMinStock: jest.fn(),
    updateCost: jest.fn(),
    bulkUpdateExtendedFields: jest.fn(),
    getExpirations: jest.fn(),
    saveExpirations: jest.fn(),
    handleExpiredPull: jest.fn(),
    markExpirationsReviewed: jest.fn(),
    getInventory: jest.fn(),
    getLowStock: jest.fn(),
    getDeletedItems: jest.fn(),
    getCatalogAudit: jest.fn(),
    enableItemAtAllLocations: jest.fn(),
    fixLocationMismatches: jest.fn(),
    fixInventoryAlerts: jest.fn(),
};

jest.mock('../../services/catalog', () => mockCatalogService);

// Mock the database module used by catalog validators (min-stock cross-field
// check reads variations.stock_alert_max). Default: no matching row so the
// validator passes through without constraining existing tests.
jest.mock('../../utils/database', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] })
}));
const mockDb = require('../../utils/database');

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
    requireWriteAccess: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (req.session.user.role === 'readonly') {
            return res.status(403).json({ error: 'Write access required', code: 'FORBIDDEN' });
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

// ============================================================================
// TEST APP SETUP
// ============================================================================

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, email: 'test@test.com' };
        if (hasMerchant) req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    const catalogRoutes = require('../../routes/catalog');
    app.use('/api', catalogRoutes);
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Catalog Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    // ==================== AUTH/MERCHANT MIDDLEWARE ====================

    describe('Auth and merchant middleware', () => {
        it('should return 401 without auth on all GET endpoints', async () => {
            app = createTestApp({ authenticated: false });
            const endpoints = [
                '/api/locations', '/api/categories', '/api/items',
                '/api/variations', '/api/variations-with-costs',
                '/api/expirations', '/api/inventory', '/api/low-stock',
                '/api/deleted-items', '/api/catalog-audit'
            ];
            for (const endpoint of endpoints) {
                const res = await request(app).get(endpoint);
                expect(res.status).toBe(401);
            }
        });

        it('should return 400 without merchant context', async () => {
            app = createTestApp({ hasMerchant: false });
            const res = await request(app).get('/api/locations');
            expect(res.status).toBe(400);
        });
    });

    // ==================== GET ENDPOINTS ====================

    describe('GET /api/locations', () => {
        it('should return locations for merchant', async () => {
            mockCatalogService.getLocations.mockResolvedValueOnce({
                count: 1,
                locations: [{ id: 'loc_1', name: 'Main Store' }]
            });
            const res = await request(app).get('/api/locations');
            expect(res.status).toBe(200);
            expect(res.body.locations).toHaveLength(1);
            expect(mockCatalogService.getLocations).toHaveBeenCalledWith(1);
        });
    });

    describe('GET /api/categories', () => {
        it('should return categories', async () => {
            mockCatalogService.getCategories.mockResolvedValueOnce(['Food', 'Toys']);
            const res = await request(app).get('/api/categories');
            expect(res.status).toBe(200);
            expect(res.body.categories).toEqual(['Food', 'Toys']);
        });
    });

    describe('GET /api/items', () => {
        it('should return items with count', async () => {
            mockCatalogService.getItems.mockResolvedValueOnce({
                count: 2,
                items: [{ id: 1, name: 'Dog Food' }, { id: 2, name: 'Cat Food' }]
            });
            const res = await request(app).get('/api/items');
            expect(res.status).toBe(200);
            expect(res.body.count).toBe(2);
        });

        it('should pass name and category filters', async () => {
            mockCatalogService.getItems.mockResolvedValueOnce({ count: 0, items: [] });
            await request(app).get('/api/items?name=dog&category=food');
            expect(mockCatalogService.getItems).toHaveBeenCalledWith(1, {
                name: 'dog', category: 'food'
            });
        });
    });

    describe('GET /api/variations', () => {
        it('should return variations', async () => {
            mockCatalogService.getVariations.mockResolvedValueOnce({
                count: 1,
                variations: [{ id: 'v1', sku: 'SKU001' }]
            });
            const res = await request(app).get('/api/variations');
            expect(res.status).toBe(200);
        });

        it('should pass all filter params', async () => {
            mockCatalogService.getVariations.mockResolvedValueOnce({ count: 0, variations: [] });
            await request(app).get('/api/variations?item_id=i1&sku=SKU&has_cost=true&search=dog&limit=50');
            expect(mockCatalogService.getVariations).toHaveBeenCalledWith(1, expect.objectContaining({
                item_id: 'i1',
                sku: 'SKU',
                has_cost: 'true',
                search: 'dog',
                limit: '50'
            }));
        });

        it('should reject search shorter than 2 chars', async () => {
            const res = await request(app).get('/api/variations?search=a');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/variations-with-costs', () => {
        it('should return variations with costs', async () => {
            mockCatalogService.getVariationsWithCosts.mockResolvedValueOnce({
                count: 1, variations: [{ id: 'v1', cost_cents: 500 }]
            });
            const res = await request(app).get('/api/variations-with-costs');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /api/expirations', () => {
        it('should return expiration data', async () => {
            mockCatalogService.getExpirations.mockResolvedValueOnce({
                count: 1, items: [{ variation_id: 'v1', expiration_date: '2026-04-01' }]
            });
            const res = await request(app).get('/api/expirations');
            expect(res.status).toBe(200);
            expect(res.body.count).toBe(1);
        });

        it('should pass expiry and category filters', async () => {
            mockCatalogService.getExpirations.mockResolvedValueOnce({ count: 0, items: [] });
            await request(app).get('/api/expirations?expiry=expired&category=Food');
            expect(mockCatalogService.getExpirations).toHaveBeenCalledWith(1, {
                expiry: 'expired', category: 'Food'
            });
        });
    });

    describe('GET /api/inventory', () => {
        it('should return inventory levels', async () => {
            mockCatalogService.getInventory.mockResolvedValueOnce({
                count: 5, inventory: []
            });
            const res = await request(app).get('/api/inventory');
            expect(res.status).toBe(200);
        });

        it('should pass location_id and low_stock filters', async () => {
            mockCatalogService.getInventory.mockResolvedValueOnce({ count: 0, inventory: [] });
            await request(app).get('/api/inventory?location_id=loc_1&low_stock=true');
            expect(mockCatalogService.getInventory).toHaveBeenCalledWith(1, {
                location_id: 'loc_1', low_stock: 'true'
            });
        });
    });

    describe('GET /api/low-stock', () => {
        it('should return low stock items', async () => {
            mockCatalogService.getLowStock.mockResolvedValueOnce({ count: 0, items: [] });
            const res = await request(app).get('/api/low-stock');
            expect(res.status).toBe(200);
        });
    });

    describe('GET /api/deleted-items', () => {
        it('should return deleted items', async () => {
            mockCatalogService.getDeletedItems.mockResolvedValueOnce({
                count: 1, items: [{ id: 'v1', name: 'Old Item' }]
            });
            const res = await request(app).get('/api/deleted-items');
            expect(res.status).toBe(200);
        });

        it('should pass age_months and status filters', async () => {
            mockCatalogService.getDeletedItems.mockResolvedValueOnce({ count: 0, items: [] });
            await request(app).get('/api/deleted-items?age_months=6&status=archived');
            expect(mockCatalogService.getDeletedItems).toHaveBeenCalledWith(1, {
                age_months: '6', status: 'archived'
            });
        });

        it('should reject invalid age_months', async () => {
            const res = await request(app).get('/api/deleted-items?age_months=0');
            expect(res.status).toBe(400);
        });

        it('should reject invalid status', async () => {
            const res = await request(app).get('/api/deleted-items?status=invalid');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/catalog-audit', () => {
        it('should return audit data', async () => {
            mockCatalogService.getCatalogAudit.mockResolvedValueOnce({
                issues: [], total: 0
            });
            const res = await request(app).get('/api/catalog-audit');
            expect(res.status).toBe(200);
        });

        it('should reject location_id with special characters', async () => {
            const res = await request(app).get('/api/catalog-audit?location_id=loc;DROP TABLE');
            expect(res.status).toBe(400);
        });
    });

    // ==================== PATCH/POST ENDPOINTS ====================

    describe('PATCH /api/variations/:id/extended', () => {
        it('should update extended fields', async () => {
            mockCatalogService.updateExtendedFields.mockResolvedValueOnce({
                success: true, variation: { id: 'v1' }, square_sync: null
            });
            const res = await request(app)
                .patch('/api/variations/v1/extended')
                .send({ case_pack_quantity: 12, shelf_location: 'A1' });
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('success');
        });

        it('should return error from service', async () => {
            mockCatalogService.updateExtendedFields.mockResolvedValueOnce({
                success: false, status: 404, error: 'Variation not found'
            });
            const res = await request(app)
                .patch('/api/variations/v1/extended')
                .send({ notes: 'test' });
            expect(res.status).toBe(404);
        });

        it('should reject negative case_pack_quantity', async () => {
            const res = await request(app)
                .patch('/api/variations/v1/extended')
                .send({ case_pack_quantity: -1 });
            expect(res.status).toBe(400);
        });
    });

    describe('PATCH /api/variations/:id/min-stock', () => {
        it('should update min stock', async () => {
            mockCatalogService.updateMinStock.mockResolvedValueOnce({
                success: true, message: 'Updated'
            });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: 10, location_id: 'loc_1' });
            expect(res.status).toBe(200);
        });

        it('should accept null min_stock (to clear)', async () => {
            mockCatalogService.updateMinStock.mockResolvedValueOnce({
                success: true, message: 'Cleared'
            });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: null });
            expect(res.status).toBe(200);
        });

        it('should return service error', async () => {
            mockCatalogService.updateMinStock.mockResolvedValueOnce({
                success: false, status: 400, error: 'Invalid', square_error: 'API error'
            });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: 5 });
            expect(res.status).toBe(400);
            expect(res.body.square_error).toBe('API error');
        });

        it('rejects min_stock that would violate stored stock_alert_max', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 20 }] });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: 25 });
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body)).toMatch(/stock_alert_max must be greater than stock_alert_min/);
            expect(mockCatalogService.updateMinStock).not.toHaveBeenCalled();
        });

        it('rejects min_stock equal to stored stock_alert_max', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 10 }] });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: 10 });
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body)).toMatch(/stock_alert_max must be greater than stock_alert_min/);
        });

        it('accepts min_stock below stored stock_alert_max', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: 50 }] });
            mockCatalogService.updateMinStock.mockResolvedValueOnce({
                success: true, message: 'Updated'
            });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: 5 });
            expect(res.status).toBe(200);
        });

        it('accepts min_stock when stored stock_alert_max is NULL (unlimited)', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [{ stock_alert_max: null }] });
            mockCatalogService.updateMinStock.mockResolvedValueOnce({
                success: true, message: 'Updated'
            });
            const res = await request(app)
                .patch('/api/variations/v1/min-stock')
                .send({ min_stock: 999 });
            expect(res.status).toBe(200);
        });
    });

    describe('PATCH /api/variations/:id/cost', () => {
        it('should update cost', async () => {
            mockCatalogService.updateCost.mockResolvedValueOnce({
                success: true, message: 'Cost updated'
            });
            const res = await request(app)
                .patch('/api/variations/v1/cost')
                .send({ cost_cents: 2500 });
            expect(res.status).toBe(200);
        });

        it('should require cost_cents', async () => {
            const res = await request(app)
                .patch('/api/variations/v1/cost')
                .send({});
            expect(res.status).toBe(400);
        });

        it('should reject negative cost_cents', async () => {
            const res = await request(app)
                .patch('/api/variations/v1/cost')
                .send({ cost_cents: -100 });
            expect(res.status).toBe(400);
        });

        it('should include location mismatch error code', async () => {
            mockCatalogService.updateCost.mockResolvedValueOnce({
                success: false, status: 400, error: 'Location mismatch',
                code: 'ITEM_AT_LOCATION_NOT_FOUND',
                parent_item_id: 'item_1', variation_id: 'v1'
            });
            const res = await request(app)
                .patch('/api/variations/v1/cost')
                .send({ cost_cents: 1000 });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('ITEM_AT_LOCATION_NOT_FOUND');
            expect(res.body.parent_item_id).toBe('item_1');
        });
    });

    describe('POST /api/variations/bulk-update-extended', () => {
        it('should bulk update by SKU', async () => {
            mockCatalogService.bulkUpdateExtendedFields.mockResolvedValueOnce({
                success: true, updated_count: 2, errors: [], squarePush: null
            });
            const res = await request(app)
                .post('/api/variations/bulk-update-extended')
                .send([
                    { sku: 'SKU001', case_pack_quantity: 6 },
                    { sku: 'SKU002', case_pack_quantity: 12 }
                ]);
            expect(res.status).toBe(200);
            expect(res.body.updated_count).toBe(2);
        });

        it('should reject non-array body', async () => {
            const res = await request(app)
                .post('/api/variations/bulk-update-extended')
                .send({ sku: 'SKU001' });
            expect(res.status).toBe(400);
        });

        it('should reject items without sku', async () => {
            const res = await request(app)
                .post('/api/variations/bulk-update-extended')
                .send([{ case_pack_quantity: 6 }]);
            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/expirations', () => {
        it('should save expiration changes', async () => {
            mockCatalogService.saveExpirations.mockResolvedValueOnce({
                success: true, message: 'Saved 2 changes',
                squarePush: null, tierOverrides: null
            });
            const res = await request(app)
                .post('/api/expirations')
                .send([
                    { variation_id: 'v1', expiration_date: '2026-06-01' },
                    { variation_id: 'v2', does_not_expire: true }
                ]);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('should reject invalid date format', async () => {
            const res = await request(app)
                .post('/api/expirations')
                .send([{ variation_id: 'v1', expiration_date: 'not-a-date' }]);
            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/expirations/pull', () => {
        it('should handle full pull (all expired)', async () => {
            mockCatalogService.handleExpiredPull.mockResolvedValueOnce({
                success: true, message: 'Inventory zeroed'
            });
            const res = await request(app)
                .post('/api/expirations/pull')
                .send({ variation_id: 'v1', all_expired: true });
            expect(res.status).toBe(200);
        });

        it('should handle partial pull with remaining quantity', async () => {
            mockCatalogService.handleExpiredPull.mockResolvedValueOnce({
                success: true, message: 'Partial pull recorded'
            });
            const res = await request(app)
                .post('/api/expirations/pull')
                .send({
                    variation_id: 'v1',
                    all_expired: false,
                    remaining_quantity: 5,
                    new_expiry_date: '2026-09-01'
                });
            expect(res.status).toBe(200);
        });

        it('should require variation_id', async () => {
            const res = await request(app)
                .post('/api/expirations/pull')
                .send({ all_expired: true });
            expect(res.status).toBe(400);
        });

        it('should require all_expired flag', async () => {
            const res = await request(app)
                .post('/api/expirations/pull')
                .send({ variation_id: 'v1' });
            expect(res.status).toBe(400);
        });

        it('should return service error status', async () => {
            mockCatalogService.handleExpiredPull.mockResolvedValueOnce({
                success: false, status: 404, error: 'Variation not found'
            });
            const res = await request(app)
                .post('/api/expirations/pull')
                .send({ variation_id: 'v_bad', all_expired: true });
            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/expirations/review', () => {
        it('should mark items as reviewed', async () => {
            mockCatalogService.markExpirationsReviewed.mockResolvedValueOnce({
                success: true, message: 'Reviewed', reviewed_count: 3, squarePush: null
            });
            const res = await request(app)
                .post('/api/expirations/review')
                .send({ variation_ids: ['v1', 'v2', 'v3'], reviewed_by: 'admin' });
            expect(res.status).toBe(200);
            expect(res.body.reviewed_count).toBe(3);
        });

        it('should require non-empty variation_ids array', async () => {
            const res = await request(app)
                .post('/api/expirations/review')
                .send({ variation_ids: [] });
            expect(res.status).toBe(400);
        });
    });

    // ==================== CATALOG AUDIT POST ENDPOINTS ====================

    describe('POST /api/catalog-audit/enable-item-at-locations', () => {
        it('should enable item at all locations', async () => {
            mockCatalogService.enableItemAtAllLocations.mockResolvedValueOnce({
                success: true, message: 'Item enabled at 3 locations'
            });
            const res = await request(app)
                .post('/api/catalog-audit/enable-item-at-locations')
                .send({ item_id: 'ITEM_ABC123' });
            expect(res.status).toBe(200);
        });

        it('should return service error', async () => {
            mockCatalogService.enableItemAtAllLocations.mockResolvedValueOnce({
                success: false, status: 404, error: 'Item not found in Square'
            });
            const res = await request(app)
                .post('/api/catalog-audit/enable-item-at-locations')
                .send({ item_id: 'ITEM_BAD' });
            expect(res.status).toBe(404);
        });

        it('should require item_id', async () => {
            const res = await request(app)
                .post('/api/catalog-audit/enable-item-at-locations')
                .send({});
            expect(res.status).toBe(400);
        });

        it('should reject item_id with special characters', async () => {
            const res = await request(app)
                .post('/api/catalog-audit/enable-item-at-locations')
                .send({ item_id: 'ITEM;DROP TABLE' });
            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/catalog-audit/fix-locations', () => {
        it('should fix location mismatches', async () => {
            mockCatalogService.fixLocationMismatches.mockResolvedValueOnce({
                success: true, message: 'Fixed',
                itemsFixed: 5, variationsFixed: 12, details: []
            });
            const res = await request(app)
                .post('/api/catalog-audit/fix-locations');
            expect(res.status).toBe(200);
            expect(res.body.itemsFixed).toBe(5);
        });

        it('should return 500 on partial failure', async () => {
            mockCatalogService.fixLocationMismatches.mockResolvedValueOnce({
                success: false, message: 'Partial failure',
                itemsFixed: 3, variationsFixed: 0,
                errors: ['Failed on ITEM_X'], details: []
            });
            const res = await request(app)
                .post('/api/catalog-audit/fix-locations');
            expect(res.status).toBe(500);
            expect(res.body.errors).toHaveLength(1);
        });
    });

    describe('POST /api/catalog-audit/fix-inventory-alerts', () => {
        it('should fix inventory alerts', async () => {
            mockCatalogService.fixInventoryAlerts.mockResolvedValueOnce({
                success: true, message: 'Fixed',
                variationsFixed: 10, totalFound: 10, details: []
            });
            const res = await request(app)
                .post('/api/catalog-audit/fix-inventory-alerts');
            expect(res.status).toBe(200);
            expect(res.body.variationsFixed).toBe(10);
        });

        it('should return 500 on failure', async () => {
            mockCatalogService.fixInventoryAlerts.mockResolvedValueOnce({
                success: false, message: 'API error',
                variationsFixed: 0, totalFound: 5,
                errors: ['Square API timeout'], details: []
            });
            const res = await request(app)
                .post('/api/catalog-audit/fix-inventory-alerts');
            expect(res.status).toBe(500);
        });
    });

    // ==================== ERROR HANDLING ====================

    describe('Error handling', () => {
        it('should return 500 when service throws', async () => {
            mockCatalogService.getLocations.mockRejectedValueOnce(
                new Error('DB connection failed')
            );
            const res = await request(app).get('/api/locations');
            expect(res.status).toBe(500);
        });
    });
});
