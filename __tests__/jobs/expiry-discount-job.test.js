/**
 * Expiry Discount Job Tests
 *
 * Tests import, disabled setting skips, enabled runs automation,
 * no merchants, and error handling.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(),
}));

jest.mock('../../services/expiry', () => ({
    getSetting: jest.fn(),
    runExpiryDiscountAutomation: jest.fn(),
}));

const db = require('../../utils/database');
const emailNotifier = require('../../utils/email-notifier');
const expiryDiscount = require('../../services/expiry');
const logger = require('../../utils/logger');
const {
    runExpiryDiscountForMerchant,
    runExpiryDiscountForAllMerchants,
    runScheduledExpiryDiscount,
} = require('../../jobs/expiry-discount-job');

describe('Expiry Discount Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runExpiryDiscountForMerchant as a function', () => {
            expect(typeof runExpiryDiscountForMerchant).toBe('function');
        });

        it('should export runExpiryDiscountForAllMerchants as a function', () => {
            expect(typeof runExpiryDiscountForAllMerchants).toBe('function');
        });

        it('should export runScheduledExpiryDiscount as a function', () => {
            expect(typeof runScheduledExpiryDiscount).toBe('function');
        });
    });

    describe('runExpiryDiscountForMerchant', () => {
        it('should skip when auto_apply_enabled is not true', async () => {
            expiryDiscount.getSetting.mockResolvedValueOnce('false');

            const result = await runExpiryDiscountForMerchant(1, 'Test Store');

            expect(result.skipped).toBe(true);
            expect(result.reason).toBe('automation_disabled');
            expect(expiryDiscount.runExpiryDiscountAutomation).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'Expiry discount automation is disabled for merchant, skipping',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should skip when setting returns null', async () => {
            expiryDiscount.getSetting.mockResolvedValueOnce(null);

            const result = await runExpiryDiscountForMerchant(5, 'Store X');

            expect(result.skipped).toBe(true);
            expect(expiryDiscount.runExpiryDiscountAutomation).not.toHaveBeenCalled();
        });

        it('should run automation when auto_apply_enabled is true', async () => {
            expiryDiscount.getSetting.mockResolvedValueOnce('true');
            expiryDiscount.runExpiryDiscountAutomation.mockResolvedValueOnce({
                success: true,
                evaluation: {
                    totalEvaluated: 20,
                    tierChanges: [],
                    newAssignments: [],
                    byTier: {},
                },
                discountApplication: { applied: [], removed: [] },
                errors: [],
                duration: 500,
            });

            const result = await runExpiryDiscountForMerchant(3, 'Pet Store');

            expect(expiryDiscount.runExpiryDiscountAutomation).toHaveBeenCalledWith({
                merchantId: 3,
                dryRun: false,
            });
            expect(result.success).toBe(true);
        });

        it('should send email when tier changes exist and email enabled', async () => {
            expiryDiscount.getSetting
                .mockResolvedValueOnce('true')   // auto_apply_enabled
                .mockResolvedValueOnce('true');  // email_notifications

            expiryDiscount.runExpiryDiscountAutomation.mockResolvedValueOnce({
                success: true,
                evaluation: {
                    totalEvaluated: 10,
                    tierChanges: [{ itemId: 1, from: 'GREEN', to: 'YELLOW' }],
                    newAssignments: [],
                    byTier: { GREEN: 5, YELLOW: 3, RED: 2 },
                },
                discountApplication: { applied: [{ id: 1 }], removed: [] },
                errors: [],
                duration: 300,
            });

            await runExpiryDiscountForMerchant(3, 'Pet Store');

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                expect.stringContaining('Pet Store'),
                expect.stringContaining('Tier changes: 1')
            );
        });

        it('should not send email when no tier changes', async () => {
            expiryDiscount.getSetting.mockResolvedValueOnce('true');
            expiryDiscount.runExpiryDiscountAutomation.mockResolvedValueOnce({
                success: true,
                evaluation: {
                    totalEvaluated: 10,
                    tierChanges: [],
                    newAssignments: [],
                    byTier: {},
                },
                discountApplication: { applied: [], removed: [] },
                errors: [],
                duration: 200,
            });

            await runExpiryDiscountForMerchant(3, 'Pet Store');

            expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
        });

        it('should not send email when email_notifications is disabled', async () => {
            expiryDiscount.getSetting
                .mockResolvedValueOnce('true')    // auto_apply_enabled
                .mockResolvedValueOnce('false');  // email_notifications

            expiryDiscount.runExpiryDiscountAutomation.mockResolvedValueOnce({
                success: true,
                evaluation: {
                    totalEvaluated: 10,
                    tierChanges: [{ itemId: 1, from: 'GREEN', to: 'YELLOW' }],
                    newAssignments: [],
                    byTier: {},
                },
                discountApplication: { applied: [], removed: [] },
                errors: [],
                duration: 200,
            });

            await runExpiryDiscountForMerchant(3, 'Pet Store');

            expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
        });

        it('should handle email send failure gracefully', async () => {
            expiryDiscount.getSetting
                .mockResolvedValueOnce('true')
                .mockResolvedValueOnce('true');

            expiryDiscount.runExpiryDiscountAutomation.mockResolvedValueOnce({
                success: true,
                evaluation: {
                    totalEvaluated: 5,
                    tierChanges: [{ itemId: 1 }],
                    newAssignments: [],
                    byTier: {},
                },
                discountApplication: { applied: [], removed: [] },
                errors: [],
                duration: 100,
            });
            emailNotifier.sendAlert.mockRejectedValueOnce(new Error('SMTP error'));

            // Should not throw
            const result = await runExpiryDiscountForMerchant(3, 'Pet Store');

            expect(result.success).toBe(true);
            expect(logger.error).toHaveBeenCalledWith(
                'Failed to send expiry discount automation email',
                expect.objectContaining({ merchantId: 3 })
            );
        });
    });

    describe('runExpiryDiscountForAllMerchants', () => {
        it('should handle no merchants gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runExpiryDiscountForAllMerchants();

            expect(result.merchantCount).toBe(0);
            expect(result.results).toEqual([]);
            expect(logger.info).toHaveBeenCalledWith(
                'No active merchants for expiry discount automation'
            );
        });

        it('should iterate through each merchant', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ],
            });
            expiryDiscount.getSetting.mockResolvedValue('false'); // Both disabled

            const result = await runExpiryDiscountForAllMerchants();

            expect(result.merchantCount).toBe(2);
            expect(result.results).toHaveLength(2);
            expect(result.results[0].skipped).toBe(true);
            expect(result.results[1].skipped).toBe(true);
        });

        it('should continue processing when one merchant fails', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ],
            });
            expiryDiscount.getSetting
                .mockRejectedValueOnce(new Error('DB error'))
                .mockResolvedValueOnce('false');

            const result = await runExpiryDiscountForAllMerchants();

            expect(result.merchantCount).toBe(2);
            expect(result.results[0].error).toBe('DB error');
            expect(result.results[1].skipped).toBe(true);
            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled expiry discount automation failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should handle DB query error by throwing', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(runExpiryDiscountForAllMerchants()).rejects.toThrow('Connection refused');
        });
    });

    describe('runScheduledExpiryDiscount', () => {
        it('should catch errors and send alert email', async () => {
            db.query.mockRejectedValueOnce(new Error('DB down'));

            await runScheduledExpiryDiscount();

            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled expiry discount automation failed',
                expect.objectContaining({ error: 'DB down' })
            );
            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                'Expiry Discount Automation Failed',
                expect.stringContaining('DB down')
            );
        });

        it('should not throw even on failure', async () => {
            db.query.mockRejectedValueOnce(new Error('fail'));

            await expect(runScheduledExpiryDiscount()).resolves.toBeUndefined();
        });
    });
});
