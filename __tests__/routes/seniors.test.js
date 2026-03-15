jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockDb = { query: jest.fn() };
jest.mock('../../utils/database', () => mockDb);

const mockSeniorsInstance = {
    initialize: jest.fn(),
    verifyPricingRuleState: jest.fn(),
    setupSquareObjects: jest.fn(),
};
const mockSeniorsService = { SeniorsService: jest.fn(() => mockSeniorsInstance) };
jest.mock('../../services/seniors', () => mockSeniorsService);

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
}));

jest.mock('../../middleware/validators/seniors', () => ({
    updateConfig: [(req, res, next) => next()],
    listMembers: [(req, res, next) => next()],
    listAuditLog: [(req, res, next) => next()],
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
    const routes = require('../../routes/seniors');
    app.use('/api', routes);
    app.use((err, req, res, _next) => { res.status(500).json({ error: err.message }); });
    return app;
}

describe('Seniors Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('Authentication & Authorization Guards', () => {
        test('all endpoints return 401 without session', async () => {
            const unauthApp = createTestApp({ authenticated: false });

            const endpoints = [
                { method: 'get', path: '/api/seniors/status' },
                { method: 'post', path: '/api/seniors/setup' },
                { method: 'get', path: '/api/seniors/config' },
                { method: 'patch', path: '/api/seniors/config' },
                { method: 'get', path: '/api/seniors/members' },
                { method: 'get', path: '/api/seniors/audit-log' },
            ];

            for (const ep of endpoints) {
                const res = await request(unauthApp)[ep.method](ep.path);
                expect(res.status).toBe(401);
                expect(res.body.error).toBe('Unauthorized');
            }
        });

        test('all endpoints return 400 without merchant context', async () => {
            const noMerchantApp = createTestApp({ hasMerchant: false });

            const endpoints = [
                { method: 'get', path: '/api/seniors/status' },
                { method: 'post', path: '/api/seniors/setup' },
                { method: 'get', path: '/api/seniors/config' },
                { method: 'patch', path: '/api/seniors/config' },
                { method: 'get', path: '/api/seniors/members' },
                { method: 'get', path: '/api/seniors/audit-log' },
            ];

            for (const ep of endpoints) {
                const res = await request(noMerchantApp)[ep.method](ep.path);
                expect(res.status).toBe(400);
                expect(res.body.error).toBe('Merchant context required');
            }
        });
    });

    describe('GET /api/seniors/status', () => {
        test('returns status when configured with members', async () => {
            mockDb.query
                .mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        merchant_id: 1,
                        discount_percent: 10,
                        min_age: 65,
                        day_of_month: 2,
                        is_enabled: true,
                        square_group_id: 'grp_123',
                        square_discount_id: 'disc_123',
                        square_pricing_rule_id: 'pr_456',
                        last_enabled_at: null,
                        last_disabled_at: null,
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-15T00:00:00Z',
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [{ count: '15' }],
                });

            mockSeniorsInstance.verifyPricingRuleState.mockResolvedValueOnce({ enabled: true });

            const res = await request(app).get('/api/seniors/status');

            expect(res.status).toBe(200);
            expect(res.body.configured).toBe(true);
            expect(res.body.config.discountPercent).toBe(10);
            expect(res.body.enrolledCount).toBe(15);
            expect(mockDb.query).toHaveBeenCalledTimes(2);
        });

        test('returns not configured when no config exists', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/seniors/status');

            expect(res.status).toBe(200);
            expect(res.body.configured).toBe(false);
        });

        test('returns 500 on database error', async () => {
            mockDb.query.mockRejectedValueOnce(new Error('Connection refused'));

            const res = await request(app).get('/api/seniors/status');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Connection refused');
        });
    });

    describe('POST /api/seniors/setup', () => {
        test('sets up Square objects successfully', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            mockSeniorsInstance.initialize.mockResolvedValueOnce();
            mockSeniorsInstance.setupSquareObjects.mockResolvedValueOnce({
                square_group_id: 'grp_new',
                square_pricing_rule_id: 'pr_new',
                square_discount_id: 'disc_new',
                square_product_set_id: 'ps_new',
                discount_percent: 10,
                min_age: 65,
            });

            const res = await request(app)
                .post('/api/seniors/setup')
                .send({ discount_percent: 10, min_age: 65 });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockSeniorsService.SeniorsService).toHaveBeenCalled();
            expect(mockSeniorsInstance.setupSquareObjects).toHaveBeenCalled();
        });

        test('returns 409 if already configured', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    square_pricing_rule_id: 'pr_456',
                }],
            });

            const res = await request(app)
                .post('/api/seniors/setup')
                .send({ discount_percent: 10, min_age: 65 });

            expect(res.status).toBe(409);
        });

        test('returns 500 on setup failure', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            mockSeniorsInstance.initialize.mockResolvedValueOnce();
            mockSeniorsInstance.setupSquareObjects.mockRejectedValueOnce(new Error('Square API error'));

            const res = await request(app)
                .post('/api/seniors/setup')
                .send({ discount_percent: 10, min_age: 65 });

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Square API error');
        });
    });

    describe('GET /api/seniors/config', () => {
        test('returns config when found', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    discount_percent: 10,
                    min_age: 65,
                    day_of_month: 2,
                    is_enabled: true,
                    last_enabled_at: null,
                    last_disabled_at: null,
                    updated_at: '2026-01-15T00:00:00Z',
                }],
            });

            const res = await request(app).get('/api/seniors/config');

            expect(res.status).toBe(200);
            expect(res.body.config.discount_percent).toBe(10);
            expect(res.body.config.day_of_month).toBe(2);
            expect(res.body.config.is_enabled).toBe(true);
        });

        test('returns 404 when config not found', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/seniors/config');

            expect(res.status).toBe(404);
        });

        test('returns 500 on database error', async () => {
            mockDb.query.mockRejectedValueOnce(new Error('Query timeout'));

            const res = await request(app).get('/api/seniors/config');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Query timeout');
        });
    });

    describe('PATCH /api/seniors/config', () => {
        test('updates config with valid fields', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    merchant_id: 1,
                    discount_percent: 15,
                    min_age: 65,
                    day_of_month: 3,
                    is_enabled: true,
                    updated_at: '2026-03-15T00:00:00Z',
                }],
            });

            const res = await request(app)
                .patch('/api/seniors/config')
                .send({ discount_percent: 15, day_of_month: 3 });

            expect(res.status).toBe(200);
            expect(mockDb.query).toHaveBeenCalled();
        });

        test('returns 400 when no valid fields provided', async () => {
            const res = await request(app)
                .patch('/api/seniors/config')
                .send({});

            expect(res.status).toBe(400);
        });

        test('returns 404 when config not found for update', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .patch('/api/seniors/config')
                .send({ discount_percent: 15 });

            expect(res.status).toBe(404);
        });

        test('updates only discount_percent', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    merchant_id: 1,
                    discount_percent: 20,
                    min_age: 65,
                    day_of_month: 2,
                    is_enabled: true,
                }],
            });

            const res = await request(app)
                .patch('/api/seniors/config')
                .send({ discount_percent: 20 });

            expect(res.status).toBe(200);
        });

        test('updates is_enabled flag', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    id: 1,
                    merchant_id: 1,
                    discount_percent: 10,
                    min_age: 65,
                    day_of_month: 2,
                    is_enabled: false,
                }],
            });

            const res = await request(app)
                .patch('/api/seniors/config')
                .send({ is_enabled: false });

            expect(res.status).toBe(200);
        });

        test('returns 500 on database error', async () => {
            mockDb.query.mockRejectedValueOnce(new Error('Update failed'));

            const res = await request(app)
                .patch('/api/seniors/config')
                .send({ discount_percent: 15 });

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Update failed');
        });
    });

    describe('GET /api/seniors/members', () => {
        test('returns paginated members list', async () => {
            mockDb.query
                .mockResolvedValueOnce({
                    rows: [
                        { square_customer_id: 'cust_1', given_name: 'Alice', family_name: 'Smith', is_active: true, added_to_group_at: '2026-01-01' },
                        { square_customer_id: 'cust_2', given_name: 'Bob', family_name: 'Jones', is_active: true, added_to_group_at: '2026-01-05' },
                    ],
                })
                .mockResolvedValueOnce({
                    rows: [{ count: '25' }],
                });

            const res = await request(app).get('/api/seniors/members');

            expect(res.status).toBe(200);
            expect(res.body.members).toHaveLength(2);
            expect(res.body.total).toBe(25);
        });

        test('passes pagination parameters', async () => {
            mockDb.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ count: '0' }] });

            await request(app)
                .get('/api/seniors/members')
                .query({ limit: '10', offset: '20' });

            expect(mockDb.query).toHaveBeenCalled();
            const firstCall = mockDb.query.mock.calls[0];
            expect(firstCall[0]).toContain('LIMIT');
        });

        test('returns empty list when no members', async () => {
            mockDb.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ count: '0' }] });

            const res = await request(app).get('/api/seniors/members');

            expect(res.status).toBe(200);
            expect(res.body.members).toEqual([]);
            expect(res.body.total).toBe(0);
        });

        test('returns 500 on database error', async () => {
            mockDb.query.mockRejectedValueOnce(new Error('Members query failed'));

            const res = await request(app).get('/api/seniors/members');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Members query failed');
        });
    });

    describe('GET /api/seniors/audit-log', () => {
        test('returns audit log entries', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, action: 'MEMBER_ADDED', details: 'Added Alice Smith', created_at: '2026-03-01T10:00:00Z' },
                    { id: 2, action: 'CONFIG_UPDATED', details: 'Discount changed to 15%', created_at: '2026-03-02T14:00:00Z' },
                ],
            });

            const res = await request(app).get('/api/seniors/audit-log');

            expect(res.status).toBe(200);
            expect(res.body.entries).toHaveLength(2);
            expect(res.body.count).toBe(2);
        });

        test('returns empty audit log', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).get('/api/seniors/audit-log');

            expect(res.status).toBe(200);
            expect(res.body.entries).toEqual([]);
            expect(res.body.count).toBe(0);
        });

        test('passes pagination parameters', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });

            await request(app)
                .get('/api/seniors/audit-log')
                .query({ limit: '25' });

            expect(mockDb.query).toHaveBeenCalled();
        });

        test('returns 500 on database error', async () => {
            mockDb.query.mockRejectedValueOnce(new Error('Audit log query failed'));

            const res = await request(app).get('/api/seniors/audit-log');

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Audit log query failed');
        });
    });
});
