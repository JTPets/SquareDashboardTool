/**
 * Security Audit — requireWriteAccess Negative-Path Tests
 *
 * Verifies that every write endpoint added during the auth-middleware security
 * audit returns 403 for a readonly user.  Routes covered:
 *
 *   purchase-orders.js          (5 write endpoints)
 *   cycle-counts.js             (7 write endpoints)
 *   expiry-discounts.js         (5 write endpoints)
 *   sync.js                     (3 write endpoints)
 *   bundles.js                  (3 write endpoints)
 *   vendor-match-suggestions.js (4 write endpoints)
 *   labels.js                   (3 write endpoints)
 *   ai-autofill.js              (3 write endpoints)
 *   settings.js                 (1 write endpoint)
 *   vendor-catalog/vendors.js   (1 write endpoint)
 *
 * Pattern follows catalog-write-access.test.js and delivery-write-access.test.js.
 */

// ─── Common mocks ────────────────────────────────────────────────────────────

jest.mock('../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        next();
    },
    requireAdmin: (req, res, next) => {
        if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
        next();
    },
    requireWriteAccess: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        if (req.session.user.role === 'readonly') {
            return res.status(403).json({ error: 'Write access required. Your account is read-only.', code: 'FORBIDDEN' });
        }
        next();
    },
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' });
        next();
    },
}));

// Pass-through validator factory
const passThrough = (_req, _res, next) => next();
const passThroughProxy = () => new Proxy({}, { get: () => [passThrough] });

jest.mock('../../middleware/validators/purchase-orders', passThroughProxy);
jest.mock('../../middleware/validators/cycle-counts', passThroughProxy);
jest.mock('../../middleware/validators/expiry-discounts', passThroughProxy);
jest.mock('../../middleware/validators/sync', passThroughProxy);
jest.mock('../../middleware/validators/bundles', passThroughProxy);
jest.mock('../../middleware/validators/vendor-match-suggestions', passThroughProxy);
jest.mock('../../middleware/validators/labels', passThroughProxy);
jest.mock('../../middleware/validators/ai-autofill', passThroughProxy);
jest.mock('../../middleware/validators/settings', passThroughProxy);
jest.mock('../../middleware/validators/vendor-catalog', passThroughProxy);

// ─── Service mocks ────────────────────────────────────────────────────────────

jest.mock('../../services/purchase-orders/po-service', () => ({
    listPurchaseOrders: jest.fn(), getPurchaseOrder: jest.fn(), createPurchaseOrder: jest.fn(),
    updatePurchaseOrder: jest.fn(), deletePurchaseOrder: jest.fn(), submitPurchaseOrder: jest.fn(),
}));
jest.mock('../../services/purchase-orders/po-receive-service', () => ({
    receivePurchaseOrder: jest.fn(),
}));
jest.mock('../../services/purchase-orders/po-export-service', () => ({
    exportPurchaseOrder: jest.fn(),
}));

jest.mock('../../services/square', () => ({
    fullSync: jest.fn(), syncSalesVelocityAllPeriods: jest.fn(),
}));
jest.mock('../../services/square/sync-orchestrator', () => ({
    runSmartSync: jest.fn(), isSyncNeeded: jest.fn(), getSyncHistory: jest.fn(),
    getSyncStatus: jest.fn(), loggedSync: jest.fn(),
}));
jest.mock('../../services/gmc/feed-service', () => ({
    generateFeed: jest.fn().mockResolvedValue({ stats: { total: 0 }, feedUrl: '/feed' }),
}));

jest.mock('../../services/inventory', () => ({
    generateDailyBatch: jest.fn(), sendCycleCountReport: jest.fn(),
}));
jest.mock('../../services/catalog/location-service', () => ({
    getFirstActiveLocation: jest.fn(),
}));
jest.mock('../../utils/image-utils', () => ({
    batchResolveImageUrls: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../services/expiry', () => ({
    getStatus: jest.fn(), getTiers: jest.fn(), updateTier: jest.fn(),
    getVariations: jest.fn(), evaluate: jest.fn(), apply: jest.fn(),
    run: jest.fn(), initSquare: jest.fn(), getAuditLog: jest.fn(), getSettings: jest.fn(),
    updateSettings: jest.fn(),
}));
jest.mock('../../utils/email-notifier', () => ({
    sendEmail: jest.fn(),
}));

