/**
 * Tests for webhook-processor service
 */

// Mock additional dependencies (logger and database are mocked in setup.js)
jest.mock('../../utils/subscription-handler', () => ({
    logEvent: jest.fn().mockResolvedValue()
}));

jest.mock('../../utils/webhook-retry', () => ({
    markForRetry: jest.fn().mockResolvedValue()
}));

jest.mock('../../services/webhook-handlers', () => ({
    routeEvent: jest.fn().mockResolvedValue({ handled: false })
}));

const webhookProcessor = require('../../services/webhook-processor');
const db = require('../../utils/database');
const { routeEvent } = require('../../services/webhook-handlers');
const subscriptionHandler = require('../../utils/subscription-handler');
const webhookRetry = require('../../utils/webhook-retry');

describe('WebhookProcessor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset environment variables
        delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
        delete process.env.SQUARE_WEBHOOK_URL;
        delete process.env.NODE_ENV;
    });

    describe('verifySignature', () => {
        it('should return true for valid signature', () => {
            const signatureKey = 'test-key';
            const notificationUrl = 'https://example.com/webhook';
            const rawBody = '{"type":"test"}';

            // Calculate expected signature
            const crypto = require('crypto');
            const hmac = crypto.createHmac('sha256', signatureKey);
            hmac.update(notificationUrl + rawBody);
            const expectedSignature = hmac.digest('base64');

            const result = webhookProcessor.verifySignature(
                expectedSignature,
                rawBody,
                notificationUrl,
                signatureKey
            );

            expect(result).toBe(true);
        });

        it('should return false for invalid signature', () => {
            const result = webhookProcessor.verifySignature(
                'invalid-signature',
                '{"type":"test"}',
                'https://example.com/webhook',
                'test-key'
            );

            expect(result).toBe(false);
        });

        it('should return false for tampered body', () => {
            const signatureKey = 'test-key';
            const notificationUrl = 'https://example.com/webhook';
            const originalBody = '{"type":"test"}';
            const tamperedBody = '{"type":"tampered"}';

            const crypto = require('crypto');
            const hmac = crypto.createHmac('sha256', signatureKey);
            hmac.update(notificationUrl + originalBody);
            const signature = hmac.digest('base64');

            const result = webhookProcessor.verifySignature(
                signature,
                tamperedBody,
                notificationUrl,
                signatureKey
            );

            expect(result).toBe(false);
        });
    });

    describe('isDuplicateEvent', () => {
        it('should return false for null eventId', async () => {
            const result = await webhookProcessor.isDuplicateEvent(null);
            expect(result).toBe(false);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('should return false for new event', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await webhookProcessor.isDuplicateEvent('new-event-id');

            expect(result).toBe(false);
            expect(db.query).toHaveBeenCalledWith(
                'SELECT id FROM webhook_events WHERE square_event_id = $1',
                ['new-event-id']
            );
        });

        it('should return true for existing event', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 123 }] });

            const result = await webhookProcessor.isDuplicateEvent('existing-event-id');

            expect(result).toBe(true);
        });
    });

    describe('logEvent', () => {
        it('should insert event and return id', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 456 }] });

            const event = {
                event_id: 'evt-123',
                type: 'catalog.version.updated',
                merchant_id: 'merch-123',
                data: { test: 'data' }
            };

            const result = await webhookProcessor.logEvent(event);

            expect(result).toBe(456);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO webhook_events'),
                ['evt-123', 'catalog.version.updated', 'merch-123', '{"test":"data"}']
            );
        });

        it('should return null when no id returned', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await webhookProcessor.logEvent({
                event_id: 'evt-123',
                type: 'test',
                merchant_id: null,
                data: {}
            });

            expect(result).toBeUndefined();
        });
    });

    describe('resolveMerchant', () => {
        it('should return null for null squareMerchantId', async () => {
            const result = await webhookProcessor.resolveMerchant(null);
            expect(result).toBeNull();
            expect(db.query).not.toHaveBeenCalled();
        });

        it('should return internal id for active merchant', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 42 }] });

            const result = await webhookProcessor.resolveMerchant('square-merchant-123');

            expect(result).toBe(42);
            expect(db.query).toHaveBeenCalledWith(
                'SELECT id FROM merchants WHERE square_merchant_id = $1 AND is_active = TRUE',
                ['square-merchant-123']
            );
        });

        it('should return null for unknown merchant', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await webhookProcessor.resolveMerchant('unknown-merchant');

            expect(result).toBeNull();
        });
    });

    describe('buildContext', () => {
        it('should build context with all fields including entityId', () => {
            const event = {
                type: 'catalog.version.updated',
                merchant_id: 'square-123',
                data: { id: 'entity-123', type: 'catalog', object: { id: 'item-1' } }
            };

            const context = webhookProcessor.buildContext(event, 42, 789, 1234567890);

            expect(context).toEqual({
                event,
                data: { id: 'item-1' },
                entityId: 'entity-123',
                entityType: 'catalog',
                merchantId: 42,
                squareMerchantId: 'square-123',
                webhookEventId: 789,
                startTime: 1234567890
            });
        });

        it('should handle missing data.object', () => {
            const event = {
                type: 'test',
                merchant_id: 'square-123',
                data: null
            };

            const context = webhookProcessor.buildContext(event, null, null, 0);

            expect(context.data).toEqual({});
            expect(context.entityId).toBeNull();
            expect(context.entityType).toBeNull();
        });

        // Regression test: Square places entity ID at event.data.id, not inside event.data.object
        // This was causing "Order webhook missing order ID - skipping" warnings
        it('should extract entityId from event.data.id for order webhooks', () => {
            // This is the actual Square webhook structure for order.created
            const event = {
                type: 'order.created',
                merchant_id: 'square-123',
                event_id: 'evt-456',
                data: {
                    type: 'order',
                    id: 'ORDER_ID_12345',  // <-- Canonical entity ID is HERE
                    object: {
                        order_created: {
                            // Square often sends minimal data here
                            created_at: '2026-01-29T12:00:00Z',
                            state: 'OPEN'
                            // Note: no 'id' field inside order_created
                        }
                    }
                }
            };

            const context = webhookProcessor.buildContext(event, 1, 100, Date.now());

            // entityId should be extracted from event.data.id
            expect(context.entityId).toBe('ORDER_ID_12345');
            expect(context.entityType).toBe('order');
            // data should be event.data.object (the wrapper)
            expect(context.data).toEqual({ order_created: { created_at: '2026-01-29T12:00:00Z', state: 'OPEN' } });
        });

        it('should extract entityId for payment webhooks', () => {
            const event = {
                type: 'payment.created',
                merchant_id: 'square-123',
                data: {
                    type: 'payment',
                    id: 'PAYMENT_ID_789',
                    object: {
                        payment: {
                            order_id: 'ORDER_123',
                            status: 'COMPLETED'
                        }
                    }
                }
            };

            const context = webhookProcessor.buildContext(event, 1, 100, Date.now());

            expect(context.entityId).toBe('PAYMENT_ID_789');
            expect(context.entityType).toBe('payment');
        });

        it('should extract entityId for customer webhooks', () => {
            const event = {
                type: 'customer.updated',
                merchant_id: 'square-123',
                data: {
                    type: 'customer',
                    id: 'CUSTOMER_ID_ABC',
                    object: {
                        customer: {
                            email_address: 'test@example.com'
                        }
                    }
                }
            };

            const context = webhookProcessor.buildContext(event, 1, 100, Date.now());

            expect(context.entityId).toBe('CUSTOMER_ID_ABC');
            expect(context.entityType).toBe('customer');
        });
    });

    describe('updateEventResults', () => {
        it('should skip update when webhookEventId is null', async () => {
            await webhookProcessor.updateEventResults(null, {}, 100);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('should update with completed status for success', async () => {
            db.query.mockResolvedValue();

            await webhookProcessor.updateEventResults(123, { items: 10 }, 150);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE webhook_events'),
                ['completed', '{"items":10}', 150, null, 123]
            );
        });

        it('should update with failed status on error', async () => {
            db.query.mockResolvedValue();

            await webhookProcessor.updateEventResults(123, { error: 'Something went wrong' }, 200);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE webhook_events'),
                ['failed', expect.any(String), 200, 'Something went wrong', 123]
            );
        });

        it('should update with skipped status when skipped', async () => {
            db.query.mockResolvedValue();

            await webhookProcessor.updateEventResults(123, { skipped: true }, 50);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE webhook_events'),
                ['skipped', expect.any(String), 50, null, 123]
            );
        });
    });

    describe('processWebhook', () => {
        let mockReq, mockRes;

        beforeEach(() => {
            mockReq = {
                headers: {},
                body: {
                    event_id: 'evt-123',
                    type: 'catalog.version.updated',
                    merchant_id: 'square-merchant-1',
                    data: { object: {} }
                }
            };
            mockRes = {
                json: jest.fn(),
                status: jest.fn().mockReturnThis()
            };

            // Default mock responses
            db.query
                .mockResolvedValueOnce({ rows: [] }) // isDuplicateEvent
                .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // logEvent
                .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // resolveMerchant
                .mockResolvedValue(); // updateEventResults

            routeEvent.mockResolvedValue({ handled: true, result: { synced: true } });
        });

        it('should skip signature verification in dev mode without key', async () => {
            process.env.NODE_ENV = 'development';

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(mockRes.json).toHaveBeenCalledWith(
                expect.objectContaining({ received: true })
            );
        });

        it('should reject in production without signature key', async () => {
            process.env.NODE_ENV = 'production';

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(500);
            expect(mockRes.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'Webhook verification not configured' })
            );
        });

        it('should reject when SQUARE_WEBHOOK_URL not set', async () => {
            process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'test-key';

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(500);
            expect(mockRes.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'Webhook URL not configured' })
            );
        });

        it('should reject invalid signature', async () => {
            process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'test-key';
            process.env.SQUARE_WEBHOOK_URL = 'https://example.com/webhook';
            mockReq.headers['x-square-hmacsha256-signature'] = 'invalid';

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
        });

        it('should return early for duplicate events', async () => {
            process.env.NODE_ENV = 'development';
            db.query.mockReset();
            db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // isDuplicateEvent returns existing

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(mockRes.json).toHaveBeenCalledWith({ received: true, duplicate: true });
            expect(routeEvent).not.toHaveBeenCalled();
        });

        it('should route event to handler', async () => {
            process.env.NODE_ENV = 'development';

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(routeEvent).toHaveBeenCalledWith(
                'catalog.version.updated',
                expect.objectContaining({
                    merchantId: 42,
                    squareMerchantId: 'square-merchant-1'
                })
            );
        });

        it('should log legacy subscription event', async () => {
            process.env.NODE_ENV = 'development';

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(subscriptionHandler.logEvent).toHaveBeenCalledWith({
                subscriberId: null,
                eventType: 'catalog.version.updated',
                eventData: mockReq.body.data,
                squareEventId: 'evt-123'
            });
        });

        it('should return 200 on processing errors to prevent Square retries', async () => {
            process.env.NODE_ENV = 'development';
            db.query.mockReset();
            db.query.mockRejectedValueOnce(new Error('Database error'));

            await webhookProcessor.processWebhook(mockReq, mockRes);

            // Returns 200 to Square to prevent automatic retries;
            // failed events are retried internally via webhook-retry job
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({ received: true, queued_for_retry: true });
        });

        it('should mark webhook for retry on error', async () => {
            process.env.NODE_ENV = 'development';
            db.query.mockReset(); // Clear mocks from beforeEach
            db.query
                .mockResolvedValueOnce({ rows: [] }) // isDuplicateEvent
                .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // logEvent
                .mockRejectedValueOnce(new Error('Processing failed')) // resolveMerchant throws
                .mockResolvedValue(); // retry update

            await webhookProcessor.processWebhook(mockReq, mockRes);

            expect(webhookRetry.markForRetry).toHaveBeenCalledWith(123, 'Processing failed');
        });
    });
});
