/**
 * Tests for loyalty-event-prefetch-service.js
 *
 * Validates prefetchRecentLoyaltyEvents (Square API pagination, lookup map building)
 * and findCustomerFromPrefetchedEvents (order-based customer identification).
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { squareApi: jest.fn() },
}));

const mockMakeSquareRequest = jest.fn();
const mockGetMerchantToken = jest.fn();

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
        makeSquareRequest: mockMakeSquareRequest,
        getMerchantToken: mockGetMerchantToken,
        SquareApiError
    };
});

const { SquareApiError } = require('../../../services/square/square-client');
const { prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents } = require('../../../services/loyalty-admin/loyalty-event-prefetch-service');

const MERCHANT_ID = 1;

describe('prefetchRecentLoyaltyEvents', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns empty result when no access token', async () => {
        mockGetMerchantToken.mockRejectedValue(new Error(`Merchant ${MERCHANT_ID} has no access token configured`));

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result).toEqual({ events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} });
        expect(mockMakeSquareRequest).not.toHaveBeenCalled();
    });

    test('fetches events and builds lookup maps', async () => {
        mockGetMerchantToken.mockResolvedValue('fake-token');

        // Events search response
        mockMakeSquareRequest.mockResolvedValueOnce({
            events: [
                { order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' },
                { order_id: 'ORD_2', loyalty_account_id: 'LACCT_2', created_at: '2026-01-16T12:00:00Z' }
            ],
            cursor: null
        });

        // Loyalty account lookups
        mockMakeSquareRequest.mockResolvedValueOnce({ loyalty_account: { customer_id: 'CUST_A' } });
        mockMakeSquareRequest.mockResolvedValueOnce({ loyalty_account: { customer_id: 'CUST_B' } });

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(2);
        expect(result.byOrderId['ORD_1']).toBeDefined();
        expect(result.byOrderId['ORD_2']).toBeDefined();
        expect(result.byTimestamp).toHaveLength(2);
        expect(result.loyaltyAccounts['LACCT_1']).toBe('CUST_A');
        expect(result.loyaltyAccounts['LACCT_2']).toBe('CUST_B');
    });

    test('handles pagination', async () => {
        mockGetMerchantToken.mockResolvedValue('fake-token');

        // Page 1
        mockMakeSquareRequest.mockResolvedValueOnce({
            events: [{ order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' }],
            cursor: 'page2'
        });
        // Page 2
        mockMakeSquareRequest.mockResolvedValueOnce({
            events: [{ order_id: 'ORD_2', loyalty_account_id: 'LACCT_1', created_at: '2026-01-16T12:00:00Z' }],
            cursor: null
        });
        // Account lookup (same account, only fetched once)
        mockMakeSquareRequest.mockResolvedValueOnce({ loyalty_account: { customer_id: 'CUST_A' } });

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(2);
        // 2 event search calls + 1 account lookup = 3
        expect(mockMakeSquareRequest).toHaveBeenCalledTimes(3);
    });

    test('passes cursor on subsequent page requests', async () => {
        mockGetMerchantToken.mockResolvedValue('fake-token');

        mockMakeSquareRequest.mockResolvedValueOnce({
            events: [{ order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' }],
            cursor: 'next-cursor-abc'
        });
        mockMakeSquareRequest.mockResolvedValueOnce({
            events: [],
            cursor: null
        });
        mockMakeSquareRequest.mockResolvedValueOnce({ loyalty_account: { customer_id: 'CUST_A' } });

        await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        // First page: no cursor in body
        const firstCallBody = JSON.parse(mockMakeSquareRequest.mock.calls[0][1].body);
        expect(firstCallBody.cursor).toBeUndefined();

        // Second page: cursor from page 1
        const secondCallBody = JSON.parse(mockMakeSquareRequest.mock.calls[1][1].body);
        expect(secondCallBody.cursor).toBe('next-cursor-abc');
    });

    test('stops fetching events on API error', async () => {
        mockGetMerchantToken.mockResolvedValue('fake-token');

        mockMakeSquareRequest.mockRejectedValueOnce(
            new SquareApiError('Square API error: 500', { status: 500, endpoint: '/v2/loyalty/events/search' })
        );

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(0);
    });

    test('handles account lookup failure gracefully', async () => {
        mockGetMerchantToken.mockResolvedValue('fake-token');

        mockMakeSquareRequest.mockResolvedValueOnce({
            events: [{ order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' }],
            cursor: null
        });
        // Account lookup throws
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('Network error'));

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(1);
        expect(Object.keys(result.loyaltyAccounts)).toHaveLength(0);
    });

    test('returns empty on unexpected error', async () => {
        // Simulate an unexpected post-token error (e.g. during events processing)
        mockGetMerchantToken.mockResolvedValue('fake-token');
        mockMakeSquareRequest.mockImplementationOnce(() => {
            throw new TypeError('unexpected sync failure');
        });

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        // Outer catch swallows and returns empty shape
        expect(result).toEqual({ events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} });
    });
});

describe('findCustomerFromPrefetchedEvents', () => {
    test('finds customer by order_id', () => {
        const prefetchedData = {
            byOrderId: {
                'ORD_1': { loyalty_account_id: 'LACCT_1' }
            },
            loyaltyAccounts: {
                'LACCT_1': 'CUST_A'
            }
        };

        const result = findCustomerFromPrefetchedEvents('ORD_1', prefetchedData);
        expect(result).toBe('CUST_A');
    });

    test('returns null when order_id not in prefetched data', () => {
        const prefetchedData = {
            byOrderId: {},
            loyaltyAccounts: {}
        };

        const result = findCustomerFromPrefetchedEvents('ORD_UNKNOWN', prefetchedData);
        expect(result).toBeNull();
    });

    test('returns null when order found but account has no customer mapping', () => {
        const prefetchedData = {
            byOrderId: {
                'ORD_1': { loyalty_account_id: 'LACCT_UNKNOWN' }
            },
            loyaltyAccounts: {}
        };

        const result = findCustomerFromPrefetchedEvents('ORD_1', prefetchedData);
        expect(result).toBeNull();
    });
});
