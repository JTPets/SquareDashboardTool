/**
 * Tests for customer-refresh-service.js
 *
 * Validates customer refresh logic: finding customers with missing data,
 * concurrent fetch with semaphore, and result aggregation.
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

jest.mock('../../../services/loyalty-admin/customer-admin-service', () => ({
    getCustomerDetails: jest.fn(),
}));

const { refreshCustomersWithMissingData } = require('../../../services/loyalty-admin/customer-refresh-service');
const db = require('../../../utils/database');
const { getCustomerDetails } = require('../../../services/loyalty-admin/customer-admin-service');

const MERCHANT_ID = 1;

describe('customer-refresh-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws on missing merchantId', async () => {
        await expect(refreshCustomersWithMissingData(undefined))
            .rejects.toThrow('merchantId is required');
    });

    test('returns early when no customers have missing data', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const result = await refreshCustomersWithMissingData(MERCHANT_ID);

        expect(result.success).toBe(true);
        expect(result.refreshed).toBe(0);
        expect(result.message).toContain('No customers');
    });

    test('refreshes customers with missing phone numbers', async () => {
        db.query.mockResolvedValue({
            rows: [
                { square_customer_id: 'CUST_1' },
                { square_customer_id: 'CUST_2' }
            ]
        });

        getCustomerDetails
            .mockResolvedValueOnce({ id: 'CUST_1', phone: '+15551234567' })
            .mockResolvedValueOnce({ id: 'CUST_2', phone: '+15559876543' });

        const result = await refreshCustomersWithMissingData(MERCHANT_ID);

        expect(result.success).toBe(true);
        expect(result.total).toBe(2);
        expect(result.refreshed).toBe(2);
        expect(result.failed).toBe(0);
        expect(result.errors).toBeUndefined();
    });

    test('tracks failures when customer lookup fails', async () => {
        db.query.mockResolvedValue({
            rows: [
                { square_customer_id: 'CUST_1' },
                { square_customer_id: 'CUST_2' }
            ]
        });

        getCustomerDetails
            .mockResolvedValueOnce({ id: 'CUST_1', phone: '+15551234567' })
            .mockRejectedValueOnce(new Error('Square API timeout'));

        const result = await refreshCustomersWithMissingData(MERCHANT_ID);

        expect(result.total).toBe(2);
        expect(result.refreshed).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toContain('Square API timeout');
    });

    test('tracks failures when customer not found', async () => {
        db.query.mockResolvedValue({
            rows: [{ square_customer_id: 'CUST_1' }]
        });

        getCustomerDetails.mockResolvedValue(null);

        const result = await refreshCustomersWithMissingData(MERCHANT_ID);

        expect(result.failed).toBe(1);
        expect(result.errors[0].error).toContain('not found in Square');
    });

    test('SQL query filters by merchant_id and missing phone', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await refreshCustomersWithMissingData(MERCHANT_ID);

        const call = db.query.mock.calls[0];
        expect(call[0]).toContain('merchant_id = $1');
        expect(call[0]).toContain('phone_number IS NULL');
        expect(call[1]).toEqual([MERCHANT_ID]);
    });

    test('handles many customers with concurrency control', async () => {
        const customerIds = Array.from({ length: 10 }, (_, i) => ({
            square_customer_id: `CUST_${i}`
        }));
        db.query.mockResolvedValue({ rows: customerIds });

        getCustomerDetails.mockResolvedValue({ id: 'test', phone: '+1555' });

        const result = await refreshCustomersWithMissingData(MERCHANT_ID);

        expect(result.total).toBe(10);
        expect(result.refreshed).toBe(10);
        expect(getCustomerDetails).toHaveBeenCalledTimes(10);
    });
});
