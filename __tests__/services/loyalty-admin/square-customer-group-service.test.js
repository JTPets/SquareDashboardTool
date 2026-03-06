/**
 * Tests for services/loyalty-admin/square-customer-group-service.js
 *
 * Direct tests for removeCustomerFromGroup and deleteCustomerGroup,
 * which were previously untested (only exercised indirectly via orchestration).
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockMakeSquareRequest = jest.fn();
const mockGetMerchantToken = jest.fn().mockResolvedValue('test-token');

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
    getSquareApi: jest.fn().mockReturnValue({
        getMerchantToken: mockGetMerchantToken,
        makeSquareRequest: mockMakeSquareRequest
    })
}));

const {
    removeCustomerFromGroup,
    deleteCustomerGroup
} = require('../../../services/loyalty-admin/square-customer-group-service');

const logger = require('../../../utils/logger');

// ============================================================================
// TESTS — removeCustomerFromGroup
// ============================================================================

describe('removeCustomerFromGroup', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should remove customer from group successfully', async () => {
        mockMakeSquareRequest.mockResolvedValueOnce({});

        const result = await removeCustomerFromGroup({
            merchantId: 1,
            squareCustomerId: 'CUST_123',
            groupId: 'GRP_456'
        });

        expect(result).toEqual({ success: true });
        expect(mockMakeSquareRequest).toHaveBeenCalledWith(
            '/v2/customers/CUST_123/groups/GRP_456',
            { method: 'DELETE', accessToken: 'test-token' }
        );
        expect(logger.info).toHaveBeenCalledWith(
            'Removed customer from group',
            expect.objectContaining({ merchantId: 1, squareCustomerId: 'CUST_123', groupId: 'GRP_456' })
        );
    });

    it('should treat 404 as success (already removed)', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('Square API error: 404 Not Found'));

        const result = await removeCustomerFromGroup({
            merchantId: 1,
            squareCustomerId: 'CUST_123',
            groupId: 'GRP_GONE'
        });

        expect(result).toEqual({ success: true });
    });

    it('should return failure on non-404 error', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('Square API error: 500 Internal Server Error'));

        const result = await removeCustomerFromGroup({
            merchantId: 1,
            squareCustomerId: 'CUST_123',
            groupId: 'GRP_456'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('500');
        expect(logger.error).toHaveBeenCalled();
    });
});

// ============================================================================
// TESTS — deleteCustomerGroup
// ============================================================================

describe('deleteCustomerGroup', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should delete group successfully', async () => {
        mockMakeSquareRequest.mockResolvedValueOnce({});

        const result = await deleteCustomerGroup({
            merchantId: 1,
            groupId: 'GRP_456'
        });

        expect(result).toEqual({ success: true });
        expect(mockMakeSquareRequest).toHaveBeenCalledWith(
            '/v2/customers/groups/GRP_456',
            { method: 'DELETE', accessToken: 'test-token' }
        );
        expect(logger.info).toHaveBeenCalledWith(
            'Deleted customer group',
            expect.objectContaining({ merchantId: 1, groupId: 'GRP_456' })
        );
    });

    it('should treat 404 as success (already deleted)', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('Square API error: 404 Not Found'));

        const result = await deleteCustomerGroup({
            merchantId: 1,
            groupId: 'GRP_GONE'
        });

        expect(result).toEqual({ success: true });
    });

    it('should return failure on non-404 error', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new Error('Square API error: 429 Too Many Requests'));

        const result = await deleteCustomerGroup({
            merchantId: 1,
            groupId: 'GRP_456'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('429');
        expect(logger.error).toHaveBeenCalled();
    });
});