jest.mock('../../services/bundles/bundle-service', () => ({
    listBundles: jest.fn(), createBundle: jest.fn(), updateBundle: jest.fn(),
    deleteBundle: jest.fn(), getBundleAvailability: jest.fn(),
}));

jest.mock('../../services/vendor/match-suggestions-service', () => ({
    listSuggestions: jest.fn(), getPendingCount: jest.fn(), approveSuggestion: jest.fn(),
    rejectSuggestion: jest.fn(), bulkApprove: jest.fn(), backfill: jest.fn(),
}));

jest.mock('../../services/label/zpl-generator', () => ({
    generateLabels: jest.fn(), generateLabelsWithPrices: jest.fn(),
    listTemplates: jest.fn(), setDefaultTemplate: jest.fn(),
}));

jest.mock('../../services/ai-autofill/ai-autofill-service', () => ({
    getItemsWithReadiness: jest.fn(), getItemsForGeneration: jest.fn(),
    validateReadiness: jest.fn(), generateContent: jest.fn(),
    generateContentBatched: jest.fn(), BATCH_SIZE: 5,
}));
jest.mock('../../services/square/api', () => ({
    batchUpdateCatalogContent: jest.fn(),
}));
jest.mock('../../utils/token-encryption', () => ({
    encryptToken: jest.fn().mockReturnValue('encrypted'), decryptToken: jest.fn(),
}));
jest.mock('../../middleware/security', () => ({
    configureAiAutofillRateLimit: () => (_req, _res, next) => next(),
}));

jest.mock('../../services/merchant', () => ({
    getMerchantSettings: jest.fn(), updateMerchantSettings: jest.fn(),
    DEFAULT_MERCHANT_SETTINGS: {},
}));

jest.mock('../../services/vendor/vendor-dashboard', () => ({
    getVendorDashboard: jest.fn(), updateVendorSettings: jest.fn(),
}));
jest.mock('../../services/vendor/vendor-query-service', () => ({
    listVendors: jest.fn(), getMerchantTaxes: jest.fn(),
}));

// db — needed by cycle-counts, expiry-discounts, ai-autofill
jest.mock('../../utils/database', () => ({ query: jest.fn() }));

// ─── Test infrastructure ──────────────────────────────────────────────────────

const request = require('supertest');
const express = require('express');
const session = require('express-session');

function makeApp(routeFactory, mountPath, userRole = 'readonly') {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, _res, next) => {
        req.session.user = { id: 1, role: userRole };
        req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    app.use(mountPath, routeFactory());
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    return app;
}

async function expectAllReturn403(app, endpoints) {
    for (const ep of endpoints) {
        const res = await request(app)[ep.method](ep.path).send(ep.body || {});
        expect({ path: ep.path, status: res.status }).toEqual({ path: ep.path, status: 403 });
        expect(res.body.code).toBe('FORBIDDEN');
    }
}

// ─── purchase-orders.js ───────────────────────────────────────────────────────
// Server mounts at /api/purchase-orders; routes are relative (/, /:id)

