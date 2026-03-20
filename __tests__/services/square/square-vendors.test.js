/**
 * Tests for square-vendors.js
 *
 * Covers syncVendors and ensureVendorsExist.
 */

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../utils/logger', () => logger);
jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn()
}));
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn(),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-key')
}));
jest.mock('../../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 50 },
    SYNC: { BATCH_DELAY_MS: 0 }
}));

const { syncVendors, ensureVendorsExist, syncVariationVendors } = require('../../../services/square/square-vendors');
const db = require('../../../utils/database');
const { makeSquareRequest, sleep } = require('../../../services/square/square-client');

const merchantId = 1;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('syncVendors', () => {
    const makeVendor = (id, name, contacts) => ({
        id,
        name,
        status: 'ACTIVE',
        contacts: contacts || [{ name: 'John', email_address: 'john@test.com', phone_number: '555-1234' }]
    });

    test('syncs single page of vendors successfully and returns count', async () => {
        makeSquareRequest.mockResolvedValue({
            vendors: [makeVendor('V1', 'Acme'), makeVendor('V2', 'Beta')],
            cursor: null
        });
        db.query.mockResolvedValue({});

        const count = await syncVendors(merchantId);

        expect(count).toBe(2);
        expect(db.query).toHaveBeenCalledTimes(2);
    });

    test('handles pagination with cursor', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({ vendors: [makeVendor('V1', 'Acme')], cursor: 'page2' })
            .mockResolvedValueOnce({ vendors: [makeVendor('V2', 'Beta')], cursor: null });
        db.query.mockResolvedValue({});

        const count = await syncVendors(merchantId);

        expect(count).toBe(2);
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('breaks pagination at MAX_PAGINATION_ITERATIONS', async () => {
        // Always return a cursor to force the loop
        makeSquareRequest.mockResolvedValue({ vendors: [makeVendor('V1', 'Test')], cursor: 'next' });
        db.query.mockResolvedValue({});

        const count = await syncVendors(merchantId);

        // Should break after MAX_PAGINATION_ITERATIONS (50) + 1 check
        expect(makeSquareRequest.mock.calls.length).toBeLessThanOrEqual(50);
        expect(logger.warn).toHaveBeenCalledWith(
            'Pagination loop exceeded max iterations',
            expect.objectContaining({ merchantId })
        );
    });

    test('upserts vendors with correct params (id, name, status, contact fields)', async () => {
        const vendor = makeVendor('V1', 'Acme Corp');
        makeSquareRequest.mockResolvedValue({ vendors: [vendor], cursor: null });
        db.query.mockResolvedValue({});

        await syncVendors(merchantId);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO vendors'),
            ['V1', 'Acme Corp', 'ACTIVE', 'John', 'john@test.com', '555-1234', merchantId]
        );
    });

    test('handles vendor with no contacts (null contact fields)', async () => {
        const vendor = makeVendor('V1', 'No Contact Vendor', undefined);
        vendor.contacts = undefined;
        makeSquareRequest.mockResolvedValue({ vendors: [vendor], cursor: null });
        db.query.mockResolvedValue({});

        await syncVendors(merchantId);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO vendors'),
            ['V1', 'No Contact Vendor', 'ACTIVE', null, null, null, merchantId]
        );
    });

    test('on unique name constraint violation calls reconcileVendorId and logs at WARN', async () => {
        const vendor = makeVendor('V_NEW', 'Duplicate Name');
        makeSquareRequest.mockResolvedValue({ vendors: [vendor], cursor: null });

        const constraintError = new Error('unique constraint');
        constraintError.constraint = 'idx_vendors_merchant_name_unique';
        db.query.mockRejectedValueOnce(constraintError);

        // reconcileVendorId calls db.transaction internally
        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'V_OLD' }], rowCount: 1 }) };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const count = await syncVendors(merchantId);

        expect(count).toBe(1);
        expect(db.transaction).toHaveBeenCalled();
        // LOGIC CHANGE: Constraint race now logs at WARN, not ERROR
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor unique name constraint hit — reconciling ID change',
            expect.objectContaining({ merchantId, vendorId: 'V_NEW', vendorName: 'Duplicate Name' })
        );
    });

    test('throws on non-constraint errors', async () => {
        makeSquareRequest.mockResolvedValue({
            vendors: [makeVendor('V1', 'Test')],
            cursor: null
        });
        db.query.mockRejectedValue(new Error('Connection refused'));

        await expect(syncVendors(merchantId)).rejects.toThrow('Connection refused');
    });

    test('sleeps between paginated requests', async () => {
        makeSquareRequest
            .mockResolvedValueOnce({ vendors: [makeVendor('V1', 'A')], cursor: 'page2' })
            .mockResolvedValueOnce({ vendors: [makeVendor('V2', 'B')], cursor: null });
        db.query.mockResolvedValue({});

        await syncVendors(merchantId);

        expect(sleep).toHaveBeenCalled();
    });
});

