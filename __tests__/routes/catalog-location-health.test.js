/**
 * Catalog Location Health Routes Test Suite
 *
 * Tests for location mismatch health check admin endpoints.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/catalog/location-health-service', () => ({
    checkAndRecordHealth: jest.fn(),
    getMismatchHistory: jest.fn(),
    getOpenMismatches: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => {
        if (req.session?.user?.role === 'admin') {
            return next();
        }
        return res.status(403).json({ error: 'Admin access required' });
    },
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const { checkAndRecordHealth, getMismatchHistory, getOpenMismatches } = require('../../services/catalog/location-health-service');

function createTestApp(userRole = 'admin') {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com', role: userRole };
        next();
    });
    app.use('/api/admin/catalog-location-health', require('../../routes/catalog-location-health'));
    return app;
}

describe('Catalog Location Health Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/admin/catalog-location-health', () => {
        it('should return mismatch history and open mismatches', async () => {
            const mockHistory = [{ id: 1, checked_at: '2026-03-15', mismatches: 2 }];
            const mockMismatches = [{ item_id: 'ITEM_1', location_id: 'LOC_1', issue: 'not_present' }];
            getMismatchHistory.mockResolvedValueOnce(mockHistory);
            getOpenMismatches.mockResolvedValueOnce(mockMismatches);

            const res = await request(app)
                .get('/api/admin/catalog-location-health')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.history).toEqual(mockHistory);
            expect(res.body.openMismatches).toEqual(mockMismatches);
            // Hard-coded to merchant_id = 3
            expect(getMismatchHistory).toHaveBeenCalledWith(3);
            expect(getOpenMismatches).toHaveBeenCalledWith(3);
        });

        it('should require admin role', async () => {
            const userApp = createTestApp('user');

            await request(userApp)
                .get('/api/admin/catalog-location-health')
                .expect(403);
        });
    });

    describe('POST /api/admin/catalog-location-health/check', () => {
        it('should trigger location health check and return results', async () => {
            const mockResult = {
                totalItems: 50,
                totalLocations: 3,
                mismatches: 2,
                newMismatches: 1,
            };
            checkAndRecordHealth.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/admin/catalog-location-health/check')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.totalItems).toBe(50);
            expect(res.body.mismatches).toBe(2);
            expect(checkAndRecordHealth).toHaveBeenCalledWith(3);
        });

        it('should require admin role', async () => {
            const userApp = createTestApp('user');

            await request(userApp)
                .post('/api/admin/catalog-location-health/check')
                .expect(403);
        });
    });
});
