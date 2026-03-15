/**
 * Tests for order-delivery.js
 *
 * Covers all 6 exported functions:
 * - ingestDeliveryOrder
 * - handleOrderCancellation
 * - handleOrderCompletion
 * - refreshDeliveryOrderCustomerIfNeeded
 * - handleFulfillmentDeliveryUpdate
 * - autoIngestFromFulfillment
 */

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};
jest.mock('../../../utils/logger', () => logger);

const deliveryApi = {
    getSettings: jest.fn(),
    ingestSquareOrder: jest.fn(),
    handleSquareOrderUpdate: jest.fn(),
    getOrderBySquareId: jest.fn(),
    updateOrder: jest.fn()
};
jest.mock('../../../services/delivery', () => deliveryApi);

const mockSquareClient = {
    orders: {
        get: jest.fn()
    }
};
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient)
}));

const { getSquareClientForMerchant } = require('../../../middleware/merchant');

const customerDetailsService = {
    getCustomerDetails: jest.fn()
};
jest.mock('../../../services/loyalty-admin/customer-details-service', () => customerDetailsService);

const orderNormalize = {
    fetchFullOrder: jest.fn()
};
jest.mock('../../../services/webhook-handlers/order-handler/order-normalize', () => orderNormalize);

const {
    ingestDeliveryOrder,
    handleOrderCancellation,
    handleOrderCompletion,
    refreshDeliveryOrderCustomerIfNeeded,
    handleFulfillmentDeliveryUpdate,
    autoIngestFromFulfillment
} = require('../../../services/webhook-handlers/order-handler/order-delivery');

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ingestDeliveryOrder
// ---------------------------------------------------------------------------
describe('ingestDeliveryOrder', () => {
    const order = { id: 'sq_order_1' };
    const merchantId = 42;

    it('ingests order when auto_ingest is enabled', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        deliveryApi.ingestSquareOrder.mockResolvedValue({
            id: 100,
            customer_name: 'Alice',
            square_synced_at: null
        });

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(deliveryApi.getSettings).toHaveBeenCalledWith(merchantId);
        expect(deliveryApi.ingestSquareOrder).toHaveBeenCalledWith(merchantId, order);
        expect(result.deliveryOrder).toEqual({
            id: 100,
            customerName: 'Alice',
            isNew: true
        });
        expect(logger.info).toHaveBeenCalledWith(
            'Ingested Square order for delivery',
            expect.objectContaining({ merchantId, squareOrderId: 'sq_order_1', deliveryOrderId: 100 })
        );
    });

    it('marks isNew false when square_synced_at is set', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        deliveryApi.ingestSquareOrder.mockResolvedValue({
            id: 101,
            customer_name: 'Bob',
            square_synced_at: '2026-01-01'
        });

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(result.deliveryOrder.isNew).toBe(false);
    });

    it('returns early when auto_ingest is disabled', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: false });

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(deliveryApi.ingestSquareOrder).not.toHaveBeenCalled();
        expect(result.deliveryOrder).toBeUndefined();
    });

    it('defaults auto_ingest to true when setting is undefined', async () => {
        deliveryApi.getSettings.mockResolvedValue({});
        deliveryApi.ingestSquareOrder.mockResolvedValue({ id: 102, customer_name: 'C', square_synced_at: null });

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(deliveryApi.ingestSquareOrder).toHaveBeenCalled();
    });

    it('defaults auto_ingest to true when settings are null', async () => {
        deliveryApi.getSettings.mockResolvedValue(null);
        deliveryApi.ingestSquareOrder.mockResolvedValue({ id: 103, customer_name: 'D', square_synced_at: null });

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(deliveryApi.ingestSquareOrder).toHaveBeenCalled();
    });

    it('does not set result.deliveryOrder when ingestSquareOrder returns null', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        deliveryApi.ingestSquareOrder.mockResolvedValue(null);

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(result.deliveryOrder).toBeUndefined();
    });

    it('catches and logs error from ingestSquareOrder', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        deliveryApi.ingestSquareOrder.mockRejectedValue(new Error('DB timeout'));

        const result = {};
        await ingestDeliveryOrder(order, merchantId, result);

        expect(logger.error).toHaveBeenCalledWith(
            'Failed to ingest order for delivery',
            expect.objectContaining({ error: 'DB timeout', orderId: 'sq_order_1' })
        );
        expect(result.deliveryOrder).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// handleOrderCancellation
// ---------------------------------------------------------------------------
describe('handleOrderCancellation', () => {
    const orderId = 'sq_cancel_1';
    const merchantId = 42;

    it('calls handleSquareOrderUpdate with CANCELED and logs', async () => {
        deliveryApi.handleSquareOrderUpdate.mockResolvedValue();

        const result = {};
        await handleOrderCancellation(orderId, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(merchantId, orderId, 'CANCELED');
        expect(logger.info).toHaveBeenCalledWith(
            'Removed cancelled order from delivery queue',
            { squareOrderId: orderId }
        );
    });

    it('catches and logs errors', async () => {
        deliveryApi.handleSquareOrderUpdate.mockRejectedValue(new Error('not found'));

        const result = {};
        await handleOrderCancellation(orderId, merchantId, result);

        expect(logger.error).toHaveBeenCalledWith(
            'Failed to handle order cancellation for delivery',
            expect.objectContaining({ error: 'not found', orderId })
        );
    });
});

// ---------------------------------------------------------------------------
// handleOrderCompletion
// ---------------------------------------------------------------------------
describe('handleOrderCompletion', () => {
    const orderId = 'sq_complete_1';
    const merchantId = 42;

    it('sets result.deliveryCompletion and logs on success', async () => {
        deliveryApi.handleSquareOrderUpdate.mockResolvedValue();

        const result = {};
        await handleOrderCompletion(orderId, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(merchantId, orderId, 'COMPLETED');
        expect(result.deliveryCompletion).toEqual({ squareOrderId: orderId });
        expect(logger.info).toHaveBeenCalledWith(
            'Marked delivery order as completed via webhook',
            { squareOrderId: orderId }
        );
    });

    it('catches and logs errors without setting result', async () => {
        deliveryApi.handleSquareOrderUpdate.mockRejectedValue(new Error('oops'));

        const result = {};
        await handleOrderCompletion(orderId, merchantId, result);

        expect(result.deliveryCompletion).toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to handle order completion for delivery',
            expect.objectContaining({ error: 'oops', orderId })
        );
    });
});

// ---------------------------------------------------------------------------
// refreshDeliveryOrderCustomerIfNeeded
// ---------------------------------------------------------------------------
describe('refreshDeliveryOrderCustomerIfNeeded', () => {
    const merchantId = 42;
    const baseOrder = { id: 'sq_refresh_1', state: 'OPEN' };

    const existingOrder = {
        id: 200,
        customer_name: 'Unknown Customer',
        phone: null,
        square_customer_id: null,
        needs_customer_refresh: true
    };

    it('returns early when no existing order', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(null);

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(baseOrder, merchantId, result);

        expect(deliveryApi.updateOrder).not.toHaveBeenCalled();
        expect(result.deliveryCustomerRefresh).toBeUndefined();
    });

    it('returns early when needs_customer_refresh is false', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue({
            ...existingOrder,
            needs_customer_refresh: false
        });

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(baseOrder, merchantId, result);

        expect(deliveryApi.updateOrder).not.toHaveBeenCalled();
    });

    it('extracts customer from delivery fulfillment when present on order', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);

        const orderWithFulfillments = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: {
                        display_name: 'Alice Smith',
                        phone_number: '555-1234'
                    }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithFulfillments, merchantId, result);

        expect(orderNormalize.fetchFullOrder).not.toHaveBeenCalled();
        expect(deliveryApi.updateOrder).toHaveBeenCalledWith(merchantId, 200, expect.objectContaining({
            customerName: 'Alice Smith',
            phone: '555-1234',
            needsCustomerRefresh: false
        }));
        expect(result.deliveryCustomerRefresh).toEqual({
            orderId: 200,
            previousName: 'Unknown Customer',
            newName: 'Alice Smith'
        });
    });

    it('extracts customer from shipment fulfillment', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);

        const orderWithShipment = {
            ...baseOrder,
            fulfillments: [{
                type: 'SHIPMENT',
                shipment_details: {
                    recipient: {
                        display_name: 'Bob Jones',
                        phone_number: '555-5678'
                    }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithShipment, merchantId, result);

        expect(deliveryApi.updateOrder).toHaveBeenCalledWith(merchantId, 200, expect.objectContaining({
            customerName: 'Bob Jones',
            phone: '555-5678'
        }));
    });

    it('supports camelCase fulfillment properties', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);

        const orderCamelCase = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                deliveryDetails: {
                    recipient: {
                        displayName: 'CamelCase Name',
                        phoneNumber: '555-9999'
                    }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderCamelCase, merchantId, result);

        expect(deliveryApi.updateOrder).toHaveBeenCalledWith(merchantId, 200, expect.objectContaining({
            customerName: 'CamelCase Name',
            phone: '555-9999'
        }));
    });

    it('calls fetchFullOrder when order has no fulfillments', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);
        orderNormalize.fetchFullOrder.mockResolvedValue({
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: {
                        display_name: 'Fetched Name',
                        phone_number: '555-0000'
                    }
                }
            }]
        });

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(baseOrder, merchantId, result);

        expect(orderNormalize.fetchFullOrder).toHaveBeenCalledWith('sq_refresh_1', merchantId);
        expect(deliveryApi.updateOrder).toHaveBeenCalledWith(merchantId, 200, expect.objectContaining({
            customerName: 'Fetched Name'
        }));
    });

    it('calls fetchFullOrder when fulfillments array is empty', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);
        orderNormalize.fetchFullOrder.mockResolvedValue({
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: { recipient: { display_name: 'Full' } }
            }]
        });

        const orderEmptyFulfillments = { ...baseOrder, fulfillments: [] };
        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderEmptyFulfillments, merchantId, result);

        expect(orderNormalize.fetchFullOrder).toHaveBeenCalled();
    });

    it('returns early when fetchFullOrder returns null', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);
        orderNormalize.fetchFullOrder.mockResolvedValue(null);

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(baseOrder, merchantId, result);

        expect(deliveryApi.updateOrder).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Could not fetch full order for customer refresh',
            expect.objectContaining({ squareOrderId: 'sq_refresh_1' })
        );
    });

    it('falls back to Square customer lookup when name missing from fulfillment', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);
        customerDetailsService.getCustomerDetails.mockResolvedValue({
            displayName: 'Looked Up Name',
            phone: '555-LOOKUP'
        });

        const orderNoRecipientName = {
            ...baseOrder,
            customer_id: 'sq_cust_1',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: { recipient: {} }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderNoRecipientName, merchantId, result);

        expect(customerDetailsService.getCustomerDetails).toHaveBeenCalledWith('sq_cust_1', merchantId);
        expect(deliveryApi.updateOrder).toHaveBeenCalledWith(merchantId, 200, expect.objectContaining({
            customerName: 'Looked Up Name',
            phone: '555-LOOKUP'
        }));
    });

    it('falls back to customer lookup when fulfillment name equals existing name', async () => {
        const existingWithName = { ...existingOrder, customer_name: 'Same Name' };
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingWithName);
        customerDetailsService.getCustomerDetails.mockResolvedValue({
            displayName: 'Better Name',
            phone: '555-BETTER'
        });

        const orderSameName = {
            ...baseOrder,
            customer_id: 'sq_cust_2',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'Same Name' }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderSameName, merchantId, result);

        expect(customerDetailsService.getCustomerDetails).toHaveBeenCalledWith('sq_cust_2', merchantId);
    });

    it('logs warning and continues when customer lookup fails', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);
        customerDetailsService.getCustomerDetails.mockRejectedValue(new Error('API down'));

        const orderWithCustomerId = {
            ...baseOrder,
            customer_id: 'sq_cust_3',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: { recipient: {} }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithCustomerId, merchantId, result);

        expect(logger.warn).toHaveBeenCalledWith(
            'Customer lookup failed during refresh',
            expect.objectContaining({ error: 'API down', squareCustomerId: 'sq_cust_3' })
        );
        // Should still call updateOrder with at least the state and flag updates
        expect(deliveryApi.updateOrder).toHaveBeenCalled();
    });

    it('does not overwrite existing phone on the order', async () => {
        const existingWithPhone = {
            ...existingOrder,
            phone: '555-EXISTING'
        };
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingWithPhone);

        const orderWithFulfillments = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: {
                        display_name: 'New Name',
                        phone_number: '555-NEW'
                    }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithFulfillments, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.phone).toBeUndefined();
    });

    it('does not set customerName when it equals "Unknown Customer"', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue({
            ...existingOrder,
            customer_name: 'OldName'
        });

        const orderWithUnknown = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'Unknown Customer' }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithUnknown, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.customerName).toBeUndefined();
    });

    it('does not set customerName when it matches existing name', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue({
            ...existingOrder,
            customer_name: 'Already Correct'
        });

        // No customer_id so no fallback lookup
        const orderSameName = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'Already Correct' }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderSameName, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.customerName).toBeUndefined();
    });

    it('sets squareCustomerId when existing order lacks it', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);

        const orderWithCustId = {
            ...baseOrder,
            customer_id: 'sq_cust_new',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'With CustId' }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithCustId, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.squareCustomerId).toBe('sq_cust_new');
    });

    it('does not overwrite existing squareCustomerId', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue({
            ...existingOrder,
            square_customer_id: 'existing_cust'
        });

        const orderWithCustId = {
            ...baseOrder,
            customer_id: 'sq_cust_new',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'With CustId' }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithCustId, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.squareCustomerId).toBeUndefined();
    });

    it('includes line items in squareOrderData when present', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);

        const orderWithLineItems = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'Line Item Test' }
                }
            }],
            line_items: [
                {
                    name: 'Dog Food',
                    quantity: '2',
                    variation_name: 'Large Bag',
                    modifiers: [],
                    note: 'Grain free'
                }
            ],
            total_money: { amount: 5000, currency: 'CAD' },
            created_at: '2026-01-15T10:00:00Z',
            state: 'OPEN'
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderWithLineItems, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.squareOrderData).toBeDefined();
        expect(updateCall.squareOrderData.lineItems).toHaveLength(1);
        expect(updateCall.squareOrderData.lineItems[0]).toEqual({
            name: 'Dog Food',
            quantity: '2',
            variationName: 'Large Bag',
            modifiers: [],
            note: 'Grain free'
        });
        expect(updateCall.squareOrderData.totalMoney).toEqual({ amount: 5000, currency: 'CAD' });
    });

    it('does not include squareOrderData when no line items', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);

        const orderNoLineItems = {
            ...baseOrder,
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: {
                    recipient: { display_name: 'No Lines' }
                }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderNoLineItems, merchantId, result);

        const updateCall = deliveryApi.updateOrder.mock.calls[0][2];
        expect(updateCall.squareOrderData).toBeUndefined();
    });

    it('catches and logs top-level errors', async () => {
        deliveryApi.getOrderBySquareId.mockRejectedValue(new Error('DB error'));

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(baseOrder, merchantId, result);

        expect(logger.error).toHaveBeenCalledWith(
            'Failed to refresh delivery order customer',
            expect.objectContaining({ error: 'DB error', squareOrderId: 'sq_refresh_1' })
        );
        expect(result.deliveryCustomerRefresh).toBeUndefined();
    });

    it('uses camelCase customerId property', async () => {
        deliveryApi.getOrderBySquareId.mockResolvedValue(existingOrder);
        customerDetailsService.getCustomerDetails.mockResolvedValue({
            displayName: 'CamelCase Customer',
            phone: null
        });

        const orderCamelCaseId = {
            ...baseOrder,
            customerId: 'sq_cust_camel',
            fulfillments: [{
                type: 'DELIVERY',
                delivery_details: { recipient: {} }
            }]
        };

        const result = {};
        await refreshDeliveryOrderCustomerIfNeeded(orderCamelCaseId, merchantId, result);

        expect(customerDetailsService.getCustomerDetails).toHaveBeenCalledWith('sq_cust_camel', merchantId);
    });
});

