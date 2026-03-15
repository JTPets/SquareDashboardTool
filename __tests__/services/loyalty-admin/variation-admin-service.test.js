/**
 * Tests for services/loyalty-admin/variation-admin-service.js
 *
 * Covers: checkVariationConflicts, addQualifyingVariations, getQualifyingVariations,
 *         getOfferForVariation, removeQualifyingVariation.
 * (getVariationAssignments already covered in variation-assignments.test.js)
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const mockLogAuditEvent = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: mockLogAuditEvent,
}));

const mockGetOfferById = jest.fn();
jest.mock('../../../services/loyalty-admin/offer-admin-service', () => ({
    getOfferById: mockGetOfferById,
}));

const mockQueryQualifyingVariations = jest.fn();
const mockQueryOfferForVariation = jest.fn();
jest.mock('../../../services/loyalty-admin/loyalty-queries', () => ({
    queryQualifyingVariations: mockQueryQualifyingVariations,
    queryOfferForVariation: mockQueryOfferForVariation,
}));

const db = require('../../../utils/database');
const {
    checkVariationConflicts,
    addQualifyingVariations,
    getQualifyingVariations,
    getOfferForVariation,
    removeQualifyingVariation,
} = require('../../../services/loyalty-admin/variation-admin-service');

const MERCHANT_ID = 1;
const OFFER_ID = 10;

describe('variation-admin-service', () => {
    beforeEach(() => jest.clearAllMocks());

    // ========================================================================
    // checkVariationConflicts
    // ========================================================================

    describe('checkVariationConflicts', () => {
        test('throws if merchantId is missing', async () => {
            await expect(checkVariationConflicts(['V1'], null, null))
                .rejects.toThrow('merchantId is required');
        });

        test('returns empty for empty variationIds', async () => {
            const result = await checkVariationConflicts([], null, MERCHANT_ID);
            expect(result).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('returns empty for null variationIds', async () => {
            const result = await checkVariationConflicts(null, null, MERCHANT_ID);
            expect(result).toEqual([]);
        });

        test('returns conflicts found in database', async () => {
            const conflicts = [
                { variation_id: 'V1', item_name: 'Item A', offer_id: 5, offer_name: 'Existing Offer' },
            ];
            db.query.mockResolvedValue({ rows: conflicts });

            const result = await checkVariationConflicts(['V1'], null, MERCHANT_ID);

            expect(result).toEqual(conflicts);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('qv.merchant_id');
            expect(sql).toContain('qv.is_active = TRUE');
            expect(sql).toContain('o.is_active = TRUE');
            expect(params).toContain('V1');
            expect(params).toContain(MERCHANT_ID);
        });

        test('excludes offer when excludeOfferId provided', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await checkVariationConflicts(['V1'], OFFER_ID, MERCHANT_ID);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('qv.offer_id !=');
            expect(params).toContain(OFFER_ID);
        });

        test('does not exclude offer when excludeOfferId is null', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await checkVariationConflicts(['V1'], null, MERCHANT_ID);

            const [sql] = db.query.mock.calls[0];
            expect(sql).not.toContain('offer_id !=');
        });
    });

    // ========================================================================
    // addQualifyingVariations
    // ========================================================================

    describe('addQualifyingVariations', () => {
        test('throws if merchantId is missing', async () => {
            await expect(addQualifyingVariations(OFFER_ID, [], null))
                .rejects.toThrow('merchantId is required');
        });

        test('throws if offer not found', async () => {
            mockGetOfferById.mockResolvedValue(null);

            await expect(addQualifyingVariations(OFFER_ID, [], MERCHANT_ID))
                .rejects.toThrow('Offer not found');
        });

        test('adds variations and logs audit events', async () => {
            mockGetOfferById.mockResolvedValue({ id: OFFER_ID });
            // No conflicts
            db.query
                .mockResolvedValueOnce({ rows: [] }) // conflict check
                .mockResolvedValueOnce({ rows: [{ id: 1, variation_id: 'V1' }] }); // INSERT

            const result = await addQualifyingVariations(OFFER_ID, [
                { variationId: 'V1', itemName: 'Item A', variationName: '4lb' },
            ], MERCHANT_ID, 99);

            expect(result).toHaveLength(1);
            expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
                merchantId: MERCHANT_ID,
                action: 'VARIATION_ADDED',
                offerId: OFFER_ID,
                triggeredBy: 'ADMIN',
                userId: 99,
            }));
        });

        test('throws on variation conflict', async () => {
            mockGetOfferById.mockResolvedValue({ id: OFFER_ID });
            db.query.mockResolvedValue({
                rows: [{ variation_id: 'V1', item_name: 'Item A', variation_name: '4lb', offer_name: 'Other Offer' }]
            });

            await expect(addQualifyingVariations(OFFER_ID, [
                { variationId: 'V1' },
            ], MERCHANT_ID)).rejects.toThrow('Variation conflict');
        });

        test('skips conflict check when force option set', async () => {
            mockGetOfferById.mockResolvedValue({ id: OFFER_ID });
            db.query.mockResolvedValue({ rows: [{ id: 1, variation_id: 'V1' }] });

            const result = await addQualifyingVariations(OFFER_ID, [
                { variationId: 'V1', itemName: 'Item A' },
            ], MERCHANT_ID, null, { force: true });

            expect(result).toHaveLength(1);
            // Only the INSERT query, no conflict check
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        test('logs SYSTEM when no userId provided', async () => {
            mockGetOfferById.mockResolvedValue({ id: OFFER_ID });
            db.query
                .mockResolvedValueOnce({ rows: [] }) // conflict check
                .mockResolvedValueOnce({ rows: [{ id: 1, variation_id: 'V1' }] });

            await addQualifyingVariations(OFFER_ID, [
                { variationId: 'V1' },
            ], MERCHANT_ID);

            expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
                triggeredBy: 'SYSTEM',
            }));
        });

        test('continues adding other variations on individual insert error', async () => {
            mockGetOfferById.mockResolvedValue({ id: OFFER_ID });
            db.query
                .mockResolvedValueOnce({ rows: [] }) // conflict check
                .mockRejectedValueOnce(new Error('duplicate key')) // first insert fails
                .mockResolvedValueOnce({ rows: [{ id: 2, variation_id: 'V2' }] }); // second succeeds

            const result = await addQualifyingVariations(OFFER_ID, [
                { variationId: 'V1' },
                { variationId: 'V2' },
            ], MERCHANT_ID);

            expect(result).toHaveLength(1);
            expect(result[0].variation_id).toBe('V2');
        });
    });

    // ========================================================================
    // getQualifyingVariations
    // ========================================================================

    describe('getQualifyingVariations', () => {
        test('throws if merchantId is missing', async () => {
            await expect(getQualifyingVariations(OFFER_ID, null))
                .rejects.toThrow('merchantId is required');
        });

        test('delegates to queryQualifyingVariations', async () => {
            const mockRows = [{ id: 1, variation_id: 'V1' }];
            mockQueryQualifyingVariations.mockResolvedValue(mockRows);

            const result = await getQualifyingVariations(OFFER_ID, MERCHANT_ID);

            expect(result).toEqual(mockRows);
            expect(mockQueryQualifyingVariations).toHaveBeenCalledWith(OFFER_ID, MERCHANT_ID);
        });
    });

    // ========================================================================
    // getOfferForVariation
    // ========================================================================

    describe('getOfferForVariation', () => {
        test('throws if merchantId is missing', async () => {
            await expect(getOfferForVariation('V1', null))
                .rejects.toThrow('merchantId is required');
        });

        test('delegates to queryOfferForVariation', async () => {
            const mockOffer = { id: 5, offer_name: 'Test', variation_id: 'V1' };
            mockQueryOfferForVariation.mockResolvedValue(mockOffer);

            const result = await getOfferForVariation('V1', MERCHANT_ID);

            expect(result).toEqual(mockOffer);
            expect(mockQueryOfferForVariation).toHaveBeenCalledWith('V1', MERCHANT_ID);
        });
    });

    // ========================================================================
    // removeQualifyingVariation
    // ========================================================================

    describe('removeQualifyingVariation', () => {
        test('throws if merchantId is missing', async () => {
            await expect(removeQualifyingVariation(OFFER_ID, 'V1', null))
                .rejects.toThrow('merchantId is required');
        });

        test('soft-deletes variation and logs audit', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, variation_id: 'V1', variation_name: '4lb', item_name: 'Item A' }]
            });

            const result = await removeQualifyingVariation(OFFER_ID, 'V1', MERCHANT_ID, 99);

            expect(result.variation_id).toBe('V1');
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('is_active = FALSE');
            expect(params).toEqual([OFFER_ID, 'V1', MERCHANT_ID]);
            expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
                action: 'VARIATION_REMOVED',
                triggeredBy: 'ADMIN',
                userId: 99,
            }));
        });

        test('returns null when variation not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await removeQualifyingVariation(OFFER_ID, 'MISSING', MERCHANT_ID);

            expect(result).toBeNull();
            expect(mockLogAuditEvent).not.toHaveBeenCalled();
        });

        test('logs SYSTEM when no userId', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, variation_id: 'V1', variation_name: '4lb', item_name: 'A' }]
            });

            await removeQualifyingVariation(OFFER_ID, 'V1', MERCHANT_ID);

            expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
                triggeredBy: 'SYSTEM',
                userId: null,
            }));
        });
    });
});
