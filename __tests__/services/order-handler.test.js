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

jest.mock('../../services/square', () => ({
    updateSalesVelocityFromOrder: mockUpdateVelocity
}));

const mockDetectRedemption = jest.fn().mockResolvedValue({ detected: false });
const mockMatchFreeItem = jest.fn().mockResolvedValue(null);
const mockMatchDiscountAmount = jest.fn().mockResolvedValue(null);
const mockProcessRefundsForLoyalty = jest.fn().mockResolvedValue({ processed: false });
const mockGetSquareAccessToken = jest.fn().mockResolvedValue('test-token');

jest.mock('../../services/loyalty-admin', () => ({
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

jest.mock('../../services/delivery', () => mockDeliveryApi);

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
const squareApi = require('../../services/square');
const loyaltyService = require('../../services/loyalty-admin');
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

        it('should process returns when order has return data', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_refund',
                        state: 'COMPLETED',
                        customer_id: 'cust_1',
                        line_items: [{ catalog_object_id: 'var_1', quantity: '2', total_money: { amount: 2000 } }],
                        location_id: 'loc_1',
                        returns: [{ uid: 'ret_1', return_line_items: [{ uid: 'rli_1', source_line_item_uid: 'li_1', quantity: '1' }] }]
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
        it('should process completed refund when order has returns', async () => {
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: {
                    id: 'order_1',
                    returns: [{ uid: 'ret_1', return_line_items: [{ uid: 'rli_1' }] }]
                }
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

            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_1' });
            expect(result.loyaltyRefunds).toEqual({ refundsProcessed: 1 });
        });

        it('should NOT trigger loyalty return processing when order has refunds but no returns', async () => {
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: {
                    id: 'order_1',
                    refunds: [{ id: 'refund_1', status: 'COMPLETED' }]
                }
            });

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_1' });
            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
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

        it('should handle SDK fetch failure gracefully', async () => {
            mockSquareClient.orders.get.mockRejectedValueOnce(new Error('Square API error'));

            const ctx = {
                data: { id: 'refund_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1,
                event: { type: 'refund.created' }
            };

            const result = await handler.handleRefundCreatedOrUpdated(ctx);

            expect(result.handled).toBe(true);
            expect(result.error).toBe('Square API error');
            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
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
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            // Velocity error is now caught — loyalty and delivery still process
            expect(result.handled).toBe(true);
            expect(result.salesVelocity.error).toBe('DB write failed');
            expect(logger.warn).toHaveBeenCalledWith(
                'Sales velocity update failed — continuing with delivery and loyalty',
                expect.objectContaining({ error: 'DB write failed' })
            );
            // Loyalty should still have been processed
            expect(mockProcessLoyaltyOrder).toHaveBeenCalled();
        });
    });

    // ========================================================================
    // RISK-3: Payment-only path — no prior order.* webhook
    // ========================================================================

    describe('payment-only path (RISK-3)', () => {
        it('should process loyalty via payment webhook when no order webhook fired (empty cache)', async () => {
            // No cache entry — simulates order.* webhook not firing
            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentUpdated(ctx);

            // Should fetch order from Square and process loyalty
            expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: 'order_1' });
            expect(mockProcessLoyaltyOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    merchantId: 1,
                    source: 'webhook'
                })
            );
            expect(result.loyalty).toBeDefined();
            expect(result.loyalty.purchasesRecorded).toBe(1);
        });

        it('should detect redemption via detectRewardRedemptionFromOrder after purchases (LA-20 fix)', async () => {
            mockSquareClient.orders.get.mockResolvedValueOnce({
                order: {
                    id: 'order_redemption',
                    state: 'COMPLETED',
                    customer_id: 'cust_1',
                    line_items: [{ catalog_object_id: 'var_1', quantity: '1', total_money: { amount: 1000 } }],
                    discounts: [{ uid: 'd1', catalog_object_id: 'disc_loyalty', name: 'Reward' }],
                    tenders: [{ customer_id: 'cust_1' }],
                    location_id: 'loc_1'
                }
            });

            mockDetectRedemption.mockResolvedValueOnce({
                detected: true,
                rewardId: 77,
                offerName: 'Buy 10 Get 1 Free'
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_redemption', status: 'COMPLETED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentUpdated(ctx);

            // Redemption detection should run after purchases (single call, not doubled)
            expect(mockDetectRedemption).toHaveBeenCalled();
            expect(result.loyaltyRedemption).toEqual({
                rewardId: 77,
                offerName: 'Buy 10 Get 1 Free'
            });
        });

        it('should run full redemption detection via payment path', async () => {
            mockDetectRedemption.mockResolvedValueOnce({
                detected: true,
                rewardId: 77,
                offerName: 'Buy 10 Get 1 Free'
            });

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            const result = await handler.handlePaymentUpdated(ctx);

            expect(mockDetectRedemption).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'order_1' }),
                1
            );
            expect(result.loyaltyRedemption).toEqual({
                rewardId: 77,
                offerName: 'Buy 10 Get 1 Free'
            });
        });

        it('should run full customer identification when cache is empty (payment-only)', async () => {
            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await handler.handlePaymentUpdated(ctx);

            // Should run the 6-method identification chain (not use cached customer)
            expect(mockCustomerService.identifyCustomerFromOrder).toHaveBeenCalled();
        });

        it('should handle payment loyalty error gracefully', async () => {
            // LOGIC CHANGE: 'SDK timeout' is now classified as transient — re-thrown
            // so Square retries the webhook
            mockSquareClient.orders.get.mockRejectedValueOnce(new Error('SDK timeout'));

            const ctx = {
                data: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' },
                merchantId: 1
            };

            await expect(handler.handlePaymentUpdated(ctx)).rejects.toThrow('SDK timeout');

            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('transient'),
                expect.objectContaining({
                    event: 'loyalty_transient_error',
                    orderId: 'order_1',
                    willRetry: true
                })
            );
        });
    });

    // ========================================================================
    // RISK-4: identifyCustomerForOrder DB error path
    // ========================================================================

    describe('identifyCustomerForOrder error handling (RISK-4)', () => {
        it('should log at error level when customer identification throws', async () => {
            // LOGIC CHANGE: 'DB connection refused' is transient — now re-thrown
            mockCustomerService.identifyCustomerFromOrder.mockRejectedValueOnce(
                new Error('DB connection refused')
            );

            const ctx = makeContext();
            await expect(handler.handleOrderCreatedOrUpdated(ctx)).rejects.toThrow('DB connection refused');

            // Error propagates to _processLoyalty catch block, classified as transient
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('transient'),
                expect.objectContaining({
                    event: 'loyalty_transient_error',
                    error: 'DB connection refused',
                    orderId: 'order_1',
                    willRetry: true
                })
            );
        });

        it('should still process velocity and delivery when customer identification fails', async () => {
            // LOGIC CHANGE: 'DB timeout' is transient — now re-thrown after velocity runs
            mockCustomerService.identifyCustomerFromOrder.mockRejectedValueOnce(
                new Error('DB timeout')
            );

            const ctx = makeContext();
            await expect(handler.handleOrderCreatedOrUpdated(ctx)).rejects.toThrow('DB timeout');

            // Velocity should still have been updated (runs before loyalty)
            expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalled();
        });

        it('should not populate cache when customer identification throws', async () => {
            mockCustomerService.identifyCustomerFromOrder.mockRejectedValueOnce(
                new Error('DB down')
            );

            const ctx = makeContext();
            await handler.handleOrderCreatedOrUpdated(ctx);

            // Cache should NOT be populated — error prevented processing
            const cached = OrderHandler._orderProcessingCache.get('order_1:1');
            expect(cached).toBeFalsy();
        });

        it('should log at error level when LoyaltyCustomerService.initialize throws', async () => {
            // LOGIC CHANGE: 'Failed to load merchant config' is unexpected permanent —
            // swallowed but logged at ERROR with loyalty_unexpected_error event
            mockCustomerService.initialize.mockRejectedValueOnce(
                new Error('Failed to load merchant config')
            );

            const ctx = makeContext();
            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('unexpected'),
                expect.objectContaining({
                    event: 'loyalty_unexpected_error',
                    error: 'Failed to load merchant config',
                    willRetry: false
                })
            );
            expect(result.loyaltyError).toBe('Failed to load merchant config');
        });
    });

    // ========================================================================
    // RISK-1: Multi-discount order in _checkOrderForRedemption
    // ========================================================================

    describe('_checkOrderForRedemption multi-discount (RISK-1)', () => {
        const db = require('../../utils/database');

        it('should check all discounts and match the correct one (3rd of 3)', async () => {
            // 3 discounts: first two are non-loyalty, third matches a reward
            db.query
                .mockResolvedValueOnce({ rows: [] })  // discount 1: no match
                .mockResolvedValueOnce({ rows: [] })  // discount 2: no match
                .mockResolvedValueOnce({ rows: [{     // discount 3: match!
                    id: 99,
                    offer_id: 5,
                    square_customer_id: 'cust_abc',
                    offer_name: 'Buy 12 Get 1 Free'
                }] });

            const order = {
                id: 'order_multi',
                discounts: [
                    { uid: 'd1', catalog_object_id: 'disc_sale_1', name: 'Summer Sale' },
                    { uid: 'd2', catalog_object_id: 'disc_sale_2', name: 'Staff Discount' },
                    { uid: 'd3', catalog_object_id: 'disc_loyalty_1', name: 'Loyalty Reward' }
                ]
            };

            const result = await handler._checkOrderForRedemption(order, 1);

            expect(result.isRedemptionOrder).toBe(true);
            expect(result.rewardId).toBe(99);
            expect(result.discountCatalogId).toBe('disc_loyalty_1');
            expect(db.query).toHaveBeenCalledTimes(3);
        });

        it('should stop checking after first matching discount (short-circuit)', async () => {
            db.query.mockResolvedValueOnce({ rows: [{
                id: 10,
                offer_id: 2,
                square_customer_id: 'cust_1',
                offer_name: 'First Match'
            }] });

            const order = {
                id: 'order_shortcircuit',
                discounts: [
                    { uid: 'd1', catalog_object_id: 'disc_match', name: 'Match' },
                    { uid: 'd2', catalog_object_id: 'disc_other', name: 'Other' }
                ]
            };

            const result = await handler._checkOrderForRedemption(order, 1);

            expect(result.isRedemptionOrder).toBe(true);
            expect(result.rewardId).toBe(10);
            // Should have queried only once (short-circuited after first match)
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('should skip discounts without catalog_object_id (manual discounts)', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const order = {
                id: 'order_mixed',
                discounts: [
                    { uid: 'd1', name: 'Manual 10% Off' },   // No catalog_object_id
                    { uid: 'd2', name: 'Ad-hoc', catalog_object_id: null },  // Null
                    { uid: 'd3', catalog_object_id: 'disc_real', name: 'Real Discount' }
                ]
            };

            // Only the third discount has a catalog_object_id — one DB query
            await handler._checkOrderForRedemption(order, 1);

            expect(db.query).toHaveBeenCalledTimes(1);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('square_discount_id'),
                [1, 'disc_real']
            );
        });

        it('should fall back to free item match when no discount catalog IDs match', async () => {
            // All discounts have catalog IDs but none match rewards
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            mockMatchFreeItem.mockResolvedValueOnce({
                reward_id: 55,
                offer_id: 8,
                offer_name: 'Free Item Reward',
                square_customer_id: 'cust_free',
                matched_variation_id: 'var_free'
            });

            const order = {
                id: 'order_fallback',
                discounts: [
                    { uid: 'd1', catalog_object_id: 'disc_no_match_1' },
                    { uid: 'd2', catalog_object_id: 'disc_no_match_2' }
                ]
            };

            const result = await handler._checkOrderForRedemption(order, 1);

            expect(result.isRedemptionOrder).toBe(true);
            expect(result.rewardId).toBe(55);
            expect(result.discountCatalogId).toBeNull();
            expect(mockMatchFreeItem).toHaveBeenCalled();
        });

        it('should fall back to discount amount match when free item also fails', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            mockMatchFreeItem.mockResolvedValueOnce(null);
            mockMatchDiscountAmount.mockResolvedValueOnce({
                reward_id: 88,
                offer_id: 12,
                offer_name: 'Dollar Off Reward',
                square_customer_id: 'cust_dollar',
                totalDiscountCents: 500,
                expectedValueCents: 500
            });

            const order = {
                id: 'order_amount_fallback',
                discounts: [
                    { uid: 'd1', catalog_object_id: 'disc_x' }
                ]
            };

            const result = await handler._checkOrderForRedemption(order, 1);

            expect(result.isRedemptionOrder).toBe(true);
            expect(result.rewardId).toBe(88);
            expect(mockMatchDiscountAmount).toHaveBeenCalled();
        });

        it('should return isRedemptionOrder=false when all strategies fail', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            mockMatchFreeItem.mockResolvedValueOnce(null);
            mockMatchDiscountAmount.mockResolvedValueOnce(null);

            const order = {
                id: 'order_no_redemption',
                discounts: [
                    { uid: 'd1', catalog_object_id: 'disc_none' }
                ]
            };

            const result = await handler._checkOrderForRedemption(order, 1);

            expect(result.isRedemptionOrder).toBe(false);
        });

        it('should handle order with zero discounts', async () => {
            mockMatchFreeItem.mockResolvedValueOnce(null);
            mockMatchDiscountAmount.mockResolvedValueOnce(null);

            const order = {
                id: 'order_no_discounts',
                discounts: []
            };

            const result = await handler._checkOrderForRedemption(order, 1);

            expect(result.isRedemptionOrder).toBe(false);
            // No DB queries needed — no catalog discounts to check
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // BUG FIX: order.returns vs order.refunds guard
    // ========================================================================

    describe('order.returns vs order.refunds guard fix', () => {
        it('should trigger loyalty return processing when order has returns but no refunds', async () => {
            mockProcessRefundsForLoyalty.mockResolvedValueOnce({
                processed: true,
                refundsProcessed: [{ id: 1 }]
            });

            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_return_only',
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
                        closed_at: new Date().toISOString(),
                        returns: [{ uid: 'ret_1', return_line_items: [{ uid: 'rli_1', source_line_item_uid: 'li_1', quantity: '1' }] }]
                        // No refunds property — exchange/store credit scenario
                    }
                },
                entityId: 'order_return_only'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockProcessRefundsForLoyalty).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'order_return_only' }),
                1
            );
            expect(result.loyaltyRefunds).toEqual({ refundsProcessed: 1 });
        });

        it('should NOT trigger loyalty return processing when order has refunds but no returns', async () => {
            const ctx = makeContext({
                data: {
                    order_created: {
                        id: 'order_refund_only',
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
                        closed_at: new Date().toISOString(),
                        refunds: [{ id: 'refund_1', status: 'COMPLETED', amount_money: { amount: 1000 } }]
                        // Has refunds (monetary) but no returns (item returns)
                    }
                },
                entityId: 'order_refund_only'
            });

            const result = await handler.handleOrderCreatedOrUpdated(ctx);

            expect(mockProcessRefundsForLoyalty).not.toHaveBeenCalled();
            expect(result.loyaltyRefunds).toBeUndefined();
        });
    });
});
