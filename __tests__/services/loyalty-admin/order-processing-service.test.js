/**
 * Tests for order-processing-service.js
 *
 * Validates manual order processing: token retrieval, Square API fetch,
 * customer details, diagnostics, and loyalty processing.
 *
 * LA-2 fix: manual processing now routes through processLoyaltyOrder() (order-intake)
 * instead of the legacy processOrderForLoyalty() (webhook-processing-service).
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    getSquareAccessToken: jest.fn(),
    fetchWithTimeout: jest.fn((url, options) => global.fetch(url, options)),
}));

jest.mock('../../../services/loyalty-admin/customer-admin-service', () => ({
    getCustomerDetails: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn(),
}));

const { processOrderManually } = require('../../../services/loyalty-admin/order-processing-service');
const { getSquareAccessToken } = require('../../../services/loyalty-admin/shared-utils');
const { getCustomerDetails } = require('../../../services/loyalty-admin/customer-admin-service');
const { processLoyaltyOrder } = require('../../../services/loyalty-admin/order-intake');

const MERCHANT_ID = 1;
const ORDER_ID = 'ORD_TEST_001';

function makeSquareOrder({ customerId = 'CUST_1' } = {}) {
    return {
        id: ORDER_ID,
        customer_id: customerId,
        state: 'COMPLETED',
        created_at: '2026-01-15T12:00:00Z',
        line_items: [{
            name: 'BCR Chicken 4lb',
            quantity: '1',
            catalog_object_id: 'VAR_001',
            variation_name: '4lb'
        }]
    };
}

describe('order-processing-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('throws on missing merchantId', async () => {
        await expect(processOrderManually({ squareOrderId: ORDER_ID }))
            .rejects.toThrow('merchantId is required');
    });

    test('throws when no Square access token', async () => {
        getSquareAccessToken.mockResolvedValue(null);

        await expect(processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID }))
            .rejects.toThrow('No Square access token');
    });

    test('throws on Square API error', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        global.fetch.mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error'
        });

        await expect(processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID }))
            .rejects.toThrow('Unable to retrieve order details');
    });

    test('throws when order not found in Square', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ order: null })
        });

        await expect(processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID }))
            .rejects.toThrow('Order not found in Square');
    });

    test('returns unprocessed result when order has no customer', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ order: makeSquareOrder({ customerId: null }) })
        });

        const result = await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(result.processed).toBe(false);
        expect(result.reason).toContain('no customer ID');
        expect(result.tip).toBeDefined();
        expect(result.diagnostics.hasCustomer).toBe(false);
        expect(processLoyaltyOrder).not.toHaveBeenCalled();
    });

    test('calls processLoyaltyOrder with correct signature and source=manual', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        const order = makeSquareOrder();
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ order })
        });

        getCustomerDetails.mockResolvedValue({ id: 'CUST_1', displayName: 'John' });
        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: false,
            purchaseEvents: [{ id: 1 }],
            rewardEarned: false
        });

        await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(processLoyaltyOrder).toHaveBeenCalledWith({
            order,
            merchantId: MERCHANT_ID,
            squareCustomerId: 'CUST_1',
            source: 'manual',
            customerSource: 'order'
        });
    });

    test('processes order with customer and returns diagnostics', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ order: makeSquareOrder() })
        });

        getCustomerDetails.mockResolvedValue({ id: 'CUST_1', displayName: 'John' });
        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: false,
            purchaseEvents: [{ id: 1 }],
            rewardEarned: false
        });

        const result = await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(result.processed).toBe(true);
        expect(result.diagnostics.hasCustomer).toBe(true);
        expect(result.diagnostics.customerDetails.displayName).toBe('John');
        expect(result.diagnostics.lineItems).toHaveLength(1);
        expect(processLoyaltyOrder).toHaveBeenCalledTimes(1);
    });

    test('returns processed=false when order was already processed', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ order: makeSquareOrder() })
        });

        getCustomerDetails.mockResolvedValue({ id: 'CUST_1', displayName: 'John' });
        processLoyaltyOrder.mockResolvedValue({
            alreadyProcessed: true,
            purchaseEvents: [],
            rewardEarned: false
        });

        const result = await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(result.processed).toBe(false);
    });

    test('diagnostics include line item details', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ order: makeSquareOrder({ customerId: null }) })
        });

        const result = await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(result.diagnostics.lineItems[0]).toMatchObject({
            name: 'BCR Chicken 4lb',
            quantity: '1',
            catalogObjectId: 'VAR_001',
            variationName: '4lb'
        });
    });
});