describe('ensureVendorsExist', () => {
    test('returns early when vendorIds is empty', async () => {
        await ensureVendorsExist([], merchantId);

        expect(db.query).not.toHaveBeenCalled();
        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('returns early when all vendors exist in DB', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 'V1' }, { id: 'V2' }] });

        await ensureVendorsExist(['V1', 'V2'], merchantId);

        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    test('fetches missing vendors from Square API', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'V1' }] }) // existing check
            .mockResolvedValue({}); // insert

        makeSquareRequest.mockResolvedValue({
            vendor: { id: 'V2', name: 'New Vendor', status: 'ACTIVE' }
        });

        await ensureVendorsExist(['V1', 'V2'], merchantId);

        expect(makeSquareRequest).toHaveBeenCalledWith(
            '/v2/vendors/V2',
            expect.objectContaining({ accessToken: 'test-token' })
        );
    });

    test('deduplicates input vendorIds', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({});
        makeSquareRequest.mockResolvedValue({
            vendor: { id: 'V1', name: 'Vendor', status: 'ACTIVE' }
        });

        await ensureVendorsExist(['V1', 'V1', 'V1'], merchantId);

        // Should only query Square once for the deduplicated ID
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    test('handles vendor not found in Square (continues to next)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({});
        makeSquareRequest
            .mockResolvedValueOnce({ vendor: null }) // V1 not found
            .mockResolvedValueOnce({ vendor: { id: 'V2', name: 'Found', status: 'ACTIVE' } });

        await ensureVendorsExist(['V1', 'V2'], merchantId);

        // Should still process V2 after V1 returns null
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    test('handles constraint violation on insert — reconciles', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no existing vendors

        makeSquareRequest.mockResolvedValue({
            vendor: { id: 'V_NEW', name: 'Dup Vendor', status: 'ACTIVE' }
        });

        const constraintError = new Error('unique constraint');
        constraintError.constraint = 'idx_vendors_merchant_name_unique';
        db.query.mockRejectedValueOnce(constraintError);

        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'V_OLD' }], rowCount: 1 }) };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        // Should not throw
        await ensureVendorsExist(['V_NEW'], merchantId);

        expect(db.transaction).toHaveBeenCalled();
    });

    test('logs warning on fetch failure (continues to next)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({});
        makeSquareRequest
            .mockRejectedValueOnce(new Error('Network error'))
            .mockResolvedValueOnce({ vendor: { id: 'V2', name: 'OK', status: 'ACTIVE' } });

        await ensureVendorsExist(['V1', 'V2'], merchantId);

        expect(logger.warn).toHaveBeenCalledWith(
            'On-demand vendor fetch failed',
            expect.objectContaining({ vendorId: 'V1', error: 'Network error' })
        );
        // V2 should still be processed
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
    });
});

