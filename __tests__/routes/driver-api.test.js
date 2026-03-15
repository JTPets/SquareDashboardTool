/**
 * Driver API Routes Test Suite
 *
 * Tests for public driver endpoints and authenticated token management:
 * - Generate/get/revoke shareable tokens (authenticated)
 * - Get route, complete/skip orders, upload POD, finish route (public)
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/delivery', () => ({
    generateRouteToken: jest.fn(),
    getActiveRouteToken: jest.fn(),
    revokeRouteToken: jest.fn(),
    getRouteOrdersByToken: jest.fn(),
    completeOrderByToken: jest.fn(),
    skipOrderByToken: jest.fn(),
    savePodByToken: jest.fn(),
    finishRouteByToken: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
}));

jest.mock('../../middleware/security', () => ({
    configureDeliveryRateLimit: () => (req, res, next) => next(),
    configureDeliveryStrictRateLimit: () => (req, res, next) => next(),
}));

jest.mock('../../utils/file-validation', () => ({
    validateUploadedImage: () => (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const deliveryApi = require('../../services/delivery');

const VALID_TOKEN = 'a'.repeat(64);

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/driver-api'));
    return app;
}

describe('Driver API Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    // ==================== AUTHENTICATED ENDPOINTS ====================

    describe('POST /api/delivery/route/:id/share', () => {
        it('should generate a shareable token', async () => {
            const mockToken = { id: 1, token: VALID_TOKEN, expires_at: '2026-03-16T00:00:00Z' };
            deliveryApi.generateRouteToken.mockResolvedValueOnce(mockToken);

            const res = await request(app)
                .post('/api/delivery/route/5/share')
                .send({ expiresInHours: 48 })
                .expect(200);

            expect(res.body.token).toEqual(mockToken);
            expect(res.body.shareUrl).toContain(`token=${VALID_TOKEN}`);
            expect(res.body.expiresAt).toBe('2026-03-16T00:00:00Z');
            expect(deliveryApi.generateRouteToken).toHaveBeenCalledWith(1, '5', 1, { expiresInHours: 48 });
        });

        it('should default to 24-hour expiration', async () => {
            const mockToken = { id: 1, token: VALID_TOKEN, expires_at: '2026-03-16T00:00:00Z' };
            deliveryApi.generateRouteToken.mockResolvedValueOnce(mockToken);

            await request(app)
                .post('/api/delivery/route/5/share')
                .send({})
                .expect(200);

            expect(deliveryApi.generateRouteToken).toHaveBeenCalledWith(1, '5', 1, { expiresInHours: 24 });
        });
    });

    describe('GET /api/delivery/route/:id/token', () => {
        it('should return active token with share URL', async () => {
            const mockToken = { id: 1, token: VALID_TOKEN };
            deliveryApi.getActiveRouteToken.mockResolvedValueOnce(mockToken);

            const res = await request(app)
                .get('/api/delivery/route/5/token')
                .expect(200);

            expect(res.body.token).toEqual(mockToken);
            expect(res.body.shareUrl).toContain('driver.html');
        });

        it('should return null token when none active', async () => {
            deliveryApi.getActiveRouteToken.mockResolvedValueOnce(null);

            const res = await request(app)
                .get('/api/delivery/route/5/token')
                .expect(200);

            expect(res.body.token).toBeNull();
        });
    });

    describe('DELETE /api/delivery/route/:id/token', () => {
        it('should revoke active token', async () => {
            const mockToken = { id: 10, token: VALID_TOKEN };
            deliveryApi.getActiveRouteToken.mockResolvedValueOnce(mockToken);
            deliveryApi.revokeRouteToken.mockResolvedValueOnce();

            const res = await request(app)
                .delete('/api/delivery/route/5/token')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(deliveryApi.revokeRouteToken).toHaveBeenCalledWith(1, 10);
        });

        it('should succeed even when no active token exists', async () => {
            deliveryApi.getActiveRouteToken.mockResolvedValueOnce(null);

            const res = await request(app)
                .delete('/api/delivery/route/5/token')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(deliveryApi.revokeRouteToken).not.toHaveBeenCalled();
        });
    });

    // ==================== PUBLIC ENDPOINTS ====================

    describe('GET /api/driver/:token', () => {
        it('should return route data for valid token', async () => {
            deliveryApi.getRouteOrdersByToken.mockResolvedValueOnce({
                valid: true,
                route_date: '2026-03-15',
                total_stops: 5,
                total_distance_km: 12.5,
                estimated_duration_min: 45,
                merchant_name: 'Test Store',
                orders: [
                    {
                        id: 1, route_position: 1, customer_name: 'John',
                        address: '123 Main St', phone: '555-1234', notes: null,
                        customer_note: null, status: 'pending', pod_photo_path: null,
                        square_order_data: {},
                    },
                ],
            });

            const res = await request(app)
                .get(`/api/driver/${VALID_TOKEN}`)
                .expect(200);

            expect(res.body.route.totalStops).toBe(5);
            expect(res.body.orders).toHaveLength(1);
            expect(res.body.orders[0].customerName).toBe('John');
            expect(res.body.orders[0].hasPod).toBe(false);
        });

        it('should return 404 for invalid token', async () => {
            deliveryApi.getRouteOrdersByToken.mockResolvedValueOnce(null);

            const res = await request(app)
                .get(`/api/driver/${VALID_TOKEN}`)
                .expect(404);

            expect(res.body.error).toBe('Invalid token');
        });

        it('should return 403 for expired token', async () => {
            deliveryApi.getRouteOrdersByToken.mockResolvedValueOnce({
                valid: false,
                reason: 'Token expired',
            });

            const res = await request(app)
                .get(`/api/driver/${VALID_TOKEN}`)
                .expect(403);

            expect(res.body.error).toBe('Token expired');
        });
    });

    describe('POST /api/driver/:token/orders/:orderId/complete', () => {
        it('should mark order as completed', async () => {
            deliveryApi.completeOrderByToken.mockResolvedValueOnce({ id: 1, status: 'completed' });

            const res = await request(app)
                .post(`/api/driver/${VALID_TOKEN}/orders/1/complete`)
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.order.status).toBe('completed');
        });
    });

    describe('POST /api/driver/:token/orders/:orderId/skip', () => {
        it('should skip an order', async () => {
            deliveryApi.skipOrderByToken.mockResolvedValueOnce({ id: 1, status: 'skipped' });

            const res = await request(app)
                .post(`/api/driver/${VALID_TOKEN}/orders/1/skip`)
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.order.status).toBe('skipped');
        });
    });

    describe('POST /api/driver/:token/orders/:orderId/pod', () => {
        it('should reject request with no photo', async () => {
            const res = await request(app)
                .post(`/api/driver/${VALID_TOKEN}/orders/1/pod`)
                .expect(400);

            expect(res.body.error).toBe('No photo uploaded');
        });
    });

    describe('POST /api/driver/:token/finish', () => {
        it('should finish route', async () => {
            const mockResult = { completedOrders: 5, skippedOrders: 0 };
            deliveryApi.finishRouteByToken.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post(`/api/driver/${VALID_TOKEN}/finish`)
                .send({ driverName: 'Bob', driverNotes: 'All delivered' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.result).toEqual(mockResult);
            expect(res.body.message).toContain('Thank you');
        });
    });
});
