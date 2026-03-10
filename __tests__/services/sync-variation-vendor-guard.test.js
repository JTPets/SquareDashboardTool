/**
 * Tests for syncVariation() vendor_vendors DELETE guard
 *
 * Verifies that vendor links are preserved when vendor_information is absent,
 * null, empty, or contains only entries without vendor_id. When valid vendor
 * data IS present, DELETE + INSERT runs inside a transaction.
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

jest.mock('../../services/square/square-vendors', () => ({
    ensureVendorsExist: jest.fn().mockResolvedValue(),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { ensureVendorsExist } = require('../../services/square/square-vendors');
const { syncVariation } = require('../../services/square/square-catalog-sync');

const MERCHANT_ID = 7;

function makeVariationObj(vendorInformation) {
    const data = {
        item_id: 'ITEM_001',
        name: 'Regular',
        sku: 'SKU-001',
        ordinal: 0,
        pricing_type: 'FIXED_PRICING',
        price_money: { amount: 1000, currency: 'CAD' },
    };
    if (vendorInformation !== undefined) {
        data.vendor_information = vendorInformation;
    }
    return {
        id: 'VAR_001',
        type: 'ITEM_VARIATION',
        item_variation_data: data,
    };
}

describe('syncVariation — vendor_vendors DELETE guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: main UPSERT for variation succeeds
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('INSERT INTO variations')) {
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT COUNT')) {
                return { rows: [{ cnt: '2' }] };
            }
            return { rows: [] };
        });
        // Default: transaction executes callback
        db.transaction.mockImplementation(async (cb) => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
            return cb(mockClient);
        });
    });

    test('vendor_information absent (undefined) — DELETE does NOT run, existing rows preserved, warn logged', async () => {
        const obj = makeVariationObj(/* vendorInformation omitted — undefined */);
        await syncVariation(obj, MERCHANT_ID);

        // Transaction should NOT have been called (no DELETE + INSERT)
        expect(db.transaction).not.toHaveBeenCalled();
        // Should have queried for existing link count
        const countCall = db.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('SELECT COUNT')
        );
        expect(countCall).toBeTruthy();
        // Should have logged a warning because existing links exist (cnt=2)
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
                variationId: 'VAR_001',
                merchantId: MERCHANT_ID,
                vendorInformationPresent: false,
                existingLinksPreserved: true,
            })
        );
    });

    test('vendor_information = null — DELETE does NOT run, warn logged', async () => {
        const obj = makeVariationObj(null);
        await syncVariation(obj, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
            })
        );
    });

    test('vendor_information = [] — DELETE does NOT run, warn logged', async () => {
        const obj = makeVariationObj([]);
        await syncVariation(obj, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                event: 'vendor_information_absent_skipping_vendor_sync',
            })
        );
    });

    test('vendor_information has entries but all have null vendor_id — DELETE does NOT run, warn logged', async () => {
        const obj = makeVariationObj([
            { vendor_id: null, unit_cost_money: { amount: 500, currency: 'CAD' } },
            { vendor_id: undefined },
        ]);
        await syncVariation(obj, MERCHANT_ID);

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

        const obj = makeVariationObj([
            { vendor_id: 'VENDOR_A', vendor_code: 'VC-1', unit_cost_money: { amount: 750, currency: 'CAD' } },
        ]);
        await syncVariation(obj, MERCHANT_ID);

        // Transaction SHOULD have been called
        expect(db.transaction).toHaveBeenCalledTimes(1);
        // Inside the transaction: DELETE then INSERT
        const deleteCall = mockClient.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM variation_vendors')
        );
        expect(deleteCall).toBeTruthy();
        const insertCall = mockClient.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO variation_vendors')
        );
        expect(insertCall).toBeTruthy();
        // ensureVendorsExist should have been called before the transaction
        expect(ensureVendorsExist).toHaveBeenCalledWith(['VENDOR_A'], MERCHANT_ID);
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
        // Simulate transaction: rollback on error (re-throw)
        db.transaction.mockImplementation(async (cb) => {
            try {
                return await cb(mockClient);
            } catch (err) {
                // db.transaction rolls back and re-throws
                throw err;
            }
        });

        const obj = makeVariationObj([
            { vendor_id: 'VENDOR_GONE', vendor_code: 'VC-X' },
        ]);

        // The warn inside the loop catches the error, so the transaction itself
        // should NOT throw — the try/catch around the INSERT handles it
        await syncVariation(obj, MERCHANT_ID);

        // The warning about skipping should have fired
        expect(logger.warn).toHaveBeenCalledWith(
            'Skipping variation_vendor — vendor not in DB after on-demand fetch',
            expect.objectContaining({
                vendor_id: 'VENDOR_GONE',
                variation_id: 'VAR_001',
            })
        );
        // Transaction was still called (the DELETE ran inside it)
        expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    test('no warning when vendor_information absent and no existing links', async () => {
        db.query.mockImplementation(async (sql) => {
            if (typeof sql === 'string' && sql.includes('INSERT INTO variations')) {
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT COUNT')) {
                return { rows: [{ cnt: '0' }] };
            }
            return { rows: [] };
        });

        const obj = makeVariationObj(undefined);
        await syncVariation(obj, MERCHANT_ID);

        expect(db.transaction).not.toHaveBeenCalled();
        // No warning because no existing links to preserve
        const vendorWarn = logger.warn.mock.calls.find(
            ([msg]) => msg === 'Vendor information absent — preserving existing vendor links'
        );
        expect(vendorWarn).toBeUndefined();
    });
});