describe('purchase-orders.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post',   path: '/po',      body: { vendor_id: 1 } },
        { method: 'patch',  path: '/po/1',    body: { notes: 'x' } },
        { method: 'post',   path: '/po/1/submit',  body: {} },
        { method: 'post',   path: '/po/1/receive', body: { items: [] } },
        { method: 'delete', path: '/po/1',    body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/purchase-orders'), '/po');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── cycle-counts.js ─────────────────────────────────────────────────────────

describe('cycle-counts.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post', path: '/api/cycle-counts/1/complete',               body: { counted_qty: 5 } },
        { method: 'post', path: '/api/cycle-counts/1/sync-to-square',         body: {} },
        { method: 'post', path: '/api/cycle-counts/send-now',                 body: { variation_ids: [] } },
        { method: 'post', path: '/api/cycle-counts/email-report',             body: {} },
        { method: 'post', path: '/api/cycle-counts/generate-batch',           body: {} },
        { method: 'post', path: '/api/cycle-counts/reset',                    body: {} },
        { method: 'post', path: '/api/cycle-counts/generate-category-batch',  body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/cycle-counts'), '/api');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── expiry-discounts.js ──────────────────────────────────────────────────────

describe('expiry-discounts.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'patch', path: '/api/expiry-discounts/tiers/1',       body: { discount_percent: 10 } },
        { method: 'post',  path: '/api/expiry-discounts/apply',         body: {} },
        { method: 'post',  path: '/api/expiry-discounts/run',           body: {} },
        { method: 'post',  path: '/api/expiry-discounts/init-square',   body: {} },
        { method: 'patch', path: '/api/expiry-discounts/settings',      body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/expiry-discounts'), '/api');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── sync.js ─────────────────────────────────────────────────────────────────

describe('sync.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post', path: '/api/sync',       body: {} },
        { method: 'post', path: '/api/sync-sales',  body: {} },
        { method: 'post', path: '/api/sync-smart',  body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/sync'), '/api');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── bundles.js ───────────────────────────────────────────────────────────────
// Server mounts at /api/bundles; routes are relative (/, /:id)

describe('bundles.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post',   path: '/b',    body: { name: 'Bundle A' } },
        { method: 'put',    path: '/b/1',  body: { name: 'Bundle B' } },
        { method: 'delete', path: '/b/1',  body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/bundles'), '/b');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── vendor-match-suggestions.js ─────────────────────────────────────────────
// Server mounts at /api/vendor-match-suggestions; routes are relative

describe('vendor-match-suggestions.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post', path: '/vms/bulk-approve', body: { ids: [1] } },
        { method: 'post', path: '/vms/backfill',     body: {} },
        { method: 'post', path: '/vms/1/approve',    body: {} },
        { method: 'post', path: '/vms/1/reject',     body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/vendor-match-suggestions'), '/vms');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── labels.js ────────────────────────────────────────────────────────────────

describe('labels.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post', path: '/api/labels/generate',             body: { variation_ids: [] } },
        { method: 'post', path: '/api/labels/generate-with-prices', body: { variation_ids: [] } },
        { method: 'put',  path: '/api/labels/templates/1/default',  body: {} },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/labels'), '/api');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── ai-autofill.js ───────────────────────────────────────────────────────────

describe('ai-autofill.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'post',   path: '/api/ai-autofill/api-key',  body: { apiKey: 'sk-ant-test' } },
        { method: 'delete', path: '/api/ai-autofill/api-key',  body: {} },
        { method: 'post',   path: '/api/ai-autofill/apply',    body: { updates: [] } },
    ];

    it('blocks readonly user on all write endpoints', async () => {
        const app = makeApp(() => require('../../routes/ai-autofill'), '/api/ai-autofill');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── settings.js ─────────────────────────────────────────────────────────────

describe('settings.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'put', path: '/api/settings/merchant', body: { reorder_safety_days: 5 } },
    ];

    it('blocks readonly user on write endpoint', async () => {
        const app = makeApp(() => require('../../routes/settings'), '/api');
        await expectAllReturn403(app, endpoints);
    });
});

// ─── vendor-catalog/vendors.js ────────────────────────────────────────────────

describe('vendor-catalog/vendors.js — requireWriteAccess (readonly → 403)', () => {
    const endpoints = [
        { method: 'patch', path: '/api/vendors/1/settings', body: { auto_order: true } },
    ];

    it('blocks readonly user on write endpoint', async () => {
        const app = makeApp(() => require('../../routes/vendor-catalog/vendors'), '/api');
        await expectAllReturn403(app, endpoints);
    });
});
