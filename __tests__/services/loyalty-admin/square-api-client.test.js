/**
 * Tests for services/loyalty-admin/square-api-client.js
 *
 * Covers: SquareApiClient initialization, convenience methods, pagination, error handling.
 *
 * Post Task 11 (Square client refactor): this client is now a thin shim
 * over services/square/square-client.js. Mocks target that module directly
 * so the shim's delegation and 404-null semantics are exercised end-to-end.
 * The mocked SquareApiError uses the new options-object constructor shape
 * — the same shape verified in the Section 3 risk register before migration.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const mockMakeSquareRequest = jest.fn();
const mockGetMerchantToken = jest.fn();

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: mockMakeSquareRequest,
    getMerchantToken: mockGetMerchantToken,
    SquareApiError: class SquareApiError extends Error {
        constructor(message, { status, endpoint, details = [], nonRetryable = false } = {}) {
            super(message);
            this.name = 'SquareApiError';
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
            this.nonRetryable = nonRetryable;
            this.squareErrors = details;
        }
    },
}));

const { SquareApiClient } = require('../../../services/loyalty-admin/square-api-client');
const { SquareApiError } = require('../../../services/square/square-client');

const MERCHANT_ID = 42;

describe('SquareApiClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
    });

    // ========================================================================
    // SquareApiError field-shape snapshot (Section 3 risk register)
    // ========================================================================

    describe('SquareApiError field shape', () => {
        test('exposes status/endpoint/details/nonRetryable for downstream branches', () => {
            const err = new SquareApiError('boom', {
                status: 500,
                endpoint: '/v2/orders/x',
                details: [{ code: 'INTERNAL_SERVER_ERROR' }],
                nonRetryable: false,
            });

            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe('SquareApiError');
            expect(err.status).toBe(500);
            expect(err.endpoint).toBe('/v2/orders/x');
            expect(err.details).toEqual([{ code: 'INTERNAL_SERVER_ERROR' }]);
            expect(err.nonRetryable).toBe(false);
            // Backward-compat alias used by legacy callers
            expect(err.squareErrors).toEqual([{ code: 'INTERNAL_SERVER_ERROR' }]);
        });
    });

    // ========================================================================
    // Initialization
    // ========================================================================

    describe('initialize', () => {
        test('fetches and stores access token', async () => {
            const client = new SquareApiClient(MERCHANT_ID);
            const result = await client.initialize();

            expect(mockGetMerchantToken).toHaveBeenCalledWith(MERCHANT_ID);
            expect(client.accessToken).toBe('test-token');
            expect(result).toBe(client); // returns self for chaining
        });

        test('throws SquareApiError when token fetch fails', async () => {
            mockGetMerchantToken.mockRejectedValue(new Error(`Merchant ${MERCHANT_ID} not found or inactive`));

            const client = new SquareApiClient(MERCHANT_ID);
            await expect(client.initialize()).rejects.toThrow('No access token available');
            // And the thrown error must be a SquareApiError with status 401 so
            // callers that key off err.status keep working.
            await expect(
                new SquareApiClient(MERCHANT_ID).initialize()
            ).rejects.toMatchObject({ name: 'SquareApiError', status: 401 });
        });
    });

    // ========================================================================
    // request
    // ========================================================================

    describe('request', () => {
        test('throws if client not initialized', async () => {
            const client = new SquareApiClient(MERCHANT_ID);

            await expect(client.request('GET', '/v2/test'))
                .rejects.toThrow('Client not initialized');
        });

        test('delegates to makeSquareRequest with stored token', async () => {
            mockMakeSquareRequest.mockResolvedValue({ data: 'ok' });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.request('GET', '/v2/test', null, { timeout: 5000 });

            expect(result).toEqual({ data: 'ok' });
            expect(mockMakeSquareRequest).toHaveBeenCalledWith(
                '/v2/test',
                expect.objectContaining({
                    accessToken: 'test-token',
                    method: 'GET',
                    timeout: 5000,
                })
            );
            // GET with no body: no body key should be passed
            expect(mockMakeSquareRequest.mock.calls[0][1]).not.toHaveProperty('body');
        });
    });

    // ========================================================================
    // Convenience methods
    // ========================================================================

    describe('getCustomer', () => {
        test('returns customer object', async () => {
            mockMakeSquareRequest.mockResolvedValue({ customer: { id: 'c1', given_name: 'John' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getCustomer('c1');

            expect(result).toEqual({ id: 'c1', given_name: 'John' });
            expect(mockMakeSquareRequest).toHaveBeenCalledWith(
                '/v2/customers/c1',
                expect.objectContaining({ accessToken: 'test-token', method: 'GET' })
            );
        });
    });

    describe('getLoyaltyAccount', () => {
        test('returns loyalty_account object', async () => {
            mockMakeSquareRequest.mockResolvedValue({ loyalty_account: { id: 'la1', balance: 100 } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getLoyaltyAccount('la1');

            expect(result).toEqual({ id: 'la1', balance: 100 });
        });
    });

    describe('getOrder', () => {
        test('returns order object', async () => {
            mockMakeSquareRequest.mockResolvedValue({ order: { id: 'o1', state: 'COMPLETED' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getOrder('o1');

            expect(result).toEqual({ id: 'o1', state: 'COMPLETED' });
        });

        test('returns null on 404', async () => {
            const error = new SquareApiError('Not found', { status: 404, endpoint: '/v2/orders/missing' });
            mockMakeSquareRequest.mockRejectedValue(error);
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getOrder('missing');

            expect(result).toBeNull();
        });

        test('re-throws non-404 errors', async () => {
            const error = new SquareApiError('Server error', { status: 500, endpoint: '/v2/orders/x' });
            mockMakeSquareRequest.mockRejectedValue(error);
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            await expect(client.getOrder('x')).rejects.toThrow('Server error');
        });

        test('re-throws non-SquareApiError errors (guards instanceof check)', async () => {
            // A plain Error with status=404 must still propagate — the shim's
            // 404-to-null branch is gated on `instanceof SquareApiError`.
            const plainErr = new Error('network boom');
            plainErr.status = 404;
            mockMakeSquareRequest.mockRejectedValue(plainErr);
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            await expect(client.getOrder('x')).rejects.toThrow('network boom');
        });
    });

    describe('createCustomerGroup', () => {
        test('returns created group', async () => {
            mockMakeSquareRequest.mockResolvedValue({ group: { id: 'g1', name: 'VIP' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.createCustomerGroup('VIP', 'idem-1');

            expect(result).toEqual({ id: 'g1', name: 'VIP' });
            expect(mockMakeSquareRequest).toHaveBeenCalledWith(
                '/v2/customers/groups',
                expect.objectContaining({
                    accessToken: 'test-token',
                    method: 'POST',
                    body: JSON.stringify({ group: { name: 'VIP' }, idempotency_key: 'idem-1' }),
                })
            );
        });
    });

    describe('batchUpsertCatalog', () => {
        test('returns created objects', async () => {
            mockMakeSquareRequest.mockResolvedValue({ objects: [{ id: 'obj1' }] });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.batchUpsertCatalog([{ id: 'obj1' }], 'idem-2');

            expect(result).toEqual([{ id: 'obj1' }]);
        });

        test('returns empty array when response has no objects', async () => {
            mockMakeSquareRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.batchUpsertCatalog([], 'idem-3');

            expect(result).toEqual([]);
        });
    });

    describe('getCatalogObject', () => {
        test('returns catalog object', async () => {
            mockMakeSquareRequest.mockResolvedValue({ object: { id: 'cat1', type: 'DISCOUNT' } });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getCatalogObject('cat1');

            expect(result).toEqual({ id: 'cat1', type: 'DISCOUNT' });
        });

        test('returns null on 404', async () => {
            mockMakeSquareRequest.mockRejectedValue(
                new SquareApiError('Not found', { status: 404, endpoint: '/v2/catalog' })
            );
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.getCatalogObject('missing');

            expect(result).toBeNull();
        });
    });

    describe('addCustomerToGroup', () => {
        test('returns true on success', async () => {
            mockMakeSquareRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.addCustomerToGroup('c1', 'g1');

            expect(result).toBe(true);
            expect(mockMakeSquareRequest).toHaveBeenCalledWith(
                '/v2/customers/c1/groups/g1',
                expect.objectContaining({ method: 'PUT', body: '{}' })
            );
        });
    });

    describe('removeCustomerFromGroup', () => {
        test('returns true on success', async () => {
            mockMakeSquareRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.removeCustomerFromGroup('c1', 'g1');

            expect(result).toBe(true);
        });

        test('returns true on 404 (already removed)', async () => {
            mockMakeSquareRequest.mockRejectedValue(
                new SquareApiError('Not found', { status: 404, endpoint: '/v2/test' })
            );
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.removeCustomerFromGroup('c1', 'g1');

            expect(result).toBe(true);
        });

        test('re-throws non-404 errors', async () => {
            mockMakeSquareRequest.mockRejectedValue(
                new SquareApiError('Fail', { status: 500, endpoint: '/v2/test' })
            );
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            await expect(client.removeCustomerFromGroup('c1', 'g1')).rejects.toThrow('Fail');
        });
    });

    // ========================================================================
    // Paginated methods
    // ========================================================================

    describe('searchLoyaltyEvents', () => {
        test('returns all events from single page', async () => {
            mockMakeSquareRequest.mockResolvedValue({
                events: [{ id: 'e1' }, { id: 'e2' }],
            });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            expect(result).toHaveLength(2);
        });

        test('paginates through multiple pages', async () => {
            mockMakeSquareRequest
                .mockResolvedValueOnce({ events: [{ id: 'e1' }], cursor: 'page2' })
                .mockResolvedValueOnce({ events: [{ id: 'e2' }] });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            expect(result).toHaveLength(2);
            expect(mockMakeSquareRequest).toHaveBeenCalledTimes(2);
            // Second call's body should include cursor
            const secondCallOpts = mockMakeSquareRequest.mock.calls[1][1];
            expect(JSON.parse(secondCallOpts.body).cursor).toBe('page2');
        });

        test('stops at MAX_PAGES safety limit', async () => {
            // Always return cursor to simulate infinite pagination
            mockMakeSquareRequest.mockResolvedValue({ events: [{ id: 'e' }], cursor: 'next' });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            // Should stop at 20 pages
            expect(result).toHaveLength(20);
            expect(mockMakeSquareRequest).toHaveBeenCalledTimes(20);
        });

        test('handles empty events array', async () => {
            mockMakeSquareRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchLoyaltyEvents({ query: {} });

            expect(result).toEqual([]);
        });
    });

    describe('searchCustomers', () => {
        test('returns all customers from single page', async () => {
            mockMakeSquareRequest.mockResolvedValue({
                customers: [{ id: 'c1' }, { id: 'c2' }],
            });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchCustomers({ query: {} });

            expect(result).toHaveLength(2);
        });

        test('paginates through multiple pages', async () => {
            mockMakeSquareRequest
                .mockResolvedValueOnce({ customers: [{ id: 'c1' }], cursor: 'p2' })
                .mockResolvedValueOnce({ customers: [{ id: 'c2' }] });
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchCustomers({ query: {} });

            expect(result).toHaveLength(2);
        });

        test('handles empty customers array', async () => {
            mockMakeSquareRequest.mockResolvedValue({});
            const client = await new SquareApiClient(MERCHANT_ID).initialize();

            const result = await client.searchCustomers({ query: {} });

            expect(result).toEqual([]);
        });
    });
});
