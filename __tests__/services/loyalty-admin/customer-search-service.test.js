/**
 * Tests for customer-search-service.js
 *
 * Validates customer search logic: cache-first, Square API fallback,
 * result merging, deduplication, and error handling.
 */

// Mock dependencies before imports
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
}));

jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    searchCachedCustomers: jest.fn(),
    cacheCustomerDetails: jest.fn(),
}));

const { searchCustomers } = require('../../../services/loyalty-admin/customer-search-service');
const { getSquareAccessToken } = require('../../../services/loyalty-admin/shared-utils');
const { searchCachedCustomers, cacheCustomerDetails } = require('../../../services/loyalty-admin/customer-cache-service');

const MERCHANT_ID = 1;

function makeSquareCustomer(id, { givenName = 'John', familyName = 'Doe', phone = '+15551234567', email = 'john@test.com' } = {}) {
    return {
        id,
        given_name: givenName,
        family_name: familyName,
        phone_number: phone,
        email_address: email,
        company_name: null,
        created_at: '2026-01-01T00:00:00Z'
    };
}

function makeCachedCustomer(id, { displayName = 'John Doe', phone = '+15551234567', email = 'john@test.com' } = {}) {
    return { id, displayName, phone, email };
}

describe('customer-search-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        cacheCustomerDetails.mockResolvedValue();
        // Mock global fetch
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('throws on missing merchantId', async () => {
        await expect(searchCustomers('test', undefined))
            .rejects.toThrow('merchantId is required');
    });

    test('returns cached results immediately for phone search with cache hit', async () => {
        const cached = [makeCachedCustomer('CUST_1')];
        searchCachedCustomers.mockResolvedValue(cached);

        const result = await searchCustomers('+15551234567', MERCHANT_ID);

        expect(result.source).toBe('cache');
        expect(result.searchType).toBe('phone');
        expect(result.customers).toHaveLength(1);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('falls back to cache when no Square token', async () => {
        const cached = [makeCachedCustomer('CUST_1')];
        searchCachedCustomers.mockResolvedValue(cached);
        getSquareAccessToken.mockResolvedValue(null);

        const result = await searchCustomers('john@test.com', MERCHANT_ID);

        expect(result.source).toBe('cache');
        expect(result.searchType).toBe('email');
        expect(result.customers).toHaveLength(1);
    });

    test('throws when no token and no cache results', async () => {
        searchCachedCustomers.mockResolvedValue([]);
        getSquareAccessToken.mockResolvedValue(null);

        await expect(searchCustomers('john@test.com', MERCHANT_ID))
            .rejects.toThrow('No Square access token configured');
    });

    test('searches Square API for email and merges with cache', async () => {
        searchCachedCustomers.mockResolvedValue([makeCachedCustomer('CUST_CACHED')]);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                customers: [makeSquareCustomer('CUST_SQUARE')]
            })
        });

        const result = await searchCustomers('john@test.com', MERCHANT_ID);

        expect(result.source).toBe('merged');
        expect(result.searchType).toBe('email');
        expect(result.customers).toHaveLength(2);
        // Square results first
        expect(result.customers[0].id).toBe('CUST_SQUARE');
        expect(result.customers[1].id).toBe('CUST_CACHED');
    });

    test('deduplicates customers by ID (Square takes priority)', async () => {
        const sameId = 'CUST_SAME';
        searchCachedCustomers.mockResolvedValue([makeCachedCustomer(sameId, { displayName: 'Old Name' })]);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                customers: [makeSquareCustomer(sameId, { givenName: 'New', familyName: 'Name' })]
            })
        });

        const result = await searchCustomers('john@test.com', MERCHANT_ID);

        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].displayName).toBe('New Name');
    });

    test('phone search sends exact phone filter to Square API', async () => {
        searchCachedCustomers.mockResolvedValue([]);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ customers: [] })
        });

        await searchCustomers('5551234567', MERCHANT_ID);

        expect(global.fetch).toHaveBeenCalledWith(
            'https://connect.squareup.com/v2/customers/search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('+15551234567')
            })
        );
    });

    test('name search filters results client-side', async () => {
        searchCachedCustomers.mockResolvedValue([]);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                customers: [
                    makeSquareCustomer('CUST_1', { givenName: 'Alice', familyName: 'Smith' }),
                    makeSquareCustomer('CUST_2', { givenName: 'Bob', familyName: 'Jones' })
                ]
            })
        });

        const result = await searchCustomers('Alice', MERCHANT_ID);

        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].id).toBe('CUST_1');
    });

    test('falls back to cache when Square API returns error', async () => {
        const cached = [makeCachedCustomer('CUST_1')];
        searchCachedCustomers.mockResolvedValue(cached);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error'
        });

        const result = await searchCustomers('john@test.com', MERCHANT_ID);

        expect(result.source).toBe('cache');
        expect(result.customers).toHaveLength(1);
    });

    test('throws when Square API fails and no cache results', async () => {
        searchCachedCustomers.mockResolvedValue([]);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: false,
            status: 502,
            text: async () => 'Bad Gateway'
        });

        await expect(searchCustomers('john@test.com', MERCHANT_ID))
            .rejects.toThrow('Square API error');
    });

    test('caches Square API results asynchronously', async () => {
        searchCachedCustomers.mockResolvedValue([]);
        getSquareAccessToken.mockResolvedValue('fake-token');

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                customers: [makeSquareCustomer('CUST_1'), makeSquareCustomer('CUST_2')]
            })
        });

        await searchCustomers('john@test.com', MERCHANT_ID);

        expect(cacheCustomerDetails).toHaveBeenCalledTimes(2);
    });

    test('normalizes phone numbers with dashes and spaces', async () => {
        const cached = [makeCachedCustomer('CUST_1')];
        searchCachedCustomers.mockResolvedValue(cached);

        const result = await searchCustomers('(555) 123-4567', MERCHANT_ID);

        expect(result.searchType).toBe('phone');
        expect(result.source).toBe('cache');
    });
});
