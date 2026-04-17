/**
 * Delivery Routes — requireWriteAccess Tests
 *
 * 1. Asserts that every delivery write endpoint returns 403 for a readonly user.
 * 2. Asserts that public driver-token routes (/api/driver/:token/*) are accessible
 *    with NO session and NO write-access check, and that a valid token allows all
 *    core driver actions.
 *
 * Follow-on pattern from __tests__/routes/catalog-write-access.test.js.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// Multer must be mocked before route files are required so the module
// cache picks up the mock. Both pod.js and driver-api.js use multer.
jest.mock('multer', () => {
    const multerMock = () => ({
        single: () => (req, _res, next) => {
            req.file = {
                originalname: 'test.jpg',
                mimetype: 'image/jpeg',
                buffer: Buffer.from('fake-image-data'),
            };
            next();
        },
    });
    multerMock.memoryStorage = () => ({});
    return multerMock;
});

const mockDeliveryApi = {
    getOrders: jest.fn(),
    getOrderById: jest.fn(),
    createOrder: jest.fn(),
    updateOrder: jest.fn(),
    deleteOrder: jest.fn(),
    skipOrder: jest.fn(),
    completeOrder: jest.fn(),
    completeDeliveryInSquare: jest.fn(),
    updateOrderNotes: jest.fn(),
    savePodPhoto: jest.fn(),
    getPodPhoto: jest.fn(),
    generateRoute: jest.fn(),
    getActiveRouteWithOrders: jest.fn(),
    getRouteWithOrders: jest.fn(),
    finishRoute: jest.fn(),
    geocodePendingOrders: jest.fn(),
    geocodeAndPatchOrder: jest.fn(),
    getSettingsWithDefaults: jest.fn(),
    updateSettingsWithGeocode: jest.fn(),
    syncSquareOrders: jest.fn(),
    backfillUnknownCustomers: jest.fn(),
    getAuditLog: jest.fn(),
    logAuditEvent: jest.fn(),
    generateRouteToken: jest.fn(),
    getActiveRouteToken: jest.fn(),
    revokeRouteToken: jest.fn(),
    getRouteOrdersByToken: jest.fn(),
    completeOrderByToken: jest.fn(),
    skipOrderByToken: jest.fn(),
    savePodByToken: jest.fn(),
    finishRouteByToken: jest.fn(),
};
jest.mock('../../services/delivery', () => mockDeliveryApi);

const mockDeliveryStats = {
    getCustomerInfo: jest.fn(),
    getCustomerStats: jest.fn(),
    updateCustomerNote: jest.fn(),
    getDashboardStats: jest.fn(),
};
jest.mock('../../services/delivery/delivery-stats', () => mockDeliveryStats);

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
                code: 'FORBIDDEN',
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

jest.mock('../../middleware/security', () => ({
    configureDeliveryRateLimit: () => (_req, _res, next) => next(),
    configureDeliveryStrictRateLimit: () => (_req, _res, next) => next(),
}));

jest.mock('../../utils/file-validation', () => ({
    validateUploadedImage: () => (_req, _res, next) => next(),
}));

// Pass all validators through — write-access is checked before validation,
// so validator behaviour is irrelevant for the negative-path tests.
const passThroughMiddleware = (_req, _res, next) => next();
jest.mock('../../middleware/validators/delivery', () =>
    new Proxy({}, { get: () => [passThroughMiddleware] })
);
jest.mock('../../middleware/validators/driver-api', () =>
    new Proxy({}, { get: () => [passThroughMiddleware] })
);

const request = require('supertest');
const express = require('express');
const session = require('express-session');

/**
 * App for testing authenticated delivery sub-routes (delivery/index.js).
 * Mounts at /api/delivery — same prefix server.js uses.
 */
