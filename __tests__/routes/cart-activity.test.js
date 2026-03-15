jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCartActivityService = { getList: jest.fn(), getStats: jest.fn() };
jest.mock('../../services/cart/cart-activity-service', () => mockCartActivityService);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));

jest.mock('../../middleware/validators/cart-activity', () => ({
    list: [(req, res, next) => next()],
    stats: [(req, res, next) => next()],
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');

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
    const routes = require('../../routes/cart-activity');
    app.use('/api/cart-activity', routes);
    app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });
    return app;
}

describe('Cart Activity Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('Authentication & Authorization', () => {
        test('GET / returns 401 without session', async () => {
            const unauthApp = createTestApp({ authenticated: false });
            const res = await request(unauthApp).get('/api/cart-activity');
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Unauthorized');
        });

        test('GET /stats returns 401 without session', async () => {
            const unauthApp = createTestApp({ authenticated: false });
            const res = await request(unauthApp).get('/api/cart-activity/stats');
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Unauthorized');
        });

        test('GET / returns 400 without merchant context', async () => {
            const noMerchantApp = createTestApp({ hasMerchant: false });
            const res = await request(noMerchantApp).get('/api/cart-activity');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Merchant context required');
        });

        test('GET /stats returns 400 without merchant context', async () => {
            const noMerchantApp = createTestApp({ hasMerchant: false });
            const res = await request(noMerchantApp).get('/api/cart-activity/stats');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Merchant context required');
        });
    });

    describe('GET /api/cart-activity', () => {
        test('returns cart list with default pagination', async () => {
            const mockData = {
                carts: [
                    { id: 1, customer_id: 'cust_1', status: 'abandoned', item_count: 3 },
                    { id: 2, customer_id: 'cust_2', status: 'recovered', item_count: 1 },
                ],
                total: 2,
                limit: 50,
                offset: 0,
            };
            mockCartActivityService.getList.mockResolvedValueOnce(mockData);

            const res = await request(app).get('/api/cart-activity');

            expect(res.status).toBe(200);
            expect(res.body.carts).toHaveLength(2);
            expect(res.body.total).toBe(2);
            expect(res.body.limit).toBe(50);
            expect(res.body.offset).toBe(0);
            expect(mockCartActivityService.getList).toHaveBeenCalledWith(1, expect.objectContaining({}));
        });

        test('passes filter parameters to service', async () => {
            mockCartActivityService.getList.mockResolvedValueOnce({
                carts: [], total: 0, limit: 25, offset: 10,
            });

            await request(app)
                .get('/api/cart-activity')
                .query({ status: 'abandoned', startDate: '2026-01-01', endDate: '2026-01-31', limit: '25', offset: '10' });

            expect(mockCartActivityService.getList).toHaveBeenCalledWith(1, expect.objectContaining({
                status: 'abandoned',
                startDate: new Date('2026-01-01'),
                endDate: new Date('2026-01-31'),
                limit: 25,
                offset: 10,
            }));
        });

        test('caps limit at 200', async () => {
            mockCartActivityService.getList.mockResolvedValueOnce({
                carts: [], total: 0, limit: 200, offset: 0,
            });

            await request(app)
                .get('/api/cart-activity')
                .query({ limit: '500' });

            expect(mockCartActivityService.getList).toHaveBeenCalledWith(1, expect.objectContaining({
                limit: 200,
            }));
        });

        test('returns empty list when no carts found', async () => {
            mockCartActivityService.getList.mockResolvedValueOnce({
                carts: [], total: 0, limit: 50, offset: 0,
            });

            const res = await request(app).get('/api/cart-activity');

            expect(res.status).toBe(200);
            expect(res.body.carts).toEqual([]);
            expect(res.body.total).toBe(0);
        });

        test('returns 500 when service throws', async () => {
            mockCartActivityService.getList.mockRejectedValueOnce(new Error('Database connection failed'));

            const res = await request(app).get('/api/cart-activity');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Database connection failed');
        });
    });

    describe('GET /api/cart-activity/stats', () => {
        test('returns stats with default days=7', async () => {
            const mockStats = {
                totalCarts: 50,
                abandonedCarts: 30,
                recoveredCarts: 10,
                recoveryRate: 0.33,
                avgCartValue: 45.99,
            };
            mockCartActivityService.getStats.mockResolvedValueOnce(mockStats);

            const res = await request(app).get('/api/cart-activity/stats');

            expect(res.status).toBe(200);
            expect(res.body.totalCarts).toBe(50);
            expect(res.body.recoveryRate).toBe(0.33);
            expect(mockCartActivityService.getStats).toHaveBeenCalledWith(1, 7);
        });

        test('passes custom days parameter', async () => {
            mockCartActivityService.getStats.mockResolvedValueOnce({
                totalCarts: 100,
                abandonedCarts: 60,
                recoveredCarts: 25,
                recoveryRate: 0.42,
                avgCartValue: 52.00,
            });

            const res = await request(app)
                .get('/api/cart-activity/stats')
                .query({ days: '30' });

            expect(res.status).toBe(200);
            expect(mockCartActivityService.getStats).toHaveBeenCalledWith(1, 30);
        });

        test('returns 500 when service throws', async () => {
            mockCartActivityService.getStats.mockRejectedValueOnce(new Error('Stats query failed'));

            const res = await request(app).get('/api/cart-activity/stats');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Stats query failed');
        });
    });
});
