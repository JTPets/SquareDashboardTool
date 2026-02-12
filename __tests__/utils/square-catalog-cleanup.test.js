/**
 * Tests for square-catalog-cleanup utility
 *
 * Tests the shared catalog object deletion and customer group cleanup functions.
 */

// Mock dependencies before requiring the module
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../../services/square/api', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
}));

const { deleteCatalogObjects, deleteCustomerGroupWithMembers } = require('../../utils/square-catalog-cleanup');
const squareApi = require('../../services/square/api');
const logger = require('../../utils/logger');

beforeEach(() => {
    jest.clearAllMocks();
});

// ============================================================================
// deleteCatalogObjects
// ============================================================================

describe('deleteCatalogObjects', () => {
    it('should return success with empty arrays when no object IDs provided', async () => {
        const result = await deleteCatalogObjects(1, []);
        expect(result).toEqual({ success: true, deleted: [], failed: [], errors: [] });
        expect(squareApi.makeSquareRequest).not.toHaveBeenCalled();
    });

    it('should return success when objectIds is null', async () => {
        const result = await deleteCatalogObjects(1, null);
        expect(result).toEqual({ success: true, deleted: [], failed: [], errors: [] });
    });

    it('should return success when objectIds is undefined', async () => {
        const result = await deleteCatalogObjects(1, undefined);
        expect(result).toEqual({ success: true, deleted: [], failed: [], errors: [] });
    });

    it('should filter out null and undefined IDs', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({
            deleted_object_ids: ['ID1'],
        });

        const result = await deleteCatalogObjects(1, [null, 'ID1', undefined, '']);
        expect(result.success).toBe(true);
        expect(result.deleted).toEqual(['ID1']);
        // Should only send the one valid ID
        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/batch-delete',
            expect.objectContaining({
                body: JSON.stringify({ object_ids: ['ID1'] }),
            })
        );
    });

    it('should batch-delete multiple mixed-type catalog objects in one call', async () => {
        const objectIds = ['DISCOUNT_ID', 'PRODUCT_SET_ID', 'PRICING_RULE_ID'];
        squareApi.makeSquareRequest.mockResolvedValue({
            deleted_object_ids: objectIds,
        });

        const result = await deleteCatalogObjects(1, objectIds, {
            auditContext: 'test-cleanup',
        });

        expect(result.success).toBe(true);
        expect(result.deleted).toEqual(objectIds);
        expect(result.failed).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(squareApi.makeSquareRequest).toHaveBeenCalledTimes(1);
        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith(
            '/v2/catalog/batch-delete',
            expect.objectContaining({
                method: 'POST',
                accessToken: 'test-token',
                body: JSON.stringify({ object_ids: objectIds }),
            })
        );
    });

    it('should treat 404 errors as success (already deleted)', async () => {
        squareApi.makeSquareRequest.mockRejectedValue(
            new Error('Square API error: 404 - [{"code":"NOT_FOUND"}]')
        );

        const result = await deleteCatalogObjects(1, ['GONE_ID']);
        expect(result.success).toBe(true);
        expect(result.deleted).toEqual(['GONE_ID']);
    });

    it('should return failure on non-404 errors', async () => {
        squareApi.makeSquareRequest.mockRejectedValue(
            new Error('Square API error: 500 - Internal Server Error')
        );

        const result = await deleteCatalogObjects(1, ['ID1', 'ID2']);
        expect(result.success).toBe(false);
        expect(result.deleted).toEqual([]);
        expect(result.failed).toEqual(['ID1', 'ID2']);
        expect(result.errors).toHaveLength(1);
        expect(logger.error).toHaveBeenCalled();
    });

    it('should identify partially deleted objects', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({
            deleted_object_ids: ['ID1', 'ID3'],
        });

        const result = await deleteCatalogObjects(1, ['ID1', 'ID2', 'ID3']);
        expect(result.success).toBe(true);
        expect(result.deleted).toEqual(['ID1', 'ID3']);
        expect(result.failed).toEqual(['ID2']);
    });

    it('should fall back to validIds when response has no deleted_object_ids', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({});

        const result = await deleteCatalogObjects(1, ['ID1']);
        expect(result.success).toBe(true);
        expect(result.deleted).toEqual(['ID1']);
    });

    it('should log with the provided auditContext', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({
            deleted_object_ids: ['ID1'],
        });

        await deleteCatalogObjects(1, ['ID1'], { auditContext: 'loyalty-reward-cleanup' });
        expect(logger.info).toHaveBeenCalledWith(
            'Deleted catalog objects',
            expect.objectContaining({ context: 'loyalty-reward-cleanup' })
        );
    });

    it('should use default auditContext when none provided', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({
            deleted_object_ids: ['ID1'],
        });

        await deleteCatalogObjects(1, ['ID1']);
        expect(logger.info).toHaveBeenCalledWith(
            'Deleted catalog objects',
            expect.objectContaining({ context: 'unknown' })
        );
    });
});