// ---------------------------------------------------------------------------
// handleFulfillmentDeliveryUpdate
// ---------------------------------------------------------------------------
describe('handleFulfillmentDeliveryUpdate', () => {
    const squareOrderId = 'sq_ful_1';
    const merchantId = 42;

    it('returns early for non-delivery/shipment fulfillment types', async () => {
        const fulfillment = { type: 'PICKUP', state: 'COMPLETED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).not.toHaveBeenCalled();
        expect(result.deliveryUpdate).toBeUndefined();
    });

    it('handles COMPLETED state for DELIVERY type', async () => {
        deliveryApi.handleSquareOrderUpdate.mockResolvedValue();
        const fulfillment = { type: 'DELIVERY', state: 'COMPLETED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(merchantId, squareOrderId, 'COMPLETED');
        expect(result.deliveryUpdate).toEqual({
            orderId: squareOrderId,
            fulfillmentState: 'COMPLETED',
            action: 'marked_completed'
        });
    });

    it('handles CANCELED state for DELIVERY type', async () => {
        deliveryApi.handleSquareOrderUpdate.mockResolvedValue();
        const fulfillment = { type: 'DELIVERY', state: 'CANCELED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(merchantId, squareOrderId, 'CANCELED');
        expect(result.deliveryUpdate).toEqual({
            orderId: squareOrderId,
            fulfillmentState: 'CANCELED',
            action: 'removed'
        });
    });

    it('handles COMPLETED state for SHIPMENT type', async () => {
        deliveryApi.handleSquareOrderUpdate.mockResolvedValue();
        const fulfillment = { type: 'SHIPMENT', state: 'COMPLETED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(merchantId, squareOrderId, 'COMPLETED');
        expect(result.deliveryUpdate.action).toBe('marked_completed');
    });

    it('handles FAILED state by sending CANCELED', async () => {
        deliveryApi.handleSquareOrderUpdate.mockResolvedValue();
        const fulfillment = { type: 'DELIVERY', state: 'FAILED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        expect(deliveryApi.handleSquareOrderUpdate).toHaveBeenCalledWith(merchantId, squareOrderId, 'CANCELED');
        expect(result.deliveryUpdate).toEqual({
            orderId: squareOrderId,
            fulfillmentState: 'FAILED',
            action: 'removed'
        });
    });

    it('calls autoIngestFromFulfillment for non-terminal states', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        mockSquareClient.orders.get.mockResolvedValue({
            order: { id: squareOrderId, state: 'OPEN' }
        });
        deliveryApi.ingestSquareOrder.mockResolvedValue({ id: 300 });

        const fulfillment = { type: 'DELIVERY', state: 'PROPOSED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        // autoIngestFromFulfillment should have been called internally
        expect(deliveryApi.getSettings).toHaveBeenCalledWith(merchantId);
        expect(deliveryApi.ingestSquareOrder).toHaveBeenCalled();
    });

    it('catches errors and sets result.deliveryError', async () => {
        deliveryApi.handleSquareOrderUpdate.mockRejectedValue(new Error('delivery fail'));
        const fulfillment = { type: 'DELIVERY', state: 'COMPLETED' };
        const result = {};

        await handleFulfillmentDeliveryUpdate(squareOrderId, fulfillment, merchantId, result);

        expect(logger.warn).toHaveBeenCalledWith(
            'Delivery order update via fulfillment webhook failed',
            expect.objectContaining({ error: 'delivery fail', orderId: squareOrderId })
        );
        expect(result.deliveryError).toBe('delivery fail');
    });
});

// ---------------------------------------------------------------------------
// autoIngestFromFulfillment
// ---------------------------------------------------------------------------
describe('autoIngestFromFulfillment', () => {
    const squareOrderId = 'sq_auto_1';
    const fulfillmentState = 'PROPOSED';
    const merchantId = 42;

    it('returns early when auto_ingest is disabled', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: false });

        const result = {};
        await autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);

        expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
        expect(deliveryApi.ingestSquareOrder).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            'Skipped auto-ingest - disabled in settings',
            expect.objectContaining({ squareOrderId, fulfillmentState, merchantId })
        );
    });

    it('fetches order from Square and ingests successfully', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        const fullOrder = { id: squareOrderId, state: 'OPEN', line_items: [] };
        mockSquareClient.orders.get.mockResolvedValue({ order: fullOrder });
        deliveryApi.ingestSquareOrder.mockResolvedValue({ id: 400 });

        const result = {};
        await autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);

        expect(getSquareClientForMerchant).toHaveBeenCalledWith(merchantId);
        expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId: squareOrderId });
        expect(deliveryApi.ingestSquareOrder).toHaveBeenCalledWith(merchantId, fullOrder);
        expect(result.deliveryUpdate).toEqual({
            orderId: squareOrderId,
            fulfillmentState,
            action: 'ingested',
            deliveryOrderId: 400
        });
    });

    it('does not set result when ingestSquareOrder returns null', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        mockSquareClient.orders.get.mockResolvedValue({ order: { id: squareOrderId } });
        deliveryApi.ingestSquareOrder.mockResolvedValue(null);

        const result = {};
        await autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);

        expect(result.deliveryUpdate).toBeUndefined();
    });

    it('does not ingest when Square returns no order', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        mockSquareClient.orders.get.mockResolvedValue({ order: null });

        const result = {};
        await autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);

        expect(deliveryApi.ingestSquareOrder).not.toHaveBeenCalled();
    });

    it('catches and logs errors', async () => {
        deliveryApi.getSettings.mockResolvedValue({ auto_ingest_ready_orders: true });
        mockSquareClient.orders.get.mockRejectedValue(new Error('Square API error'));

        const result = {};
        await autoIngestFromFulfillment(squareOrderId, fulfillmentState, merchantId, result);

        expect(logger.warn).toHaveBeenCalledWith(
            'Auto-ingest via fulfillment webhook failed',
            expect.objectContaining({ error: 'Square API error', squareOrderId, fulfillmentState })
        );
    });
});
