/**
 * Catalog Health Routes Test Suite
 *
 * Tests for catalog health check admin endpoints.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/catalog/catalog-health-service', () => ({
    runFullHealthCheck: jest.fn(),
    getHealthHistory: jest.fn(),
    getOpenIssues: jest.fn(),
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
const { runFullHealthCheck, getHealthHistory, getOpenIssues } = require('../../services/catalog/catalog-health-service');

function createTestApp(userRole = 'admin') {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com', role: userRole };
        next();
    });
    app.use('/api/admin/catalog-health', require('../../routes/catalog-health'));
    return app;
}

describe('Catalog Health Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/admin/catalog-health', () => {
        it('should return health history and open issues', async () => {
            const mockHistory = [{ id: 1, checked_at: '2026-03-15', status: 'healthy' }];
            const mockIssues = [{ id: 2, issue_type: 'missing_image', item_id: 'ITEM_1' }];
            getHealthHistory.mockResolvedValueOnce(mockHistory);
            getOpenIssues.mockResolvedValueOnce(mockIssues);

            const res = await request(app)
                .get('/api/admin/catalog-health')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.history).toEqual(mockHistory);
            expect(res.body.openIssues).toEqual(mockIssues);
            // Hard-coded to merchant_id = 3
            expect(getHealthHistory).toHaveBeenCalledWith(3);
            expect(getOpenIssues).toHaveBeenCalledWith(3);
        });

        it('should require admin role', async () => {
            const userApp = createTestApp('user');

            await request(userApp)
                .get('/api/admin/catalog-health')
                .expect(403);
        });
    });

    describe('POST /api/admin/catalog-health/check', () => {
        it('should trigger a health check and return results', async () => {
            const mockResult = {
                totalItems: 100,
                issuesFound: 3,
                newIssues: 1,
                resolvedIssues: 2,
            };
            runFullHealthCheck.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/admin/catalog-health/check')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.totalItems).toBe(100);
            expect(res.body.issuesFound).toBe(3);
            expect(runFullHealthCheck).toHaveBeenCalledWith(3);
        });

        it('should require admin role', async () => {
            const userApp = createTestApp('user');

            await request(userApp)
                .post('/api/admin/catalog-health/check')
                .expect(403);
        });
    });
});
