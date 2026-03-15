jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));

jest.mock('../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../services/ai-autofill-service', () => ({
    getItemsWithReadiness: jest.fn(),
    getItemsForGeneration: jest.fn(),
    validateReadiness: jest.fn(),
    generateContent: jest.fn(),
    generateContentBatched: jest.fn(),
    BATCH_SIZE: 5,
}));
jest.mock('../../services/square/api', () => ({
    batchUpdateCatalogContent: jest.fn(),
}));
jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn().mockReturnValue('encrypted'),
    decryptToken: jest.fn().mockReturnValue('sk-ant-test-key'),
}));
jest.mock('../../middleware/validators/ai-autofill', () => ({
    getStatus: [(req, res, next) => next()],
    generate: [(req, res, next) => next()],
    apply: [(req, res, next) => next()],
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const aiAutofillService = require('../../services/ai-autofill-service');
const squareApi = require('../../services/square/api');
const tokenEncryption = require('../../utils/token-encryption');

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
    const routes = require('../../routes/ai-autofill');
    app.use('/api/ai-autofill', routes);
    app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });
    return app;
}

describe('AI Autofill Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('Authentication and Merchant Guards', () => {
        test('returns 401 when not authenticated', async () => {
            const unauthApp = createTestApp({ authenticated: false });
            const res = await request(unauthApp).get('/api/ai-autofill/status');
            expect(res.status).toBe(401);
        });

        test('returns 400 when no merchant context', async () => {
            const noMerchantApp = createTestApp({ hasMerchant: false });
            const res = await request(noMerchantApp).get('/api/ai-autofill/status');
            expect(res.status).toBe(400);
        });
    });

    describe('POST /api/ai-autofill/api-key', () => {
        test('returns 400 when apiKey is missing', async () => {
            const res = await request(app)
                .post('/api/ai-autofill/api-key')
                .send({});
            expect(res.status).toBe(400);
        });

        test('returns 400 when apiKey does not start with sk-ant-', async () => {
            const res = await request(app)
                .post('/api/ai-autofill/api-key')
                .send({ apiKey: 'invalid-key' });
            expect(res.status).toBe(400);
        });

        test('encrypts and saves valid API key', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app)
                .post('/api/ai-autofill/api-key')
                .send({ apiKey: 'sk-ant-valid-key-123' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(tokenEncryption.encryptToken).toHaveBeenCalledWith('sk-ant-valid-key-123');
            expect(db.query).toHaveBeenCalled();
        });
    });

    describe('GET /api/ai-autofill/api-key/status', () => {
        test('returns hasKey true when key exists', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ has_key: true }],
            });
            const res = await request(app).get('/api/ai-autofill/api-key/status');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.hasKey).toBe(true);
        });

        test('returns hasKey false when no key exists', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app).get('/api/ai-autofill/api-key/status');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.hasKey).toBe(false);
        });

        test('returns hasKey false when key value is null', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ has_key: false }],
            });
            const res = await request(app).get('/api/ai-autofill/api-key/status');
            expect(res.status).toBe(200);
            expect(res.body.data.hasKey).toBe(false);
        });
    });

    describe('DELETE /api/ai-autofill/api-key', () => {
        test('deletes the API key successfully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app).delete('/api/ai-autofill/api-key');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(db.query).toHaveBeenCalled();
        });
    });

    describe('GET /api/ai-autofill/status', () => {
        test('returns items with readiness data', async () => {
            const mockData = {
                ready: [{ id: 1, name: 'Item A' }],
                notReady: [{ id: 2, name: 'Item B' }],
            };
            aiAutofillService.getItemsWithReadiness.mockResolvedValueOnce(mockData);
            const res = await request(app).get('/api/ai-autofill/status');
            expect(res.status).toBe(200);
            expect(aiAutofillService.getItemsWithReadiness).toHaveBeenCalledWith(1);
        });

        test('returns 401 when unauthenticated', async () => {
            const unauthApp = createTestApp({ authenticated: false });
            const res = await request(unauthApp).get('/api/ai-autofill/status');
            expect(res.status).toBe(401);
        });
    });

    describe('POST /api/ai-autofill/generate', () => {
        test('returns 400 when no API key configured', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app)
                .post('/api/ai-autofill/generate')
                .send({ itemIds: ['item1'] });
            expect(res.status).toBe(400);
        });

        test('returns 404 when no items found', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ claude_api_key_encrypted: 'encrypted-key' }],
            });
            aiAutofillService.getItemsForGeneration.mockResolvedValueOnce([]);
            const res = await request(app)
                .post('/api/ai-autofill/generate')
                .send({ itemIds: ['item1'] });
            expect(res.status).toBe(404);
        });

        test('returns 400 when items are not ready', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ claude_api_key_encrypted: 'encrypted-key' }],
            });
            const items = [{ id: 'item1', name: 'Test Item' }];
            aiAutofillService.getItemsForGeneration.mockResolvedValueOnce(items);
            aiAutofillService.validateReadiness.mockReturnValueOnce({
                valid: false,
                errors: ['Missing images'],
            });
            const res = await request(app)
                .post('/api/ai-autofill/generate')
                .send({ itemIds: ['item1'] });
            expect(res.status).toBe(400);
        });

        test('generates content successfully', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ claude_api_key_encrypted: 'encrypted-key' }],
            });
            const items = [{ id: 'item1', name: 'Test Item' }];
            aiAutofillService.getItemsForGeneration.mockResolvedValueOnce(items);
            aiAutofillService.validateReadiness.mockReturnValueOnce({ valid: true });
            aiAutofillService.generateContent.mockResolvedValueOnce(
                [{ itemId: 'item1', description: 'Generated desc', generated: true }]
            );
            const res = await request(app)
                .post('/api/ai-autofill/generate')
                .send({ itemIds: ['item1'] });
            expect(res.status).toBe(200);
            expect(tokenEncryption.decryptToken).toHaveBeenCalled();
        });
    });

    describe('POST /api/ai-autofill/apply', () => {
        test('applies updates successfully', async () => {
            const updates = [{ itemId: 'item1', description: 'New description' }];
            squareApi.batchUpdateCatalogContent.mockResolvedValueOnce({
                succeeded: [{ itemId: 'item1' }],
                failed: [],
            });
            const res = await request(app)
                .post('/api/ai-autofill/apply')
                .send({ updates });
            expect(res.status).toBe(200);
            expect(squareApi.batchUpdateCatalogContent).toHaveBeenCalledWith(1, updates);
        });

        test('returns 400 when no merchant context for apply', async () => {
            const noMerchantApp = createTestApp({ hasMerchant: false });
            const res = await request(noMerchantApp)
                .post('/api/ai-autofill/apply')
                .send({ updates: [] });
            expect(res.status).toBe(400);
        });
    });
});