function createDeliveryApp(opts = {}) {
    const { userRole = 'user' } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use((_req, _res, next) => {
        // Intentional: suppress unused-var lint; Express requires 4-arg error middleware
        void _req; void _res;
        next();
    });
    app.use((req, _res, next) => {
        req.session.user = { id: 1, email: 'test@test.com', role: userRole };
        req.merchantContext = { id: 1, businessName: 'Test Store' };
        next();
    });
    // eslint-disable-next-line import/no-dynamic-require
    const deliveryRoutes = require('../../routes/delivery/index');
    app.use('/api/delivery', deliveryRoutes);
    app.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

/**
 * App for testing driver-api.js routes (both authenticated token-management
 * endpoints and public driver-facing endpoints).
 * Mounts at /api — same prefix server.js uses.
 */
function createDriverApiApp(opts = {}) {
    const { userRole = 'user', withSession = true } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    if (withSession) {
        app.use((req, _res, next) => {
            req.session.user = { id: 1, email: 'test@test.com', role: userRole };
            req.merchantContext = { id: 1, businessName: 'Test Store' };
            next();
        });
    }
    // eslint-disable-next-line import/no-dynamic-require
    const driverApiRoutes = require('../../routes/driver-api');
    app.use('/api', driverApiRoutes);
    app.use((err, _req, res, _next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

// ---------------------------------------------------------------------------
// Suite 1 — Delivery sub-routes: readonly user blocked on all write endpoints
// ---------------------------------------------------------------------------

describe('Delivery Routes — requireWriteAccess (readonly → 403)', () => {
    const writeEndpoints = [
        { method: 'post',   path: '/api/delivery/orders',                        body: { customerName: 'Test', address: '123 Main St' } },
        { method: 'patch',  path: '/api/delivery/orders/order-id-1',             body: { notes: 'updated' } },
        { method: 'delete', path: '/api/delivery/orders/order-id-1',             body: {} },
        { method: 'patch',  path: '/api/delivery/orders/order-id-1/notes',       body: { notes: 'note' } },
        { method: 'patch',  path: '/api/delivery/orders/order-id-1/customer-note', body: { note: 'note' } },
        { method: 'post',   path: '/api/delivery/orders/order-id-1/pod',         body: {} },
        { method: 'post',   path: '/api/delivery/route/generate',                body: { routeDate: '2026-04-17' } },
        { method: 'post',   path: '/api/delivery/route/finish',                  body: {} },
        { method: 'post',   path: '/api/delivery/geocode',                       body: {} },
        { method: 'put',    path: '/api/delivery/settings',                      body: {} },
        { method: 'post',   path: '/api/delivery/sync',                          body: {} },
        { method: 'post',   path: '/api/delivery/backfill-customers',            body: {} },
    ];

    it('should return 403 for readonly user on all delivery write endpoints', async () => {
        const app = createDeliveryApp({ userRole: 'readonly' });

        for (const endpoint of writeEndpoints) {
            const res = await request(app)[endpoint.method](endpoint.path)
                .send(endpoint.body);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
        }
    });

    it('should allow a non-readonly user through to a delivery write endpoint', async () => {
        const app = createDeliveryApp({ userRole: 'user' });

        mockDeliveryApi.createOrder.mockResolvedValue({
            id: 'order-id-1',
            customerName: 'Test',
            address: '123 Main St',
        });
        mockDeliveryApi.geocodeAndPatchOrder.mockResolvedValue(null);
        mockDeliveryApi.logAuditEvent.mockResolvedValue(undefined);

        const res = await request(app)
            .post('/api/delivery/orders')
            .send({ customerName: 'Test', address: '123 Main St' });

        expect(res.status).not.toBe(403);
    });

    it('should still allow GET endpoints for readonly users', async () => {
        const app = createDeliveryApp({ userRole: 'readonly' });

        mockDeliveryApi.getOrders.mockResolvedValue([]);

        const res = await request(app).get('/api/delivery/orders');

        expect(res.status).not.toBe(403);
    });
});

// ---------------------------------------------------------------------------
// Suite 2 — driver-api.js: token-management endpoints blocked for readonly
// ---------------------------------------------------------------------------

describe('Driver API Token Management — requireWriteAccess (readonly → 403)', () => {
    const writeEndpoints = [
        { method: 'post',   path: '/api/delivery/route/route-id-1/share', body: {} },
        { method: 'delete', path: '/api/delivery/route/route-id-1/token', body: {} },
    ];

    it('should return 403 for readonly user on share/revoke token endpoints', async () => {
        const app = createDriverApiApp({ userRole: 'readonly', withSession: true });

        for (const endpoint of writeEndpoints) {
            const res = await request(app)[endpoint.method](endpoint.path)
                .send(endpoint.body);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 3 — Public driver token routes: accessible with NO auth, NO write-access check
// ---------------------------------------------------------------------------

describe('Driver Token Routes — public accessibility (no session → 200)', () => {
    const TOKEN = 'a'.repeat(64);
    const ORDER_ID = 'order-uuid-0000-0000-000000000001';

    beforeEach(() => {
        jest.clearAllMocks();

        mockDeliveryApi.getRouteOrdersByToken.mockResolvedValue({
            valid: true,
            route_date: '2026-04-17',
            total_stops: 3,
            total_distance_km: 8.2,
            estimated_duration_min: 30,
            merchant_name: 'JTPets',
            orders: [],
        });
        mockDeliveryApi.completeOrderByToken.mockResolvedValue({
            id: ORDER_ID,
            status: 'completed',
        });
        mockDeliveryApi.skipOrderByToken.mockResolvedValue({
            id: ORDER_ID,
            status: 'skipped',
        });
        mockDeliveryApi.savePodByToken.mockResolvedValue({
            id: 'pod-uuid-001',
            captured_at: new Date().toISOString(),
        });
        mockDeliveryApi.finishRouteByToken.mockResolvedValue({ success: true });
    });

    it('GET /api/driver/:token — 200 with valid token and no session cookie', async () => {
        const app = createDriverApiApp({ withSession: false });
        const res = await request(app).get(`/api/driver/${TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/driver/:token/orders/:orderId/complete — 200 with valid token and no session cookie', async () => {
        const app = createDriverApiApp({ withSession: false });
        const res = await request(app)
            .post(`/api/driver/${TOKEN}/orders/${ORDER_ID}/complete`)
            .send({});
        expect(res.status).toBe(200);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/driver/:token/orders/:orderId/skip — 200 with valid token and no session cookie', async () => {
        const app = createDriverApiApp({ withSession: false });
        const res = await request(app)
            .post(`/api/driver/${TOKEN}/orders/${ORDER_ID}/skip`)
            .send({});
        expect(res.status).toBe(200);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/driver/:token/orders/:orderId/pod — 200 with valid token and no session cookie', async () => {
        const app = createDriverApiApp({ withSession: false });
        const res = await request(app)
            .post(`/api/driver/${TOKEN}/orders/${ORDER_ID}/pod`)
            .attach('photo', Buffer.from('fake-image-data'), 'delivery.jpg');
        expect(res.status).toBe(200);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/driver/:token/finish — 200 with valid token and no session cookie', async () => {
        const app = createDriverApiApp({ withSession: false });
        const res = await request(app)
            .post(`/api/driver/${TOKEN}/finish`)
            .send({ driverName: 'Jane Driver' });
        expect(res.status).toBe(200);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.body.success).toBe(true);
    });
});
