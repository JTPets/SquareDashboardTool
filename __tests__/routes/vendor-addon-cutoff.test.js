/**
 * Vendor Add-on Cutoff Endpoint Tests
 *
 * Tests for PATCH /api/vendors/:id/settings with addon_cutoff_* fields
 * and GET /api/vendor-dashboard addon_cutoff field inclusion.
 * Service-level business rule tests live in vendor-dashboard.test.js.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const mockVendorDashboard = {
    getVendorDashboard: jest.fn(),
    updateVendorSettings: jest.fn(),
};
jest.mock('../../services/vendor/vendor-dashboard', () => mockVendorDashboard);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        next();
    },
    requireWriteAccess: (req, res, next) => {
        if (req.session?.user?.role === 'readonly') {
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

const request = require('supertest');
const express = require('express');
const session = require('express-session');

function createTestApp(opts = {}) {
    const { authenticated = true, hasMerchant = true, merchantId = 1, role = 'admin' } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        if (authenticated) req.session.user = { id: 1, email: 'test@test.com', role };
        if (hasMerchant) req.merchantContext = { id: merchantId };
        next();
    });
    const vendorCatalogRoutes = require('../../routes/vendor-catalog');
    app.use('/api', vendorCatalogRoutes);
    app.use((err, req, res, _next) => {
        const status = err.statusCode || err.status || 500;
        res.status(status).json({ error: err.message });
    });
    return app;
}

describe('Vendor Add-on Cutoff — PATCH /api/vendors/:id/settings', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('saves addon_cutoff fields when all three are valid', async () => {
        mockVendorDashboard.updateVendorSettings.mockResolvedValueOnce({
            id: 'V1',
            addon_cutoff_enabled: true,
            addon_cutoff_day: 'tuesday',
            addon_cutoff_time: '14:00:00',
        });

        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: true, addon_cutoff_day: 'tuesday', addon_cutoff_time: '14:00' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockVendorDashboard.updateVendorSettings).toHaveBeenCalledWith(
            'V1', 1,
            expect.objectContaining({
                addon_cutoff_enabled: true,
                addon_cutoff_day: 'tuesday',
                addon_cutoff_time: '14:00',
            })
        );
    });

    it('returns 400 when service throws for missing addon_cutoff_day', async () => {
        mockVendorDashboard.updateVendorSettings.mockImplementationOnce(() => {
            const err = new Error('addon_cutoff_day and addon_cutoff_time are required when enabling the add-on order window');
            err.statusCode = 400;
            throw err;
        });

        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: true, addon_cutoff_time: '09:00' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/addon_cutoff_day/);
    });

    it('returns 400 when service throws for missing addon_cutoff_time', async () => {
        mockVendorDashboard.updateVendorSettings.mockImplementationOnce(() => {
            const err = new Error('addon_cutoff_day and addon_cutoff_time are required when enabling the add-on order window');
            err.statusCode = 400;
            throw err;
        });

        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: true, addon_cutoff_day: 'monday' });

        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid addon_cutoff_day value (must be lowercase)', async () => {
        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: true, addon_cutoff_day: 'MONDAY', addon_cutoff_time: '09:00' });

        expect(res.status).toBe(400);
        expect(mockVendorDashboard.updateVendorSettings).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid addon_cutoff_time format', async () => {
        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: true, addon_cutoff_day: 'monday', addon_cutoff_time: '9am' });

        expect(res.status).toBe(400);
        expect(mockVendorDashboard.updateVendorSettings).not.toHaveBeenCalled();
    });

    it('returns 200 when addon_cutoff_enabled is false', async () => {
        mockVendorDashboard.updateVendorSettings.mockResolvedValueOnce({
            id: 'V1',
            addon_cutoff_enabled: false,
            addon_cutoff_day: null,
            addon_cutoff_time: null,
        });

        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: false });

        expect(res.status).toBe(200);
        expect(mockVendorDashboard.updateVendorSettings).toHaveBeenCalledWith(
            'V1', 1, expect.objectContaining({ addon_cutoff_enabled: false })
        );
    });

    it('passes request to service when addon_cutoff_enabled false with day/time provided', async () => {
        mockVendorDashboard.updateVendorSettings.mockResolvedValueOnce({
            id: 'V1',
            addon_cutoff_enabled: false,
            addon_cutoff_day: null,
            addon_cutoff_time: null,
        });

        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: false, addon_cutoff_day: 'friday', addon_cutoff_time: '10:00' });

        expect(res.status).toBe(200);
        expect(mockVendorDashboard.updateVendorSettings).toHaveBeenCalledWith(
            'V1', 1, expect.objectContaining({ addon_cutoff_enabled: false })
        );
    });

    it('returns 403 when readonly user attempts PATCH', async () => {
        app = createTestApp({ role: 'readonly' });

        const res = await request(app)
            .patch('/api/vendors/V1/settings')
            .send({ addon_cutoff_enabled: true, addon_cutoff_day: 'tuesday', addon_cutoff_time: '14:00' });

        expect(res.status).toBe(403);
        expect(mockVendorDashboard.updateVendorSettings).not.toHaveBeenCalled();
    });
});

describe('Vendor Add-on Cutoff — GET /api/vendor-dashboard includes fields', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    it('response includes addon_cutoff_enabled, addon_cutoff_day, addon_cutoff_time for each vendor', async () => {
        mockVendorDashboard.getVendorDashboard.mockResolvedValueOnce({
            vendors: [
                {
                    id: 'V1',
                    name: 'Test Vendor',
                    total_items: 10,
                    addon_cutoff_enabled: true,
                    addon_cutoff_day: 'tuesday',
                    addon_cutoff_time: '14:00:00',
                },
                {
                    id: 'V2',
                    name: 'No Cutoff Vendor',
                    total_items: 5,
                    addon_cutoff_enabled: false,
                    addon_cutoff_day: null,
                    addon_cutoff_time: null,
                },
            ],
            global_oos_count: 0,
        });

        const res = await request(app).get('/api/vendor-dashboard');

        expect(res.status).toBe(200);
        expect(res.body.vendors).toHaveLength(2);

        const v1 = res.body.vendors[0];
        expect(v1).toHaveProperty('addon_cutoff_enabled', true);
        expect(v1).toHaveProperty('addon_cutoff_day', 'tuesday');
        expect(v1).toHaveProperty('addon_cutoff_time', '14:00:00');

        const v2 = res.body.vendors[1];
        expect(v2).toHaveProperty('addon_cutoff_enabled', false);
        expect(v2).toHaveProperty('addon_cutoff_day', null);
        expect(v2).toHaveProperty('addon_cutoff_time', null);
    });
});
