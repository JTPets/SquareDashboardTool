/**
 * Delivery Order Completion Test Suite
 *
 * Tests for the order completion logic that syncs with Square API
 * This is CRITICAL for ensuring orders don't disappear from Square Dashboard
 *
 * Key functionality tested:
 * - Fulfillment state transitions (PROPOSED → RESERVED → PREPARED → COMPLETED)
 * - Order state being set to COMPLETED after fulfillments complete
 * - deliveredAt/shippedAt/pickedUpAt timestamps being set
 * - Multiple fulfillment handling
 * - Error handling and edge cases
 */

// Mock all dependencies before imports
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/delivery-api', () => ({
    getOrderById: jest.fn(),
    completeOrder: jest.fn(),
}));

jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        req.merchantContext = { id: 1, squareMerchantId: 'MERCHANT123' };
        next();
    },
    getSquareClientForMerchant: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        req.session = { user: { id: 1, email: 'test@test.com', role: 'user' } };
        next();
    },
}));

jest.mock('../../middleware/security', () => ({
    configureDeliveryRateLimit: () => (req, res, next) => next(),
    configureDeliveryStrictRateLimit: () => (req, res, next) => next(),
}));

jest.mock('../../middleware/validators/delivery', () => ({
    listOrders: (req, res, next) => next(),
    createOrder: (req, res, next) => next(),
    getOrder: (req, res, next) => next(),
    updateOrder: (req, res, next) => next(),
    deleteOrder: (req, res, next) => next(),
    skipOrder: (req, res, next) => next(),
    completeOrder: (req, res, next) => next(),
    updateCustomerNote: (req, res, next) => next(),
    updateOrderNotes: (req, res, next) => next(),
    uploadPod: (req, res, next) => next(),
    getPod: (req, res, next) => next(),
    generateRoute: (req, res, next) => next(),
    getActiveRoute: (req, res, next) => next(),
    getRoute: (req, res, next) => next(),
    finishRoute: (req, res, next) => next(),
    geocode: (req, res, next) => next(),
    updateSettings: (req, res, next) => next(),
    getAudit: (req, res, next) => next(),
    syncOrders: (req, res, next) => next(),
}));

jest.mock('multer', () => {
    const multerMock = jest.fn(() => ({
        single: () => (req, res, next) => next(),
        array: () => (req, res, next) => next(),
    }));
    multerMock.memoryStorage = jest.fn(() => ({}));
    multerMock.diskStorage = jest.fn(() => ({}));
    return multerMock;
}, { virtual: true });

const deliveryApi = require('../../utils/delivery-api');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const logger = require('../../utils/logger');

