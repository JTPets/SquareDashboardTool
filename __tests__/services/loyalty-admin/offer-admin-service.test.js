/**
 * Tests for offer-admin-service.js
 *
 * Validates tenant isolation (merchant_id) on vendor lookup queries
 * in createOffer() and updateOffer() (LA-25 fix).
 */

const db = require('../../../utils/database');

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn().mockResolvedValue(),
}));

const { createOffer, updateOffer, getOffers, getOfferById, deleteOffer } = require('../../../services/loyalty-admin/offer-admin-service');

const MERCHANT_ID = 42;

describe('createOffer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws if merchantId is missing', async () => {
        await expect(createOffer({ brandName: 'X', sizeGroup: 'S', requiredQuantity: 5 }))
            .rejects.toThrow('merchantId is required');
    });

    test('LA-25: vendor lookup includes merchant_id filter', async () => {
        const vendorId = 7;

        // First call: vendor lookup
        db.query.mockResolvedValueOnce({ rows: [{ name: 'Acme', contact_email: 'acme@test.com' }] });
        // Second call: INSERT offer
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID }] });

        await createOffer({
            merchantId: MERCHANT_ID,
            brandName: 'TestBrand',
            sizeGroup: 'Large',
            requiredQuantity: 10,
            vendorId
        });

        // Verify vendor lookup query includes merchant_id
        const [vendorSql, vendorParams] = db.query.mock.calls[0];
        expect(vendorSql).toContain('FROM vendors');
        expect(vendorSql).toContain('AND merchant_id = $2');
        expect(vendorParams).toEqual([vendorId, MERCHANT_ID]);
    });

    test('creates offer without vendor lookup when vendorId not provided', async () => {
        // Only the INSERT call
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID }] });

        await createOffer({
            merchantId: MERCHANT_ID,
            brandName: 'TestBrand',
            sizeGroup: 'Small',
            requiredQuantity: 5
        });

        // Only one query (the INSERT), no vendor lookup
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO loyalty_offers');
    });

    test('vendor not found does not block offer creation', async () => {
        // Vendor lookup returns empty
        db.query.mockResolvedValueOnce({ rows: [] });
        // INSERT offer
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID }] });

        const offer = await createOffer({
            merchantId: MERCHANT_ID,
            brandName: 'TestBrand',
            sizeGroup: 'Medium',
            requiredQuantity: 8,
            vendorId: 999
        });

        expect(offer).toBeDefined();
    });
});

describe('updateOffer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws if merchantId is missing', async () => {
        await expect(updateOffer(1, { offer_name: 'New Name' }, null))
            .rejects.toThrow('merchantId is required');
    });

    test('LA-25: vendor lookup in updateOffer includes merchant_id filter', async () => {
        const vendorId = 15;

        // First call: vendor lookup
        db.query.mockResolvedValueOnce({ rows: [{ name: 'NewVendor', contact_email: 'nv@test.com' }] });
        // Second call: UPDATE offer
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID }] });

        await updateOffer(1, { vendor_id: vendorId }, MERCHANT_ID);

        // Verify vendor lookup query includes merchant_id
        const [vendorSql, vendorParams] = db.query.mock.calls[0];
        expect(vendorSql).toContain('FROM vendors');
        expect(vendorSql).toContain('AND merchant_id = $2');
        expect(vendorParams).toEqual([vendorId, MERCHANT_ID]);
    });

    test('clearing vendor_id does not query vendors table', async () => {
        // UPDATE offer
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID }] });

        await updateOffer(1, { vendor_id: null }, MERCHANT_ID);

        // Only one query (the UPDATE), no vendor lookup
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('UPDATE loyalty_offers');
    });

    test('updates without vendor_id change skip vendor lookup', async () => {
        // UPDATE offer
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID, offer_name: 'Updated' }] });

        await updateOffer(1, { offer_name: 'Updated' }, MERCHANT_ID);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('UPDATE loyalty_offers');
        expect(sql).toContain('AND merchant_id = $2');
    });
});

describe('getOffers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('includes merchant_id filter', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getOffers(MERCHANT_ID);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('o.merchant_id = $1');
        expect(params[0]).toBe(MERCHANT_ID);
    });
});

describe('deleteOffer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('all queries include merchant_id', async () => {
        // Offer check
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, offer_name: 'Test', brand_name: 'B', size_group: 'S' }] });
        // Active rewards check
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
        // DELETE variations
        db.query.mockResolvedValueOnce({ rows: [] });
        // DELETE offer
        db.query.mockResolvedValueOnce({ rows: [] });

        await deleteOffer(1, MERCHANT_ID);

        // All 4 queries should include merchant_id
        for (const [sql, params] of db.query.mock.calls) {
            expect(params).toContain(MERCHANT_ID);
        }
    });
});
