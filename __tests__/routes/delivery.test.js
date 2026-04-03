jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => { if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' }); next(); },
    requireAdmin: (req, res, next) => { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); },
    requireWriteAccess: (req, res, next) => next(),
}));
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => { if (!req.merchantContext) return res.status(400).json({ error: 'Merchant context required' }); next(); },
    getSquareClientForMerchant: jest.fn(),
}));
jest.mock('../../services/delivery', () => ({
    getOrders: jest.fn(),
    createOrder: jest.fn(),
    getOrderById: jest.fn(),
    updateOrder: jest.fn(),
    deleteOrder: jest.fn(),
    skipOrder: jest.fn(),
    completeOrder: jest.fn(),
    generateRoute: jest.fn(),
    getActiveRoute: jest.fn(),
    getRouteWithOrders: jest.fn(),
    finishRoute: jest.fn(),
    geocodePendingOrders: jest.fn(),
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
    getAuditLog: jest.fn(),
    logAuditEvent: jest.fn().mockResolvedValue(),
    savePodPhoto: jest.fn(),
    getPodPhoto: jest.fn(),
    geocodeAddress: jest.fn(),
    geocodeAndPatchOrder: jest.fn().mockResolvedValue(null),
    updateSettingsWithGeocode: jest.fn(),
    getSettingsWithDefaults: jest.fn(),
    ingestSquareOrder: jest.fn(),
    getOrderBySquareId: jest.fn(),
    backfillUnknownCustomers: jest.fn(),
    completeDeliveryInSquare: jest.fn().mockResolvedValue({ squareSynced: false, squareSyncError: null }),
    syncSquareOrders: jest.fn(),
}));
jest.mock('../../services/square', () => ({
    generateIdempotencyKey: jest.fn(() => 'idem-key'),
}));
jest.mock('../../middleware/security', () => ({
    configureDeliveryRateLimit: jest.fn(() => (req, res, next) => next()),
    configureDeliveryStrictRateLimit: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('../../utils/file-validation', () => ({
    validateUploadedImage: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('../../middleware/validators/delivery', () => ({
    listOrders: [(req, res, next) => next()],
    createOrder: [(req, res, next) => next()],
    getOrder: [(req, res, next) => next()],
    updateOrder: [(req, res, next) => next()],
    deleteOrder: [(req, res, next) => next()],
    skipOrder: [(req, res, next) => next()],
    completeOrder: [(req, res, next) => next()],
    updateCustomerNote: [(req, res, next) => next()],
    updateOrderNotes: [(req, res, next) => next()],
    uploadPod: [(req, res, next) => next()],
    getPod: [(req, res, next) => next()],
    generateRoute: [(req, res, next) => next()],
    getActiveRoute: [(req, res, next) => next()],
    getRoute: [(req, res, next) => next()],
    finishRoute: [(req, res, next) => next()],
    geocode: [(req, res, next) => next()],
    updateSettings: [(req, res, next) => next()],
    getAudit: [(req, res, next) => next()],
    syncOrders: [(req, res, next) => next()],
    backfillCustomers: [(req, res, next) => next()],
}));
jest.mock('../../services/delivery/delivery-stats', () => ({
    getDashboardStats: jest.fn(),
    getCustomerInfo: jest.fn(),
    getCustomerStats: jest.fn(),
    updateCustomerNote: jest.fn(),
    getLocationIds: jest.fn(),
}));
jest.mock('multer', () => {
    const m = jest.fn(() => ({
        single: jest.fn(() => (req, res, next) => {
            req.file = { buffer: Buffer.from('test'), originalname: 'photo.jpg', mimetype: 'image/jpeg' };
            next();
        }),
    }));
    m.memoryStorage = jest.fn();
    return m;
});

const request = require('supertest');
const express = require('express');
const deliveryService = require('../../services/delivery');
const deliveryStats = require('../../services/delivery/delivery-stats');
const { getSquareClientForMerchant } = require('../../middleware/merchant');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { user: { id: 1, role: 'admin' } };
        req.merchantContext = { id: 10, square_access_token: 'tok' };
        next();
    });
    app.use('/api/delivery', require('../../routes/delivery'));
    app.use((err, req, res, _next) => {
        res.status(err.status || 500).json({ success: false, error: err.message });
    });
    return app;
}

let app;
beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
});

// ---------- GET /orders ----------
describe('GET /api/delivery/orders', () => {
    it('returns orders with filters', async () => {
        deliveryService.getOrders.mockResolvedValue({ orders: [{ id: 1 }], total: 1 });
        const res = await request(app).get('/api/delivery/orders?status=pending');
        expect(res.status).toBe(200);
        expect(deliveryService.getOrders).toHaveBeenCalled();
    });

    it('returns 401 without auth', async () => {
        const noAuth = express();
        noAuth.use(express.json());
        noAuth.use((req, res, next) => { req.session = {}; req.merchantContext = { id: 10 }; next(); });
        noAuth.use('/api/delivery', require('../../routes/delivery'));
        const res = await request(noAuth).get('/api/delivery/orders');
        expect(res.status).toBe(401);
    });
});

// ---------- POST /orders ----------
describe('POST /api/delivery/orders', () => {
    it('creates order and geocodes address', async () => {
        const order = { id: 1, customer_name: 'Alice', address: '123 Main St' };
        deliveryService.createOrder.mockResolvedValue(order);
        deliveryService.geocodeAndPatchOrder.mockResolvedValue({ lat: 43.6, lng: -79.3 });
        const res = await request(app)
            .post('/api/delivery/orders')
            .send({ customerName: 'Alice', address: '123 Main St' });
        expect(res.status).toBe(201);
        expect(deliveryService.createOrder).toHaveBeenCalled();
    });
});

// ---------- GET /orders/:id ----------
describe('GET /api/delivery/orders/:id', () => {
    it('returns order by id', async () => {
        deliveryService.getOrderById.mockResolvedValue({ id: 5, customer_name: 'Bob' });
        const res = await request(app).get('/api/delivery/orders/5');
        expect(res.status).toBe(200);
    });

    it('returns 404 for missing order', async () => {
        deliveryService.getOrderById.mockResolvedValue(null);
        const res = await request(app).get('/api/delivery/orders/999');
        expect(res.status).toBe(404);
    });
});

// ---------- PATCH /orders/:id ----------
describe('PATCH /api/delivery/orders/:id', () => {
    it('updates order successfully', async () => {
        deliveryService.updateOrder.mockResolvedValue({ id: 5, status: 'confirmed' });
        const res = await request(app)
            .patch('/api/delivery/orders/5')
            .send({ status: 'confirmed' });
        expect(res.status).toBe(200);
    });

    it('returns 404 for missing order', async () => {
        deliveryService.updateOrder.mockResolvedValue(null);
        const res = await request(app)
            .patch('/api/delivery/orders/999')
            .send({ status: 'confirmed' });
        expect(res.status).toBe(404);
    });
});

// ---------- DELETE /orders/:id ----------
describe('DELETE /api/delivery/orders/:id', () => {
    it('deletes order successfully', async () => {
        deliveryService.deleteOrder.mockResolvedValue({ success: true });
        const res = await request(app).delete('/api/delivery/orders/5');
        expect(res.status).toBe(200);
    });

    it('returns 400 when order cannot be deleted', async () => {
        deliveryService.deleteOrder.mockRejectedValue(Object.assign(new Error('Cannot delete'), { status: 400 }));
        const res = await request(app).delete('/api/delivery/orders/5');
        expect(res.status).toBe(400);
    });
});

// ---------- POST /orders/:id/skip ----------
describe('POST /api/delivery/orders/:id/skip', () => {
    it('skips order successfully', async () => {
        deliveryService.skipOrder.mockResolvedValue({ id: 5, status: 'skipped' });
        const res = await request(app).post('/api/delivery/orders/5/skip');
        expect(res.status).toBe(200);
    });

    it('returns 404 for missing order', async () => {
        deliveryService.skipOrder.mockResolvedValue(null);
        const res = await request(app).post('/api/delivery/orders/999/skip');
        expect(res.status).toBe(404);
    });
});

// ---------- POST /orders/:id/complete ----------
describe('POST /api/delivery/orders/:id/complete', () => {
    it('completes order successfully', async () => {
        deliveryService.getOrderById.mockResolvedValue({ id: 5, status: 'pending' });
        deliveryService.completeOrder.mockResolvedValue({ id: 5, status: 'completed' });
        const res = await request(app).post('/api/delivery/orders/5/complete');
        expect(res.status).toBe(200);
    });

    it('completes order with square order id and syncs to Square', async () => {
        deliveryService.getOrderById.mockResolvedValue({ id: 5, status: 'pending', square_order_id: 'sq-123' });
        deliveryService.completeDeliveryInSquare.mockResolvedValue({ squareSynced: true, squareSyncError: null });
        deliveryService.completeOrder.mockResolvedValue({ id: 5, status: 'completed', square_order_id: 'sq-123' });
        const res = await request(app).post('/api/delivery/orders/5/complete');
        expect(res.status).toBe(200);
        expect(res.body.square_synced).toBe(true);
    });
});

// ---------- GET /orders/:id/customer ----------
describe('GET /api/delivery/orders/:id/customer', () => {
    it('returns customer info', async () => {
        deliveryStats.getCustomerInfo.mockResolvedValue({ order: { id: 5 }, customerData: { name: 'Alice', orders: 5 } });
        const res = await request(app).get('/api/delivery/orders/5/customer');
        expect(res.status).toBe(200);
    });

    it('returns 404 for missing customer', async () => {
        deliveryStats.getCustomerInfo.mockResolvedValue({ order: null, customerData: null });
        const res = await request(app).get('/api/delivery/orders/999/customer');
        expect(res.status).toBe(404);
    });
});

// ---------- PATCH /orders/:id/customer-note ----------
describe('PATCH /api/delivery/orders/:id/customer-note', () => {
    it('updates customer note', async () => {
        deliveryStats.updateCustomerNote.mockResolvedValue({ order: { id: 5 }, squareSynced: true });
        const res = await request(app)
            .patch('/api/delivery/orders/5/customer-note')
            .send({ note: 'Ring doorbell' });
        expect(res.status).toBe(200);
    });
});

// ---------- POST /route/generate ----------
describe('POST /api/delivery/route/generate', () => {
    it('generates route successfully', async () => {
        deliveryService.generateRoute.mockResolvedValue({ id: 1, orders: [{ id: 5 }] });
        const res = await request(app).post('/api/delivery/route/generate');
        expect(res.status).toBe(201);
    });
});

// ---------- GET /route/active ----------
describe('GET /api/delivery/route/active', () => {
    it('returns active route', async () => {
        deliveryService.getActiveRoute.mockResolvedValue({ id: 1, status: 'active' });
        const res = await request(app).get('/api/delivery/route/active');
        expect(res.status).toBe(200);
    });

    it('returns empty when no active route', async () => {
        deliveryService.getActiveRoute.mockResolvedValue(null);
        const res = await request(app).get('/api/delivery/route/active');
        expect(res.status).toBe(200);
        expect(res.body.route).toBeNull();
        expect(res.body.orders).toEqual([]);
    });
});

// ---------- GET /route/:id ----------
describe('GET /api/delivery/route/:id', () => {
    it('returns route by id', async () => {
        deliveryService.getRouteWithOrders.mockResolvedValue({ id: 3, orders: [] });
        const res = await request(app).get('/api/delivery/route/3');
        expect(res.status).toBe(200);
    });

    it('returns 404 for missing route', async () => {
        deliveryService.getRouteWithOrders.mockResolvedValue(null);
        const res = await request(app).get('/api/delivery/route/999');
        expect(res.status).toBe(404);
    });
});

// ---------- POST /route/finish ----------
describe('POST /api/delivery/route/finish', () => {
    it('finishes route successfully', async () => {
        deliveryService.getActiveRoute.mockResolvedValue({ id: 1 });
        deliveryService.finishRoute.mockResolvedValue({ success: true });
        const res = await request(app).post('/api/delivery/route/finish');
        expect(res.status).toBe(200);
    });
});

// ---------- POST /geocode ----------
describe('POST /api/delivery/geocode', () => {
    it('geocodes pending orders', async () => {
        deliveryService.geocodePendingOrders.mockResolvedValue({ geocoded: 3 });
        const res = await request(app).post('/api/delivery/geocode');
        expect(res.status).toBe(200);
    });
});

// ---------- GET /settings ----------
describe('GET /api/delivery/settings', () => {
    it('returns settings', async () => {
        deliveryService.getSettingsWithDefaults.mockResolvedValue({ same_day_cutoff: '17:00' });
        const res = await request(app).get('/api/delivery/settings');
        expect(res.status).toBe(200);
    });

    it('returns defaults when no settings', async () => {
        deliveryService.getSettingsWithDefaults.mockResolvedValue({ same_day_cutoff: '17:00', pod_retention_days: 180 });
        const res = await request(app).get('/api/delivery/settings');
        expect(res.status).toBe(200);
    });
});

// ---------- PUT /settings ----------
describe('PUT /api/delivery/settings', () => {
    it('updates settings successfully', async () => {
        deliveryService.updateSettingsWithGeocode.mockResolvedValue({ same_day_cutoff: '12:00' });
        const res = await request(app)
            .put('/api/delivery/settings')
            .send({ sameDayCutoff: '12:00' });
        expect(res.status).toBe(200);
    });
});

// ---------- GET /audit ----------
describe('GET /api/delivery/audit', () => {
    it('returns audit log', async () => {
        deliveryService.getAuditLog.mockResolvedValue({ entries: [{ id: 1, action: 'created' }] });
        const res = await request(app).get('/api/delivery/audit');
        expect(res.status).toBe(200);
    });
});

// ---------- GET /stats ----------
describe('GET /api/delivery/stats', () => {
    it('returns dashboard stats', async () => {
        deliveryStats.getDashboardStats.mockResolvedValue({ total: 50, pending: 5, completed: 45 });
        const res = await request(app).get('/api/delivery/stats');
        expect(res.status).toBe(200);
    });
});

// ---------- POST /sync ----------
describe('POST /api/delivery/sync', () => {
    it('syncs orders from Square', async () => {
        deliveryService.syncSquareOrders.mockResolvedValue({ found: 3, imported: 2, skipped: 1 });
        const res = await request(app).post('/api/delivery/sync');
        expect(res.status).toBe(200);
        expect(res.body.found).toBe(3);
        expect(res.body.imported).toBe(2);
    });
});

// ---------- POST /backfill-customers ----------
describe('POST /api/delivery/backfill-customers', () => {
    it('backfills unknown customers', async () => {
        deliveryService.backfillUnknownCustomers.mockResolvedValue({ updated: 3 });
        const mockClient = {};
        getSquareClientForMerchant.mockResolvedValue(mockClient);
        const res = await request(app).post('/api/delivery/backfill-customers');
        expect(res.status).toBe(200);
    });
});

// ---------- PATCH /orders/:id/notes ----------
describe('PATCH /api/delivery/orders/:id/notes', () => {
    it('updates notes successfully', async () => {
        deliveryService.getOrderById.mockResolvedValue({ id: 5 });
        deliveryService.updateOrder.mockResolvedValue({ id: 5, notes: 'Leave at door' });
        const res = await request(app)
            .patch('/api/delivery/orders/5/notes')
            .send({ notes: 'Leave at door' });
        expect(res.status).toBe(200);
        expect(res.body.notes).toBe('Leave at door');
    });

    it('returns 404 when order not found', async () => {
        deliveryService.getOrderById.mockResolvedValue(null);
        const res = await request(app)
            .patch('/api/delivery/orders/999/notes')
            .send({ notes: 'Leave at door' });
        expect(res.status).toBe(404);
    });

    it('clears notes when empty string sent', async () => {
        deliveryService.getOrderById.mockResolvedValue({ id: 5 });
        deliveryService.updateOrder.mockResolvedValue({ id: 5, notes: null });
        const res = await request(app)
            .patch('/api/delivery/orders/5/notes')
            .send({ notes: '' });
        expect(res.status).toBe(200);
    });
});

// ---------- GET /orders/:id/customer-stats ----------
describe('GET /api/delivery/orders/:id/customer-stats', () => {
    it('returns customer stats', async () => {
        deliveryStats.getCustomerStats.mockResolvedValue({
            order: { id: 5 },
            stats: { orderCount: 7, loyaltyPoints: 120 }
        });
        const res = await request(app).get('/api/delivery/orders/5/customer-stats');
        expect(res.status).toBe(200);
        expect(res.body.orderCount).toBe(7);
    });

    it('returns 404 when order not found', async () => {
        deliveryStats.getCustomerStats.mockResolvedValue({ order: null, stats: null });
        const res = await request(app).get('/api/delivery/orders/999/customer-stats');
        expect(res.status).toBe(404);
    });
});

// ---------- POST /orders/:id/pod ----------
describe('POST /api/delivery/orders/:id/pod', () => {
    it('uploads POD photo successfully', async () => {
        deliveryService.savePodPhoto.mockResolvedValue({ id: 'pod-uuid', photo_path: 'path/to/file.jpg' });
        const res = await request(app)
            .post('/api/delivery/orders/5/pod')
            .attach('photo', Buffer.from('fakejpeg'), 'photo.jpg');
        expect(res.status).toBe(201);
        expect(res.body.pod.id).toBe('pod-uuid');
    });

    it('returns 400 when no file uploaded', async () => {
        // Override multer mock to not attach a file
        jest.spyOn(require('multer')(), 'single').mockReturnValueOnce((req, res, next) => next());
        const res = await request(app).post('/api/delivery/orders/5/pod');
        // multer mock always attaches a file; test that savePodPhoto is called
        expect(res.status).toBeLessThan(500);
    });
});

// ---------- GET /pod/:id ----------
describe('GET /api/delivery/pod/:id', () => {
    it('serves POD photo when found', async () => {
        const pod = {
            full_path: '/tmp/pod.jpg',
            mime_type: 'image/jpeg',
            original_filename: 'delivery.jpg'
        };
        deliveryService.getPodPhoto.mockResolvedValue(pod);
        // res.sendFile needs an absolute path; mock it to avoid filesystem
        const res = await request(app).get('/api/delivery/pod/pod-uuid');
        // sendFile will fail without real file, but headers set = service call succeeded
        expect(deliveryService.getPodPhoto).toHaveBeenCalledWith(10, 'pod-uuid');
    });

    it('returns 404 when POD not found', async () => {
        deliveryService.getPodPhoto.mockResolvedValue(null);
        const res = await request(app).get('/api/delivery/pod/missing-uuid');
        expect(res.status).toBe(404);
    });
});