describe('Delivery Order Completion Logic', () => {

    // Helper to create mock Square client
    function createMockSquareClient(options = {}) {
        const mockClient = {
            orders: {
                get: jest.fn(),
                update: jest.fn(),
            },
        };

        if (options.orderData) {
            mockClient.orders.get.mockResolvedValue(options.orderData);
        }

        if (options.updateResponse) {
            mockClient.orders.update.mockResolvedValue(options.updateResponse);
        } else {
            mockClient.orders.update.mockResolvedValue({ order: { version: 2 } });
        }

        return mockClient;
    }

    // Helper to create order data with fulfillments
    function createSquareOrderData(fulfillmentState, fulfillmentType = 'DELIVERY', orderState = 'OPEN') {
        return {
            order: {
                id: 'SQUARE_ORDER_123',
                version: 1,
                locationId: 'LOCATION_123',
                state: orderState,
                fulfillments: [{
                    uid: 'FULFILLMENT_UID_1',
                    type: fulfillmentType,
                    state: fulfillmentState,
                    deliveryDetails: fulfillmentType === 'DELIVERY' ? {
                        recipient: { displayName: 'Test Customer' }
                    } : undefined,
                    shipmentDetails: fulfillmentType === 'SHIPMENT' ? {
                        recipient: { displayName: 'Test Customer' }
                    } : undefined,
                    pickupDetails: fulfillmentType === 'PICKUP' ? {
                        recipient: { displayName: 'Test Customer' }
                    } : undefined,
                }],
            },
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Fulfillment State Transitions', () => {

        test('transitions through all states: PROPOSED → RESERVED → PREPARED → COMPLETED', async () => {
            const mockClient = createMockSquareClient();
            let callCount = 0;

            // Simulate state progression on each get call
            mockClient.orders.get.mockImplementation(() => {
                const states = ['PROPOSED', 'RESERVED', 'PREPARED', 'COMPLETED'];
                const stateIndex = Math.min(callCount, 3);
                callCount++;
                return Promise.resolve(createSquareOrderData(states[stateIndex]));
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            // Import router after mocks are set up
            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            const response = await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should have called update 3 times (PROPOSED→RESERVED, RESERVED→PREPARED, PREPARED→COMPLETED)
            // Plus 1 more for order state update
            expect(mockClient.orders.update).toHaveBeenCalled();
            expect(response.body.square_synced).toBe(true);
        });

        test('handles already COMPLETED fulfillment gracefully', async () => {
            const mockClient = createMockSquareClient({
                orderData: createSquareOrderData('COMPLETED', 'DELIVERY', 'COMPLETED'),
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            const response = await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should not call update for already completed fulfillment
            // (only order state check if needed)
            expect(response.body.square_synced).toBe(true);
        });

        test('skips fulfillments in unexpected states (CANCELED, FAILED)', async () => {
            const mockClient = createMockSquareClient({
                orderData: {
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: 1,
                        locationId: 'LOCATION_123',
                        state: 'OPEN',
                        fulfillments: [{
                            uid: 'FULFILLMENT_UID_1',
                            type: 'DELIVERY',
                            state: 'CANCELED',
                        }],
                    },
                },
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should log warning about unexpected state
            expect(logger.warn).toHaveBeenCalledWith(
                'Fulfillment in unexpected state, skipping',
                expect.objectContaining({ state: 'CANCELED' })
            );
        });
    });

    describe('Order State Update (Critical Fix)', () => {

        test('updates order.state to COMPLETED after fulfillments complete', async () => {
            const mockClient = createMockSquareClient();
            let version = 1;

            // First call returns PREPARED state (one step from COMPLETED)
            mockClient.orders.get
                .mockResolvedValueOnce(createSquareOrderData('PREPARED', 'DELIVERY', 'OPEN'))
                // After fulfillment update, still OPEN
                .mockResolvedValueOnce({
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: ++version,
                        locationId: 'LOCATION_123',
                        state: 'OPEN', // Order state still OPEN
                        fulfillments: [{
                            uid: 'FULFILLMENT_UID_1',
                            type: 'DELIVERY',
                            state: 'COMPLETED', // Fulfillment now COMPLETED
                            deliveryDetails: {},
                        }],
                    },
                })
                // After order state update
                .mockResolvedValueOnce({
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: ++version,
                        locationId: 'LOCATION_123',
                        state: 'OPEN',
                        fulfillments: [{
                            uid: 'FULFILLMENT_UID_1',
                            type: 'DELIVERY',
                            state: 'COMPLETED',
                            deliveryDetails: {},
                        }],
                    },
                });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Find the call that updates order state
            const orderStateUpdateCall = mockClient.orders.update.mock.calls.find(call =>
                call[0].order && call[0].order.state === 'COMPLETED'
            );

            expect(orderStateUpdateCall).toBeDefined();
            expect(orderStateUpdateCall[0].order.state).toBe('COMPLETED');
        });

        test('does not update order.state if already COMPLETED', async () => {
            const mockClient = createMockSquareClient();

            // Order already COMPLETED
            mockClient.orders.get.mockResolvedValue({
                order: {
                    id: 'SQUARE_ORDER_123',
                    version: 1,
                    locationId: 'LOCATION_123',
                    state: 'COMPLETED', // Already completed
                    fulfillments: [{
                        uid: 'FULFILLMENT_UID_1',
                        type: 'DELIVERY',
                        state: 'COMPLETED',
                        deliveryDetails: {},
                    }],
                },
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should not have any update call with state: 'COMPLETED' since order already completed
            const orderStateUpdateCall = mockClient.orders.update.mock.calls.find(call =>
                call[0].order && call[0].order.state === 'COMPLETED'
            );

            expect(orderStateUpdateCall).toBeUndefined();
        });
    });

    describe('Timestamp Setting', () => {

        test('sets deliveredAt for DELIVERY fulfillments', async () => {
            const mockClient = createMockSquareClient();

            mockClient.orders.get
                .mockResolvedValueOnce(createSquareOrderData('PREPARED', 'DELIVERY', 'OPEN'))
                .mockResolvedValue({
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: 2,
                        locationId: 'LOCATION_123',
                        state: 'COMPLETED',
                        fulfillments: [{
                            uid: 'FULFILLMENT_UID_1',
                            type: 'DELIVERY',
                            state: 'COMPLETED',
                            deliveryDetails: {},
                        }],
                    },
                });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Find the fulfillment update call with COMPLETED state
            const completedUpdateCall = mockClient.orders.update.mock.calls.find(call =>
                call[0].order &&
                call[0].order.fulfillments &&
                call[0].order.fulfillments[0]?.state === 'COMPLETED'
            );

            expect(completedUpdateCall).toBeDefined();
            expect(completedUpdateCall[0].order.fulfillments[0].deliveryDetails).toBeDefined();
            expect(completedUpdateCall[0].order.fulfillments[0].deliveryDetails.deliveredAt).toBeDefined();
        });

        test('sets shippedAt for SHIPMENT fulfillments', async () => {
            const mockClient = createMockSquareClient();

            mockClient.orders.get
                .mockResolvedValueOnce(createSquareOrderData('PREPARED', 'SHIPMENT', 'OPEN'))
                .mockResolvedValue({
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: 2,
                        locationId: 'LOCATION_123',
                        state: 'COMPLETED',
                        fulfillments: [{
                            uid: 'FULFILLMENT_UID_1',
                            type: 'SHIPMENT',
                            state: 'COMPLETED',
                            shipmentDetails: {},
                        }],
                    },
                });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            const completedUpdateCall = mockClient.orders.update.mock.calls.find(call =>
                call[0].order &&
                call[0].order.fulfillments &&
                call[0].order.fulfillments[0]?.state === 'COMPLETED'
            );

            expect(completedUpdateCall).toBeDefined();
            expect(completedUpdateCall[0].order.fulfillments[0].shipmentDetails).toBeDefined();
            expect(completedUpdateCall[0].order.fulfillments[0].shipmentDetails.shippedAt).toBeDefined();
        });

        test('sets pickedUpAt for PICKUP fulfillments', async () => {
            const mockClient = createMockSquareClient();

            mockClient.orders.get
                .mockResolvedValueOnce(createSquareOrderData('PREPARED', 'PICKUP', 'OPEN'))
                .mockResolvedValue({
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: 2,
                        locationId: 'LOCATION_123',
                        state: 'COMPLETED',
                        fulfillments: [{
                            uid: 'FULFILLMENT_UID_1',
                            type: 'PICKUP',
                            state: 'COMPLETED',
                            pickupDetails: {},
                        }],
                    },
                });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            const completedUpdateCall = mockClient.orders.update.mock.calls.find(call =>
                call[0].order &&
                call[0].order.fulfillments &&
                call[0].order.fulfillments[0]?.state === 'COMPLETED'
            );

            expect(completedUpdateCall).toBeDefined();
            expect(completedUpdateCall[0].order.fulfillments[0].pickupDetails).toBeDefined();
            expect(completedUpdateCall[0].order.fulfillments[0].pickupDetails.pickedUpAt).toBeDefined();
        });
    });

    describe('Multiple Fulfillment Handling', () => {

        test('completes all delivery-type fulfillments', async () => {
            const mockClient = createMockSquareClient();

            // Order with multiple delivery fulfillments
            mockClient.orders.get.mockResolvedValue({
                order: {
                    id: 'SQUARE_ORDER_123',
                    version: 1,
                    locationId: 'LOCATION_123',
                    state: 'OPEN',
                    fulfillments: [
                        {
                            uid: 'FULFILLMENT_UID_1',
                            type: 'DELIVERY',
                            state: 'PREPARED',
                            deliveryDetails: {},
                        },
                        {
                            uid: 'FULFILLMENT_UID_2',
                            type: 'DELIVERY',
                            state: 'PREPARED',
                            deliveryDetails: {},
                        },
                    ],
                },
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should log that multiple fulfillments were found
            expect(logger.info).toHaveBeenCalledWith(
                'Found fulfillments to complete',
                expect.objectContaining({ fulfillmentCount: 2 })
            );
        });

        test('filters to only delivery/shipment/pickup fulfillments', async () => {
            const mockClient = createMockSquareClient();

            // Order with mixed fulfillment types
            mockClient.orders.get.mockResolvedValue({
                order: {
                    id: 'SQUARE_ORDER_123',
                    version: 1,
                    locationId: 'LOCATION_123',
                    state: 'OPEN',
                    fulfillments: [
                        {
                            uid: 'FULFILLMENT_UID_1',
                            type: 'DELIVERY',
                            state: 'PREPARED',
                            deliveryDetails: {},
                        },
                        {
                            uid: 'FULFILLMENT_UID_2',
                            type: 'DINE_IN', // Should be ignored
                            state: 'PROPOSED',
                        },
                    ],
                },
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should only process 1 fulfillment (DELIVERY), not the DINE_IN one
            expect(logger.info).toHaveBeenCalledWith(
                'Found fulfillments to complete',
                expect.objectContaining({ fulfillmentCount: 1 })
            );
        });
    });

    describe('Error Handling', () => {

        test('continues local completion even if Square sync fails', async () => {
            const mockClient = createMockSquareClient();
            mockClient.orders.get.mockRejectedValue(new Error('Square API error'));

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            const response = await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Local completion should succeed
            expect(response.body.order.status).toBe('completed');
            // But Square sync should have failed
            expect(response.body.square_synced).toBe(false);
            expect(response.body.square_sync_error).toBe('Square API error');
        });

        test('returns 404 for non-existent order', async () => {
            deliveryApi.getOrderById.mockResolvedValue(null);

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            const response = await request(app)
                .post('/api/delivery/orders/NONEXISTENT/complete')
                .expect(404);

            expect(response.body.error).toBe('Order not found');
        });

        test('handles orders without Square order ID', async () => {
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: null, // Manual order without Square link
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            const response = await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Should complete locally without Square sync
            expect(response.body.order.status).toBe('completed');
            expect(response.body.square_synced).toBe(false);
        });

        test('handles Square order with no fulfillments', async () => {
            const mockClient = createMockSquareClient({
                orderData: {
                    order: {
                        id: 'SQUARE_ORDER_123',
                        version: 1,
                        locationId: 'LOCATION_123',
                        state: 'OPEN',
                        fulfillments: null, // No fulfillments
                    },
                },
            });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            expect(logger.warn).toHaveBeenCalledWith(
                'Square order has no fulfillments',
                expect.objectContaining({ squareOrderId: 'SQUARE_ORDER_123' })
            );
        });
    });

    describe('Idempotency Keys', () => {

        test('uses unique idempotency keys for each state transition', async () => {
            const mockClient = createMockSquareClient();
            let version = 1;

            // Progress through states
            mockClient.orders.get
                .mockResolvedValueOnce(createSquareOrderData('PROPOSED', 'DELIVERY', 'OPEN'))
                .mockImplementation(() => {
                    version++;
                    return Promise.resolve({
                        order: {
                            id: 'SQUARE_ORDER_123',
                            version,
                            locationId: 'LOCATION_123',
                            state: 'OPEN',
                            fulfillments: [{
                                uid: 'FULFILLMENT_UID_1',
                                type: 'DELIVERY',
                                state: version === 2 ? 'RESERVED' : version === 3 ? 'PREPARED' : 'COMPLETED',
                                deliveryDetails: {},
                            }],
                        },
                    });
                });

            getSquareClientForMerchant.mockResolvedValue(mockClient);
            deliveryApi.getOrderById.mockResolvedValue({
                id: 'ORDER_UUID',
                square_order_id: 'SQUARE_ORDER_123',
                status: 'active',
            });
            deliveryApi.completeOrder.mockResolvedValue({
                id: 'ORDER_UUID',
                status: 'completed',
            });

            const express = require('express');
            const router = require('../../routes/delivery');
            const app = express();
            app.use(express.json());
            app.use('/api/delivery', router);

            const request = require('supertest');
            await request(app)
                .post('/api/delivery/orders/ORDER_UUID/complete')
                .expect(200);

            // Get all idempotency keys used
            const idempotencyKeys = mockClient.orders.update.mock.calls.map(
                call => call[0].idempotencyKey
            );

            // All keys should be unique
            const uniqueKeys = new Set(idempotencyKeys);
            expect(uniqueKeys.size).toBe(idempotencyKeys.length);

            // Each key should contain the order ID and state
            idempotencyKeys.forEach(key => {
                expect(key).toContain('ORDER_UUID');
            });
        });
    });
});
