jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../services/square', () => ({
    updateCustomAttributeValues: jest.fn(),
    batchUpdateCustomAttributeValues: jest.fn(),
}));

const db = require('../../../utils/database');
const squareApi = require('../../../services/square');
const {
    listBrands,
    createBrand,
    assignItemBrand,
    autoDetectBrands,
    bulkAssignBrands,
} = require('../../../services/gmc/brand-service');

beforeEach(() => jest.clearAllMocks());

// ── listBrands ────────────────────────────────────────────────────────────────

describe('listBrands', () => {
    it('returns brands for the merchant', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1, name: 'Acana' }, { id: 2, name: 'Orijen' }] });
        const result = await listBrands(10);
        expect(result.count).toBe(2);
        expect(result.brands).toHaveLength(2);
        expect(db.query.mock.calls[0][1]).toEqual([10]);
    });

    it('includes merchant_id in query', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await listBrands(42);
        expect(db.query.mock.calls[0][0]).toContain('merchant_id');
        expect(db.query.mock.calls[0][1]).toEqual([42]);
    });
});

// ── createBrand ───────────────────────────────────────────────────────────────

describe('createBrand', () => {
    it('returns the created brand', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 5, name: 'Purina', merchant_id: 10 }] });
        const result = await createBrand(10, { name: 'Purina', logo_url: null, website: null });
        expect(result.brand.name).toBe('Purina');
    });

    it('throws with status 409 on duplicate', async () => {
        const err = new Error('duplicate key');
        err.code = '23505';
        db.query.mockRejectedValue(err);
        await expect(createBrand(10, { name: 'Acana' })).rejects.toMatchObject({ status: 409 });
    });

    it('re-throws non-duplicate DB errors', async () => {
        const err = new Error('connection refused');
        db.query.mockRejectedValue(err);
        await expect(createBrand(10, { name: 'X' })).rejects.toThrow('connection refused');
    });
});

// ── assignItemBrand ───────────────────────────────────────────────────────────

describe('assignItemBrand', () => {
    it('returns { notFound: "item" } when item is missing', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // item check fails
        const result = await assignItemBrand(10, 'item-x', 1);
        expect(result).toEqual({ notFound: 'item' });
    });

    it('returns { notFound: "brand" } when brand is missing', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] }) // item exists
            .mockResolvedValueOnce({ rows: [] });                  // brand not found
        const result = await assignItemBrand(10, 'item-1', 99);
        expect(result).toEqual({ notFound: 'brand' });
    });

    it('assigns brand and syncs to Square', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] })     // item exists
            .mockResolvedValueOnce({ rows: [{ name: 'Acana' }] })    // brand lookup
            .mockResolvedValueOnce({ rows: [] });                      // upsert item_brands
        squareApi.updateCustomAttributeValues.mockResolvedValue({ success: true });

        const result = await assignItemBrand(10, 'item-1', 1);
        expect(result.brand_name).toBe('Acana');
        expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
            'item-1',
            { brand: { string_value: 'Acana' } },
            { merchantId: 10 }
        );
    });

    it('removes brand when brandId is null', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] }) // item exists
            .mockResolvedValueOnce({ rows: [] });                  // DELETE
        squareApi.updateCustomAttributeValues.mockResolvedValue({ success: true });

        const result = await assignItemBrand(10, 'item-1', null);
        expect(result.message).toMatch(/removed/i);
        expect(squareApi.updateCustomAttributeValues).toHaveBeenCalledWith(
            'item-1',
            { brand: { string_value: '' } },
            { merchantId: 10 }
        );
    });

    it('Square sync failure is non-fatal', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] })
            .mockResolvedValueOnce({ rows: [{ name: 'Acana' }] })
            .mockResolvedValueOnce({ rows: [] });
        squareApi.updateCustomAttributeValues.mockRejectedValue(new Error('Square timeout'));

        const result = await assignItemBrand(10, 'item-1', 1);
        expect(result.brand_name).toBe('Acana');
        expect(result.square_sync.success).toBe(false);
    });
});

