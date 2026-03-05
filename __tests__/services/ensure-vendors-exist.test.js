/**
 * Tests for ensureVendorsExist() — on-demand vendor fetch
 *
 * Verifies that missing vendors are fetched from Square and upserted
 * before variation_vendors INSERT, preventing FK violations during
 * delta catalog sync.
 *
 * Mocks at the square-client service boundary (makeSquareRequest) instead of
 * the HTTP transport layer (node-fetch), following the pattern in
 * square-api-version-mismatch.test.js.
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// Mock square-client at the service boundary — bypasses HTTP layer entirely
jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: jest.fn(),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue(),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getMerchantToken, makeSquareRequest } = require('../../services/square/square-client');

const { ensureVendorsExist } = require('../../services/square/api');

describe('ensureVendorsExist', () => {
    const MERCHANT_ID = 3;

    beforeEach(() => {
        jest.clearAllMocks();
        getMerchantToken.mockResolvedValue('test-access-token');
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [] };
            }
            return { rows: [] };
        });
    });

    test('does nothing when vendor list is empty', async () => {
        await ensureVendorsExist([], MERCHANT_ID);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('does nothing when all vendors already exist locally', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [{ id: 'VENDOR_A' }, { id: 'VENDOR_B' }] };
            }
            return { rows: [] };
        });

        await ensureVendorsExist(['VENDOR_A', 'VENDOR_B'], MERCHANT_ID);
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('fetches missing vendor from Square and upserts it', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [{ id: 'VENDOR_A' }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO vendors')) {
                return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
        });

        makeSquareRequest.mockResolvedValueOnce({
            vendor: {
                id: 'VENDOR_B',
                name: 'Acme Pet Supplies',
                status: 'ACTIVE',
                contacts: [{ name: 'John', email_address: 'john@acme.com', phone_number: '555-1234' }]
            }
        });

        await ensureVendorsExist(['VENDOR_A', 'VENDOR_B'], MERCHANT_ID);

        // Should have fetched VENDOR_B from Square
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/vendors/VENDOR_B',
            expect.objectContaining({ accessToken: 'test-access-token' })
        );

        // Should have upserted into vendors table
        const insertCalls = db.query.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO vendors')
        );
        expect(insertCalls.length).toBe(1);
        const insertParams = insertCalls[0][1];
        expect(insertParams[0]).toBe('VENDOR_B');
        expect(insertParams[1]).toBe('Acme Pet Supplies');
        expect(insertParams[2]).toBe('ACTIVE');
        expect(insertParams[3]).toBe('John');
        expect(insertParams[4]).toBe('john@acme.com');
        expect(insertParams[5]).toBe('555-1234');
        expect(insertParams[6]).toBe(MERCHANT_ID);
    });

    test('deduplicates vendor IDs', async () => {
        makeSquareRequest.mockResolvedValue({
            vendor: { id: 'VENDOR_X', name: 'Test', status: 'ACTIVE', contacts: [] }
        });

        // Pass same vendor ID 3 times
        await ensureVendorsExist(['VENDOR_X', 'VENDOR_X', 'VENDOR_X'], MERCHANT_ID);

        // Should only fetch once
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    test('logs warning and continues when Square fetch fails', async () => {
        // Simulate a failed Square request
        makeSquareRequest.mockRejectedValueOnce(new Error('NOT_FOUND: Vendor not found'));

        // Should not throw
        await ensureVendorsExist(['DELETED_VENDOR'], MERCHANT_ID);

        expect(logger.warn).toHaveBeenCalledWith(
            'On-demand vendor fetch failed',
            expect.objectContaining({ vendorId: 'DELETED_VENDOR' })
        );
    });

    test('handles vendor with no contacts gracefully', async () => {
        makeSquareRequest.mockResolvedValueOnce({
            vendor: { id: 'VENDOR_NC', name: 'No Contact Corp', status: 'ACTIVE' }
        });

        await ensureVendorsExist(['VENDOR_NC'], MERCHANT_ID);

        const insertCalls = db.query.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO vendors')
        );
        expect(insertCalls.length).toBe(1);
        const params = insertCalls[0][1];
        // contact fields should be null
        expect(params[3]).toBeNull();
        expect(params[4]).toBeNull();
        expect(params[5]).toBeNull();
    });

    test('fetches multiple missing vendors individually', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({
                vendor: { id: 'V1', name: 'Vendor One', status: 'ACTIVE', contacts: [] }
            })
            .mockResolvedValueOnce({
                vendor: { id: 'V2', name: 'Vendor Two', status: 'INACTIVE', contacts: [] }
            });

        await ensureVendorsExist(['V1', 'V2'], MERCHANT_ID);

        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/vendors/V1',
            expect.objectContaining({ accessToken: 'test-access-token' })
        );
        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/vendors/V2',
            expect.objectContaining({ accessToken: 'test-access-token' })
        );
    });
});
