/**
 * Tests for syncVariationVendors() vendor_vendors DELETE guard
 *
 * Verifies that vendor links are preserved when vendor_information is absent,
 * null, empty, or contains only entries without vendor_id. When valid vendor
 * data IS present, DELETE + INSERT runs inside a transaction.
 *
 * NOTE: Vendor sync logic was extracted from square-catalog-sync.js into
 * square-vendors.js as syncVariationVendors() (O-5 extraction). These guard
 * tests now test the extracted function directly.
 */

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn(),
}));

jest.mock('../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
    SYNC: { BATCH_DELAY_MS: 0 },
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { syncVariationVendors } = require('../../services/square/square-vendors');

const MERCHANT_ID = 7;
const VARIATION_ID = 'VAR_001';

describe('syncVariationVendors — vendor_vendors DELETE guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT COUNT')) {
                return { rows: [{ cnt: '2' }] };
            }
            // ensureVendorsExist: all vendors already exist
            if (typeof sql === 'string' && sql.includes('SELECT id FROM vendors')) {
                return { rows: [{ id: 'VENDOR_A' }] };
            }
            return { rows: [] };
        });
        db.transaction.mockImplementation(async (cb) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            return cb(mockClient);
        });
    });

    test('vendor_information absent (undefined) — DELETE does NOT run, existing rows preserved, warn logged', async () => {
        await syncVariationVendors(VARIATION_ID, undefined, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        const countCall = db.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('SELECT COUNT')
        );
        expect(countCall).toBeTruthy();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
                variationId: VARIATION_ID,
                merchantId: MERCHANT_ID,
                vendorInformationPresent: false,
                existingLinksPreserved: true,
            })
        );
    });

    test('vendor_information = null — DELETE does NOT run, warn logged', async () => {
        await syncVariationVendors(VARIATION_ID, null, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
            })
        );
    });

    test('vendor_information = [] — DELETE does NOT run, warn logged', async () => {
        await syncVariationVendors(VARIATION_ID, [], MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
            })
        );
    });

    test('vendor_information has entries but all have null vendor_id — DELETE does NOT run, warn logged', async () => {
        await syncVariationVendors(VARIATION_ID, [
            { vendor_id: null, unit_cost_money: { amount: 500, currency: 'CAD' } },
            { vendor_id: undefined },
        ], MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
            })
        );
    });

    test('vendor_information has valid entry — DELETE + INSERT runs inside transaction', async () => {
        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        db.transaction.mockImplementation(async (cb) => cb(mockClient));

        await syncVariationVendors(VARIATION_ID, [
            { vendor_id: 'VENDOR_A', vendor_code: 'VC-1', unit_cost_money: { amount: 750, currency: 'CAD' } },
        ], MERCHANT_ID);

        expect(db.transaction).toHaveBeenCalledTimes(1);
        const deleteCall = mockClient.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM variation_vendors')
        );
        expect(deleteCall).toBeTruthy();
        const insertCall = mockClient.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO variation_vendors')
        );
        expect(insertCall).toBeTruthy();
    });

    test('transaction rollback on INSERT failure — original rows preserved', async () => {
        const mockClient = {
            query: jest.fn().mockImplementation(async (sql) => {
                if (typeof sql === 'string' && sql.includes('INSERT INTO variation_vendors')) {
                    throw new Error('FK violation: vendor not found');
                }
                return { rows: [] };
            }),
        };
        db.transaction.mockImplementation(async (cb) => {
            try {
                return await cb(mockClient);
            } catch (err) {
                throw err;
            }
        });

        await syncVariationVendors(VARIATION_ID, [
            { vendor_id: 'VENDOR_GONE', vendor_code: 'VC-X' },
        ], MERCHANT_ID);

        expect(logger.warn).toHaveBeenCalledWith(
            'Skipping variation_vendor — vendor not in DB after on-demand fetch',
            expect.objectContaining({
                vendor_id: 'VENDOR_GONE',
                variation_id: VARIATION_ID,
            })
        );
        expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    test('no warning when vendor_information absent and no existing links', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT COUNT')) {
                return { rows: [{ cnt: '0' }] };
            }
            return { rows: [] };
        });

        await syncVariationVendors(VARIATION_ID, undefined, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        const vendorWarn = logger.warn.mock.calls.find(
            ([msg]) => msg === 'Vendor information absent — preserving existing vendor links'
        );
        expect(vendorWarn).toBeUndefined();
    });
});
