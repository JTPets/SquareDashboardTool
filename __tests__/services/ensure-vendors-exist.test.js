/**
 * Tests for ensureVendorsExist() — on-demand vendor fetch
 *
 * Verifies that missing vendors are fetched from Square and upserted
 * before variation_vendors INSERT, preventing FK violations during
 * delta catalog sync.
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

// Mock token-encryption — mark token as already encrypted so getMerchantToken
// calls decryptToken instead of trying to re-encrypt
jest.mock('../../utils/token-encryption', () => ({
    decryptToken: jest.fn().mockReturnValue('decrypted-test-token'),
    isEncryptedToken: jest.fn().mockReturnValue(true),
    encryptToken: jest.fn().mockReturnValue('encrypted'),
}));

// Mock node-fetch
jest.mock('node-fetch', () => jest.fn());

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const fetch = require('node-fetch');

/** Helper: default db.query mock that handles getMerchantToken lookup */
function defaultDbMock(sql) {
    if (typeof sql === 'string' && sql.includes('square_access_token') && sql.includes('merchants')) {
        return Promise.resolve({ rows: [{ square_access_token: 'enc:test-token' }] });
    }
    return Promise.resolve({ rows: [] });
}

const { ensureVendorsExist } = require('../../services/square/api');

describe('ensureVendorsExist', () => {
    const MERCHANT_ID = 3;

    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockImplementation(defaultDbMock);
    });

    test('does nothing when vendor list is empty', async () => {
        await ensureVendorsExist([], MERCHANT_ID);
        // Only the setup query (if any) — no vendor lookups
        expect(fetch).not.toHaveBeenCalled();
    });

    test('does nothing when all vendors already exist locally', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'enc:test-token' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [{ id: 'VENDOR_A' }, { id: 'VENDOR_B' }] };
            }
            return { rows: [] };
        });

        await ensureVendorsExist(['VENDOR_A', 'VENDOR_B'], MERCHANT_ID);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('fetches missing vendor from Square and upserts it', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'enc:test-token' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [{ id: 'VENDOR_A' }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO vendors')) {
                return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
        });

        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                vendor: {
                    id: 'VENDOR_B',
                    name: 'Acme Pet Supplies',
                    status: 'ACTIVE',
                    contacts: [{ name: 'John', email_address: 'john@acme.com', phone_number: '555-1234' }]
                }
            })
        });

        await ensureVendorsExist(['VENDOR_A', 'VENDOR_B'], MERCHANT_ID);

        // Should have fetched VENDOR_B from Square
        expect(fetch).toHaveBeenCalledTimes(1);
        const fetchUrl = fetch.mock.calls[0][0];
        expect(fetchUrl).toContain('/v2/vendors/VENDOR_B');

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
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'enc:test-token' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                vendor: { id: 'VENDOR_X', name: 'Test', status: 'ACTIVE', contacts: [] }
            })
        });

        // Pass same vendor ID 3 times
        await ensureVendorsExist(['VENDOR_X', 'VENDOR_X', 'VENDOR_X'], MERCHANT_ID);

        // Should only fetch once
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('logs warning and continues when Square fetch fails', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'enc:test-token' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        // Simulate 400 NOT_FOUND from Square (deleted vendor — non-retryable)
        fetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ errors: [{ code: 'NOT_FOUND', detail: 'Vendor not found' }] })
        });

        // Should not throw
        await ensureVendorsExist(['DELETED_VENDOR'], MERCHANT_ID);

        expect(logger.warn).toHaveBeenCalledWith(
            'On-demand vendor fetch failed',
            expect.objectContaining({ vendorId: 'DELETED_VENDOR' })
        );
    });

    test('handles vendor with no contacts gracefully', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'enc:test-token' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                vendor: { id: 'VENDOR_NC', name: 'No Contact Corp', status: 'ACTIVE' }
            })
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
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('square_access_token')) {
                return { rows: [{ square_access_token: 'enc:test-token' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        fetch
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    vendor: { id: 'V1', name: 'Vendor One', status: 'ACTIVE', contacts: [] }
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    vendor: { id: 'V2', name: 'Vendor Two', status: 'INACTIVE', contacts: [] }
                })
            });

        await ensureVendorsExist(['V1', 'V2'], MERCHANT_ID);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][0]).toContain('/v2/vendors/V1');
        expect(fetch.mock.calls[1][0]).toContain('/v2/vendors/V2');
    });
});
