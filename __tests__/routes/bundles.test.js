/**
 * Bundle Routes Test Suite
 *
 * Tests for bundle CRUD operations and availability calculation.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/bundle-service', () => ({
    listBundles: jest.fn(),
    createBundle: jest.fn(),
    updateBundle: jest.fn(),
    deleteBundle: jest.fn(),
    calculateAvailability: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const bundleService = require('../../services/bundle-service');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api/bundles', require('../../routes/bundles'));
    return app;
}

describe('Bundle Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/bundles', () => {
        it('should list bundles', async () => {
            const mockResult = {
                bundles: [{ id: 1, name: 'Starter Pack', components: [] }],
                count: 1,
            };
            bundleService.listBundles.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .get('/api/bundles')
                .expect(200);

            expect(res.body.bundles).toHaveLength(1);
            expect(res.body.count).toBe(1);
            expect(bundleService.listBundles).toHaveBeenCalledWith(1, expect.any(Object));
        });
    });

    describe('GET /api/bundles/availability', () => {
        it('should calculate bundle availability', async () => {
            const mockResult = {
                bundles: [{ id: 1, name: 'Pack', assemblable_quantity: 5 }],
            };
            bundleService.calculateAvailability.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .get('/api/bundles/availability')
                .expect(200);

            expect(res.body.bundles[0].assemblable_quantity).toBe(5);
            expect(bundleService.calculateAvailability).toHaveBeenCalledWith(1, expect.any(Object));
        });
    });

    describe('POST /api/bundles', () => {
        it('should create a bundle', async () => {
            const newBundle = { id: 2, name: 'Premium Pack' };
            bundleService.createBundle.mockResolvedValueOnce(newBundle);

            const res = await request(app)
                .post('/api/bundles')
                .send({
                    bundle_variation_id: 'VAR_BUNDLE_1',
                    bundle_item_name: 'Premium Pack',
                    bundle_cost_cents: 2500,
                    components: [{ child_variation_id: 'var_1', quantity_in_bundle: 2 }],
                })
                .expect(201);

            expect(res.body.success).toBe(true);
            expect(res.body.bundle).toEqual(newBundle);
            expect(bundleService.createBundle).toHaveBeenCalledWith(1, expect.objectContaining({
                bundle_item_name: 'Premium Pack',
            }));
        });
    });

    describe('PUT /api/bundles/:id', () => {
        it('should update a bundle', async () => {
            const updated = { id: 1, name: 'Updated Pack' };
            bundleService.updateBundle.mockResolvedValueOnce(updated);

            const res = await request(app)
                .put('/api/bundles/1')
                .send({ name: 'Updated Pack' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.bundle).toEqual(updated);
            expect(bundleService.updateBundle).toHaveBeenCalledWith(1, 1, expect.any(Object));
        });
    });

    describe('DELETE /api/bundles/:id', () => {
        it('should soft-delete a bundle', async () => {
            const deleted = { id: 1, name: 'Pack', is_active: false };
            bundleService.deleteBundle.mockResolvedValueOnce(deleted);

            const res = await request(app)
                .delete('/api/bundles/1')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('deactivated');
            expect(res.body.bundle).toEqual(deleted);
        });

        it('should return 404 for non-existent bundle', async () => {
            bundleService.deleteBundle.mockResolvedValueOnce(null);

            const res = await request(app)
                .delete('/api/bundles/999')
                .expect(404);

            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('Bundle not found');
        });
    });
});
