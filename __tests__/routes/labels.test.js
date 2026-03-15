/**
 * Label Printing Routes Test Suite
 *
 * Tests for ZPL label generation and template management.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/label/zpl-generator', () => ({
    generateLabels: jest.fn(),
    generateLabelsWithPrices: jest.fn(),
    getTemplates: jest.fn(),
    setDefaultTemplate: jest.fn(),
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
const zplGenerator = require('../../services/label/zpl-generator');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/labels'));
    return app;
}

describe('Label Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('POST /api/labels/generate', () => {
        it('should generate ZPL labels for variations', async () => {
            const mockResult = {
                zpl: '^XA^FO...^XZ',
                labelCount: 2,
                totalLabels: 2,
                template: { id: 1, name: 'Standard' },
                missingVariations: [],
            };
            zplGenerator.generateLabels.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/labels/generate')
                .send({ variationIds: ['var_1', 'var_2'] })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.zpl).toBe('^XA^FO...^XZ');
            expect(res.body.labelCount).toBe(2);
            expect(zplGenerator.generateLabels).toHaveBeenCalledWith(1, ['var_1', 'var_2'], {
                templateId: null,
                copies: 1,
            });
        });

        it('should pass template and copies options', async () => {
            zplGenerator.generateLabels.mockResolvedValueOnce({
                zpl: '^XA^XZ', labelCount: 1, totalLabels: 3,
                template: { id: 5, name: 'Large' }, missingVariations: [],
            });

            await request(app)
                .post('/api/labels/generate')
                .send({ variationIds: ['var_1'], templateId: 5, copies: 3 })
                .expect(200);

            expect(zplGenerator.generateLabels).toHaveBeenCalledWith(1, ['var_1'], {
                templateId: 5,
                copies: 3,
            });
        });
    });

    describe('POST /api/labels/generate-with-prices', () => {
        it('should generate ZPL with override prices', async () => {
            const priceChanges = [
                { variationId: 'var_1', newPriceCents: 1299 },
            ];
            const mockResult = {
                zpl: '^XA^XZ', labelCount: 1, totalLabels: 1,
                template: { id: 1, name: 'Standard' }, missingVariations: [],
            };
            zplGenerator.generateLabelsWithPrices.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/labels/generate-with-prices')
                .send({ priceChanges })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(zplGenerator.generateLabelsWithPrices).toHaveBeenCalledWith(1, priceChanges, {
                templateId: null,
                copies: 1,
            });
        });
    });

    describe('GET /api/labels/templates', () => {
        it('should list label templates', async () => {
            const mockTemplates = [
                { id: 1, name: 'Standard', is_default: true },
                { id: 2, name: 'Large', is_default: false },
            ];
            zplGenerator.getTemplates.mockResolvedValueOnce(mockTemplates);

            const res = await request(app)
                .get('/api/labels/templates')
                .expect(200);

            expect(res.body.count).toBe(2);
            expect(res.body.templates).toEqual(mockTemplates);
        });
    });

    describe('PUT /api/labels/templates/:id/default', () => {
        it('should set template as default', async () => {
            zplGenerator.setDefaultTemplate.mockResolvedValueOnce({ id: 2, name: 'Large' });

            const res = await request(app)
                .put('/api/labels/templates/2/default')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('Large');
            expect(zplGenerator.setDefaultTemplate).toHaveBeenCalledWith(1, 2);
        });

        it('should return 404 for non-existent template', async () => {
            zplGenerator.setDefaultTemplate.mockResolvedValueOnce(null);

            const res = await request(app)
                .put('/api/labels/templates/999/default')
                .expect(404);

            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('Template not found');
        });
    });
});
