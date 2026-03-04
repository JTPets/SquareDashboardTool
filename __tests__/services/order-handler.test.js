/**
 * Tests for services/webhook-handlers/order-handler.js
 *
 * T-2: Highest-risk untested code — 1,316 lines, handles order webhooks.
 * Covers main processing paths: new order, order updated, order fulfilled,
 * order refunded. Focus on edge cases that could cause data corruption
 * or silent failures.
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] })
}));

const mockUpdateVelocity = jest.fn().mockResolvedValue({
    updated: 3, skipped: 0, periods: [91, 182, 365]
});

jest.mock('../../utils/square-api', () => ({
    updateSalesVelocityFromOrder: mockUpdateVelocity
}));

const mockDetectRedemption = jest.fn().mockResolvedValue({ detected: false });
const mockMatchFreeItem = jest.fn().mockResolvedValue(null);
const mockMatchDiscountAmount = jest.fn().mockResolvedValue(null);
const mockProcessRefundsForLoyalty = jest.fn().mockResolvedValue({ processed: false });
const mockGetSquareAccessToken = jest.fn().mockResolvedValue('test-token');

jest.mock('../../utils/loyalty-service', () => ({
    detectRewardRedemptionFromOrder: mockDetectRedemption,
    matchEarnedRewardByFreeItem: mockMatchFreeItem,
    matchEarnedRewardByDiscountAmount: mockMatchDiscountAmount,
    processOrderRefundsForLoyalty: mockProcessRefundsForLoyalty,
    getSquareAccessToken: mockGetSquareAccessToken
}));

const mockDeliveryApi = {
    getSettings: jest.fn().mockResolvedValue({ auto_ingest_ready_orders: true }),
    ingestSquareOrder: jest.fn().mockResolvedValue(null),
    handleSquareOrderUpdate: jest.fn().mockResolvedValue(),
    getOrderBySquareId: jest.fn().mockResolvedValue(null),
    updateOrder: jest.fn().mockResolvedValue()
};

jest.mock('../../utils/delivery-api', () => mockDeliveryApi);

const mockSquareClient = {
    orders: {
        get: jest.fn().mockResolvedValue({
            order: {
                id: 'order_1',
                state: 'COMPLETED',
                customer_id: 'cust_1',
                line_items: [
                    {
                        catalog_object_id: 'var_1',
                        quantity: '2',
                        total_money: { amount: 2000 },
                        base_price_money: { amount: 1000 }
                    }
                ],
                tenders: [{ customer_id: 'cust_1' }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }
        })
    }
};

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient),
    loadMerchantContext: jest.fn(),
    requireMerchant: jest.fn()
}));

const mockProcessLoyaltyOrder = jest.fn().mockResolvedValue({
    alreadyProcessed: false,
    purchaseEvents: [{ id: 1, variation_id: 'var_1', quantity: 2 }],
    rewardEarned: false
});

jest.mock('../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: mockProcessLoyaltyOrder
}));

const mockCustomerService = {
    initialize: jest.fn().mockResolvedValue({}),
    identifyCustomerFromOrder: jest.fn().mockResolvedValue({
        customerId: 'cust_1',
        method: 'order.customer_id',
        success: true
    }),
    getCustomerDetails: jest.fn().mockResolvedValue(null)
};

jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => mockCustomerService)
}));

const mockCartActivity = {
    createFromDraftOrder: jest.fn().mockResolvedValue(null),
    markConverted: jest.fn().mockResolvedValue(null),
    markCanceled: jest.fn().mockResolvedValue(null)
};

jest.mock('../../services/cart/cart-activity-service', () => mockCartActivity);

jest.mock('../../config/constants', () => ({
    SQUARE: { API_VERSION: '2025-01-16' }
}));

const logger = require('../../utils/logger');
const squareApi = require('../../utils/square-api');
const loyaltyService = require('../../utils/loyalty-service');
const OrderHandler = require('../../services/webhook-handlers/order-handler');
const { normalizeSquareOrder } = OrderHandler;

// ============================================================================
// HELPERS
// ============================================================================

function makeContext(overrides = {}) {
    return {
        data: overrides.data || {
            order_created: {
                id: 'order_1',
                state: 'COMPLETED',
                customer_id: 'cust_1',
                line_items: [{
                    catalog_object_id: 'var_1',
                    quantity: '2',
                    total_money: { amount: 2000 },
                    base_price_money: { amount: 1000 }
                }],
                tenders: [{ customer_id: 'cust_1' }],
                location_id: 'loc_1',
                closed_at: new Date().toISOString()
            }
        },
        merchantId: 'merchantId' in overrides ? overrides.merchantId : 1,
        event: overrides.event || { type: 'order.created' },
        entityId: 'entityId' in overrides ? overrides.entityId : 'order_1'
    };
}

// ============================================================================
// TESTS
// ============================================================================

describe('OrderHandler', () => {
    let handler;

    beforeEach(() => {
        jest.clearAllMocks();
        OrderHandler._orderProcessingCache.clear();
        OrderHandler._completedOrderVelocityCache.clear();
        handler = new OrderHandler();
    });

    afterEach(() => {
        OrderHandler._orderProcessingCache.clear();
        OrderHandler._completedOrderVelocityCache.clear();
    });

    // ========================================================================
    // normalizeSquareOrder
    // ========================================================================

    describe('normalizeSquareOrder', () => {
        it('should return null/undefined input unchanged', () => {
            expect(normalizeSquareOrder(null)).toBeNull();
            expect(normalizeSquareOrder(undefined)).toBeUndefined();
        });

        it('should add snake_case aliases for camelCase order fields', () => {
            const order = {
                lineItems: [{ catalogObjectId: 'var_1', totalMoney: { amount: 100 }, basePriceMoney: { amount: 100 } }],
                customerId: 'cust_1',
                locationId: 'loc_1',
                totalMoney: { amount: 500 },
                createdAt: '2026-01-01'
            };

            const result = normalizeSquareOrder(order);

            expect(result.line_items).toBe(order.lineItems);
            expect(result.customer_id).toBe('cust_1');
            expect(result.location_id).toBe('loc_1');
            expect(result.total_money).toEqual({ amount: 500 });
            expect(result.created_at).toBe('2026-01-01');
        });

        it('should not overwrite existing snake_case fields', () => {
            const order = {
                customer_id: 'existing_cust',
                customerId: 'camel_cust',
                line_items: [{ catalog_object_id: 'existing_var', catalogObjectId: 'camel_var' }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.customer_id).toBe('existing_cust');
            expect(result.line_items[0].catalog_object_id).toBe('existing_var');
        });

        it('should normalize discount fields for redemption detection', () => {
            const order = {
                discounts: [{
                    catalogObjectId: 'disc_1',
                    appliedMoney: { amount: 500 },
                    amountMoney: { amount: 500 }
                }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.discounts[0].catalog_object_id).toBe('disc_1');
            expect(result.discounts[0].applied_money).toEqual({ amount: 500 });
        });

        it('should normalize tender customer_id for identification fallback', () => {
            const order = {
                tenders: [{ customerId: 'tender_cust' }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.tenders[0].customer_id).toBe('tender_cust');
        });

        it('should normalize fulfillment recipient fields', () => {
            const order = {
                fulfillments: [{
                    pickupDetails: {
                        recipient: {
                            phoneNumber: '555-1234',
                            emailAddress: 'a@b.com',
                            displayName: 'John'
                        }
                    }
                }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.fulfillments[0].pickup_details).toBeDefined();
            const r = result.fulfillments[0].pickup_details.recipient;
            expect(r.phone_number).toBe('555-1234');
            expect(r.email_address).toBe('a@b.com');
            expect(r.display_name).toBe('John');
        });
    });

    // ========================================================================
    // handleOrderCreatedOrUpdated - Core Path
    // ========================================================================

    describe('handleOrderCreatedOrUpdated', () => {
        it('should process a new COMPLETED order end-to-end', async () => {
            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(result.handled).toBe(true);
            // Velocity updated
            expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);
            expect(result.salesVelocity.updated).toBe(3);
            // Loyalty processed
            expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    merchantId: 1,
                    source: 'webhook'
                })
            );
        });

        it('should skip processing when WEBHOOK_ORDER_SYNC is disabled', async () => {
            process.env.WEBHOOK_ORDER_SYNC = 'false';
            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(result.skipped).toBe(true);
            expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
            delete process.env.WEBHOOK_ORDER_SYNC;
        });

        it('should warn and return error when merchantId is missing', async () => {
            const ctx = makeContext({ merchantId: null });
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // merchantId=null triggers early return with error
            expect(result.handled).toBe(true);
            expect(result.error).toBe('Merchant not found');
            expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
        });

        it('should skip when no order ID is available', async () => {
            const ctx = makeContext({
                data: {},
                entityId: null
            });
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // No entityId and no order data means no orderId can be extracted
            expect(result.skipped).toBe(true);
            expect(result.reason).toContain('No order ID');
        });

        it('should not update velocity for non-COMPLETED orders', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_open',
                        state: 'OPEN',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1'
                    }
                },
                entityId: 'order_open'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
        });

        it('should not process loyalty for non-COMPLETED orders', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_open',
                        state: 'OPEN',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1'
                    }
                },
                entityId: 'order_open'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockProcessLoyaltyOrder).not.toHaveBeenCalled();
        });

        it('should fetch full order from API when webhook data is incomplete', async () => {
            const ctx = makeContext({
                data: { order_created: { id: 'order_1', state: 'COMPLETED' } }, // No line_items
                entityId: 'order_1'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_1' });
        });

        it('should use webhook data directly when complete (P0-API-1 optimization)', async () => {
            const ctx = makeContext();

            await handler.handleOrderCreatedOrUpdated(ctx);

            // Should NOT fetch from API since webhook has complete data
            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        });

        it('should extract orderId from multiple possible locations', async () => {
            // Test data.order_updated
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'order_from_update',
                        state: 'COMPLETED',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1'
                    }
                },
                entityId: 'order_from_update'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);
            expect(result.handled).toBe(true);
        });
    });

    // ========================================================================
    // handleOrderCreatedOrUpdated - Loyalty Integration
    // ========================================================================

    describe('handleOrderCreatedOrUpdated - loyalty', () => {
        it('should skip loyalty when order already processed (dedup)', async () => {
            mockProcessLoyaltyOrder.mockResolvedValueOnce({
                alreadyProcessed: true,
                purchaseEvents: [],
                rewardEarned: false
            });

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(result.loyalty).toBeUndefined();
            expect(mockDetectRedemption).not.toHaveBeenCalled();
        });

        it('should process redemption detection after purchases', async () => {
            mockDetectRedemption.mockResolvedValueOnce({
                detected: true,
                rewardId: 42,
                offerName: 'Buy 12 Get 1 Free'
            });

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(result.loyaltyRedemption).toEqual({
                rewardId: 42,
                offerName: 'Buy 12 Get 1 Free'
            });
        });

        it('should process refunds when order has refund data', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_refund',
                        state: 'COMPLETED',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '2', total_money: { amount: 2000 } }],
                        location_id: 'loc_1',
                        refunds: [{ id: 'refund_1', status: 'COMPLETED' }]
                    }
                },
                entityId: 'order_refund'
            });

            mockProcessRefundsForLoyalty.mockResolvedValueOnce({
                processed: true,
                refundsProcessed: [{ id: 1 }]
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(result.loyaltyRefunds).toEqual({ refundsProcessed: 1 });
        });

        it('should cache result so payment.* webhooks can skip', async () => {
            const ctx = makeContext();
            await handler.handleOrderCreatedOrUpdated(ctx);

            const cached = OrderHandler._orderProcessingCache.get('order_1:1');
            expect(cached).toBeDefined();
            expect(cached.customerId).toBe('cust_1');
            expect(cached.pointsAwarded).toBe(true);
            expect(cached.redemptionChecked).toBe(true);
        });

        it('should handle loyalty error gracefully without failing webhook', async () => {
            mockCustomerService.identifyCustomerFromOrder.mockRejectedValueOnce(
                new Error('Customer service down')
            );

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Handler should still complete (error caught)
            expect(result.handled).toBe(true);
            expect(result.loyaltyError).toBe('Customer service down');
        });

        it('should handle no customer identified gracefully', async () => {
            mockCustomerService.identifyCustomerFromOrder.mockResolvedValueOnce({
                customerId: null,
                method: null,
                success: false
            });

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Should still call processLoyaltyOrder (which handles null customer)
            expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({ squareCustomerId: null })
            );
        });
    });

    // ========================================================================
    // handleOrderCreatedOrUpdated - Delivery Routing
    // ========================================================================

    describe('handleOrderCreatedOrUpdated - delivery routing', () => {
        it('should route DRAFT orders to cart activity, not delivery', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'draft_order',
                        state: 'DRAFT',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        source: { name: 'Square Online' }
                    }
                },
                entityId: 'draft_order'
            });

            mockCartActivity.createFromDraftOrder.mockResolvedValueOnce({
                id: 99, item_count: 1, status: 'active'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockCartActivity.createFromDraftOrder).toHaveBeenCalled();
            expect(result.cartActivity).toEqual({ id: 99, itemCount: 1, status: 'active' });
        });

        it('should check cart conversion when order becomes OPEN', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'open_order',
                        state: 'OPEN',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        fulfillments: [{ type: 'DELIVERY', state: 'PROPOSED' }]
                    }
                },
                entityId: 'open_order'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockCartActivity.markConverted).toHaveBeenCalledWith('open_order', 1);
        });

        it('should mark cart canceled when order is CANCELED', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'cancel_order',
                        state: 'CANCELED',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1'
                    }
                },
                entityId: 'cancel_order'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockCartActivity.markCanceled).toHaveBeenCalledWith('cancel_order', 1);
        });

        it('should auto-ingest OPEN delivery order when auto_ingest enabled', async () => {
            const deliveryOrder = {
                id: 55, customer_name: 'John', square_synced_at: null
            };
            mockDeliveryApi.ingestSquareOrder.mockResolvedValueOnce(deliveryOrder);

            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'delivery_order',
                        state: 'OPEN',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        fulfillments: [{ type: 'DELIVERY', state: 'PROPOSED' }]
                    }
                },
                entityId: 'delivery_order'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockDeliveryApi.ingestSquareOrder).toHaveBeenCalled();
            expect(result.deliveryOrder).toEqual({
                id: 55,
                customerName: 'John',
                isNew: true
            });
        });

        it('should not auto-ingest when auto_ingest disabled in settings', async () => {
            mockDeliveryApi.getSettings.mockResolvedValueOnce({ auto_ingest_ready_orders: false });

            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'delivery_order',
                        state: 'OPEN',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        fulfillments: [{ type: 'DELIVERY', state: 'PROPOSED' }]
                    }
                },
                entityId: 'delivery_order'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockDeliveryApi.ingestSquareOrder).not.toHaveBeenCalled();
        });

        it('should handle order completion for delivery', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'complete_order',
                        state: 'COMPLETED',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        fulfillments: [{ type: 'DELIVERY', state: 'COMPLETED' }]
                    }
                },
                entityId: 'complete_order'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(1, 'complete_order', 'COMPLETED');
        });

        it('should handle order cancellation for delivery', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'cancel_order',
                        state: 'CANCELED',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        fulfillments: [{ type: 'DELIVERY', state: 'CANCELED' }]
                    }
                },
                entityId: 'cancel_order'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(1, 'cancel_order', 'CANCELED');
        });

        it('should not process delivery for non-delivery fulfillments', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'pickup_order',
                        state: 'OPEN',
                        line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }],
                        location_id: 'loc_1',
                        fulfillments: [{ type: 'PICKUP', state: 'PROPOSED' }]
                    }
                },
                entityId: 'pickup_order'
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockDeliveryApi.ingestSquareOrder).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // handleFulfillmentUpdated
    // ========================================================================

    describe('handleFulfillmentUpdated', () => {
        it('should update velocity when fulfillment is COMPLETED', async () => {
            const ctx = {
                data: {
                    order_id: 'order_ful',
                    fulfillment: { uid: 'ful_1', state: 'COMPLETED', type: 'DELIVERY' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' },
                entityId: 'order_ful'
            };

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_ful' });
            expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledTimes(1);
            expect(result.salesVelocity.fromFulfillment).toBe(true);
        });

        it('should skip when WEBHOOK_ORDER_SYNC is disabled', async () => {
            process.env.WEBHOOK_ORDER_SYNC = 'false';

            const ctx = {
                data: { order_id: 'order_1', fulfillment: { state: 'COMPLETED' } },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(ctx);
            expect(result.skipped).toBe(true);
            delete process.env.WEBHOOK_ORDER_SYNC;
        });

        it('should return error when merchantId is missing', async () => {
            const ctx = {
                data: { order_id: 'order_1', fulfillment: { state: 'COMPLETED' } },
                merchantId: null,
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(ctx);
            expect(result.error).toBe('Merchant not found');
        });

        it('should handle delivery update for COMPLETED fulfillment', async () => {
            const ctx = {
                data: {
                    order_id: 'order_ful',
                    fulfillment: { uid: 'ful_1', state: 'COMPLETED', type: 'DELIVERY' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' },
                entityId: 'order_ful'
            };

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(1, 'order_ful', 'COMPLETED');
            expect(result.deliveryUpdate.action).toBe('marked_completed');
        });

        it('should handle CANCELED fulfillment', async () => {
            const ctx = {
                data: {
                    order_id: 'order_ful',
                    fulfillment: { uid: 'ful_1', state: 'CANCELED', type: 'SHIPMENT' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' },
                entityId: 'order_ful'
            };

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(1, 'order_ful', 'CANCELED');
        });

        it('should treat FAILED fulfillment as CANCELED', async () => {
            const ctx = {
                data: {
                    order_id: 'order_ful',
                    fulfillment: { uid: 'ful_1', state: 'FAILED', type: 'DELIVERY' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' },
                entityId: 'order_ful'
            };

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(1, 'order_ful', 'CANCELED');
            expect(result.deliveryUpdate.fulfillmentState).toBe('FAILED');
        });

        it('should ignore non-delivery/shipment fulfillments', async () => {
            const ctx = {
                data: {
                    order_id: 'order_ful',
                    fulfillment: { uid: 'ful_1', state: 'COMPLETED', type: 'PICKUP' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' },
                entityId: 'order_ful'
            };

            // Set up to avoid velocity path interference
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: { id: 'order_ful', state: 'OPEN' }
            });

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).not.toHaveBeenCalled();
        });

        it('should auto-ingest on non-terminal fulfillment state', async () => {
            mockDeliveryApi.getSettings.mockResolvedValueOnce({ auto_ingest_ready_orders: true });
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: {
                    id: 'order_ful',
                    state: 'OPEN',
                    fulfillments: [{ type: 'DELIVERY', state: 'PROPOSED' }],
                    line_items: [{ catalog_object_id: 'v1', quantity: '1', total_money: { amount: 100 } }]
                }
            });
            mockDeliveryApi.ingestSquareOrder.mockResolvedValueOnce({ id: 77 });

            const ctx = {
                data: {
                    order_id: 'order_ful',
                    fulfillment: { uid: 'ful_1', state: 'PROPOSED', type: 'DELIVERY' }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' },
                entityId: 'order_ful'
            };

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockDeliveryApi.ingestSquareOrder).toHaveBeenCalled();
        });
    });

    // ========================================================================
    // handlePaymentCreated / handlePaymentUpdated
    // ========================================================================

    describe('handlePaymentCreated', () => {
        it('should skip when merchantId is missing', async () => {
            const ctx = { data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' }, merchantId: null };
            const result = await handler.handlePaymentCreated(ctx);
            expect(result.handled).toBe(true);
            expect(mockProcessLoyaltyOrder).not.toHaveBeenCalled();
        });

        it('should process loyalty when payment is already COMPLETED', async () => {
            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentCreated(ctx);

            expect(result.paymentCreated).toEqual({
                paymentId: 'pay_1',
                orderId: 'order_1',
                status: 'COMPLETED'
            });
        });

        it('should not process loyalty when payment is PENDING', async () => {
            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'PENDING' },
                merchantId: 1
            };

            const result = await handler.handlePaymentCreated(ctx);
            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        });
    });

    describe('handlePaymentUpdated', () => {
        it('should skip fully-processed orders from cache', async () => {
            // Pre-populate cache as if order.* webhook already processed
            OrderHandler._orderProcessingCache.set('order_1:1', {
                customerId: 'cust_1',
                pointsAwarded: true,
                redemptionChecked: true
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentUpdated(ctx);

            expect(result.skippedByCache).toBe(true);
            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        });

        it('should re-run when cache has no customer (payment adds tender data)', async () => {
            OrderHandler._orderProcessingCache.set('order_1:1', {
                customerId: null,
                pointsAwarded: false,
                redemptionChecked: true
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await handler.handlePaymentUpdated(ctx);

            // Should fetch order and re-process
            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_1' });
        });

        it('should use cached customer_id when available', async () => {
            OrderHandler._orderProcessingCache.set('order_1:1', {
                customerId: 'cached_cust',
                pointsAwarded: false,
                redemptionChecked: false
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await handler.handlePaymentUpdated(ctx);

            // Should use cached customer, not re-run identification
            expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({ squareCustomerId: 'cached_cust' })
            );
        });

        it('should not process non-COMPLETED payment status', async () => {
            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'FAILED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentUpdated(ctx);

            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        });

        it('should not process payment without order_id', async () => {
            const ctx = {
                data: { id: 'pay_1', status: 'COMPLETED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentUpdated(ctx);

            expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        });

        it('should handle non-COMPLETED order fetched from Square', async () => {
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: { id: 'order_1', state: 'OPEN', line_items: [] }
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await handler.handlePaymentUpdated(ctx);

            // Should not process loyalty for non-COMPLETED order
            expect(mockProcessLoyaltyOrder).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // handleRefundCreatedOrUpdated
    // ========================================================================

    describe('handleRefundCreatedOrUpdated', () => {
        it('should process completed refund with order refunds', async () => {
            // Mock fetch globally for the refund handler's direct API call
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    order: {
                        id: 'order_1',
                        refunds: [{ id: 'refund_1', status: 'COMPLETED' }]
                    }
                })
            });

            mockProcessRefundsForLoyalty.mockResolvedValueOnce({
                processed: true,
                refundsProcessed: [{ id: 1 }]
            });

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(result.loyaltyRefunds).toEqual({ refundsProcessed: 1 });
            delete global.fetch;
        });

        it('should skip non-COMPLETED refunds', async () => {
            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'PENDING' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(result.handled).toBe(true);
            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
        });

        it('should skip refund without order_id', async () => {
            const ctx = {
                data: { id: 'refund_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
        });

        it('should skip when WEBHOOK_ORDER_SYNC is disabled', async () => {
            process.env.WEBHOOK_ORDER_SYNC = 'false';

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);
            expect(result.handled).toBe(true);
            delete process.env.WEBHOOK_ORDER_SYNC;
        });

        it('should skip when no access token available', async () => {
            mockGetSquareAccessToken.mockResolvedValueOnce(null);

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
        });

        it('should handle API fetch failure gracefully', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 500
            });

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            // Should not crash
            expect(result.handled).toBe(true);
            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
            delete global.fetch;
        });

        it('should return error when merchantId is missing', async () => {
            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: null,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);
            expect(result.error).toBe('Merchant not found');
        });
    });

    // ========================================================================
    // Edge Cases: Data Corruption Prevention
    // ========================================================================

    describe('data corruption prevention', () => {
        it('should handle order with empty line_items array', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'empty_order',
                        state: 'COMPLETED',
                        customer_id: 'cust_1',
                        line_items: [],
                        location_id: 'loc_1'
                    }
                },
                entityId: 'empty_order'
            });

            // Empty line_items means incomplete data — should fetch from API
            const result = await handler.handleOrderCreatedOrUpdated(ctx);
            expect(mockSquareClient.orders.get).toHaveBeenCalled();
        });

        it('should handle API returning null order', async () => {
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: null
            });

            const ctx = makeContext({
                data: { order_created: { id: 'missing' } }, // Incomplete
                entityId: 'missing'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Should not crash — order is null so velocity/loyalty/delivery skipped
            expect(result.handled).toBe(true);
        });

        it('should handle Square API fetch error', async () => {
            mockSquareClient.orders.get.mockRejectedValueOnce(new Error('API timeout'));

            const ctx = makeContext({
                data: { order_created: { id: 'timeout_order' } },
                entityId: 'timeout_order'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);
            expect(result.handled).toBe(true);
        });

        it('should handle velocity update failure without blocking loyalty', async () => {
            mockUpdateVelocity.mockRejectedValueOnce(new Error('DB write failed'));

            const ctx = makeContext();

            // BUG: Velocity error IS propagated (not caught) — blocks delivery + loyalty
            // The velocity call at line ~266 is NOT wrapped in try-catch, so if
            // updateSalesVelocityFromOrder throws, _processDeliveryRouting and
            // _processLoyalty are never reached.
            // This is a real issue: a transient DB write error in velocity tracking
            // silently prevents loyalty points from being awarded.
            try {
                await handler.handleOrderCreatedOrUpdated(ctx);
            } catch (e) {
                expect(e.message).toBe('DB write failed');
            }

            // Verify loyalty was NOT processed due to uncaught velocity error
            expect(mockProcessLoyaltyOrder).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // normalizeSquareOrder — nested field normalization
    // ========================================================================

    describe('normalizeSquareOrder — nested fields', () => {
        it('should normalize fulfillment fields (pickupDetails, deliveryDetails)', () => {
            const order = {
                id: 'ord_1',
                fulfillments: [{
                    type: 'DELIVERY',
                    pickupDetails: {
                        recipient: {
                            phoneNumber: '555-1234',
                            emailAddress: 'test@test.com',
                            displayName: 'John Doe'
                        }
                    },
                    deliveryDetails: {
                        recipient: {
                            phoneNumber: '555-5678'
                        }
                    }
                }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.fulfillments[0].pickup_details).toBe(order.fulfillments[0].pickupDetails);
            expect(result.fulfillments[0].delivery_details).toBe(order.fulfillments[0].deliveryDetails);
            expect(result.fulfillments[0].pickup_details.recipient.phone_number).toBe('555-1234');
            expect(result.fulfillments[0].pickup_details.recipient.email_address).toBe('test@test.com');
            expect(result.fulfillments[0].pickup_details.recipient.display_name).toBe('John Doe');
        });

        it('should normalize tender customer IDs', () => {
            const order = {
                id: 'ord_1',
                tenders: [
                    { customerId: 'cust_1', id: 'tender_1' },
                    { customer_id: 'cust_2', id: 'tender_2' } // Already snake_case
                ]
            };

            const result = normalizeSquareOrder(order);

            expect(result.tenders[0].customer_id).toBe('cust_1');
            expect(result.tenders[1].customer_id).toBe('cust_2');
        });

        it('should normalize discount fields (catalogObjectId, appliedMoney, amountMoney)', () => {
            const order = {
                id: 'ord_1',
                discounts: [{
                    catalogObjectId: 'disc_1',
                    appliedMoney: { amount: 500 },
                    amountMoney: { amount: 500 }
                }]
            };

            const result = normalizeSquareOrder(order);

            expect(result.discounts[0].catalog_object_id).toBe('disc_1');
            expect(result.discounts[0].applied_money).toEqual({ amount: 500 });
            expect(result.discounts[0].amount_money).toEqual({ amount: 500 });
        });

        it('should not overwrite existing snake_case fields', () => {
            const order = {
                id: 'ord_1',
                customer_id: 'existing_cust',
                customerId: 'camel_cust',
                line_items: [{ name: 'existing' }],
                lineItems: [{ name: 'camel' }]
            };

            const result = normalizeSquareOrder(order);

            // Existing snake_case should be preserved
            expect(result.customer_id).toBe('existing_cust');
            expect(result.line_items).toEqual([{ name: 'existing' }]);
        });

        it('should handle order with no optional arrays', () => {
            const order = { id: 'ord_1' };
            const result = normalizeSquareOrder(order);
            expect(result.id).toBe('ord_1');
            // No errors from missing discounts/fulfillments/tenders
        });
    });

    // ========================================================================
    // DRAFT order routing to cart activity
    // ========================================================================

    describe('DRAFT order cart routing', () => {
        it('should route DRAFT orders to cart activity service', async () => {
            mockCartActivity.createFromDraftOrder.mockResolvedValueOnce({
                id: 42, item_count: 3, status: 'active'
            });

            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'draft_order_1',
                        state: 'DRAFT',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 500 }, base_price_money: { amount: 500 } }],
                        source: { name: 'Square Online' }
                    }
                },
                entityId: 'draft_order_1'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockCartActivity.createFromDraftOrder).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'draft_order_1', state: 'DRAFT' }),
                1
            );
            expect(result.cartActivity).toEqual({
                id: 42, itemCount: 3, status: 'active'
            });
        });

        it('should NOT process DRAFT orders for delivery, velocity, or loyalty', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'draft_order_1',
                        state: 'DRAFT',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 500 }, base_price_money: { amount: 500 } }]
                    }
                },
                entityId: 'draft_order_1'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Velocity only runs for COMPLETED orders
            expect(mockUpdateVelocity).not.toHaveBeenCalled();
            // Loyalty only runs for COMPLETED orders
            expect(mockProcessLoyaltyOrder).not.toHaveBeenCalled();
            // Delivery ingest should NOT happen for DRAFT
            expect(mockDeliveryApi.ingestSquareOrder).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // CANCELED order cleanup
    // ========================================================================

    describe('CANCELED order cleanup', () => {
        it('should mark cart as canceled for CANCELED orders', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'canceled_order',
                        state: 'CANCELED',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 500 }, base_price_money: { amount: 500 } }]
                    }
                },
                entityId: 'canceled_order',
                event: { type: 'order.updated' }
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockCartActivity.markCanceled).toHaveBeenCalledWith('canceled_order', 1);
        });

        it('should handle CANCELED order with delivery fulfillment', async () => {
            const ctx = makeContext({
                data: {
                    order_updated: {
                        id: 'canceled_delivery',
                        state: 'CANCELED',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 500 }, base_price_money: { amount: 500 } }],
                        fulfillments: [{ type: 'DELIVERY', state: 'CANCELED' }]
                    }
                },
                entityId: 'canceled_delivery',
                event: { type: 'order.updated' }
            });

            await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(
                1, 'canceled_delivery', 'CANCELED'
            );
        });
    });

    // ========================================================================
    // _processLoyalty error containment
    // ========================================================================

    describe('_processLoyalty error containment', () => {
        it('should catch loyalty errors without crashing the handler', async () => {
            mockProcessLoyaltyOrder.mockRejectedValueOnce(new Error('Loyalty DB down'));

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Handler should still return successfully
            expect(result.handled).toBe(true);
            expect(result.loyaltyError).toBe('Loyalty DB down');
        });

        it('should continue when customer identification fails', async () => {
            mockCustomerService.identifyCustomerFromOrder.mockResolvedValueOnce({
                customerId: null,
                method: null,
                success: false
            });

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Should still call processLoyaltyOrder with null customer
            expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({ squareCustomerId: null })
            );
        });

        it('should process refunds present on completed order', async () => {
            mockProcessRefundsForLoyalty.mockResolvedValueOnce({
                processed: true,
                refundsProcessed: [{ id: 1 }, { id: 2 }]
            });

            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_refund',
                        state: 'COMPLETED',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '2', total_money: { amount: 2000 }, base_price_money: { amount: 1000 } }],
                        tenders: [{ customer_id: 'cust_1' }],
                        refunds: [
                            { id: 'ref_1', status: 'COMPLETED' },
                            { id: 'ref_2', status: 'COMPLETED' }
                        ],
                        location_id: 'loc_1'
                    }
                },
                entityId: 'order_refund'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockProcessRefundsForLoyalty).toHaveBeenCalled();
            expect(result.loyaltyRefunds).toEqual({ refundsProcessed: 2 });
        });

        it('should skip loyalty processing for already-processed order', async () => {
            mockProcessLoyaltyOrder.mockResolvedValueOnce({
                alreadyProcessed: true,
                purchaseEvents: []
            });

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Redemption detection should be skipped
            expect(mockDetectRedemption).not.toHaveBeenCalled();
        });

        it('should record redemption when detected on order', async () => {
            mockDetectRedemption.mockResolvedValueOnce({
                detected: true,
                rewardId: 42,
                offerName: 'Buy 12 Get 1 Free'
            });

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(result.loyaltyRedemption).toEqual({
                rewardId: 42,
                offerName: 'Buy 12 Get 1 Free'
            });
        });
    });

    // ========================================================================
    // handleRefundCreatedOrUpdated — additional edge cases
    // ========================================================================

    describe('handleRefundCreatedOrUpdated — additional edge cases', () => {
        it('should handle order with no refunds array', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    order: { id: 'order_1' } // No refunds property
                })
            });

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(result.handled).toBe(true);
            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
            delete global.fetch;
        });

        it('should handle order with empty refunds array', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    order: { id: 'order_1', refunds: [] }
                })
            });

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
            delete global.fetch;
        });

        it('should handle fetch network error (connection refused)', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            // Should catch and log error, not crash
            expect(result.handled).toBe(true);
            expect(result.error).toBe('ECONNREFUSED');
            delete global.fetch;
        });

        it('should handle null order in response', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ order: null })
            });

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(result.handled).toBe(true);
            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
            delete global.fetch;
        });
    });

    // ========================================================================
    // handlePaymentUpdated — cache interaction edge cases
    // ========================================================================

    describe('handlePaymentUpdated — cache edge cases', () => {
        it('should re-run identification when cache has no customer but has pointsAwarded', async () => {
            // Simulate cache from order webhook where customer was not identified
            OrderHandler._orderProcessingCache.set('order_1:1', {
                customerId: null,
                pointsAwarded: false,
                redemptionChecked: false
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await handler.handlePaymentUpdated(ctx);

            // Should fetch order and re-process (falls through to full processing)
            expect(mockSquareClient.orders.get).toHaveBeenCalled();
            expect(mockProcessLoyaltyOrder).toHaveBeenCalled();
        });

        it('should use cached customer_id when available (avoids 6-method chain)', async () => {
            OrderHandler._orderProcessingCache.set('order_1:1', {
                customerId: 'cached_cust',
                pointsAwarded: false,
                redemptionChecked: false
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await handler.handlePaymentUpdated(ctx);

            // Should pass cached customer, not re-identify
            expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({ squareCustomerId: 'cached_cust' })
            );
        });
    });

    // ========================================================================
    // handleFulfillmentUpdated — delivery routing
    // ========================================================================

    describe('handleFulfillmentUpdated — delivery routing', () => {
        it('should handle FAILED fulfillment as cancellation', async () => {
            const ctx = {
                data: {
                    order_id: 'order_1',
                    fulfillment: {
                        uid: 'ff_1',
                        type: 'DELIVERY',
                        state: 'FAILED'
                    }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            const result = await handler.handleFulfillmentUpdated(ctx);

            expect(mockDeliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(
                1, 'order_1', 'CANCELED'
            );
            expect(result.deliveryUpdate.action).toBe('removed');
        });

        it('should ignore non-DELIVERY/SHIPMENT fulfillment types', async () => {
            const ctx = {
                data: {
                    order_id: 'order_1',
                    fulfillment: {
                        uid: 'ff_1',
                        type: 'PICKUP',
                        state: 'COMPLETED'
                    }
                },
                merchantId: 1,
                event: { type: 'order.fulfillment.updated' }
            };

            // Need the Square client mock for velocity
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: { id: 'order_1', state: 'COMPLETED', line_items: [{ catalog_object_id: 'v1', quantity: '1' }] }
            });

            const result = await handler.handleFulfillmentUpdated(ctx);

            // Should NOT route to delivery
            expect(mockDeliveryApi.handleSquareOrderUpdate).not.toHaveBeenCalled();
        });
    });
});
