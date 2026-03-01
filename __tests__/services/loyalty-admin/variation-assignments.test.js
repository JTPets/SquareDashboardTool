/**
 * Tests for variation-admin-service.js - getVariationAssignments
 *
 * Tests the new function extracted from routes/loyalty/variations.js (A-17).
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

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/offer-admin-service', () => ({
    getOfferById: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/loyalty-queries', () => ({
    queryQualifyingVariations: jest.fn(),
    queryOfferForVariation: jest.fn(),
}));

const { getVariationAssignments } = require('../../../services/loyalty-admin/variation-admin-service');
const db = require('../../../utils/database');

const MERCHANT_ID = 1;

describe('getVariationAssignments', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws on missing merchantId', async () => {
        await expect(getVariationAssignments(undefined))
            .rejects.toThrow('merchantId is required');
    });

    test('returns empty map when no assignments', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const result = await getVariationAssignments(MERCHANT_ID);

        expect(result).toEqual({});
    });

    test('returns variation map keyed by variation_id', async () => {
        db.query.mockResolvedValue({
            rows: [
                {
                    variation_id: 'VAR_BCR_4LB',
                    item_name: 'BCR Chicken',
                    variation_name: '4lb',
                    offer_id: 1,
                    offer_name: 'BCR 4lb Buy 12',
                    brand_name: 'Big Country Raw',
                    size_group: '4lb'
                },
                {
                    variation_id: 'VAR_SMACK_1KG',
                    item_name: 'Smack Chicken',
                    variation_name: '1kg',
                    offer_id: 2,
                    offer_name: 'Smack 1kg Buy 8',
                    brand_name: 'Smack',
                    size_group: '1kg'
                }
            ]
        });

        const result = await getVariationAssignments(MERCHANT_ID);

        expect(Object.keys(result)).toHaveLength(2);
        expect(result['VAR_BCR_4LB']).toEqual({
            offerId: 1,
            offerName: 'BCR 4lb Buy 12',
            brandName: 'Big Country Raw',
            sizeGroup: '4lb'
        });
        expect(result['VAR_SMACK_1KG'].offerName).toBe('Smack 1kg Buy 8');
    });

    test('filters by is_active and merchant_id', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getVariationAssignments(MERCHANT_ID);

        const call = db.query.mock.calls[0];
        expect(call[0]).toContain('qv.merchant_id = $1');
        expect(call[0]).toContain('qv.is_active = TRUE');
        expect(call[0]).toContain('o.is_active = TRUE');
        expect(call[1]).toEqual([MERCHANT_ID]);
    });
});
