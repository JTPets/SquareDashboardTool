/**
 * Tests for services/vendor/vendor-query-service.js
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockDb = { query: jest.fn() };
jest.mock('../../../utils/database', () => mockDb);

const mockGetMerchantToken = jest.fn();
const mockMakeSquareRequest = jest.fn();
jest.mock('../../../services/square/square-client', () => ({
    getMerchantToken: mockGetMerchantToken,
    makeSquareRequest: mockMakeSquareRequest,
}));

const {
    listVendors,
    lookupOurItemByUPC,
    verifyVariationsBelongToMerchant,
    getMerchantTaxes,
    confirmVendorLinks,
} = require('../../../services/vendor/vendor-query-service');

beforeEach(() => jest.clearAllMocks());

// ============================================================================
// listVendors
// ============================================================================

describe('listVendors', () => {
    it('returns all vendors for merchant', async () => {
        const rows = [{ id: 1, name: 'ACME' }];
        mockDb.query.mockResolvedValueOnce({ rows });
        const result = await listVendors(42);
        expect(result).toEqual(rows);
        expect(mockDb.query.mock.calls[0][1]).toEqual([42]);
    });

    it('adds status filter when provided', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [] });
        await listVendors(1, 'ACTIVE');
        const [sql, params] = mockDb.query.mock.calls[0];
        expect(sql).toContain('status = $2');
        expect(params).toEqual([1, 'ACTIVE']);
    });

    it('returns empty array when no vendors', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [] });
        expect(await listVendors(1)).toEqual([]);
    });
});

// ============================================================================
// lookupOurItemByUPC
// ============================================================================

describe('lookupOurItemByUPC', () => {
    it('returns the first matching row', async () => {
        const row = { id: 'v1', item_name: 'Dog Food', upc: '123' };
        mockDb.query.mockResolvedValueOnce({ rows: [row] });
        const result = await lookupOurItemByUPC(10, '123');
        expect(result).toEqual(row);
        expect(mockDb.query.mock.calls[0][1]).toEqual(['123', 10]);
    });

    it('returns null when no match', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [] });
        expect(await lookupOurItemByUPC(10, '999')).toBeNull();
    });

    it('scopes query to merchant_id', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [] });
        await lookupOurItemByUPC(55, 'upc1');
        const [sql, params] = mockDb.query.mock.calls[0];
        expect(sql).toContain('merchant_id = $2');
        expect(params).toContain(55);
    });
});

// ============================================================================
// verifyVariationsBelongToMerchant
// ============================================================================

describe('verifyVariationsBelongToMerchant', () => {
    it('returns true when all IDs verified', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }, { id: 'v2' }] });
        expect(await verifyVariationsBelongToMerchant(1, ['v1', 'v2'])).toBe(true);
    });

    it('returns false when count does not match', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
        expect(await verifyVariationsBelongToMerchant(1, ['v1', 'v2'])).toBe(false);
    });

    it('includes merchant_id in query params', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
        await verifyVariationsBelongToMerchant(99, ['v1']);
        const params = mockDb.query.mock.calls[0][1];
        expect(params).toContain(99);
    });
});

// ============================================================================
// getMerchantTaxes
// ============================================================================

describe('getMerchantTaxes', () => {
    it('returns mapped tax objects', async () => {
        mockGetMerchantToken.mockResolvedValueOnce('tok');
        mockMakeSquareRequest.mockResolvedValueOnce({
            objects: [
                { id: 'TAX1', is_deleted: false, tax_data: { name: 'HST', percentage: '13', enabled: true } },
                { id: 'TAX2', is_deleted: true,  tax_data: { name: 'Old Tax' } },
            ]
        });
        const taxes = await getMerchantTaxes(1);
        expect(taxes).toHaveLength(1);
        expect(taxes[0]).toMatchObject({ id: 'TAX1', name: 'HST', percentage: '13', enabled: true });
    });

    it('returns empty array when Square call throws', async () => {
        mockGetMerchantToken.mockRejectedValueOnce(new Error('Square down'));
        const taxes = await getMerchantTaxes(1);
        expect(taxes).toEqual([]);
    });

    it('returns empty array when objects is absent', async () => {
        mockGetMerchantToken.mockResolvedValueOnce('tok');
        mockMakeSquareRequest.mockResolvedValueOnce({});
        const taxes = await getMerchantTaxes(1);
        expect(taxes).toEqual([]);
    });
});

// ============================================================================
// confirmVendorLinks
// ============================================================================

describe('confirmVendorLinks', () => {
    it('inserts all links and returns created count', async () => {
        mockDb.query.mockResolvedValue({ rows: [] });
        const links = [
            { variation_id: 'V1', vendor_id: 'VND1', vendor_code: 'A1', cost_cents: 100 },
            { variation_id: 'V2', vendor_id: 'VND1', vendor_code: 'A2', cost_cents: 200 },
        ];
        const result = await confirmVendorLinks(5, links);
        expect(result.created).toBe(2);
        expect(result.failed).toBe(0);
        expect(result.errors).toHaveLength(0);
    });

    it('handles partial failures and continues', async () => {
        mockDb.query
            .mockResolvedValueOnce({ rows: [] })
            .mockRejectedValueOnce(new Error('FK violation'));
        const links = [
            { variation_id: 'V1', vendor_id: 'VND1', cost_cents: 100 },
            { variation_id: 'INVALID', vendor_id: 'VND1', cost_cents: 200 },
        ];
        const result = await confirmVendorLinks(5, links);
        expect(result.created).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors[0].variation_id).toBe('INVALID');
    });

    it('passes merchantId as last param in INSERT', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [] });
        await confirmVendorLinks(77, [{ variation_id: 'V1', vendor_id: 'VND1', cost_cents: 50 }]);
        const params = mockDb.query.mock.calls[0][1];
        expect(params[4]).toBe(77);
    });
});
