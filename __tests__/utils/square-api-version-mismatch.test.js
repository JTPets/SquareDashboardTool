/**
 * Tests for Square API VERSION_MISMATCH retry logic
 * Specifically tests setSquareInventoryAlertThreshold retry behavior
 *
 * Mocks at the square-client service boundary (makeSquareRequest) instead of
 * the HTTP transport layer (node-fetch). This avoids 401 auth errors from
 * makeSquareRequest's response.status checks intercepting mock responses
 * before the retry logic in setSquareInventoryAlertThreshold can handle them.
 */

// Mock square-client at the service boundary — bypasses HTTP layer entirely
jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: jest.fn(),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn().mockResolvedValue(),
    generateIdempotencyKey: jest.fn(),
    SQUARE_BASE_URL: 'https://connect.squareup.com',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { makeSquareRequest, getMerchantToken, generateIdempotencyKey } = require('../../services/square/square-client');
const logger = require('../../utils/logger');

// Import the module under test after mocks are set up
const squareApi = require('../../utils/square-api');

describe('setSquareInventoryAlertThreshold VERSION_MISMATCH retry', () => {
    const merchantId = 1;
    const catalogObjectId = 'TEST_VARIATION_ID';
    const locationId = 'TEST_LOCATION_ID';
    const threshold = 5;

    // Mock catalog object response (for retrieval)
    const createCatalogResponse = (version) => ({
        object: {
            type: 'ITEM_VARIATION',
            id: catalogObjectId,
            version: version,
            item_variation_data: {
                name: 'Test Variation',
                location_overrides: []
            }
        }
    });

    // Mock successful update response
    const createSuccessResponse = (newVersion) => ({
        catalog_object: {
            type: 'ITEM_VARIATION',
            id: catalogObjectId,
            version: newVersion
        }
    });

    // Factory for VERSION_MISMATCH error (matches what makeSquareRequest throws)
    const createVersionMismatchError = () => {
        const err = new Error('Square API error: 400 - [{"category":"INVALID_REQUEST_ERROR","code":"VERSION_MISMATCH","detail":"Object version does not match latest database version.","field":"version"}]');
        err.nonRetryable = true;
        err.squareErrors = [{
            category: 'INVALID_REQUEST_ERROR',
            code: 'VERSION_MISMATCH',
            detail: 'Object version does not match latest database version.',
            field: 'version'
        }];
        return err;
    };

    let idempotencyCounter;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.clearAllTimers();
        idempotencyCounter = 0;

        // Re-establish mock implementations (restoreMocks: true resets them between tests)
        getMerchantToken.mockResolvedValue('test-access-token');
        generateIdempotencyKey.mockImplementation((prefix) => `${prefix || 'key'}-${++idempotencyCounter}`);
        makeSquareRequest.mockReset();
    });

    afterAll(() => {
        jest.clearAllTimers();
    });

    it('should succeed on first attempt when no version conflict', async () => {
        // Mock makeSquareRequest responses: retrieve then update
        makeSquareRequest
            .mockResolvedValueOnce(createCatalogResponse(100))
            .mockResolvedValueOnce(createSuccessResponse(101));

        const result = await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        expect(result.success).toBe(true);
        expect(result.catalog_object.version).toBe(101);
        // Should only have 2 makeSquareRequest calls: retrieve + update
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        // Should not log any VERSION_MISMATCH retry warnings
        expect(logger.warn).not.toHaveBeenCalledWith(
            'VERSION_MISMATCH on inventory alert update, retrying with fresh version',
            expect.anything()
        );
    });

    it('should retry and succeed after VERSION_MISMATCH on first attempt', async () => {
        // First attempt: retrieve succeeds, update fails with VERSION_MISMATCH
        // Second attempt: retrieve succeeds with new version, update succeeds
        makeSquareRequest
            // Attempt 1: retrieve
            .mockResolvedValueOnce(createCatalogResponse(100))
            // Attempt 1: update fails
            .mockRejectedValueOnce(createVersionMismatchError())
            // Attempt 2: retrieve with new version
            .mockResolvedValueOnce(createCatalogResponse(101))
            // Attempt 2: update succeeds
            .mockResolvedValueOnce(createSuccessResponse(102));

        const result = await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        expect(result.success).toBe(true);
        expect(result.catalog_object.version).toBe(102);
        // Should have 4 makeSquareRequest calls: retrieve + update (fail) + retrieve + update (success)
        expect(makeSquareRequest).toHaveBeenCalledTimes(4);
        // Should log retry warning
        expect(logger.warn).toHaveBeenCalledWith(
            'VERSION_MISMATCH on inventory alert update, retrying with fresh version',
            expect.objectContaining({
                catalogObjectId,
                locationId,
                attempt: 1,
                maxRetries: 3
            })
        );
    });

    it('should retry multiple times before succeeding', async () => {
        // Fail twice, succeed on third attempt
        makeSquareRequest
            // Attempt 1
            .mockResolvedValueOnce(createCatalogResponse(100))
            .mockRejectedValueOnce(createVersionMismatchError())
            // Attempt 2
            .mockResolvedValueOnce(createCatalogResponse(101))
            .mockRejectedValueOnce(createVersionMismatchError())
            // Attempt 3
            .mockResolvedValueOnce(createCatalogResponse(102))
            .mockResolvedValueOnce(createSuccessResponse(103));

        const result = await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        expect(result.success).toBe(true);
        // Should have 6 makeSquareRequest calls (3 attempts x 2 calls each)
        expect(makeSquareRequest).toHaveBeenCalledTimes(6);
        // Should log retry warnings for attempts 1 and 2
        const versionMismatchWarnings = logger.warn.mock.calls.filter(
            call => call[0] === 'VERSION_MISMATCH on inventory alert update, retrying with fresh version'
        );
        expect(versionMismatchWarnings.length).toBe(2);
    });

    it('should fail after max retries exhausted', async () => {
        // All 3 attempts fail with VERSION_MISMATCH
        makeSquareRequest
            // Attempt 1
            .mockResolvedValueOnce(createCatalogResponse(100))
            .mockRejectedValueOnce(createVersionMismatchError())
            // Attempt 2
            .mockResolvedValueOnce(createCatalogResponse(101))
            .mockRejectedValueOnce(createVersionMismatchError())
            // Attempt 3
            .mockResolvedValueOnce(createCatalogResponse(102))
            .mockRejectedValueOnce(createVersionMismatchError());

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow('VERSION_MISMATCH');

        // Should have 6 makeSquareRequest calls (3 attempts x 2 calls each)
        expect(makeSquareRequest).toHaveBeenCalledTimes(6);
        // Should log final error
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to update Square inventory alert threshold',
            expect.objectContaining({
                catalogObjectId,
                locationId,
                threshold,
                attempts: 3
            })
        );
    });

    it('should not retry on non-VERSION_MISMATCH errors', async () => {
        // Retrieve succeeds, update fails with a non-VERSION_MISMATCH error
        const invalidValueError = new Error('Square API error: 400 - [{"category":"INVALID_REQUEST_ERROR","code":"INVALID_VALUE","detail":"Invalid value provided.","field":"threshold"}]');
        invalidValueError.nonRetryable = true;
        invalidValueError.squareErrors = [{
            category: 'INVALID_REQUEST_ERROR',
            code: 'INVALID_VALUE',
            detail: 'Invalid value provided.',
            field: 'threshold'
        }];

        makeSquareRequest
            .mockResolvedValueOnce(createCatalogResponse(100))
            .mockRejectedValueOnce(invalidValueError);

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow('INVALID_VALUE');

        // Should only have 2 makeSquareRequest calls (no retry)
        expect(makeSquareRequest).toHaveBeenCalledTimes(2);
        // Should not log VERSION_MISMATCH retry warning
        expect(logger.warn).not.toHaveBeenCalledWith(
            'VERSION_MISMATCH on inventory alert update, retrying with fresh version',
            expect.anything()
        );
    });

    it('should fail immediately if catalog object not found', async () => {
        // Retrieve returns no object
        makeSquareRequest.mockResolvedValueOnce({ object: null });

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow(`Catalog object not found: ${catalogObjectId}`);

        // Should only have 1 makeSquareRequest call
        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    it('should fail immediately if object is not a variation', async () => {
        // Retrieve returns wrong type
        makeSquareRequest.mockResolvedValueOnce({
            object: {
                type: 'ITEM',
                id: catalogObjectId,
                version: 100
            }
        });

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow('Object is not a variation: ITEM');

        expect(makeSquareRequest).toHaveBeenCalledTimes(1);
    });

    it('should require merchantId', async () => {
        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                {} // No merchantId
            )
        ).rejects.toThrow('merchantId is required for setSquareInventoryAlertThreshold');

        expect(makeSquareRequest).not.toHaveBeenCalled();
    });

    it('should use unique idempotency keys for each retry attempt', async () => {
        // Fail once, succeed on second
        makeSquareRequest
            .mockResolvedValueOnce(createCatalogResponse(100))
            .mockRejectedValueOnce(createVersionMismatchError())
            .mockResolvedValueOnce(createCatalogResponse(101))
            .mockResolvedValueOnce(createSuccessResponse(102));

        await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        // Check that different idempotency keys were used
        // Update calls are POSTs to /v2/catalog/object (no object ID suffix)
        const updateCalls = makeSquareRequest.mock.calls.filter(call =>
            call[0] === '/v2/catalog/object' &&
            call[1]?.method === 'POST'
        );

        expect(updateCalls.length).toBe(2);

        const body1 = JSON.parse(updateCalls[0][1].body);
        const body2 = JSON.parse(updateCalls[1][1].body);

        expect(body1.idempotency_key).toBeDefined();
        expect(body2.idempotency_key).toBeDefined();
        expect(body1.idempotency_key).not.toBe(body2.idempotency_key);
    });
});
