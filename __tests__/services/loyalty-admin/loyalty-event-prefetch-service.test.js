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

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    getSquareAccessToken: jest.fn(),
    fetchWithTimeout: jest.fn(),
}));

const { prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents } = require('../../../services/loyalty-admin/loyalty-event-prefetch-service');
const { getSquareAccessToken, fetchWithTimeout } = require('../../../services/loyalty-admin/shared-utils');

const MERCHANT_ID = 1;

describe('prefetchRecentLoyaltyEvents', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns empty result when no access token', async () => {
        getSquareAccessToken.mockResolvedValue(null);

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result).toEqual({ events: [], byOrderId: {}, byTimestamp: [], loyaltyAccounts: {} });
        expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    test('fetches events and builds lookup maps', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');

        // Events search response
        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                events: [
                    { order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' },
                    { order_id: 'ORD_2', loyalty_account_id: 'LACCT_2', created_at: '2026-01-16T12:00:00Z' }
                ],
                cursor: null
            })
        });

        // Loyalty account lookups
        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ loyalty_account: { customer_id: 'CUST_A' } })
        });
        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ loyalty_account: { customer_id: 'CUST_B' } })
        });

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(2);
        expect(result.byOrderId['ORD_1']).toBeDefined();
        expect(result.byOrderId['ORD_2']).toBeDefined();
        expect(result.byTimestamp).toHaveLength(2);
        expect(result.loyaltyAccounts['LACCT_1']).toBe('CUST_A');
        expect(result.loyaltyAccounts['LACCT_2']).toBe('CUST_B');
    });

    test('handles pagination', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');

        // Page 1
        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                events: [{ order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' }],
                cursor: 'page2'
            })
        });
        // Page 2
        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                events: [{ order_id: 'ORD_2', loyalty_account_id: 'LACCT_1', created_at: '2026-01-16T12:00:00Z' }],
                cursor: null
            })
        });
        // Account lookup (same account, only fetched once)
        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ loyalty_account: { customer_id: 'CUST_A' } })
        });

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(2);
        // 2 event search calls + 1 account lookup = 3
        expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    });

    test('stops fetching events on API error', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');

        fetchWithTimeout.mockResolvedValueOnce({
            ok: false,
            status: 500,
        });

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(0);
    });

    test('handles account lookup failure gracefully', async () => {
        getSquareAccessToken.mockResolvedValue('fake-token');

        fetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                events: [{ order_id: 'ORD_1', loyalty_account_id: 'LACCT_1', created_at: '2026-01-15T12:00:00Z' }],
                cursor: null
            })
        });
        // Account lookup throws
        fetchWithTimeout.mockRejectedValueOnce(new Error('Network error'));

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

        expect(result.events).toHaveLength(1);
        expect(Object.keys(result.loyaltyAccounts)).toHaveLength(0);
    });

    test('returns empty on unexpected error', async () => {
        getSquareAccessToken.mockRejectedValue(new Error('Token error'));

        const result = await prefetchRecentLoyaltyEvents(MERCHANT_ID, 7);

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
