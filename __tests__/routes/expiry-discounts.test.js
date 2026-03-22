jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));

jest.mock('../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../services/expiry', () => ({
    getDiscountStatusSummary: jest.fn(),
    ensureMerchantTiers: jest.fn(),
    evaluateAllVariations: jest.fn(),
    applyDiscounts: jest.fn(),
    runExpiryDiscountAutomation: jest.fn(),
    getSetting: jest.fn(),
    initializeSquareDiscounts: jest.fn(),
    getAuditLog: jest.fn(),
    updateSetting: jest.fn(),
    validateExpiryDiscounts: jest.fn(),
    getFlaggedVariations: jest.fn(),
    resolveFlaggedVariation: jest.fn(),
}));
jest.mock('../../utils/email-notifier', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../../middleware/validators/expiry-discounts', () => ({
    updateTier: [(req, res, next) => next()],
    getVariations: [(req, res, next) => next()],
    evaluate: [(req, res, next) => next()],
    apply: [(req, res, next) => next()],
    run: [(req, res, next) => next()],
    getAuditLog: [(req, res, next) => next()],
    updateSettings: [(req, res, next) => next()],
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const db = require('../../utils/database');
const expiryService = require('../../services/expiry');
const imageUtils = require('../../utils/image-utils');

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
    const routes = require('../../routes/expiry-discounts');
    app.use('/api', routes);
    app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });
    return app;
}

