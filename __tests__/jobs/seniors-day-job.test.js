/**
 * Seniors Day Job Tests
 *
 * Tests structural coverage: import, empty data, DB errors, scheduled wrapper.
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(),
}));

jest.mock('../../services/seniors', () => ({
    SeniorsService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(),
        enablePricingRule: jest.fn().mockResolvedValue({ success: true }),
        disablePricingRule: jest.fn().mockResolvedValue({ success: true }),
        sweepLocalAges: jest.fn().mockResolvedValue({ updated: 0 }),
        verifyPricingRuleState: jest.fn().mockResolvedValue({ verified: true }),
        logAudit: jest.fn().mockResolvedValue(),
        config: {
            last_verified_state: 'disabled',
            last_verified_at: new Date().toISOString(),
            last_disabled_at: new Date(Date.now() - 86400000).toISOString(),
        },
    })),
}));

jest.mock('../../config/constants', () => ({
    SENIORS_DISCOUNT: {
        DAY_OF_MONTH: 1,
    },
    RETRY: {
        MAX_ATTEMPTS: 3,
    },
    WEBHOOK: {
        RETRY_DELAY_MS: 100,
    },
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const emailNotifier = require('../../utils/email-notifier');
const { SeniorsService } = require('../../services/seniors');
const {
    runSeniorsDiscountForMerchant,
    runSeniorsDiscountForAllMerchants,
    runScheduledSeniorsDiscount,
    verifyStateOnStartup,
    getMerchantsWithSeniorsConfig,
} = require('../../jobs/seniors-day-job');

describe('Seniors Day Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export all expected functions', () => {
            expect(typeof runSeniorsDiscountForMerchant).toBe('function');
            expect(typeof runSeniorsDiscountForAllMerchants).toBe('function');
            expect(typeof runScheduledSeniorsDiscount).toBe('function');
            expect(typeof verifyStateOnStartup).toBe('function');
            expect(typeof getMerchantsWithSeniorsConfig).toBe('function');
        });
    });

    describe('getMerchantsWithSeniorsConfig', () => {
        it('should return merchants with seniors config', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, business_name: 'Pet Store', day_of_month: 1 }],
            });

            const result = await getMerchantsWithSeniorsConfig();

            expect(result).toHaveLength(1);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('seniors_discount_config');
            expect(sql).toContain('is_active = TRUE');
            expect(sql).toContain('is_enabled = TRUE');
        });

        it('should return empty array when no merchants configured', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getMerchantsWithSeniorsConfig();

            expect(result).toHaveLength(0);
        });

        it('should return empty array when table does not exist', async () => {
            db.query.mockRejectedValueOnce(new Error('relation "seniors_discount_config" does not exist'));

            const result = await getMerchantsWithSeniorsConfig();

            expect(result).toHaveLength(0);
        });

        it('should propagate non-table-missing errors', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(getMerchantsWithSeniorsConfig()).rejects.toThrow('Connection refused');
        });
    });

    describe('runSeniorsDiscountForMerchant', () => {
        it('should return result with merchant info', async () => {
            const result = await runSeniorsDiscountForMerchant(1, 'Pet Store', 1);

            expect(result.merchantId).toBe(1);
            expect(result.businessName).toBe('Pet Store');
            expect(SeniorsService).toHaveBeenCalledWith(1);
        });

        it('should handle SeniorsService initialization errors', async () => {
            SeniorsService.mockImplementationOnce(() => ({
                initialize: jest.fn().mockRejectedValue(new Error('No config found')),
            }));

            await expect(
                runSeniorsDiscountForMerchant(1, 'Pet Store', 1)
            ).rejects.toThrow('No config found');
        });
    });

    describe('runSeniorsDiscountForAllMerchants', () => {
        it('should return empty results when no merchants configured', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runSeniorsDiscountForAllMerchants();

            expect(result.merchantCount).toBe(0);
            expect(result.results).toHaveLength(0);
        });

        it('should process multiple merchants', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A', day_of_month: 1 },
                    { id: 2, business_name: 'Store B', day_of_month: 1 },
                ],
            });

            const result = await runSeniorsDiscountForAllMerchants();

            expect(result.merchantCount).toBe(2);
            expect(result.results).toHaveLength(2);
        });

        it('should isolate merchant errors and send alert email', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Failing Store', day_of_month: 1 },
                    { id: 2, business_name: 'Working Store', day_of_month: 1 },
                ],
            });

            // First merchant fails on initialize
            SeniorsService
                .mockImplementationOnce(() => ({
                    initialize: jest.fn().mockRejectedValue(new Error('API down')),
                }))
                .mockImplementationOnce(() => ({
                    initialize: jest.fn().mockResolvedValue(),
                    enablePricingRule: jest.fn().mockResolvedValue({ success: true }),
                    disablePricingRule: jest.fn().mockResolvedValue({ success: true }),
                    sweepLocalAges: jest.fn().mockResolvedValue({ updated: 0 }),
                    verifyPricingRuleState: jest.fn().mockResolvedValue({ verified: true }),
                    logAudit: jest.fn().mockResolvedValue(),
                    config: {
                        last_verified_state: 'disabled',
                        last_verified_at: new Date().toISOString(),
                        last_disabled_at: new Date(Date.now() - 86400000).toISOString(),
                    },
                }));

            const result = await runSeniorsDiscountForAllMerchants();

            expect(result.results).toHaveLength(2);
            // First merchant result should have error
            expect(result.results[0].error).toContain('API down');
            // Second merchant should succeed
            expect(result.results[1].merchantId).toBe(2);
            // Alert email sent for failing merchant
            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                expect.stringContaining('Failing Store'),
                expect.stringContaining('API down')
            );
        });
    });

    describe('verifyStateOnStartup', () => {
        it('should handle no merchants gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await expect(verifyStateOnStartup()).resolves.toBeUndefined();
        });

        it('should handle table-not-exist error gracefully', async () => {
            // getMerchantsWithSeniorsConfig catches "does not exist" and returns []
            // so verifyStateOnStartup sees 0 merchants and exits cleanly
            db.query.mockRejectedValueOnce(new Error('relation "seniors_discount_config" does not exist'));

            await expect(verifyStateOnStartup()).resolves.toBeUndefined();
            // No error logged because getMerchantsWithSeniorsConfig handles it
            expect(logger.error).not.toHaveBeenCalled();
        });

        it('should handle other errors gracefully', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(verifyStateOnStartup()).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalled();
        });

        it('should isolate per-merchant errors during startup check', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A', day_of_month: 1 },
                    { id: 2, business_name: 'Store B', day_of_month: 1 },
                ],
            });

            SeniorsService
                .mockImplementationOnce(() => ({
                    initialize: jest.fn().mockRejectedValue(new Error('Init failed')),
                }))
                .mockImplementationOnce(() => ({
                    initialize: jest.fn().mockResolvedValue(),
                    verifyPricingRuleState: jest.fn().mockResolvedValue({ verified: true }),
                    config: {
                        last_verified_state: 'disabled',
                        last_verified_at: new Date().toISOString(),
                        last_disabled_at: new Date(Date.now() - 86400000).toISOString(),
                    },
                }));

            await expect(verifyStateOnStartup()).resolves.toBeUndefined();

            expect(logger.error).toHaveBeenCalledWith(
                'Seniors startup state check failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
        });
    });

    describe('runScheduledSeniorsDiscount', () => {
        it('should not throw even when job fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledSeniorsDiscount()).resolves.toBeUndefined();
        });

        it('should send alert email on failure', async () => {
            db.query.mockRejectedValueOnce(new Error('Total failure'));

            await runScheduledSeniorsDiscount();

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                expect.stringContaining('Seniors Discount Automation Failed'),
                expect.stringContaining('Total failure')
            );
        });

        it('should handle email send failure gracefully', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));
            emailNotifier.sendAlert.mockRejectedValueOnce(new Error('SMTP down'));

            await expect(runScheduledSeniorsDiscount()).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalledWith(
                'Failed to send seniors discount failure alert',
                expect.any(Object)
            );
        });
    });
});
