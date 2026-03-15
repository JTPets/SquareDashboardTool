/**
 * Tests for order-velocity.js
 *
 * Covers updateVelocityFromOrder, updateVelocityFromFulfillment,
 * and completedOrderVelocityCache dedup behavior.
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../../utils/logger', () => logger);
jest.mock('../../../../services/square', () => ({
    updateSalesVelocityFromOrder: jest.fn()
}));
const mockSquareClient = { orders: { get: jest.fn() } };
jest.mock('../../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue(mockSquareClient)
}));

const { completedOrderVelocityCache, updateVelocityFromOrder, updateVelocityFromFulfillment } = require('../../../../services/webhook-handlers/order-handler/order-velocity');
const squareApi = require('../../../../services/square');
const { getSquareClientForMerchant } = require('../../../../middleware/merchant');

beforeEach(() => {
    jest.clearAllMocks();
    completedOrderVelocityCache.clear();
});

describe('updateVelocityFromOrder', () => {
    const merchantId = 1;
    const order = { id: 'ORDER_123', state: 'COMPLETED', line_items: [] };

    test('returns deduplicated result when order already in cache', async () => {
        completedOrderVelocityCache.set(`${order.id}:${merchantId}`, true);

        const result = await updateVelocityFromOrder(order, merchantId);

        expect(result).toEqual({ method: 'incremental', deduplicated: true });
        expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            'Sales velocity dedup — skipping duplicate order webhook',
            expect.objectContaining({ orderId: order.id, merchantId })
        );
    });

    test('calls updateSalesVelocityFromOrder and returns result with updated/skipped/periods', async () => {
        squareApi.updateSalesVelocityFromOrder.mockResolvedValue({
            updated: 3, skipped: 1, periods: [7, 30, 90]
        });

        const result = await updateVelocityFromOrder(order, merchantId);

        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledWith(order, merchantId);
        expect(result).toEqual({
            method: 'incremental',
            updated: 3,
            skipped: 1,
            periods: [7, 30, 90]
        });
    });

    test('logs info when updated > 0', async () => {
        squareApi.updateSalesVelocityFromOrder.mockResolvedValue({
            updated: 2, skipped: 0, periods: [7]
        });

        await updateVelocityFromOrder(order, merchantId);

        expect(logger.info).toHaveBeenCalledWith(
            'Sales velocity updated incrementally from completed order',
            expect.objectContaining({ orderId: order.id, updated: 2, merchantId })
        );
    });

    test('does not log info when updated === 0', async () => {
        squareApi.updateSalesVelocityFromOrder.mockResolvedValue({
            updated: 0, skipped: 5, periods: [7, 30]
        });

        await updateVelocityFromOrder(order, merchantId);

        expect(logger.info).not.toHaveBeenCalledWith(
            'Sales velocity updated incrementally from completed order',
            expect.anything()
        );
    });

    test('returns error info when velocity update throws (non-blocking)', async () => {
        squareApi.updateSalesVelocityFromOrder.mockRejectedValue(new Error('DB timeout'));

        const result = await updateVelocityFromOrder(order, merchantId);

        expect(result).toEqual({ method: 'incremental', error: 'DB timeout' });
        expect(logger.warn).toHaveBeenCalledWith(
            'Sales velocity update failed — continuing with delivery and loyalty',
            expect.objectContaining({ orderId: order.id, error: 'DB timeout' })
        );
    });

    test('sets cache entry for the order', async () => {
        squareApi.updateSalesVelocityFromOrder.mockResolvedValue({
            updated: 1, skipped: 0, periods: [7]
        });

        await updateVelocityFromOrder(order, merchantId);

        expect(completedOrderVelocityCache.has(`${order.id}:${merchantId}`)).toBe(true);
    });
});

describe('updateVelocityFromFulfillment', () => {
    const merchantId = 2;
    const orderId = 'ORDER_456';

    test('returns deduplicated result when order already in cache', async () => {
        completedOrderVelocityCache.set(`${orderId}:${merchantId}`, true);

        const result = await updateVelocityFromFulfillment(orderId, merchantId);

        expect(result).toEqual({ method: 'incremental', fromFulfillment: true, deduplicated: true });
        expect(mockSquareClient.orders.get).not.toHaveBeenCalled();
    });

    test('fetches order from Square, normalizes it, updates velocity if COMPLETED', async () => {
        const squareOrder = { id: orderId, state: 'COMPLETED', lineItems: [{ catalogObjectId: 'VAR_1' }] };
        mockSquareClient.orders.get.mockResolvedValue({ order: squareOrder });
        squareApi.updateSalesVelocityFromOrder.mockResolvedValue({ updated: 1 });

        const result = await updateVelocityFromFulfillment(orderId, merchantId);

        expect(getSquareClientForMerchant).toHaveBeenCalledWith(merchantId);
        expect(mockSquareClient.orders.get).toHaveBeenCalledWith({ orderId });
        expect(squareApi.updateSalesVelocityFromOrder).toHaveBeenCalledWith(
            expect.objectContaining({ id: orderId, state: 'COMPLETED' }),
            merchantId
        );
        expect(result).toEqual({
            method: 'incremental',
            fromFulfillment: true,
            updated: 1
        });
    });

    test('returns null when order is not COMPLETED', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: { id: orderId, state: 'OPEN' }
        });

        const result = await updateVelocityFromFulfillment(orderId, merchantId);

        expect(result).toBeNull();
        expect(squareApi.updateSalesVelocityFromOrder).not.toHaveBeenCalled();
    });

    test('returns null when Square API throws error', async () => {
        mockSquareClient.orders.get.mockRejectedValue(new Error('Not found'));

        const result = await updateVelocityFromFulfillment(orderId, merchantId);

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Could not fetch order for fulfillment velocity update',
            expect.objectContaining({ orderId, error: 'Not found' })
        );
    });

    test('sets cache entry on success', async () => {
        mockSquareClient.orders.get.mockResolvedValue({
            order: { id: orderId, state: 'COMPLETED', lineItems: [] }
        });
        squareApi.updateSalesVelocityFromOrder.mockResolvedValue({ updated: 0 });

        await updateVelocityFromFulfillment(orderId, merchantId);

        expect(completedOrderVelocityCache.has(`${orderId}:${merchantId}`)).toBe(true);
    });
});
