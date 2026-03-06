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

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: jest.fn(),
    getSquareAccessToken: jest.fn().mockResolvedValue('test-token'),
    generateIdempotencyKey: jest.fn(prefix => `${prefix}-idem`)
}));

const mockDeleteCatalogObjects = jest.fn();

jest.mock('../../../utils/square-catalog-cleanup', () => ({
    deleteCatalogObjects: mockDeleteCatalogObjects
}));

const {
    deleteRewardDiscountObjects
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
