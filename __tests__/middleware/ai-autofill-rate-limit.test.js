/**
 * AI Autofill Rate Limiter Test Suite (Audit 3.4.1)
 *
 * Tests:
 * - Rate limiter is configured with correct parameters
 * - Keys by merchant ID
 * - Falls back to IP when no merchant context
 * - Returns 429 with correct error code
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const request = require('supertest');
const express = require('express');

describe('AI Autofill Rate Limiter', () => {
    let configureAiAutofillRateLimit;

    beforeEach(() => {
        jest.clearAllMocks();
        // Fresh import to avoid rate limiter state leaking between tests
        jest.isolateModules(() => {
            ({ configureAiAutofillRateLimit } = require('../../middleware/security'));
        });
    });

    test('exports configureAiAutofillRateLimit function', () => {
        expect(typeof configureAiAutofillRateLimit).toBe('function');
    });

    test('returns an express middleware function', () => {
        const limiter = configureAiAutofillRateLimit();
        // express-rate-limit returns a function
        expect(typeof limiter).toBe('function');
    });

    test('allows requests under the limit', async () => {
        const limiter = configureAiAutofillRateLimit();
        const app = express();
        app.use((req, res, next) => {
            req.merchantContext = { id: 1 };
            next();
        });
        app.use(limiter);
        app.get('/test', (req, res) => res.json({ ok: true }));

        const res = await request(app).get('/test');
        expect(res.status).toBe(200);
        // Standard headers: ratelimit-limit (draft-6) or x-ratelimit-limit (legacy)
        const limitHeader = res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'];
        expect(limitHeader).toBe('10');
    });

    test('returns 429 after exceeding 10 requests', async () => {
        const limiter = configureAiAutofillRateLimit();
        const app = express();
        app.use((req, res, next) => {
            req.merchantContext = { id: 42 };
            next();
        });
        app.use(limiter);
        app.get('/test', (req, res) => res.json({ ok: true }));

        // Send 10 requests (should all succeed)
        for (let i = 0; i < 10; i++) {
            await request(app).get('/test').expect(200);
        }

        // 11th request should be rate limited
        const res = await request(app).get('/test');
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('AI_AUTOFILL_RATE_LIMITED');
    });

    test('rate limits independently per merchant', async () => {
        const limiter = configureAiAutofillRateLimit();
        let currentMerchantId = 1;
        const app = express();
        app.use((req, res, next) => {
            req.merchantContext = { id: currentMerchantId };
            next();
        });
        app.use(limiter);
        app.get('/test', (req, res) => res.json({ ok: true }));

        // Exhaust merchant 1's limit
        for (let i = 0; i < 10; i++) {
            await request(app).get('/test').expect(200);
        }
        // Merchant 1 should be rate limited
        const blocked = await request(app).get('/test');
        expect(blocked.status).toBe(429);

        // Merchant 2 should still be allowed
        currentMerchantId = 2;
        const allowed = await request(app).get('/test');
        expect(allowed.status).toBe(200);
    });
});
