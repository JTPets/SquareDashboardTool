/**
 * Tests for the generateCategoryBatch and previewCategoryBatch validators
 * in middleware/validators/cycle-counts.js.
 *
 * Uses supertest to drive the validators through a minimal Express app so that
 * express-validator runs for real (no mocks), exercising the isIn(['category','vendor'])
 * guard and the required-field checks.
 */

const request = require('supertest');
const express = require('express');
const { generateCategoryBatch, previewCategoryBatch } = require('../../../middleware/validators/cycle-counts');

function makeApp() {
    const app = express();
    app.use(express.json());

    app.post('/test-generate', generateCategoryBatch, (req, res) => res.json({ ok: true }));
    app.get('/test-preview', previewCategoryBatch, (req, res) => res.json({ ok: true }));

    // express-validator errors surface as 400 from handleValidationErrors
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
    return app;
}

const app = makeApp();

describe('generateCategoryBatch validator', () => {
    it('accepts valid category type', async () => {
        const res = await request(app).post('/test-generate').send({ type: 'category', id: 'Dogs' });
        expect(res.status).toBe(200);
    });

    it('accepts valid vendor type', async () => {
        const res = await request(app).post('/test-generate').send({ type: 'vendor', id: 'vendor-abc' });
        expect(res.status).toBe(200);
    });

    it('rejects invalid type with 400', async () => {
        const res = await request(app).post('/test-generate').send({ type: 'invalid', id: 'Dogs' });
        expect(res.status).toBe(400);
    });

    it('rejects missing type with 400', async () => {
        const res = await request(app).post('/test-generate').send({ id: 'Dogs' });
        expect(res.status).toBe(400);
    });

    it('rejects missing id with 400', async () => {
        const res = await request(app).post('/test-generate').send({ type: 'category' });
        expect(res.status).toBe(400);
    });

    it('rejects empty id with 400', async () => {
        const res = await request(app).post('/test-generate').send({ type: 'category', id: '' });
        expect(res.status).toBe(400);
    });

    it('rejects added_by over 100 chars with 400', async () => {
        const res = await request(app)
            .post('/test-generate')
            .send({ type: 'category', id: 'Dogs', added_by: 'x'.repeat(101) });
        expect(res.status).toBe(400);
    });
});

describe('previewCategoryBatch validator', () => {
    it('accepts valid category query', async () => {
        const res = await request(app).get('/test-preview?type=category&id=Dogs');
        expect(res.status).toBe(200);
    });

    it('accepts valid vendor query', async () => {
        const res = await request(app).get('/test-preview?type=vendor&id=vendor-abc');
        expect(res.status).toBe(200);
    });

    it('rejects invalid type with 400', async () => {
        const res = await request(app).get('/test-preview?type=bad&id=Dogs');
        expect(res.status).toBe(400);
    });

    it('rejects missing type with 400', async () => {
        const res = await request(app).get('/test-preview?id=Dogs');
        expect(res.status).toBe(400);
    });

    it('rejects missing id with 400', async () => {
        const res = await request(app).get('/test-preview?type=category');
        expect(res.status).toBe(400);
    });
});
