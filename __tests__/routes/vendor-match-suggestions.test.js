/**
 * Tests for routes/vendor-match-suggestions.js — BACKLOG-114
 *
 * Covers:
 * - GET  /api/vendor-match-suggestions/count  — returns pending badge count
 * - GET  /api/vendor-match-suggestions        — list with pagination
 * - POST /api/vendor-match-suggestions/:id/approve  — approve one
 * - POST /api/vendor-match-suggestions/:id/reject   — reject one
 * - POST /api/vendor-match-suggestions/bulk-approve — approve many
 * - POST /api/vendor-match-suggestions/backfill     — trigger backfill scan
 * - Auth and merchant middleware rejections
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

const mockMatchSvc = {
    getPendingCount: jest.fn(),
    listSuggestions: jest.fn(),
    approveSuggestion: jest.fn(),
    rejectSuggestion: jest.fn(),
    bulkApprove: jest.fn(),
    runBackfillScan: jest.fn(),
};
jest.mock('../../services/vendor/match-suggestions-service', () => mockMatchSvc);

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
// TEST APP
// ============================================================================

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true, merchantId = 1, userId = 42 } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) {
            req.session.user = { id: userId, email: 'owner@test.com', role: 'admin' };
            req.user = { id: userId };
        }
        if (hasMerchant) {
            req.merchantContext = { id: merchantId, businessName: 'JTPets' };
        }
        next();
    });

    const routes = require('../../routes/vendor-match-suggestions');
    app.use('/api/vendor-match-suggestions', routes);

    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Vendor Match Suggestions Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    // -------------------------------------------------------------------------
    // Auth / merchant guards
    // -------------------------------------------------------------------------

    describe('Auth and merchant middleware', () => {
        it('returns 401 for unauthenticated GET /count', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/vendor-match-suggestions/count');
            expect(res.status).toBe(401);
        });

        it('returns 400 for missing merchant on GET /', async () => {
            app = createTestApp({ hasMerchant: false });
            const res = await request(app).get('/api/vendor-match-suggestions/');
            expect(res.status).toBe(400);
        });

        it('returns 401 for unauthenticated POST /backfill', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app).post('/api/vendor-match-suggestions/backfill');
            expect(res.status).toBe(401);
        });
    });

    // -------------------------------------------------------------------------
    // GET /count
    // -------------------------------------------------------------------------

    describe('GET /count', () => {
        it('returns pending count', async () => {
            mockMatchSvc.getPendingCount.mockResolvedValueOnce(3);

            const res = await request(app).get('/api/vendor-match-suggestions/count');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(3);
            expect(mockMatchSvc.getPendingCount).toHaveBeenCalledWith(1);
        });

        it('returns 0 when no pending suggestions', async () => {
            mockMatchSvc.getPendingCount.mockResolvedValueOnce(0);

            const res = await request(app).get('/api/vendor-match-suggestions/count');

            expect(res.status).toBe(200);
            expect(res.body.count).toBe(0);
        });
    });

    // -------------------------------------------------------------------------
    // GET /
    // -------------------------------------------------------------------------

    describe('GET /', () => {
        it('returns paginated suggestions (defaults to pending)', async () => {
            mockMatchSvc.listSuggestions.mockResolvedValueOnce({
                suggestions: [
                    { id: 1, upc: '123', status: 'pending',
                      source_vendor_name: 'Acme', suggested_vendor_name: 'Bobs' },
                ],
                total: 1,
            });

            const res = await request(app).get('/api/vendor-match-suggestions/');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.items).toHaveLength(1);
            expect(res.body.total).toBe(1);
            expect(mockMatchSvc.listSuggestions).toHaveBeenCalledWith(
                1,
                expect.objectContaining({ status: 'pending' })
            );
        });

        it('accepts status filter', async () => {
            mockMatchSvc.listSuggestions.mockResolvedValueOnce({ suggestions: [], total: 0 });

            const res = await request(app)
                .get('/api/vendor-match-suggestions/?status=approved');

            expect(res.status).toBe(200);
            expect(mockMatchSvc.listSuggestions).toHaveBeenCalledWith(
                1,
                expect.objectContaining({ status: 'approved' })
            );
        });

        it('rejects invalid status with 400', async () => {
            const res = await request(app)
                .get('/api/vendor-match-suggestions/?status=bogus');
            expect(res.status).toBe(400);
        });
    });

    // -------------------------------------------------------------------------
    // POST /:id/approve
    // -------------------------------------------------------------------------

    describe('POST /:id/approve', () => {
        it('approves the suggestion and returns result', async () => {
            mockMatchSvc.approveSuggestion.mockResolvedValueOnce({
                approved: true,
                suggestionId: 7,
                variationId: 'VAR1',
                suggestedVendorId: 'V2',
                squarePushError: null,
            });

            const res = await request(app)
                .post('/api/vendor-match-suggestions/7/approve');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.approved).toBe(true);
            expect(mockMatchSvc.approveSuggestion).toHaveBeenCalledWith(7, 42, 1);
        });

        it('returns 404 when suggestion not found', async () => {
            const err = Object.assign(new Error('Suggestion not found'), { statusCode: 404 });
            mockMatchSvc.approveSuggestion.mockRejectedValueOnce(err);

            const res = await request(app)
                .post('/api/vendor-match-suggestions/999/approve');

            expect(res.status).toBe(404);
        });

        it('returns 409 when suggestion already approved', async () => {
            const err = Object.assign(new Error('Suggestion is already approved'), { statusCode: 409 });
            mockMatchSvc.approveSuggestion.mockRejectedValueOnce(err);

            const res = await request(app)
                .post('/api/vendor-match-suggestions/5/approve');

            expect(res.status).toBe(409);
        });

        it('rejects non-integer id with 400', async () => {
            const res = await request(app)
                .post('/api/vendor-match-suggestions/abc/approve');
            expect(res.status).toBe(400);
        });
    });

    // -------------------------------------------------------------------------
    // POST /:id/reject
    // -------------------------------------------------------------------------

    describe('POST /:id/reject', () => {
        it('rejects the suggestion', async () => {
            mockMatchSvc.rejectSuggestion.mockResolvedValueOnce({
                rejected: true,
                suggestionId: 3,
            });

            const res = await request(app)
                .post('/api/vendor-match-suggestions/3/reject');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.rejected).toBe(true);
            expect(mockMatchSvc.rejectSuggestion).toHaveBeenCalledWith(3, 42, 1);
        });

        it('returns 404 when suggestion not found', async () => {
            const err = Object.assign(new Error('Suggestion not found'), { statusCode: 404 });
            mockMatchSvc.rejectSuggestion.mockRejectedValueOnce(err);

            const res = await request(app)
                .post('/api/vendor-match-suggestions/999/reject');

            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // POST /bulk-approve
    // -------------------------------------------------------------------------

    describe('POST /bulk-approve', () => {
        it('bulk approves and returns counts', async () => {
            mockMatchSvc.bulkApprove.mockResolvedValueOnce({
                approved: 2, failed: 0, errors: [],
            });

            const res = await request(app)
                .post('/api/vendor-match-suggestions/bulk-approve')
                .send({ ids: [1, 2] });

            expect(res.status).toBe(200);
            expect(res.body.approved).toBe(2);
            expect(res.body.failed).toBe(0);
            expect(mockMatchSvc.bulkApprove).toHaveBeenCalledWith([1, 2], 42, 1);
        });

        it('rejects empty ids array with 400', async () => {
            const res = await request(app)
                .post('/api/vendor-match-suggestions/bulk-approve')
                .send({ ids: [] });
            expect(res.status).toBe(400);
        });

        it('rejects missing ids with 400', async () => {
            const res = await request(app)
                .post('/api/vendor-match-suggestions/bulk-approve')
                .send({});
            expect(res.status).toBe(400);
        });

        it('rejects non-integer ids with 400', async () => {
            const res = await request(app)
                .post('/api/vendor-match-suggestions/bulk-approve')
                .send({ ids: ['abc', 1] });
            expect(res.status).toBe(400);
        });
    });

    // -------------------------------------------------------------------------
    // POST /backfill
    // -------------------------------------------------------------------------

    describe('POST /backfill', () => {
        it('triggers backfill scan and returns result', async () => {
            mockMatchSvc.runBackfillScan.mockResolvedValueOnce({
                scanned: 12,
                suggestionsCreated: 3,
            });

            const res = await request(app)
                .post('/api/vendor-match-suggestions/backfill');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.scanned).toBe(12);
            expect(res.body.suggestionsCreated).toBe(3);
            expect(mockMatchSvc.runBackfillScan).toHaveBeenCalledWith(1);
        });

        it('returns 401 for unauthenticated request', async () => {
            app = createTestApp({ authenticated: false });
            const res = await request(app)
                .post('/api/vendor-match-suggestions/backfill');
            expect(res.status).toBe(401);
        });
    });
});
