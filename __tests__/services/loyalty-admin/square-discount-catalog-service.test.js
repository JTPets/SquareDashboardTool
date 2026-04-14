/**
 * Tests for services/loyalty-admin/square-discount-catalog-service.js
 *
 * Direct test for deleteRewardDiscountObjects, which was previously
 * untested (only exercised indirectly via cleanupSquareCustomerGroupDiscount).
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { squareApi: jest.fn() }
}));

class MockSquareApiError extends Error {
    constructor(message, { status, endpoint, details = [], nonRetryable = false } = {}) {
        super(message);
        this.name = 'SquareApiError';
        this.status = status;
        this.endpoint = endpoint;
        this.details = details;
        this.nonRetryable = nonRetryable;
        this.squareErrors = details;
    }
}

const mockMakeSquareRequest = jest.fn();
const mockGetMerchantToken = jest.fn().mockResolvedValue('test-token');

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: mockMakeSquareRequest,
    getMerchantToken: mockGetMerchantToken,
    generateIdempotencyKey: jest.fn(prefix => `${prefix}-idem`),
    SquareApiError: MockSquareApiError,
}));

const mockDeleteCatalogObjects = jest.fn();

jest.mock('../../../utils/square-catalog-cleanup', () => ({
    deleteCatalogObjects: mockDeleteCatalogObjects
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

const {
    deleteRewardDiscountObjects,
    createRewardDiscount,
    getMerchantCurrency,
    _merchantCurrencyCache
} = require('../../../services/loyalty-admin/square-discount-catalog-service');

// ============================================================================
// TESTS — deleteRewardDiscountObjects
// ============================================================================

describe('deleteRewardDiscountObjects', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should delete objects and return count', async () => {
        mockDeleteCatalogObjects.mockResolvedValueOnce({
            success: true,
            deleted: ['OBJ_1', 'OBJ_2', 'OBJ_3'],
            errors: []
        });

        const result = await deleteRewardDiscountObjects({
            merchantId: 1,
            objectIds: ['OBJ_1', 'OBJ_2', 'OBJ_3']
        });

        expect(result).toEqual({
            success: true,
            deleted: 3,
            errors: undefined
        });
        expect(mockDeleteCatalogObjects).toHaveBeenCalledWith(
            1,
            ['OBJ_1', 'OBJ_2', 'OBJ_3'],
            { auditContext: 'loyalty-reward-cleanup' }
        );
    });

    it('should include errors when some deletions fail', async () => {
        mockDeleteCatalogObjects.mockResolvedValueOnce({
            success: false,
            deleted: ['OBJ_1'],
            errors: [{ objectId: 'OBJ_2', error: 'NOT_FOUND' }]
        });

        const result = await deleteRewardDiscountObjects({
            merchantId: 1,
            objectIds: ['OBJ_1', 'OBJ_2']
        });

        expect(result.success).toBe(false);
        expect(result.deleted).toBe(1);
        expect(result.errors).toEqual([{ objectId: 'OBJ_2', error: 'NOT_FOUND' }]);
    });

    it('should return zero deleted when all fail', async () => {
        mockDeleteCatalogObjects.mockResolvedValueOnce({
            success: false,
            deleted: [],
            errors: [{ objectId: 'OBJ_1', error: 'FORBIDDEN' }]
        });

        const result = await deleteRewardDiscountObjects({
            merchantId: 1,
            objectIds: ['OBJ_1']
        });

        expect(result.success).toBe(false);
        expect(result.deleted).toBe(0);
        expect(result.errors).toHaveLength(1);
    });
});

// ============================================================================
// TESTS — getMerchantCurrency (LA-23)
// ============================================================================

describe('getMerchantCurrency', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _merchantCurrencyCache.clear();
    });

    it('should fetch currency from Square Merchants API', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ square_merchant_id: 'SQ_MERCH_1' }] });
        mockMakeSquareRequest.mockResolvedValueOnce({ merchant: { currency: 'USD' } });

        const currency = await getMerchantCurrency(1, 'test-token');
        expect(currency).toBe('USD');
        expect(mockMakeSquareRequest).toHaveBeenCalledWith(
            '/v2/merchants/SQ_MERCH_1',
            expect.objectContaining({
                method: 'GET',
                accessToken: 'test-token',
                timeout: 10000,
            })
        );
    });

    it('should return cached currency on second call', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ square_merchant_id: 'SQ_MERCH_1' }] });
        mockMakeSquareRequest.mockResolvedValueOnce({ merchant: { currency: 'GBP' } });

        await getMerchantCurrency(1, 'test-token');
        const currency2 = await getMerchantCurrency(1, 'test-token');

        expect(currency2).toBe('GBP');
        // Only one API call — second was cached
        expect(mockMakeSquareRequest).toHaveBeenCalledTimes(1);
    });

    it('should fall back to CAD when Square API fails', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ square_merchant_id: 'SQ_MERCH_1' }] });
        mockMakeSquareRequest.mockRejectedValueOnce(new MockSquareApiError('Square API error: 500', {
            status: 500,
            endpoint: '/v2/merchants/SQ_MERCH_1',
            details: [{ code: 'INTERNAL_SERVER_ERROR' }],
        }));

        const currency = await getMerchantCurrency(1, 'test-token');
        expect(currency).toBe('CAD');
        expect(logger.warn).toHaveBeenCalledWith(
            'Failed to fetch merchant currency from Square, defaulting to CAD',
            expect.objectContaining({ merchantId: 1, status: 500 })
        );
    });

    it('should fall back to CAD when no square_merchant_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [{}] });

        const currency = await getMerchantCurrency(1, 'test-token');
        expect(currency).toBe('CAD');
    });

    it('should fall back to CAD on network error', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ square_merchant_id: 'SQ_MERCH_1' }] });
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('timeout'));

        const currency = await getMerchantCurrency(1, 'test-token');
        expect(currency).toBe('CAD');
    });
});

// ============================================================================
// TESTS — createRewardDiscount uses fetched currency (LA-23)
// ============================================================================

describe('createRewardDiscount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _merchantCurrencyCache.clear();
    });

    it('should use merchant currency from Square API instead of hardcoded CAD', async () => {
        // Mock: DB lookup for square_merchant_id
        db.query.mockResolvedValueOnce({ rows: [{ square_merchant_id: 'SQ_MERCH_1' }] });

        // Mock: Square Merchants API returns USD
        mockMakeSquareRequest.mockResolvedValueOnce({ merchant: { currency: 'USD' } });

        // Mock: batch upsert succeeds
        mockMakeSquareRequest.mockResolvedValueOnce({
            id_mappings: [
                { client_object_id: '#loyalty-discount-99', object_id: 'DISC_REAL' },
                { client_object_id: '#loyalty-productset-99', object_id: 'PSET_REAL' },
                { client_object_id: '#loyalty-pricingrule-99', object_id: 'PRULE_REAL' }
            ]
        });

        const result = await createRewardDiscount({
            merchantId: 1,
            internalRewardId: 99,
            groupId: 'GRP_1',
            offerName: 'Test Offer',
            variationIds: ['VAR_1'],
            maxDiscountAmountCents: 1500
        });

        expect(result.success).toBe(true);

        // Verify the batch upsert was called with USD, not CAD
        const batchUpsertCall = mockMakeSquareRequest.mock.calls[1];
        expect(batchUpsertCall[0]).toBe('/v2/catalog/batch-upsert');
        const body = JSON.parse(batchUpsertCall[1].body);
        const discountObj = body.batches[0].objects.find(o => o.type === 'DISCOUNT');
        expect(discountObj.discount_data.maximum_amount_money.currency).toBe('USD');
        // Verify idempotency key format (byte-identical to shared-utils version)
        expect(body.idempotency_key).toBe('loyalty-discount-batch-99-idem');
        // Verify 10s timeout is preserved
        expect(batchUpsertCall[1].timeout).toBe(10000);
    });
});
