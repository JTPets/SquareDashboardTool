/**
 * Webhook Management Routes Test Suite
 *
 * Tests for webhook subscription CRUD operations:
 * - List, create, update, delete webhook subscriptions
 * - Audit webhook configuration
 * - Send test webhook events
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/square-webhooks', () => ({
    listWebhookSubscriptions: jest.fn(),
    auditWebhookConfiguration: jest.fn(),
    createWebhookSubscription: jest.fn(),
    ensureWebhookSubscription: jest.fn(),
    updateWebhookSubscription: jest.fn(),
    deleteWebhookSubscription: jest.fn(),
    testWebhookSubscription: jest.fn(),
    WEBHOOK_EVENT_TYPES: { inventory: ['inventory.count.updated'] },
    getAllEventTypes: jest.fn(() => ['inventory.count.updated']),
    getRecommendedEventTypes: jest.fn(() => ['inventory.count.updated']),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const squareWebhooks = require('../../utils/square-webhooks');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
        req.session.user = { id: 1, email: 'test@example.com', role: 'admin' };
        req.merchantContext = { id: 1, business_name: 'Test Store' };
        next();
    });
    app.use('/api', require('../../routes/webhooks'));
    return app;
}

describe('Webhook Routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
    });

    describe('GET /api/webhooks/subscriptions', () => {
        it('should list webhook subscriptions', async () => {
            const mockSubs = [{ id: 'sub_1', name: 'Test', enabled: true }];
            squareWebhooks.listWebhookSubscriptions.mockResolvedValueOnce(mockSubs);

            const res = await request(app)
                .get('/api/webhooks/subscriptions')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.subscriptions).toEqual(mockSubs);
            expect(res.body.count).toBe(1);
            expect(squareWebhooks.listWebhookSubscriptions).toHaveBeenCalledWith(1);
        });

        it('should return empty array when no subscriptions', async () => {
            squareWebhooks.listWebhookSubscriptions.mockResolvedValueOnce([]);

            const res = await request(app)
                .get('/api/webhooks/subscriptions')
                .expect(200);

            expect(res.body.subscriptions).toEqual([]);
            expect(res.body.count).toBe(0);
        });
    });

    describe('GET /api/webhooks/subscriptions/audit', () => {
        it('should return audit results', async () => {
            const mockAudit = { missing: ['order.created'], extra: [], subscriptionCount: 1 };
            squareWebhooks.auditWebhookConfiguration.mockResolvedValueOnce(mockAudit);

            const res = await request(app)
                .get('/api/webhooks/subscriptions/audit')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.missing).toEqual(['order.created']);
            expect(squareWebhooks.auditWebhookConfiguration).toHaveBeenCalledWith(1);
        });
    });

    describe('GET /api/webhooks/event-types', () => {
        it('should return event types', async () => {
            const res = await request(app)
                .get('/api/webhooks/event-types')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.eventTypes).toBeDefined();
            expect(res.body.all).toBeDefined();
            expect(res.body.recommended).toBeDefined();
        });
    });

    describe('POST /api/webhooks/register', () => {
        it('should register a new subscription', async () => {
            const mockSub = { id: 'sub_new', name: 'My Webhook' };
            squareWebhooks.createWebhookSubscription.mockResolvedValueOnce(mockSub);

            const res = await request(app)
                .post('/api/webhooks/register')
                .send({ notificationUrl: 'https://example.com/webhook', name: 'My Webhook' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.subscription).toEqual(mockSub);
            expect(res.body.nextSteps).toBeDefined();
            expect(squareWebhooks.createWebhookSubscription).toHaveBeenCalledWith(1, {
                notificationUrl: 'https://example.com/webhook',
                eventTypes: undefined,
                name: 'My Webhook',
            });
        });
    });

    describe('POST /api/webhooks/ensure', () => {
        it('should ensure subscription exists', async () => {
            const mockSub = { id: 'sub_1', created_at: '2026-01-01' };
            squareWebhooks.ensureWebhookSubscription.mockResolvedValueOnce(mockSub);

            const res = await request(app)
                .post('/api/webhooks/ensure')
                .send({ notificationUrl: 'https://example.com/webhook' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('already exists');
        });

        it('should report new subscription created', async () => {
            const mockSub = { id: 'sub_new' };
            squareWebhooks.ensureWebhookSubscription.mockResolvedValueOnce(mockSub);

            const res = await request(app)
                .post('/api/webhooks/ensure')
                .send({ notificationUrl: 'https://example.com/webhook' })
                .expect(200);

            expect(res.body.message).toContain('New webhook subscription created');
        });
    });

    describe('PUT /api/webhooks/subscriptions/:subscriptionId', () => {
        it('should update subscription', async () => {
            const mockSub = { id: 'sub_1', enabled: false };
            squareWebhooks.updateWebhookSubscription.mockResolvedValueOnce(mockSub);

            const res = await request(app)
                .put('/api/webhooks/subscriptions/sub_1')
                .send({ enabled: false })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.subscription).toEqual(mockSub);
        });

        it('should reject empty update body', async () => {
            const res = await request(app)
                .put('/api/webhooks/subscriptions/sub_1')
                .send({})
                .expect(400);

            expect(res.body.error).toContain('No updates provided');
        });
    });

    describe('DELETE /api/webhooks/subscriptions/:subscriptionId', () => {
        it('should delete subscription', async () => {
            squareWebhooks.deleteWebhookSubscription.mockResolvedValueOnce();

            const res = await request(app)
                .delete('/api/webhooks/subscriptions/sub_1')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(squareWebhooks.deleteWebhookSubscription).toHaveBeenCalledWith(1, 'sub_1');
        });
    });

    describe('POST /api/webhooks/subscriptions/:subscriptionId/test', () => {
        it('should send test event', async () => {
            const mockResult = { statusCode: 200 };
            squareWebhooks.testWebhookSubscription.mockResolvedValueOnce(mockResult);

            const res = await request(app)
                .post('/api/webhooks/subscriptions/sub_1/test')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.result).toEqual(mockResult);
            expect(squareWebhooks.testWebhookSubscription).toHaveBeenCalledWith(1, 'sub_1');
        });
    });
});
