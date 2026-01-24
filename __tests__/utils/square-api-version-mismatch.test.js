/**
 * Tests for Square API VERSION_MISMATCH retry logic
 * Specifically tests setSquareInventoryAlertThreshold retry behavior
 */

// Mock modules BEFORE requiring the module under test
jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('node-fetch');

const fetch = require('node-fetch');
const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Import the module under test after mocks are set up
const squareApi = require('../../utils/square-api');

describe('setSquareInventoryAlertThreshold VERSION_MISMATCH retry', () => {
    const merchantId = 1;
    const catalogObjectId = 'TEST_VARIATION_ID';
    const locationId = 'TEST_LOCATION_ID';
    const threshold = 5;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.clearAllTimers();
    });

    afterAll(() => {
        jest.clearAllTimers();
    });

    // Mock merchant token response
    const mockMerchantTokenResponse = {
        rows: [{ square_access_token: 'encrypted_test_token' }]
    };

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

    // Mock VERSION_MISMATCH error response
    const versionMismatchError = {
        ok: false,
        status: 400,
        json: jest.fn().mockResolvedValue({
            errors: [{
                category: 'INVALID_REQUEST_ERROR',
                code: 'VERSION_MISMATCH',
                detail: 'Object version does not match latest database version.',
                field: 'version'
            }]
        })
    };

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset fetch mock
        fetch.mockReset();
    });

    it('should succeed on first attempt when no version conflict', async () => {
        // Mock db query for merchant token
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // Mock fetch responses: retrieve then update
        fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(100))
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createSuccessResponse(101))
            });

        const result = await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        expect(result.success).toBe(true);
        expect(result.catalog_object.version).toBe(101);
        // Should only have 2 fetch calls: retrieve + update
        expect(fetch).toHaveBeenCalledTimes(2);
        // Should not log any VERSION_MISMATCH retry warnings
        expect(logger.warn).not.toHaveBeenCalledWith(
            'VERSION_MISMATCH on inventory alert update, retrying with fresh version',
            expect.anything()
        );
    });

    it('should retry and succeed after VERSION_MISMATCH on first attempt', async () => {
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // First attempt: retrieve succeeds, update fails with VERSION_MISMATCH
        // Second attempt: retrieve succeeds with new version, update succeeds
        fetch
            // Attempt 1: retrieve
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(100))
            })
            // Attempt 1: update fails
            .mockResolvedValueOnce(versionMismatchError)
            // Attempt 2: retrieve with new version
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(101))
            })
            // Attempt 2: update succeeds
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createSuccessResponse(102))
            });

        const result = await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        expect(result.success).toBe(true);
        expect(result.catalog_object.version).toBe(102);
        // Should have 4 fetch calls: retrieve + update (fail) + retrieve + update (success)
        expect(fetch).toHaveBeenCalledTimes(4);
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
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // Fail twice, succeed on third attempt
        fetch
            // Attempt 1
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(100))
            })
            .mockResolvedValueOnce(versionMismatchError)
            // Attempt 2
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(101))
            })
            .mockResolvedValueOnce(versionMismatchError)
            // Attempt 3
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(102))
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createSuccessResponse(103))
            });

        const result = await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        expect(result.success).toBe(true);
        // Should have 6 fetch calls (3 attempts x 2 calls each)
        expect(fetch).toHaveBeenCalledTimes(6);
        // Should log retry warnings for attempts 1 and 2
        const versionMismatchWarnings = logger.warn.mock.calls.filter(
            call => call[0] === 'VERSION_MISMATCH on inventory alert update, retrying with fresh version'
        );
        expect(versionMismatchWarnings.length).toBe(2);
    });

    it('should fail after max retries exhausted', async () => {
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // All 3 attempts fail with VERSION_MISMATCH
        fetch
            // Attempt 1
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(100))
            })
            .mockResolvedValueOnce(versionMismatchError)
            // Attempt 2
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(101))
            })
            .mockResolvedValueOnce(versionMismatchError)
            // Attempt 3
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(102))
            })
            .mockResolvedValueOnce(versionMismatchError);

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow('VERSION_MISMATCH');

        // Should have 6 fetch calls (3 attempts x 2 calls each)
        expect(fetch).toHaveBeenCalledTimes(6);
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
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // Retrieve succeeds, update fails with a 400 error that's NOT VERSION_MISMATCH
        // Using INVALID_VALUE which is a non-retryable 400 error
        const invalidValueError = {
            ok: false,
            status: 400,
            json: jest.fn().mockResolvedValue({
                errors: [{
                    category: 'INVALID_REQUEST_ERROR',
                    code: 'INVALID_VALUE',
                    detail: 'Invalid value provided.',
                    field: 'threshold'
                }]
            })
        };

        fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(100))
            })
            .mockResolvedValueOnce(invalidValueError);

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow('INVALID_VALUE');

        // Should only have 2 fetch calls (no retry at setSquareInventoryAlertThreshold level)
        expect(fetch).toHaveBeenCalledTimes(2);
        // Should not log VERSION_MISMATCH retry warning
        expect(logger.warn).not.toHaveBeenCalledWith(
            'VERSION_MISMATCH on inventory alert update, retrying with fresh version',
            expect.anything()
        );
    });

    it('should fail immediately if catalog object not found', async () => {
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // Retrieve returns no object
        fetch.mockResolvedValueOnce({
            ok: true,
            json: jest.fn().mockResolvedValue({ object: null })
        });

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow(`Catalog object not found: ${catalogObjectId}`);

        // Should only have 1 fetch call
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should fail immediately if object is not a variation', async () => {
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // Retrieve returns wrong type
        fetch.mockResolvedValueOnce({
            ok: true,
            json: jest.fn().mockResolvedValue({
                object: {
                    type: 'ITEM',
                    id: catalogObjectId,
                    version: 100
                }
            })
        });

        await expect(
            squareApi.setSquareInventoryAlertThreshold(
                catalogObjectId,
                locationId,
                threshold,
                { merchantId }
            )
        ).rejects.toThrow('Object is not a variation: ITEM');

        expect(fetch).toHaveBeenCalledTimes(1);
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

        expect(fetch).not.toHaveBeenCalled();
    });

    it('should use unique idempotency keys for each retry attempt', async () => {
        db.query.mockResolvedValue(mockMerchantTokenResponse);

        // Fail once, succeed on second
        fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(100))
            })
            .mockResolvedValueOnce(versionMismatchError)
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createCatalogResponse(101))
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(createSuccessResponse(102))
            });

        await squareApi.setSquareInventoryAlertThreshold(
            catalogObjectId,
            locationId,
            threshold,
            { merchantId }
        );

        // Check that different idempotency keys were used
        const updateCalls = fetch.mock.calls.filter(call =>
            call[0].includes('/v2/catalog/object') &&
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
