/**
 * Tests for SeniorsService pricing rule management
 *
 * Covers:
 * - enablePricingRule() / disablePricingRule() VERSION_MISMATCH retry
 * - Response validation after batch upsert
 * - verifyPricingRuleState() correctness
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Mock square-client (migrated from square-api-client in Task 9).
// makeSquareRequest is routed to per-endpoint jest.fn()s so tests can
// drive each logical Square operation the same way the previous
// SquareApiClient-shaped tests did.
const mockGetMerchantToken = jest.fn();
const mockGetCatalogObject = jest.fn();
const mockBatchUpsertCatalog = jest.fn();

const mockMakeSquareRequest = jest.fn(async (endpoint, opts) => {
    if (endpoint.startsWith('/v2/catalog/object/')) {
        const objectId = endpoint.slice('/v2/catalog/object/'.length);
        const object = await mockGetCatalogObject(objectId);
        return { object };
    }
    if (endpoint === '/v2/catalog/batch-upsert') {
        const body = JSON.parse(opts.body);
        const objects = await mockBatchUpsertCatalog(
            body.batches[0].objects,
            body.idempotency_key,
        );
        return { objects };
    }
    throw new Error(`Unexpected Square endpoint in test: ${endpoint}`);
});

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

jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: (...args) => mockGetMerchantToken(...args),
    makeSquareRequest: (...args) => mockMakeSquareRequest(...args),
    SquareApiError: MockSquareApiError,
    // Preserve the real implementation used by services/square/api, which
    // re-exports this symbol (seniors-service reads it from there).
    generateIdempotencyKey: jest.requireActual('../../utils/idempotency').generateIdempotencyKey,
}));

const { SquareApiError } = require('../../services/square/square-client');
const { SeniorsService } = require('../../services/seniors/seniors-service');

describe('SeniorsService', () => {
    let service;
    const merchantId = 1;
    const pricingRuleId = 'RULE_ID_123';

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMerchantToken.mockResolvedValue('TOKEN_123');

        service = new SeniorsService(merchantId);
        service.accessToken = 'TOKEN_123';
        service.config = {
            merchant_id: merchantId,
            square_pricing_rule_id: pricingRuleId,
            square_group_id: 'GROUP_123',
            square_discount_id: 'DISC_123',
        };

        // Default: catalog/object returns a valid pricing rule
        mockGetCatalogObject.mockResolvedValue({
            id: pricingRuleId,
            type: 'PRICING_RULE',
            version: 100,
            pricing_rule_data: {
                name: 'seniors-day-discount',
                valid_from_date: '2020-01-01',
                valid_until_date: '2020-01-01',
            },
        });

        // Default: batch-upsert echoes the inputs back with bumped versions
        mockBatchUpsertCatalog.mockImplementation(async (objects) => {
            return objects.map(obj => ({
                ...obj,
                version: obj.version + 1,
            }));
        });

        // Mock db.query for config updates
        db.query.mockResolvedValue({ rows: [service.config] });
    });

    describe('enablePricingRule', () => {
        it('should enable the pricing rule and validate response', async () => {
            const result = await service.enablePricingRule();

            expect(result.enabled).toBe(true);
            expect(result.pricingRuleId).toBe(pricingRuleId);
            expect(mockGetCatalogObject).toHaveBeenCalledWith(pricingRuleId);
            expect(mockBatchUpsertCatalog).toHaveBeenCalledTimes(1);

            // Verify the upsert was called with today's date
            const [sentObjects] = mockBatchUpsertCatalog.mock.calls[0];
            const sentObject = sentObjects[0];
            expect(sentObject.version).toBe(100);
            expect(sentObject.pricing_rule_data.valid_until_date).toBeDefined();
            expect(sentObject.pricing_rule_data.valid_until_date).not.toBe('2020-01-01');

            // Verify DB was updated
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("last_verified_state = 'enabled'"),
                [merchantId]
            );
        });

        it('should throw when pricing rule not configured', async () => {
            service.config = {};
            await expect(service.enablePricingRule())
                .rejects.toThrow('Seniors discount not configured');
        });

        it('should throw when pricing rule not found in Square', async () => {
            mockGetCatalogObject.mockResolvedValue(null);
            await expect(service.enablePricingRule())
                .rejects.toThrow('not found in Square');
        });

        it('should retry on VERSION_MISMATCH and succeed', async () => {
            const versionError = new SquareApiError('Square API error: 400', {
                status: 400,
                endpoint: '/v2/catalog/batch-upsert',
                details: [{ code: 'VERSION_MISMATCH', detail: 'Object version does not match' }],
            });

            // First attempt fails with VERSION_MISMATCH, second succeeds
            mockBatchUpsertCatalog
                .mockRejectedValueOnce(versionError)
                .mockImplementationOnce(async (objects) => {
                    return objects.map(obj => ({ ...obj, version: obj.version + 1 }));
                });

            // Second catalog/object fetch returns fresh version
            mockGetCatalogObject
                .mockResolvedValueOnce({
                    id: pricingRuleId, type: 'PRICING_RULE', version: 100,
                    pricing_rule_data: { name: 'seniors-day-discount' },
                })
                .mockResolvedValueOnce({
                    id: pricingRuleId, type: 'PRICING_RULE', version: 101,
                    pricing_rule_data: { name: 'seniors-day-discount' },
                });

            const result = await service.enablePricingRule();

            expect(result.enabled).toBe(true);
            expect(mockGetCatalogObject).toHaveBeenCalledTimes(2);
            expect(mockBatchUpsertCatalog).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                'VERSION_MISMATCH on seniors enable, retrying with fresh version',
                expect.objectContaining({ merchantId, attempt: 1 })
            );
        });

        it('should throw after max VERSION_MISMATCH retries', async () => {
            const versionError = new SquareApiError('Square API error: 400', {
                status: 400,
                endpoint: '/v2/catalog/batch-upsert',
                details: [{ code: 'VERSION_MISMATCH' }],
            });

            mockBatchUpsertCatalog.mockRejectedValue(versionError);

            await expect(service.enablePricingRule()).rejects.toThrow('Square API error: 400');
            expect(mockBatchUpsertCatalog).toHaveBeenCalledTimes(3);
        });

        it('should not retry on non-VERSION_MISMATCH errors', async () => {
            const otherError = new SquareApiError('Square API error: 500', {
                status: 500,
                endpoint: '/v2/catalog/batch-upsert',
                details: [],
            });
            mockBatchUpsertCatalog.mockRejectedValue(otherError);

            await expect(service.enablePricingRule()).rejects.toThrow('Square API error: 500');
            expect(mockBatchUpsertCatalog).toHaveBeenCalledTimes(1);
        });
    });

    describe('disablePricingRule', () => {
        it('should disable the pricing rule with past date', async () => {
            const result = await service.disablePricingRule();

            expect(result.enabled).toBe(false);
            expect(result.pricingRuleId).toBe(pricingRuleId);

            const [sentObjects] = mockBatchUpsertCatalog.mock.calls[0];
            expect(sentObjects[0].pricing_rule_data.valid_until_date).toBe('2020-01-01');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("last_verified_state = 'disabled'"),
                [merchantId]
            );
        });

        it('should retry on VERSION_MISMATCH and succeed', async () => {
            const versionError = new SquareApiError('Square API error: 400', {
                status: 400,
                endpoint: '/v2/catalog/batch-upsert',
                details: [{ code: 'VERSION_MISMATCH' }],
            });

            mockBatchUpsertCatalog
                .mockRejectedValueOnce(versionError)
                .mockImplementationOnce(async (objects) => {
                    return objects.map(obj => ({ ...obj, version: obj.version + 1 }));
                });

            mockGetCatalogObject
                .mockResolvedValueOnce({
                    id: pricingRuleId, type: 'PRICING_RULE', version: 100,
                    pricing_rule_data: { name: 'seniors-day-discount' },
                })
                .mockResolvedValueOnce({
                    id: pricingRuleId, type: 'PRICING_RULE', version: 101,
                    pricing_rule_data: { name: 'seniors-day-discount' },
                });

            const result = await service.disablePricingRule();

            expect(result.enabled).toBe(false);
            expect(mockGetCatalogObject).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                'VERSION_MISMATCH on seniors disable, retrying with fresh version',
                expect.objectContaining({ merchantId, attempt: 1 })
            );
        });

        it('should throw after max VERSION_MISMATCH retries', async () => {
            const versionError = new SquareApiError('VERSION_MISMATCH', {
                status: 400,
                endpoint: '/v2/catalog/batch-upsert',
                details: [{ code: 'VERSION_MISMATCH' }],
            });

            mockBatchUpsertCatalog.mockRejectedValue(versionError);

            await expect(service.disablePricingRule()).rejects.toThrow('VERSION_MISMATCH');
            expect(mockBatchUpsertCatalog).toHaveBeenCalledTimes(3);
        });
    });

    describe('verifyPricingRuleState', () => {
        it('should return verified:true when state matches expected (disabled)', async () => {
            mockGetCatalogObject.mockResolvedValue({
                id: pricingRuleId, type: 'PRICING_RULE', version: 100,
                pricing_rule_data: { valid_until_date: '2020-01-01' },
            });

            const result = await service.verifyPricingRuleState(false);

            expect(result.verified).toBe(true);
            expect(result.actual).toBe('disabled');
        });

        it('should return verified:false when state mismatches (expected disabled, got enabled)', async () => {
            mockGetCatalogObject.mockResolvedValue({
                id: pricingRuleId, type: 'PRICING_RULE', version: 100,
                pricing_rule_data: { valid_until_date: '2099-12-31' },
            });

            const result = await service.verifyPricingRuleState(false);

            expect(result.verified).toBe(false);
            expect(result.expected).toBe('disabled');
            expect(result.actual).toBe('enabled');
        });

        it('should return not_configured when no pricing rule ID', async () => {
            service.config = {};
            const result = await service.verifyPricingRuleState(false);
            expect(result.verified).toBe(false);
            expect(result.reason).toBe('not_configured');
        });

        it('should return not_found when object missing from Square', async () => {
            mockGetCatalogObject.mockResolvedValue(null);
            const result = await service.verifyPricingRuleState(false);
            expect(result.verified).toBe(false);
            expect(result.reason).toBe('not_found_in_square');
        });
    });
});