describe('Expiry Discounts Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('Authentication and Merchant Guards', () => {
        test('returns 401 when not authenticated', async () => {
            const unauthApp = createTestApp({ authenticated: false });
            const res = await request(unauthApp).get('/api/expiry-discounts/status');
            expect(res.status).toBe(401);
        });

        test('returns 400 when no merchant context', async () => {
            const noMerchantApp = createTestApp({ hasMerchant: false });
            const res = await request(noMerchantApp).get('/api/expiry-discounts/status');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/expiry-discounts/status', () => {
        test('returns discount status summary', async () => {
            const mockSummary = { totalItems: 10, discountedItems: 3, totalSavings: 150 };
            expiryService.getDiscountStatusSummary.mockResolvedValueOnce(mockSummary);
            const res = await request(app).get('/api/expiry-discounts/status');
            expect(res.status).toBe(200);
            expect(expiryService.getDiscountStatusSummary).toHaveBeenCalledWith(1);
        });

        test('handles service error', async () => {
            expiryService.getDiscountStatusSummary.mockRejectedValueOnce(new Error('DB error'));
            const res = await request(app).get('/api/expiry-discounts/status');
            expect(res.status).toBe(500);
        });
    });

    describe('GET /api/expiry-discounts/tiers', () => {
        test('returns tiers after ensuring they exist', async () => {
            expiryService.ensureMerchantTiers.mockResolvedValueOnce();
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, name: 'Tier 1', min_days: 0, max_days: 30, discount_percent: 25 },
                    { id: 2, name: 'Tier 2', min_days: 31, max_days: 60, discount_percent: 50 },
                ],
            });
            const res = await request(app).get('/api/expiry-discounts/tiers');
            expect(res.status).toBe(200);
            expect(expiryService.ensureMerchantTiers).toHaveBeenCalledWith(1);
            expect(db.query).toHaveBeenCalled();
        });
    });

    describe('PATCH /api/expiry-discounts/tiers/:id', () => {
        test('updates tier successfully', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, name: 'Updated Tier', discount_percent: 30 }],
            });
            const res = await request(app)
                .patch('/api/expiry-discounts/tiers/1')
                .send({ discount_percent: 30 });
            expect(res.status).toBe(200);
        });

        test('returns 404 when tier not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app)
                .patch('/api/expiry-discounts/tiers/999')
                .send({ discount_percent: 30 });
            expect(res.status).toBe(404);
        });

        test('returns 400 when no valid fields provided', async () => {
            const res = await request(app)
                .patch('/api/expiry-discounts/tiers/1')
                .send({ invalidField: 'value' });
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/expiry-discounts/variations', () => {
        test('returns variations with resolved images', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { variation_id: 'var1', variation_name: 'Expiring Item', days_until_expiry: 15, images: null, item_images: null },
                ],
            });
            db.query.mockResolvedValueOnce({
                rows: [{ total: '1' }],
            });
            imageUtils.batchResolveImageUrls.mockResolvedValueOnce(
                new Map([[0, ['https://example.com/img1.jpg']]])
            );
            const res = await request(app).get('/api/expiry-discounts/variations');
            expect(res.status).toBe(200);
            expect(res.body.variations).toHaveLength(1);
            expect(res.body.total).toBe(1);
        });

        test('returns empty array when no variations', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
            const res = await request(app).get('/api/expiry-discounts/variations');
            expect(res.status).toBe(200);
            expect(res.body.variations).toHaveLength(0);
        });
    });

    describe('POST /api/expiry-discounts/evaluate', () => {
        test('evaluates all variations successfully', async () => {
            const mockResult = { evaluated: 10, needsDiscount: 3 };
            expiryService.evaluateAllVariations.mockResolvedValueOnce(mockResult);
            const res = await request(app).post('/api/expiry-discounts/evaluate');
            expect(res.status).toBe(200);
            expect(expiryService.evaluateAllVariations).toHaveBeenCalledWith({ dryRun: false, triggeredBy: 'MANUAL', merchantId: 1 });
        });

        test('handles evaluation error', async () => {
            expiryService.evaluateAllVariations.mockRejectedValueOnce(new Error('Evaluation failed'));
            const res = await request(app).post('/api/expiry-discounts/evaluate');
            expect(res.status).toBe(500);
        });
    });

    describe('POST /api/expiry-discounts/apply', () => {
        test('applies discounts successfully', async () => {
            const mockResult = { applied: 5, skipped: 2 };
            expiryService.applyDiscounts.mockResolvedValueOnce(mockResult);
            const res = await request(app).post('/api/expiry-discounts/apply');
            expect(res.status).toBe(200);
            expect(expiryService.applyDiscounts).toHaveBeenCalledWith({ dryRun: false, merchantId: 1 });
        });
    });

    describe('POST /api/expiry-discounts/run', () => {
        test('runs automation successfully without email', async () => {
            const mockResult = { evaluated: 10, applied: 3, removed: 1 };
            expiryService.runExpiryDiscountAutomation.mockResolvedValueOnce(mockResult);
            const res = await request(app)
                .post('/api/expiry-discounts/run')
                .send({});
            expect(res.status).toBe(200);
            expect(expiryService.runExpiryDiscountAutomation).toHaveBeenCalledWith({ dryRun: false, merchantId: 1 });
        });

        test('runs automation with email notification', async () => {
            const mockResult = { evaluated: 10, applied: 3, removed: 1 };
            expiryService.runExpiryDiscountAutomation.mockResolvedValueOnce(mockResult);
            const res = await request(app)
                .post('/api/expiry-discounts/run')
                .send({ sendEmail: true });
            expect(res.status).toBe(200);
        });

        test('handles automation error', async () => {
            expiryService.runExpiryDiscountAutomation.mockRejectedValueOnce(new Error('Automation failed'));
            const res = await request(app).post('/api/expiry-discounts/run');
            expect(res.status).toBe(500);
        });
    });

    describe('POST /api/expiry-discounts/init-square', () => {
        test('initializes Square discounts', async () => {
            expiryService.initializeSquareDiscounts.mockResolvedValueOnce({ created: 2, errors: [] });
            const res = await request(app).post('/api/expiry-discounts/init-square');
            expect(res.status).toBe(200);
            expect(expiryService.initializeSquareDiscounts).toHaveBeenCalledWith(1);
        });
    });

    describe('GET /api/expiry-discounts/audit-log', () => {
        test('returns audit log entries', async () => {
            const mockLog = [
                { id: 1, action: 'DISCOUNT_APPLIED', created_at: '2026-03-01' },
                { id: 2, action: 'DISCOUNT_REMOVED', created_at: '2026-03-02' },
            ];
            expiryService.getAuditLog.mockResolvedValueOnce(mockLog);
            const res = await request(app).get('/api/expiry-discounts/audit-log');
            expect(res.status).toBe(200);
            expect(expiryService.getAuditLog).toHaveBeenCalled();
        });
    });

    describe('GET /api/expiry-discounts/settings', () => {
        test('returns settings from database', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { setting_key: 'auto_run', setting_value: 'true' },
                    { setting_key: 'email_notifications', setting_value: 'false' },
                ],
            });
            const res = await request(app).get('/api/expiry-discounts/settings');
            expect(res.status).toBe(200);
        });
    });

    describe('PATCH /api/expiry-discounts/settings', () => {
        test('updates settings successfully', async () => {
            expiryService.updateSetting.mockResolvedValue();
            const res = await request(app)
                .patch('/api/expiry-discounts/settings')
                .send({ auto_run: true, email_notifications: false });
            expect(res.status).toBe(200);
            expect(expiryService.updateSetting).toHaveBeenCalled();
        });

        test('handles empty settings update', async () => {
            const res = await request(app)
                .patch('/api/expiry-discounts/settings')
                .send({});
            expect(res.status).toBe(200);
        });
    });

    describe('GET /api/expiry-discounts/validate', () => {
        test('validates without fixing', async () => {
            const mockResult = { valid: true, issues: [] };
            expiryService.validateExpiryDiscounts.mockResolvedValueOnce(mockResult);
            const res = await request(app).get('/api/expiry-discounts/validate');
            expect(res.status).toBe(200);
            expect(expiryService.validateExpiryDiscounts).toHaveBeenCalledWith({ merchantId: 1, fix: false });
        });
    });

    describe('POST /api/expiry-discounts/validate-and-fix', () => {
        test('validates and fixes issues', async () => {
            const mockResult = { valid: false, issues: ['stale discount'], fixed: 1 };
            expiryService.validateExpiryDiscounts.mockResolvedValueOnce(mockResult);
            const res = await request(app).post('/api/expiry-discounts/validate-and-fix');
            expect(res.status).toBe(200);
            expect(expiryService.validateExpiryDiscounts).toHaveBeenCalledWith({ merchantId: 1, fix: true });
        });

        test('requires authentication for validate-and-fix', async () => {
            const unauthApp = createTestApp({ authenticated: false });
            const res = await request(unauthApp).post('/api/expiry-discounts/validate-and-fix');
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/expiry-discounts/flagged', () => {
        test('returns flagged variations', async () => {
            const mockFlagged = [
                { id: 1, variation_id: 'var1', reason: 'price_mismatch' },
            ];
            expiryService.getFlaggedVariations.mockResolvedValueOnce(mockFlagged);
            const res = await request(app).get('/api/expiry-discounts/flagged');
            expect(res.status).toBe(200);
            expect(expiryService.getFlaggedVariations).toHaveBeenCalledWith(1);
        });

        test('returns empty array when no flagged variations', async () => {
            expiryService.getFlaggedVariations.mockResolvedValueOnce([]);
            const res = await request(app).get('/api/expiry-discounts/flagged');
            expect(res.status).toBe(200);
        });
    });

    describe('PATCH /api/expiry-discounts/variations/:variationId/quantity (BACKLOG-94)', () => {
        test('sets expiring_quantity for a variation', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ variation_id: 'VAR-1', expiring_quantity: 12, units_sold_at_discount: 0 }],
            });
            const res = await request(app)
                .patch('/api/expiry-discounts/variations/VAR-1/quantity')
                .send({ expiring_quantity: 12 });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.expiring_quantity).toBe(12);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('expiring_quantity'),
                [12, 'VAR-1', 1]
            );
        });

        test('clears expiring_quantity with null (unlimited)', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ variation_id: 'VAR-1', expiring_quantity: null, units_sold_at_discount: 0 }],
            });
            const res = await request(app)
                .patch('/api/expiry-discounts/variations/VAR-1/quantity')
                .send({ expiring_quantity: null });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.expiring_quantity).toBeNull();
        });

        test('returns 400 for invalid quantity', async () => {
            const res = await request(app)
                .patch('/api/expiry-discounts/variations/VAR-1/quantity')
                .send({ expiring_quantity: -5 });
            expect(res.status).toBe(400);
        });

        test('returns 404 when variation not found', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            const res = await request(app)
                .patch('/api/expiry-discounts/variations/VAR-NOPE/quantity')
                .send({ expiring_quantity: 10 });
            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/expiry-discounts/flagged/resolve', () => {
        test('resolves a flagged variation successfully', async () => {
            expiryService.resolveFlaggedVariation.mockResolvedValueOnce({ success: true, resolved: true });
            const res = await request(app)
                .post('/api/expiry-discounts/flagged/resolve')
                .send({ variation_id: 'var1', action: 'apply_new', note: 'Checked and OK' });
            expect(res.status).toBe(200);
            expect(expiryService.resolveFlaggedVariation).toHaveBeenCalledWith({
                merchantId: 1,
                variationId: 'var1',
                action: 'apply_new',
                note: 'Checked and OK'
            });
        });

        test('returns 400 when variation_id is missing', async () => {
            const res = await request(app)
                .post('/api/expiry-discounts/flagged/resolve')
                .send({ action: 'dismiss' });
            expect(res.status).toBe(400);
        });

        test('returns 400 when action is missing', async () => {
            const res = await request(app)
                .post('/api/expiry-discounts/flagged/resolve')
                .send({ variation_id: 'var1' });
            expect(res.status).toBe(400);
        });

        test('returns 400 when note is missing', async () => {
            const res = await request(app)
                .post('/api/expiry-discounts/flagged/resolve')
                .send({ variation_id: 'var1', action: 'dismiss' });
            expect(res.status).toBe(400);
        });
    });
});
