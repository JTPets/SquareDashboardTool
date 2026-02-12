/**
 * Tests for SeniorsService pricing rule management
 *
 * Covers:
 * - enablePricingRule() / disablePricingRule() VERSION_MISMATCH retry
 * - Response validation after batchUpsertCatalog
 * - verifyPricingRuleState() correctness
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

// Mock LoyaltySquareClient
const mockSquareClient = {
    initialize: jest.fn().mockResolvedValue({}),
    getCatalogObject: jest.fn(),
    batchUpsertCatalog: jest.fn(),
};

jest.mock('../../services/loyalty/square-client', () => ({
    LoyaltySquareClient: jest.fn().mockImplementation(() => mockSquareClient),
    SquareApiError: class SquareApiError extends Error {
        constructor(message, status, endpoint, details = {}) {
            super(message);
            this.name = 'SquareApiError';
            this.status = status;
            this.endpoint = endpoint;
            this.details = details;
        }
    },
}));

const { SquareApiError } = require('../../services/loyalty/square-client');
const { SeniorsService } = require('../../services/seniors/seniors-service');

describe('SeniorsService', () => {
    let service;
    const merchantId = 1;
    const pricingRuleId = 'RULE_ID_123';

    beforeEach(() => {
        jest.clearAllMocks();
        service = new SeniorsService(merchantId);
        service.squareClient = mockSquareClient;
        service.config = {
            merchant_id: merchantId,
            square_pricing_rule_id: pricingRuleId,
            square_group_id: 'GROUP_123',
            square_discount_id: 'DISC_123',
        };

        // Default: getCatalogObject returns a valid pricing rule
        mockSquareClient.getCatalogObject.mockResolvedValue({
            id: pricingRuleId,
            type: 'PRICING_RULE',
            version: 100,
            pricing_rule_data: {
                name: 'seniors-day-discount',
                valid_from_date: '2020-01-01',
                valid_until_date: '2020-01-01',
            },
        });

        // Default: batchUpsertCatalog returns the updated object
        mockSquareClient.batchUpsertCatalog.mockImplementation(async (objects) => {
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
            expect(mockSquareClient.getCatalogObject).toHaveBeenCalledWith(pricingRuleId);
            expect(mockSquareClient.batchUpsertCatalog).toHaveBeenCalledTimes(1);

            // Verify the upsert was called with today's date
            const upsertCall = mockSquareClient.batchUpsertCatalog.mock.calls[0];
            const sentObject = upsertCall[0][0];
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
            mockSquareClient.getCatalogObject.mockResolvedValue(null);
            await expect(service.enablePricingRule())
                .rejects.toThrow('not found in Square');
        });

        it('should retry on VERSION_MISMATCH and succeed', async () => {
            const versionError = new SquareApiError(
                'Square API error: 400', 400, '/catalog/batch-upsert',
                { errors: [{ code: 'VERSION_MISMATCH', detail: 'Object version does not match' }] }
            );

            // First attempt fails with VERSION_MISMATCH, second succeeds
            mockSquareClient.batchUpsertCatalog
                .mockRejectedValueOnce(versionError)
                .mockImplementationOnce(async (objects) => {
                    return objects.map(obj => ({ ...obj, version: obj.version + 1 }));
                });

            // Second getCatalogObject returns fresh version
            mockSquareClient.getCatalogObject
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
            expect(mockSquareClient.getCatalogObject).toHaveBeenCalledTimes(2);
            expect(mockSquareClient.batchUpsertCatalog).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                'VERSION_MISMATCH on seniors enable, retrying with fresh version',
                expect.objectContaining({ merchantId, attempt: 1 })
            );
        });

        it('should throw after max VERSION_MISMATCH retries', async () => {
            const versionError = new SquareApiError(
                'Square API error: 400', 400, '/catalog/batch-upsert',
                { errors: [{ code: 'VERSION_MISMATCH' }] }
            );

            mockSquareClient.batchUpsertCatalog.mockRejectedValue(versionError);

            await expect(service.enablePricingRule()).rejects.toThrow('Square API error: 400');
            expect(mockSquareClient.batchUpsertCatalog).toHaveBeenCalledTimes(3);
        });

        it('should not retry on non-VERSION_MISMATCH errors', async () => {
            const otherError = new SquareApiError(
                'Square API error: 500', 500, '/catalog/batch-upsert', {}
            );
            mockSquareClient.batchUpsertCatalog.mockRejectedValue(otherError);

            await expect(service.enablePricingRule()).rejects.toThrow('Square API error: 500');
            expect(mockSquareClient.batchUpsertCatalog).toHaveBeenCalledTimes(1);
        });
    });

    describe('disablePricingRule', () => {
        it('should disable the pricing rule with past date', async () => {
            const result = await service.disablePricingRule();

            expect(result.enabled).toBe(false);
            expect(result.pricingRuleId).toBe(pricingRuleId);

            const sentObject = mockSquareClient.batchUpsertCatalog.mock.calls[0][0][0];
            expect(sentObject.pricing_rule_data.valid_until_date).toBe('2020-01-01');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("last_verified_state = 'disabled'"),
                [merchantId]
            );
        });

        it('should retry on VERSION_MISMATCH and succeed', async () => {
            const versionError = new SquareApiError(
                'Square API error: 400', 400, '/catalog/batch-upsert',
                { errors: [{ code: 'VERSION_MISMATCH' }] }
            );

            mockSquareClient.batchUpsertCatalog
                .mockRejectedValueOnce(versionError)
                .mockImplementationOnce(async (objects) => {
                    return objects.map(obj => ({ ...obj, version: obj.version + 1 }));
                });

            mockSquareClient.getCatalogObject
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
            expect(mockSquareClient.getCatalogObject).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                'VERSION_MISMATCH on seniors disable, retrying with fresh version',
                expect.objectContaining({ merchantId, attempt: 1 })
            );
        });

        it('should throw after max VERSION_MISMATCH retries', async () => {
            const versionError = new SquareApiError(
                'VERSION_MISMATCH', 400, '/catalog/batch-upsert',
                { errors: [{ code: 'VERSION_MISMATCH' }] }
            );

            mockSquareClient.batchUpsertCatalog.mockRejectedValue(versionError);

            await expect(service.disablePricingRule()).rejects.toThrow('VERSION_MISMATCH');
            expect(mockSquareClient.batchUpsertCatalog).toHaveBeenCalledTimes(3);
        });
    });

    describe('verifyPricingRuleState', () => {
        it('should return verified:true when state matches expected (disabled)', async () => {
            mockSquareClient.getCatalogObject.mockResolvedValue({
                id: pricingRuleId, type: 'PRICING_RULE', version: 100,
                pricing_rule_data: { valid_until_date: '2020-01-01' },
            });

            const result = await service.verifyPricingRuleState(false);

            expect(result.verified).toBe(true);
            expect(result.actual).toBe('disabled');
        });

        it('should return verified:false when state mismatches (expected disabled, got enabled)', async () => {
            mockSquareClient.getCatalogObject.mockResolvedValue({
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
            mockSquareClient.getCatalogObject.mockResolvedValue(null);
            const result = await service.verifyPricingRuleState(false);
            expect(result.verified).toBe(false);
            expect(result.reason).toBe('not_found_in_square');
        });
    });
});