// ── autoDetectBrands ──────────────────────────────────────────────────────────

describe('autoDetectBrands', () => {
    it('returns null for empty brand list', async () => {
        expect(await autoDetectBrands(10, [])).toBeNull();
    });

    it('returns null for whitespace-only brand list', async () => {
        expect(await autoDetectBrands(10, ['', '  '])).toBeNull();
    });

    it('detects brands by prefix matching', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })                                              // INSERT brand
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] })                     // SELECT brands
            .mockResolvedValueOnce({ rows: [{ id: 'i1', name: 'Acana Large Breed', category_name: 'Dogs' }] }); // items

        const result = await autoDetectBrands(10, ['Acana']);
        expect(result.detected_count).toBe(1);
        expect(result.detected[0].detected_brand_name).toBe('Acana');
        expect(result.no_match_count).toBe(0);
    });

    it('puts unmatched items in no_match', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] })
            .mockResolvedValueOnce({ rows: [{ id: 'i2', name: 'Unknown Brand Food', category_name: 'Dogs' }] });

        const result = await autoDetectBrands(10, ['Acana']);
        expect(result.detected_count).toBe(0);
        expect(result.no_match_count).toBe(1);
    });

    it('passes merchantId to every DB query', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'X' }] })
            .mockResolvedValueOnce({ rows: [] });

        await autoDetectBrands(99, ['X']);
        for (const call of db.query.mock.calls) {
            expect(call[1]).toContain(99);
        }
    });
});

// ── bulkAssignBrands ──────────────────────────────────────────────────────────

describe('bulkAssignBrands', () => {
    it('assigns brands and calls Square batch with merchantId', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] }) // brand lookup
            .mockResolvedValueOnce({ rows: [] });                          // upsert item_brands
        squareApi.batchUpdateCustomAttributeValues.mockResolvedValue({ updated: 1, errors: [] });

        const result = await bulkAssignBrands(10, [{ item_id: 'i1', brand_id: 1 }]);
        expect(result.assigned).toBe(1);
        expect(result.synced_to_square).toBe(1);
        expect(squareApi.batchUpdateCustomAttributeValues).toHaveBeenCalledWith(
            expect.any(Array),
            { merchantId: 10 }
        );
    });

    it('counts missing item_id / brand_id as failures', async () => {
        db.query.mockResolvedValue({ rows: [] }); // brand lookup returns empty
        squareApi.batchUpdateCustomAttributeValues.mockResolvedValue({ updated: 0, errors: [] });

        const result = await bulkAssignBrands(10, [{ item_id: null, brand_id: 1 }]);
        expect(result.failed).toBe(1);
        expect(result.errors[0].error).toMatch(/Missing/);
    });

    it('returns success=true when no failures', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] })
            .mockResolvedValueOnce({ rows: [] });
        squareApi.batchUpdateCustomAttributeValues.mockResolvedValue({ updated: 1, errors: [] });

        const result = await bulkAssignBrands(10, [{ item_id: 'i1', brand_id: 1 }]);
        expect(result.success).toBe(true);
    });

    it('Square batch failure is non-fatal and recorded in errors', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acana' }] })
            .mockResolvedValueOnce({ rows: [] });
        squareApi.batchUpdateCustomAttributeValues.mockRejectedValue(new Error('Square down'));

        const result = await bulkAssignBrands(10, [{ item_id: 'i1', brand_id: 1 }]);
        expect(result.assigned).toBe(1);
        expect(result.errors.some(e => e.type === 'square_batch_sync')).toBe(true);
    });

    it('handles empty assignment array gracefully', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const result = await bulkAssignBrands(10, []);
        expect(result.assigned).toBe(0);
        expect(result.success).toBe(true);
        expect(squareApi.batchUpdateCustomAttributeValues).not.toHaveBeenCalled();
    });
});