// ============================================================================
// deleteCustomerGroupWithMembers
// ============================================================================

describe('deleteCustomerGroupWithMembers', () => {
    it('should return success when groupId is null', async () => {
        const result = await deleteCustomerGroupWithMembers(1, null, ['CUST1']);
        expect(result).toEqual({ success: true, customersRemoved: true, groupDeleted: true });
        expect(squareApi.makeSquareRequest).not.toHaveBeenCalled();
    });

    it('should remove customer and delete group', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({});

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1']);
        expect(result.success).toBe(true);
        expect(result.customersRemoved).toBe(true);
        expect(result.groupDeleted).toBe(true);

        // Two calls: remove customer from group, delete group
        expect(squareApi.makeSquareRequest).toHaveBeenCalledTimes(2);
        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith(
            '/v2/customers/CUST1/groups/GROUP1',
            expect.objectContaining({ method: 'DELETE' })
        );
        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith(
            '/v2/customers/groups/GROUP1',
            expect.objectContaining({ method: 'DELETE' })
        );
    });

    it('should delete group with no customers', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({});

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', []);
        expect(result.success).toBe(true);
        expect(result.customersRemoved).toBe(true);
        expect(result.groupDeleted).toBe(true);

        // Only one call: delete group
        expect(squareApi.makeSquareRequest).toHaveBeenCalledTimes(1);
        expect(squareApi.makeSquareRequest).toHaveBeenCalledWith(
            '/v2/customers/groups/GROUP1',
            expect.objectContaining({ method: 'DELETE' })
        );
    });

    it('should tolerate 404 when removing customer (already removed)', async () => {
        squareApi.makeSquareRequest
            .mockRejectedValueOnce(new Error('Square API error: 404 - Not found'))
            .mockResolvedValueOnce({}); // group delete succeeds

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1']);
        expect(result.success).toBe(true);
        expect(result.customersRemoved).toBe(true);
        expect(result.groupDeleted).toBe(true);
    });

    it('should tolerate 404 when deleting group (already deleted)', async () => {
        squareApi.makeSquareRequest
            .mockResolvedValueOnce({}) // customer removal succeeds
            .mockRejectedValueOnce(new Error('Square API error: 404 - Not found'));

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1']);
        expect(result.success).toBe(true);
        expect(result.groupDeleted).toBe(true);
    });

    it('should report failure when customer removal fails with non-404', async () => {
        squareApi.makeSquareRequest
            .mockRejectedValueOnce(new Error('Square API error: 500 - Server error'))
            .mockResolvedValueOnce({}); // group delete succeeds

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1']);
        expect(result.success).toBe(false); // overall success is false because customersRemoved failed
        expect(result.customersRemoved).toBe(false);
        expect(result.groupDeleted).toBe(true);
    });

    it('should report failure when group deletion fails with non-404', async () => {
        squareApi.makeSquareRequest
            .mockResolvedValueOnce({}) // customer removal succeeds
            .mockRejectedValueOnce(new Error('Square API error: 500 - Server error'));

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1']);
        expect(result.success).toBe(false); // overall success is false because groupDeleted failed
        expect(result.customersRemoved).toBe(true);
        expect(result.groupDeleted).toBe(false);
    });

    it('should handle multiple customers', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({});

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1', 'CUST2']);
        expect(result.success).toBe(true);

        // Three calls: remove CUST1, remove CUST2, delete group
        expect(squareApi.makeSquareRequest).toHaveBeenCalledTimes(3);
    });

    it('should filter null customer IDs', async () => {
        squareApi.makeSquareRequest.mockResolvedValue({});

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', [null, 'CUST1', undefined]);
        expect(result.success).toBe(true);

        // Two calls: remove CUST1, delete group (null/undefined filtered out)
        expect(squareApi.makeSquareRequest).toHaveBeenCalledTimes(2);
    });

    it('should return failure when getMerchantToken fails', async () => {
        squareApi.getMerchantToken.mockRejectedValue(new Error('Merchant not found'));

        const result = await deleteCustomerGroupWithMembers(1, 'GROUP1', ['CUST1']);
        expect(result.success).toBe(false);
        expect(result.customersRemoved).toBe(false);
        expect(result.groupDeleted).toBe(false);
    });
});
