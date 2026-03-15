/**
 * Tests for services/loyalty-admin/square-api-client.js
 *
 * Covers: SquareApiClient initialization, convenience methods, pagination, error handling.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const mockSquareApiRequest = jest.fn();
const mockGetSquareAccessToken = jest.fn();

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    squareApiRequest: mockSquareApiRequest,
    getSquareAccessToken: mockGetSquareAccessToken,
    SquareApiError: class SquareApiError extends Error {
        constructor(message, status, endpoint, details = {}) {
            super(message);
            this.name = 'SquareApiError';
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
        }
    },
}));

const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');
const { SquareApiError } = require('../../../services/loyalty-admin/shared-utils');

const MERCHANT_ID = 42;

describe('SquareApiClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSquareAccessToken.mockResolvedValue('test-token');
    });

    // ========================================================================
    // Initialization
    // ========================================================================

    describe('initialize', () => {
        test('fetches and stores access token', async () => {
            const client = new SquareApiClient(MERCHANT_ID);
            const result = await client.initialize();

            expect(mockGetSquareAccessToken).toHaveBeenCalledWith(MERCHANT_ID);
            expect(client.accessToken).toBe('test-token');
            expect(result).toBe(client); // returns self for chaining
        });

        test('throws SquareApiError when no token available', async () => {
            mockGetSquareAccessToken.mockResolvedValue(null);

            const client = new SquareApiClient(MERCHANT_ID);
            await expect(client.initialize()).rejects.toThrow('No access token available');
        });
    });

    // ========================================================================
    // request
    // ========================================================================

    describe('request', () => {
        test('throws if client not initialized', async () => {
            const client = new SquareApiClient(MERCHANT_ID);

            await expect(client.request('GET', '/test'))
                .rejects.toThrow('Client not initialized');
        });

        test('delegates to squareApiRequest with stored token', async () => {
            mockSquareApiRequest.mockResolvedValue({ data: 'ok' });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.request('GET', '/test', null, { timeout: 5000 });

            expect(result).toEqual({ data: 'ok' });
            expect(mockSquareApiRequest).toHaveBeenCalledWith(
                'test-token', 'GET', '/test', null,
                expect.objectContaining({ merchantId: MERCHANT_ID, timeout: 5000 })
            );
        });
    });

    // ========================================================================
    // Convenience methods
    // ========================================================================

    describe('getCustomer', () => {
        test('returns customer object', async () => {
            mockSquareApiRequest.mockResolvedValue({ customer: { id: 'c1', given_name: 'John' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getCustomer('c1');

            expect(result).toEqual({ id: 'c1', given_name: 'John' });
        });
    });

    describe('getLoyaltyAccount', () => {
        test('returns loyalty_account object', async () => {
            mockSquareApiRequest.mockResolvedValue({ loyalty_account: { id: 'la1', balance: 100 } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getLoyaltyAccount('la1');

            expect(result).toEqual({ id: 'la1', balance: 100 });
        });
    });

    describe('getOrder', () => {
        test('returns order object', async () => {
            mockSquareApiRequest.mockResolvedValue({ order: { id: 'o1', state: 'COMPLETED' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getOrder('o1');

            expect(result).toEqual({ id: 'o1', state: 'COMPLETED' });
        });

        test('returns null on 404', async () => {
            const error = new SquareApiError('Not found', 404, '/orders/missing');
            mockSquareApiRequest.mockRejectedValue(error);
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getOrder('missing');

            expect(result).toBeNull();
        });

        test('re-throws non-404 errors', async () => {
            const error = new SquareApiError('Server error', 500, '/orders/x');
            mockSquareApiRequest.mockRejectedValue(error);
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            await expect(client.getOrder('x')).rejects.toThrow('Server error');
        });
    });

    describe('createCustomerGroup', () => {
        test('returns created group', async () => {
            mockSquareApiRequest.mockResolvedValue({ group: { id: 'g1', name: 'VIP' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.createCustomerGroup('VIP', 'idem-1');

            expect(result).toEqual({ id: 'g1', name: 'VIP' });
            expect(mockSquareApiRequest).toHaveBeenCalledWith(
                'test-token', 'POST', '/customers/groups',
                { group: { name: 'VIP' }, idempotency_key: 'idem-1' },
                expect.any(Object)
            );
        });
    });

    describe('batchUpsertCatalog', () => {
        test('returns created objects', async () => {
            mockSquareApiRequest.mockResolvedValue({ objects: [{ id: 'obj1' }] });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.batchUpsertCatalog([{ id: 'obj1' }], 'idem-2');

            expect(result).toEqual([{ id: 'obj1' }]);
        });

        test('returns empty array when response has no objects', async () => {
            mockSquareApiRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.batchUpsertCatalog([], 'idem-3');

            expect(result).toEqual([]);
        });
    });

    describe('getCatalogObject', () => {
        test('returns catalog object', async () => {
            mockSquareApiRequest.mockResolvedValue({ object: { id: 'cat1', type: 'DISCOUNT' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getCatalogObject('cat1');

            expect(result).toEqual({ id: 'cat1', type: 'DISCOUNT' });
        });

        test('returns null on 404', async () => {
            mockSquareApiRequest.mockRejectedValue(new SquareApiError('Not found', 404, '/catalog'));
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getCatalogObject('missing');

            expect(result).toBeNull();
        });
    });

    describe('addCustomerToGroup', () => {
        test('returns true on success', async () => {
            mockSquareApiRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.addCustomerToGroup('c1', 'g1');

            expect(result).toBe(true);
        });
    });

    describe('removeCustomerFromGroup', () => {
        test('returns true on success', async () => {
            mockSquareApiRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.removeCustomerFromGroup('c1', 'g1');

            expect(result).toBe(true);
        });

        test('returns true on 404 (already removed)', async () => {
            mockSquareApiRequest.mockRejectedValue(new SquareApiError('Not found', 404, '/test'));
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.removeCustomerFromGroup('c1', 'g1');

            expect(result).toBe(true);
        });

        test('re-throws non-404 errors', async () => {
            mockSquareApiRequest.mockRejectedValue(new SquareApiError('Fail', 500, '/test'));
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            await expect(client.removeCustomerFromGroup('c1', 'g1')).rejects.toThrow('Fail');
        });
    });

    // ========================================================================
    // Paginated methods
    // ========================================================================

    describe('searchLoyaltyEvents', () => {
        test('returns all events from single page', async () => {
            mockSquareApiRequest.mockResolvedValue({
                events: [{ id: 'e1' }, { id: 'e2' }],
            });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            expect(result).toHaveLength(2);
        });

        test('paginates through multiple pages', async () => {
            mockSquareApiRequest
                .mockResolvedValueOnce({ events: [{ id: 'e1' }], cursor: 'page2' })
                .mockResolvedValueOnce({ events: [{ id: 'e2' }] });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            expect(result).toHaveLength(2);
            expect(mockSquareApiRequest).toHaveBeenCalledTimes(2);
            // Second call should include cursor
            const secondCallBody = mockSquareApiRequest.mock.calls[1][3];
            expect(secondCallBody.cursor).toBe('page2');
        });

        test('stops at MAX_PAGES safety limit', async () => {
            // Always return cursor to simulate infinite pagination
            mockSquareApiRequest.mockResolvedValue({ events: [{ id: 'e' }], cursor: 'next' });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            // Should stop at 20 pages
            expect(result).toHaveLength(20);
            expect(mockSquareApiRequest).toHaveBeenCalledTimes(20);
        });

        test('handles empty events array', async () => {
            mockSquareApiRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            expect(result).toEqual([]);
        });
    });

    describe('searchCustomers', () => {
        test('returns all customers from single page', async () => {
            mockSquareApiRequest.mockResolvedValue({
                customers: [{ id: 'c1' }, { id: 'c2' }],
            });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchCustomers({ query: {} });

            expect(result).toHaveLength(2);
        });

        test('paginates through multiple pages', async () => {
            mockSquareApiRequest
                .mockResolvedValueOnce({ customers: [{ id: 'c1' }], cursor: 'p2' })
                .mockResolvedValueOnce({ customers: [{ id: 'c2' }] });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchCustomers({ query: {} });

            expect(result).toHaveLength(2);
        });

        test('handles empty customers array', async () => {
            mockSquareApiRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchCustomers({ query: {} });

            expect(result).toEqual([]);
        });
    });
});
