/**
 * Tests for order-processing-service.js
 *
 * Validates manual order processing: token retrieval, Square API fetch,
 * customer details, diagnostics, and loyalty processing.
 *
 * LA-2 fix: manual processing now routes through processLoyaltyOrder() (order-intake)
 * instead of the legacy processOrderForLoyalty() (webhook-processing-service).
 *
 * Task 16: order-processing-service was migrated onto square-client.js. Mocks
 * now target services/square/square-client (getMerchantToken + makeSquareRequest
 * + SquareApiError) instead of services/loyalty-admin/shared-utils.
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

jest.mock('../../../services/square/square-client', () => {
    class SquareApiError extends Error {
        constructor(message, { status, endpoint, details = [], nonRetryable = false } = {}) {
            super(message);
            this.name = 'SquareApiError';
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
            this.nonRetryable = nonRetryable;
            this.squareErrors = details;
        }
    }
    return {
        getMerchantToken: jest.fn(),
        makeSquareRequest: jest.fn(),
        SquareApiError,
    };
});

jest.mock('../../../services/loyalty-admin/customer-admin-service', () => ({
    getCustomerDetails: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn(),
}));

const { processOrderManually } = require('../../../services/loyalty-admin/order-processing-service');
const { getMerchantToken, makeSquareRequest, SquareApiError } = require('../../../services/square/square-client');
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
    });

    test('throws on missing merchantId', async () => {
        await expect(processOrderManually({ squareOrderId: ORDER_ID }))
            .rejects.toThrow('merchantId is required');
    });

    test('throws when no Square access token', async () => {
        // getMerchantToken throws on missing token (replaces legacy null return)
        getMerchantToken.mockRejectedValue(new Error('Merchant 1 has no access token configured'));

        await expect(processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID }))
            .rejects.toThrow('No Square access token');
    });

    test('throws on Square API error', async () => {
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockRejectedValue(new SquareApiError('Square API error: 500', {
            status: 500,
            endpoint: `/v2/orders/${ORDER_ID}`,
            details: [{ code: 'INTERNAL_SERVER_ERROR' }],
            nonRetryable: false
        }));

        await expect(processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID }))
            .rejects.toThrow('Unable to retrieve order details');
    });

    test('throws when order not found in Square', async () => {
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockResolvedValue({ order: null });

        await expect(processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID }))
            .rejects.toThrow('Order not found in Square');
    });

    test('returns unprocessed result when order has no customer', async () => {
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockResolvedValue({ order: makeSquareOrder({ customerId: null }) });

        const result = await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(result.processed).toBe(false);
        expect(result.reason).toContain('no customer ID');
        expect(result.tip).toBeDefined();
        expect(result.diagnostics.hasCustomer).toBe(false);
        expect(processLoyaltyOrder).not.toHaveBeenCalled();
    });

    test('calls processLoyaltyOrder with correct signature and source=manual', async () => {
        getMerchantToken.mockResolvedValue('fake-token');
        const order = makeSquareOrder();
        makeSquareRequest.mockResolvedValue({ order });

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

    test('preserves 10_000 ms timeout when fetching the order', async () => {
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockResolvedValue({ order: makeSquareOrder({ customerId: null }) });

        await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(makeSquareRequest).toHaveBeenCalledWith(
            `/v2/orders/${ORDER_ID}`,
            expect.objectContaining({
                accessToken: 'fake-token',
                method: 'GET',
                timeout: 10000
            })
        );
    });

    test('processes order with customer and returns diagnostics', async () => {
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockResolvedValue({ order: makeSquareOrder() });

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
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockResolvedValue({ order: makeSquareOrder() });

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
        getMerchantToken.mockResolvedValue('fake-token');
        makeSquareRequest.mockResolvedValue({ order: makeSquareOrder({ customerId: null }) });

        const result = await processOrderManually({ merchantId: MERCHANT_ID, squareOrderId: ORDER_ID });

        expect(result.diagnostics.lineItems[0]).toMatchObject({
            name: 'BCR Chicken 4lb',
            quantity: '1',
            catalogObjectId: 'VAR_001',
            variationName: '4lb'
        });
    });
});
