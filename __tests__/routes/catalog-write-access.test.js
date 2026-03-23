/**
 * Catalog Routes — requireWriteAccess Tests
 *
 * Verifies that all write endpoints (POST/PATCH) in catalog.js
 * reject readonly users with 403.
 */

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
            return res.status(403).json({
                error: 'Write access required. Your account is read-only.',
                code: 'FORBIDDEN'
            });
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

function createTestApp(opts = {}) {
    const { userRole = 'user' } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@test.com', role: userRole };
        req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    const catalogRoutes = require('../../routes/catalog');
    app.use('/api', catalogRoutes);
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

describe('Catalog Routes — requireWriteAccess', () => {
    const writeEndpoints = [
        { method: 'patch', path: '/api/variations/1/extended', body: {} },
        { method: 'patch', path: '/api/variations/1/min-stock', body: { min_stock: 5 } },
        { method: 'patch', path: '/api/variations/1/cost', body: { cost_cents: 100 } },
        { method: 'post', path: '/api/variations/bulk-update-extended', body: [] },
        { method: 'post', path: '/api/expirations', body: [] },
        { method: 'post', path: '/api/expirations/pull', body: { variation_id: '1' } },
        { method: 'post', path: '/api/expirations/review', body: { variation_ids: ['1'] } },
        { method: 'post', path: '/api/catalog-audit/enable-item-at-locations', body: { item_id: 'ABC' } },
        { method: 'post', path: '/api/catalog-audit/fix-locations', body: {} },
        { method: 'post', path: '/api/catalog-audit/fix-inventory-alerts', body: {} },
    ];

    it('should return 403 for readonly user on all write endpoints', async () => {
        const app = createTestApp({ userRole: 'readonly' });

        for (const endpoint of writeEndpoints) {
            const res = await request(app)[endpoint.method](endpoint.path)
                .send(endpoint.body);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
        }
    });

    it('should allow non-readonly user through to write endpoints', async () => {
        const app = createTestApp({ userRole: 'user' });

        // Mock success responses for services
        mockCatalogService.updateExtendedFields.mockResolvedValue({ success: true, variation: {} });

        const res = await request(app)
            .patch('/api/variations/1/extended')
            .send({ case_pack_quantity: 12 });

        // Should not be 403 — may be 200 or validation error, but not forbidden
        expect(res.status).not.toBe(403);
    });

    it('should still allow GET endpoints for readonly users', async () => {
        const app = createTestApp({ userRole: 'readonly' });

        mockCatalogService.getCategories.mockResolvedValue({ count: 0, categories: [] });

        const res = await request(app).get('/api/categories');

        expect(res.status).not.toBe(403);
    });
});