describe('syncVariationVendors', () => {
    const variationId = 'VAR_001';

    test('returns 0 and does nothing when vendorInformation is undefined', async () => {
        db.query.mockResolvedValue({ rows: [{ cnt: '0' }] });

        const count = await syncVariationVendors(variationId, undefined, merchantId);

        expect(count).toBe(0);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('returns 0 and does nothing when vendorInformation is empty array', async () => {
        db.query.mockResolvedValue({ rows: [{ cnt: '0' }] });

        const count = await syncVariationVendors(variationId, [], merchantId);

        expect(count).toBe(0);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('returns 0 when vendorInformation has no real vendor_id (cost-only)', async () => {
        db.query.mockResolvedValue({ rows: [{ cnt: '0' }] });

        const vendorInfo = [{ unit_cost_money: { amount: 1000, currency: 'CAD' } }];
        const count = await syncVariationVendors(variationId, vendorInfo, merchantId);

        expect(count).toBe(0);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    test('preserves existing vendor links when vendorInformation is absent and links exist', async () => {
        db.query.mockResolvedValue({ rows: [{ cnt: '2' }] });

        const count = await syncVariationVendors(variationId, undefined, merchantId);

        expect(count).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            'Vendor information absent — preserving existing vendor links',
            expect.objectContaining({
                variationId,
                existingLinksPreserved: true
            })
        );
    });

    test('does not warn when vendorInformation is absent and no existing links', async () => {
        db.query.mockResolvedValue({ rows: [{ cnt: '0' }] });

        await syncVariationVendors(variationId, undefined, merchantId);

        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('calls ensureVendorsExist then DELETE+INSERT in transaction when valid vendors present', async () => {
        // ensureVendorsExist is mocked at module level (already in mock setup)
        // Need to mock db.query for the ensureVendorsExist internal call
        db.query.mockResolvedValue({ rows: [{ id: 'VENDOR_A' }] });

        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
        };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const vendorInfo = [
            { vendor_id: 'VENDOR_A', vendor_code: 'VC-001', unit_cost_money: { amount: 2500, currency: 'CAD' } },
            { vendor_id: 'VENDOR_B', vendor_code: 'VC-002', unit_cost_money: { amount: 3000, currency: 'USD' } }
        ];

        const count = await syncVariationVendors(variationId, vendorInfo, merchantId);

        expect(count).toBe(2);
        expect(db.transaction).toHaveBeenCalled();

        // Verify DELETE was called first
        const deleteCall = mockClient.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('DELETE FROM variation_vendors')
        );
        expect(deleteCall).toBeDefined();
        expect(deleteCall[1]).toEqual([variationId, merchantId]);

        // Verify INSERT calls for each vendor
        const insertCalls = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        expect(insertCalls).toHaveLength(2);
        expect(insertCalls[0][1][1]).toBe('VENDOR_A');
        expect(insertCalls[1][1][1]).toBe('VENDOR_B');
    });

    test('skips cost-only entries (no vendor_id) within valid vendor_information', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 'VENDOR_A' }] });

        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
        };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const vendorInfo = [
            { vendor_id: 'VENDOR_A', vendor_code: 'VC-001', unit_cost_money: { amount: 2500, currency: 'CAD' } },
            { unit_cost_money: { amount: 1000, currency: 'CAD' } } // cost-only, no vendor_id
        ];

        const count = await syncVariationVendors(variationId, vendorInfo, merchantId);

        expect(count).toBe(1);
        expect(logger.debug).toHaveBeenCalledWith(
            'Vendor info without vendor_id (cost-only entry)',
            expect.objectContaining({ variation_id: variationId })
        );
    });

    test('handles vendor insert failure gracefully (logs warning, continues)', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 'VENDOR_GOOD' }] });

        let vendorInsertCount = 0;
        const mockClient = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.includes('INSERT INTO variation_vendors')) {
                    vendorInsertCount++;
                    if (vendorInsertCount === 2) {
                        throw new Error('FK violation');
                    }
                }
                return { rows: [], rowCount: 0 };
            })
        };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const vendorInfo = [
            { vendor_id: 'VENDOR_GOOD', vendor_code: 'G1' },
            { vendor_id: 'VENDOR_BAD', vendor_code: 'B1' }
        ];

        const count = await syncVariationVendors(variationId, vendorInfo, merchantId);

        expect(count).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Skipping variation_vendor'),
            expect.objectContaining({ vendor_id: 'VENDOR_BAD' })
        );
    });

    test('passes correct currency and cost params to INSERT', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 'V1' }] });

        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
        };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const vendorInfo = [
            { vendor_id: 'V1', vendor_code: 'CODE-1', unit_cost_money: { amount: 4200, currency: 'USD' } }
        ];

        await syncVariationVendors(variationId, vendorInfo, merchantId);

        const insertCall = mockClient.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        expect(insertCall[1]).toEqual([
            variationId, 'V1', 'CODE-1', 4200, 'USD', merchantId
        ]);
    });

    test('defaults currency to CAD when not provided', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 'V1' }] });

        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
        };
        db.transaction.mockImplementation(async (fn) => fn(mockClient));

        const vendorInfo = [
            { vendor_id: 'V1', vendor_code: null }
        ];

        await syncVariationVendors(variationId, vendorInfo, merchantId);

        const insertCall = mockClient.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO variation_vendors')
        );
        // unit_cost_money is null, currency defaults to CAD
        expect(insertCall[1]).toEqual([
            variationId, 'V1', null, null, 'CAD', merchantId
        ]);
    });
});
