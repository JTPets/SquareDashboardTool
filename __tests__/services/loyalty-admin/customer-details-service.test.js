/**
 * Tests for services/loyalty-admin/customer-details-service.js
 *
 * Covers: getCustomerDetails, cacheCustomerDetails (the standalone version)
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        customer: jest.fn(),
    },
}));

const mockInitialize = jest.fn();
const mockGetCustomer = jest.fn();

jest.mock('../../../services/loyalty-admin/square-api-client', () => ({
    SquareApiClient: jest.fn().mockImplementation(() => ({
        initialize: mockInitialize,
        getCustomer: mockGetCustomer,
    })),
}));

const db = require('../../../utils/database');
const { getCustomerDetails, cacheCustomerDetails } = require('../../../services/loyalty-admin/customer-details-service');

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'cust-123';

describe('customer-details-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockInitialize.mockReturnThis();
    });

    // ========================================================================
    // getCustomerDetails
    // ========================================================================

    describe('getCustomerDetails', () => {
        test('returns formatted customer from Square API', async () => {
            mockGetCustomer.mockResolvedValue({
                id: CUSTOMER_ID,
                given_name: 'John',
                family_name: 'Doe',
                email_address: 'john@test.com',
                phone_number: '555-1234',
                company_name: 'Acme',
                created_at: '2025-01-01',
                updated_at: '2025-06-01',
            });

            const result = await getCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result).toEqual({
                id: CUSTOMER_ID,
                givenName: 'John',
                familyName: 'Doe',
                displayName: 'John Doe',
                email: 'john@test.com',
                phone: '555-1234',
                companyName: 'Acme',
                birthday: null,
                note: null,
                createdAt: '2025-01-01',
                updatedAt: '2025-06-01',
            });
        });

        test('uses company_name as displayName when no given/family name', async () => {
            mockGetCustomer.mockResolvedValue({
                id: CUSTOMER_ID,
                given_name: null,
                family_name: null,
                company_name: 'Pet Store Inc',
                created_at: '2025-01-01',
                updated_at: '2025-01-01',
            });

            const result = await getCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result.displayName).toBe('Pet Store Inc');
        });

        test('returns null displayName when no names available', async () => {
            mockGetCustomer.mockResolvedValue({
                id: CUSTOMER_ID,
                created_at: '2025-01-01',
                updated_at: '2025-01-01',
            });

            const result = await getCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result.displayName).toBeNull();
        });

        test('returns null on Square API error', async () => {
            mockGetCustomer.mockRejectedValue(new Error('API timeout'));

            const result = await getCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // cacheCustomerDetails
    // ========================================================================

    describe('cacheCustomerDetails', () => {
        test('returns cached phone when already in database', async () => {
            db.query.mockResolvedValue({
                rows: [{ phone_number: '555-1234' }]
            });

            const result = await cacheCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result).toEqual({ id: CUSTOMER_ID, phone: '555-1234', cached: true });
            // Should NOT call Square API
            expect(mockGetCustomer).not.toHaveBeenCalled();
        });

        test('fetches from Square API when not cached', async () => {
            // Not in cache
            db.query.mockResolvedValueOnce({ rows: [] });
            // Upsert call
            db.query.mockResolvedValueOnce({ rows: [] });

            mockGetCustomer.mockResolvedValue({
                id: CUSTOMER_ID,
                given_name: 'Jane',
                family_name: 'Doe',
                phone_number: '555-9999',
                email_address: 'jane@test.com',
                created_at: '2025-01-01',
                updated_at: '2025-01-01',
            });

            const result = await cacheCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result.givenName).toBe('Jane');
            expect(result.phone).toBe('555-9999');
            // Verify upsert was called
            const [sql] = db.query.mock.calls[1];
            expect(sql).toContain('INSERT INTO loyalty_customers');
            expect(sql).toContain('ON CONFLICT');
        });

        test('fetches when cached but phone_number is null', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ phone_number: null }] });
            db.query.mockResolvedValueOnce({ rows: [] });

            mockGetCustomer.mockResolvedValue({
                id: CUSTOMER_ID,
                given_name: 'Bob',
                phone_number: '555-0000',
                created_at: '2025-01-01',
                updated_at: '2025-01-01',
            });

            const result = await cacheCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result.givenName).toBe('Bob');
            expect(mockGetCustomer).toHaveBeenCalled();
        });

        test('returns null when Square API returns nothing', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            mockGetCustomer.mockRejectedValue(new Error('API error'));

            const result = await cacheCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result).toBeNull();
        });

        test('returns null on unexpected error', async () => {
            db.query.mockRejectedValue(new Error('DB connection lost'));

            const result = await cacheCustomerDetails(CUSTOMER_ID, MERCHANT_ID);

            expect(result).toBeNull();
        });
    });
});
