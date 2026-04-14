/**
 * Tests for services/loyalty-admin/square-customer-group-service.js
 *
 * Direct tests for removeCustomerFromGroup and deleteCustomerGroup,
 * which were previously untested (only exercised indirectly via orchestration).
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

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

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { squareApi: jest.fn() }
}));

jest.mock('../../../services/square/square-client', () => ({
    makeSquareRequest: mockMakeSquareRequest,
    getMerchantToken: mockGetMerchantToken,
    SquareApiError: MockSquareApiError,
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
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
    });

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
        mockMakeSquareRequest.mockRejectedValueOnce(new MockSquareApiError('Square API error: 404', {
            status: 404,
            endpoint: '/v2/customers/CUST_123/groups/GRP_GONE',
            details: [{ code: 'NOT_FOUND' }],
        }));

        const result = await removeCustomerFromGroup({
            merchantId: 1,
            squareCustomerId: 'CUST_123',
            groupId: 'GRP_GONE'
        });

        expect(result).toEqual({ success: true });
    });

    it('should return failure on non-404 error', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new MockSquareApiError('Square API error: 500 Internal Server Error', {
            status: 500,
            endpoint: '/v2/customers/CUST_123/groups/GRP_456',
            details: [{ code: 'INTERNAL_SERVER_ERROR' }],
        }));

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
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('test-token');
    });

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
        mockMakeSquareRequest.mockRejectedValueOnce(new MockSquareApiError('Square API error: 404', {
            status: 404,
            endpoint: '/v2/customers/groups/GRP_GONE',
            details: [{ code: 'NOT_FOUND' }],
        }));

        const result = await deleteCustomerGroup({
            merchantId: 1,
            groupId: 'GRP_GONE'
        });

        expect(result).toEqual({ success: true });
    });

    it('should return failure on non-404 error', async () => {
        mockMakeSquareRequest.mockRejectedValueOnce(new MockSquareApiError('Square API error: 429 Too Many Requests', {
            status: 429,
            endpoint: '/v2/customers/groups/GRP_456',
            details: [{ code: 'RATE_LIMITED' }],
        }));

        const result = await deleteCustomerGroup({
            merchantId: 1,
            groupId: 'GRP_456'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('429');
        expect(logger.error).toHaveBeenCalled();
    });
});
