/**
 * Tests for services/loyalty-admin/loyalty-queries.js
 *
 * Validates SQL queries enforce tenant isolation and active-only filters.
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

const db = require('../../../utils/database');
const {
    queryQualifyingVariations,
    queryOfferForVariation,
    queryOffersForVariation,
    queryAllQualifyingVariationIds,
} = require('../../../services/loyalty-admin/loyalty-queries');

const MERCHANT_ID = 1;
const OFFER_ID = 10;
const VARIATION_ID = 'VAR_ABC';

describe('loyalty-queries', () => {
    beforeEach(() => jest.clearAllMocks());

    // ========================================================================
    // queryQualifyingVariations
    // ========================================================================

    describe('queryQualifyingVariations', () => {
        test('returns rows from database', async () => {
            const mockRows = [
                { id: 1, variation_id: 'V1', variation_name: '4lb', item_name: 'BCR Chicken' },
                { id: 2, variation_id: 'V2', variation_name: '2lb', item_name: 'BCR Turkey' },
            ];
            db.query.mockResolvedValue({ rows: mockRows });

            const result = await queryQualifyingVariations(OFFER_ID, MERCHANT_ID);

            expect(result).toEqual(mockRows);
        });

        test('filters by offer_id, merchant_id, and is_active', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await queryQualifyingVariations(OFFER_ID, MERCHANT_ID);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('offer_id = $1');
            expect(sql).toContain('merchant_id = $2');
            expect(sql).toContain('is_active = TRUE');
            expect(params).toEqual([OFFER_ID, MERCHANT_ID]);
        });

        test('orders by item_name, variation_name', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await queryQualifyingVariations(OFFER_ID, MERCHANT_ID);

            const [sql] = db.query.mock.calls[0];
            expect(sql).toContain('ORDER BY lqv.item_name, lqv.variation_name');
        });
    });

    // ========================================================================
    // queryOfferForVariation
    // ========================================================================

    describe('queryOfferForVariation', () => {
        test('returns offer when variation has active match', async () => {
            const mockRow = { id: 5, offer_name: 'Test Offer', variation_id: VARIATION_ID };
            db.query.mockResolvedValue({ rows: [mockRow] });

            const result = await queryOfferForVariation(VARIATION_ID, MERCHANT_ID);

            expect(result).toEqual(mockRow);
        });

        test('returns null when no match', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await queryOfferForVariation(VARIATION_ID, MERCHANT_ID);

            expect(result).toBeNull();
        });

        test('filters by active variation AND active offer', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await queryOfferForVariation(VARIATION_ID, MERCHANT_ID);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('qv.variation_id = $1');
            expect(sql).toContain('qv.merchant_id = $2');
            expect(sql).toContain('qv.is_active = TRUE');
            expect(sql).toContain('o.is_active = TRUE');
            expect(params).toEqual([VARIATION_ID, MERCHANT_ID]);
        });
    });

    // ========================================================================
    // queryOffersForVariation
    // ========================================================================

    describe('queryOffersForVariation', () => {
        test('returns all matching offers', async () => {
            const mockRows = [
                { id: 1, offer_name: 'Offer A', variation_id: VARIATION_ID },
                { id: 2, offer_name: 'Offer B', variation_id: VARIATION_ID },
            ];
            db.query.mockResolvedValue({ rows: mockRows });

            const result = await queryOffersForVariation(VARIATION_ID, MERCHANT_ID);

            expect(result).toHaveLength(2);
        });

        test('returns empty array when no matches', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await queryOffersForVariation(VARIATION_ID, MERCHANT_ID);

            expect(result).toEqual([]);
        });

        test('uses merchant_id as first parameter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await queryOffersForVariation(VARIATION_ID, MERCHANT_ID);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('o.merchant_id = $1');
            expect(sql).toContain('qv.variation_id = $2');
            expect(params).toEqual([MERCHANT_ID, VARIATION_ID]);
        });
    });

    // ========================================================================
    // queryAllQualifyingVariationIds
    // ========================================================================

    describe('queryAllQualifyingVariationIds', () => {
        test('returns array of variation_id strings', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { variation_id: 'V1' },
                    { variation_id: 'V2' },
                    { variation_id: 'V3' },
                ]
            });

            const result = await queryAllQualifyingVariationIds(MERCHANT_ID);

            expect(result).toEqual(['V1', 'V2', 'V3']);
        });

        test('returns empty array when no qualifying variations', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await queryAllQualifyingVariationIds(MERCHANT_ID);

            expect(result).toEqual([]);
        });

        test('uses DISTINCT and filters active offer + active variation', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await queryAllQualifyingVariationIds(MERCHANT_ID);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('DISTINCT');
            expect(sql).toContain('lo.is_active = TRUE');
            expect(sql).toContain('lqv.is_active = TRUE');
            expect(params).toEqual([MERCHANT_ID]);
        });
    });
});
