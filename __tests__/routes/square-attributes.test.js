/**
 * Square Custom Attributes Routes Test Suite
 *
 * Tests for custom attribute definition and value management:
 * - List, create, delete custom attribute definitions
 * - Update custom attribute values on catalog objects
 * - Push local data to Square
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/square', () => ({
    listCustomAttributeDefinitions: jest.fn(),
    initializeCustomAttributes: jest.fn(),
    upsertCustomAttributeDefinition: jest.fn(),
    deleteCustomAttributeDefinition: jest.fn(),
    updateCustomAttributeValues: jest.fn(),
    pushCasePackToSquare: jest.fn(),
    pushBrandsToSquare: jest.fn(),
    pushExpiryDatesToSquare: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    requireWriteAccess: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const squareApi = require('../../services/square');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/square-attributes'));
    return app;
}

describe('Square Custom Attributes Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/square/custom-attributes', () => {
        it('should list custom attribute definitions', async () => {
            const mockDefs = [
                { key: 'case_pack_quantity', name: 'Case Pack Quantity', type: 'NUMBER' },
                { key: 'brand', name: 'Brand', type: 'STRING' },
            ];
            squareApi.listCustomAttributeDefinitions.mockResolvedValueOnce(mockDefs);

            const res = await request(app)
                .get('/api/square/custom-attributes')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(2);
            expect(res.body.definitions).toEqual(mockDefs);
            expect(squareApi.listCustomAttributeDefinitions).toHaveBeenCalledWith({ merchantId: 1 });
        });
    });

    describe('POST /api/square/custom-attributes/init', () => {
        it('should initialize custom attribute definitions', async () => {
            const mockResult = { success: true, created: 2 };
            squareApi.initializeCustomAttributes.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/square/custom-attributes/init')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(squareApi.initializeCustomAttributes).toHaveBeenCalledWith({ merchantId: 1 });
        });
    });

    describe('POST /api/square/custom-attributes/definition', () => {
        it('should create a definition', async () => {
            const mockResult = { success: true, definition: { key: 'test_attr' } };
            squareApi.upsertCustomAttributeDefinition.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/square/custom-attributes/definition')
                .send({ key: 'test_attr', name: 'Test Attribute', type: 'STRING' })
                .expect(200);

            expect(res.body.success).toBe(true);
        });

        it('should reject definition without key', async () => {
            const res = await request(app)
                .post('/api/square/custom-attributes/definition')
                .send({ name: 'Test Attribute' })
                .expect(400);

            // Validator or route logic catches missing key
            expect(res.body.error).toBeDefined();
        });

        it('should reject definition without name', async () => {
            const res = await request(app)
                .post('/api/square/custom-attributes/definition')
                .send({ key: 'test_attr' })
                .expect(400);

            // Validator or route logic catches missing name
            expect(res.body.error).toBeDefined();
        });
    });

    describe('DELETE /api/square/custom-attributes/definition/:key', () => {
        it('should delete a definition', async () => {
            const mockResult = { success: true };
            squareApi.deleteCustomAttributeDefinition.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .delete('/api/square/custom-attributes/definition/case_pack_quantity')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(squareApi.deleteCustomAttributeDefinition).toHaveBeenCalledWith(
                'case_pack_quantity',
                { merchantId: 1 }
            );
        });
    });

    describe('PUT /api/square/custom-attributes/:objectId', () => {
        it('should update custom attribute values', async () => {
            const mockResult = { success: true };
            squareApi.updateCustomAttributeValues.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .put('/api/square/custom-attributes/OBJ_123')
                .send({ case_pack_quantity: 12, brand: 'Acme' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
                'OBJ_123',
                { case_pack_quantity: 12, brand: 'Acme' },
                { merchantId: 1 }
            );
        });

        it('should reject empty attribute values', async () => {
            const res = await request(app)
                .put('/api/square/custom-attributes/OBJ_123')
                .send({})
                .expect(400);

            // Validator or route logic catches empty body
            expect(res.body.error).toBeDefined();
        });
    });

    describe('POST /api/square/custom-attributes/push/case-pack', () => {
        it('should push case pack data to Square', async () => {
            const mockResult = { success: true, updated: 10 };
            squareApi.pushCasePackToSquare.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/square/custom-attributes/push/case-pack')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(squareApi.pushCasePackToSquare).toHaveBeenCalledWith({ merchantId: 1 });
        });

        it('should surface a warning when some variations failed to sync', async () => {
            squareApi.pushCasePackToSquare.mockResolvedValueOnce({
                success: false,
                updated: 1,
                failed: 1,
                failedVariations: [{ variationId: 'VAR-X', error: 'location mismatch' }]
            });

            const res = await request(app)
                .post('/api/square/custom-attributes/push/case-pack')
                .expect(200);

            expect(res.body.warning).toMatch(/failed to sync/i);
            expect(res.body.failedVariations).toEqual([
                { variationId: 'VAR-X', error: 'location mismatch' }
            ]);
        });
    });

    describe('POST /api/square/custom-attributes/push/brand', () => {
        it('should push brand data to Square', async () => {
            const mockResult = { success: true, updated: 5 };
            squareApi.pushBrandsToSquare.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/square/custom-attributes/push/brand')
                .expect(200);

            expect(res.body.success).toBe(true);
        });
    });

    describe('POST /api/square/custom-attributes/push/expiry', () => {
        it('should push expiry data to Square', async () => {
            const mockResult = { success: true, updated: 3 };
            squareApi.pushExpiryDatesToSquare.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/square/custom-attributes/push/expiry')
                .expect(200);

            expect(res.body.success).toBe(true);
        });
    });

    describe('POST /api/square/custom-attributes/push/all', () => {
        it('should push all custom attributes to Square', async () => {
            squareApi.pushCasePackToSquare.mockResolvedValueOnce({ updated: 10 });
            squareApi.pushBrandsToSquare.mockResolvedValueOnce({ updated: 5 });
            squareApi.pushExpiryDatesToSquare.mockResolvedValueOnce({ updated: 3 });

            const res = await request(app)
                .post('/api/square/custom-attributes/push/all')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.casePack).toEqual({ updated: 10 });
            expect(res.body.brand).toEqual({ updated: 5 });
            expect(res.body.expiry).toEqual({ updated: 3 });
            expect(res.body.errors).toEqual([]);
        });

        it('should report partial failures', async () => {
            squareApi.pushCasePackToSquare.mockResolvedValueOnce({ updated: 10 });
            squareApi.pushBrandsToSquare.mockRejectedValueOnce(new Error('Brand push failed'));
            squareApi.pushExpiryDatesToSquare.mockResolvedValueOnce({ updated: 3 });

            const res = await request(app)
                .post('/api/square/custom-attributes/push/all')
                .expect(200);

            expect(res.body.success).toBe(false);
            expect(res.body.errors).toHaveLength(1);
            expect(res.body.errors[0].type).toBe('brand');
            expect(res.body.casePack).toEqual({ updated: 10 });
            expect(res.body.brand).toBeNull();
        });

        it('should surface per-variation partial failures from sub-pushes', async () => {
            squareApi.pushCasePackToSquare.mockResolvedValueOnce({
                updated: 1,
                failedVariations: [{ variationId: 'VAR-A', error: 'location mismatch' }]
            });
            squareApi.pushBrandsToSquare.mockResolvedValueOnce({ updated: 5, failedVariations: [] });
            squareApi.pushExpiryDatesToSquare.mockResolvedValueOnce({
                updated: 0,
                failedVariations: [{ variationId: 'VAR-B', error: 'boom' }]
            });

            const res = await request(app)
                .post('/api/square/custom-attributes/push/all')
                .expect(200);

            expect(res.body.warning).toMatch(/partialFailures/i);
            expect(res.body.partialFailures).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'casePack', failedCount: 1 }),
                expect.objectContaining({ type: 'expiry', failedCount: 1 })
            ]));
        });
    });
});
