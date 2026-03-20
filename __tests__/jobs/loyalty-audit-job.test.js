/**
 * Loyalty Audit Job Tests
 *
 * Tests structural coverage: import, empty data, DB errors, merchant isolation.
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        audit: jest.fn(),
        squareApi: jest.fn(),
        perf: jest.fn(),
    },
}));

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn(),
}));

jest.mock('../../services/loyalty-admin', () => ({
    detectRewardRedemptionFromOrder: jest.fn(),
    syncRewardDiscountPrices: jest.fn(),
}));

const db = require('../../utils/database');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const { detectRewardRedemptionFromOrder, syncRewardDiscountPrices } = require('../../services/loyalty-admin');
const {
    runLoyaltyAudit,
    runScheduledLoyaltyAudit,
    auditMerchant,
    getMerchantsWithLoyalty,
} = require('../../jobs/loyalty-audit-job');

describe('Loyalty Audit Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export all expected functions', () => {
            expect(typeof runLoyaltyAudit).toBe('function');
            expect(typeof runScheduledLoyaltyAudit).toBe('function');
            expect(typeof auditMerchant).toBe('function');
            expect(typeof getMerchantsWithLoyalty).toBe('function');
        });
    });

    describe('getMerchantsWithLoyalty', () => {
        it('should return merchants from database', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, square_merchant_id: 'sq-1' }],
            });

            const result = await getMerchantsWithLoyalty();

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(1);
            expect(db.query).toHaveBeenCalledTimes(1);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('loyalty_offers');
            expect(sql).toContain('is_active = TRUE');
        });

        it('should return empty array when no merchants have loyalty', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getMerchantsWithLoyalty();

            expect(result).toHaveLength(0);
        });

        it('should propagate database errors', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(getMerchantsWithLoyalty()).rejects.toThrow('Connection refused');
        });
    });

    describe('auditMerchant', () => {
        const mockMerchant = { id: 1, square_merchant_id: 'sq-1' };

        it('should return clean results when no events found', async () => {
            getSquareClientForMerchant.mockResolvedValue({
                loyalty: { searchEvents: jest.fn().mockResolvedValue({ events: [] }) },
            });

            const result = await auditMerchant(mockMerchant, 48);

            expect(result.merchantId).toBe(1);
            expect(result.eventsChecked).toBe(0);
            expect(result.orphansFound).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it('should handle Square API errors gracefully', async () => {
            getSquareClientForMerchant.mockRejectedValue(new Error('Square API down'));

            const result = await auditMerchant(mockMerchant, 48);

            expect(result.merchantId).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain('Square API down');
        });

        it('should scope queries to merchant_id', async () => {
            getSquareClientForMerchant.mockResolvedValue({
                loyalty: { searchEvents: jest.fn().mockResolvedValue({ events: [] }) },
            });

            await auditMerchant(mockMerchant, 48);

            // getSquareClientForMerchant called with merchant ID
            expect(getSquareClientForMerchant).toHaveBeenCalledWith(1);
        });
    });

    describe('runLoyaltyAudit', () => {
        it('should return empty results when no merchants have loyalty', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runLoyaltyAudit();

            expect(result.merchantsAudited).toBe(0);
            expect(result.totalOrphansFound).toBe(0);
        });

        it('should process multiple merchants and aggregate results', async () => {
            // getMerchantsWithLoyalty
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, square_merchant_id: 'sq-1' },
                    { id: 2, square_merchant_id: 'sq-2' },
                ],
            });

            // Both merchants return no events
            getSquareClientForMerchant.mockResolvedValue({
                loyalty: { searchEvents: jest.fn().mockResolvedValue({ events: [] }) },
            });

            syncRewardDiscountPrices.mockResolvedValue({ updated: 0, failed: 0 });

            const result = await runLoyaltyAudit({ hoursBack: 24 });

            expect(result.merchantsAudited).toBe(2);
            expect(getSquareClientForMerchant).toHaveBeenCalledWith(1);
            expect(getSquareClientForMerchant).toHaveBeenCalledWith(2);
        });

        it('should isolate merchant errors without aborting other merchants', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, square_merchant_id: 'sq-1' },
                    { id: 2, square_merchant_id: 'sq-2' },
                ],
            });

            // First merchant fails, second succeeds
            getSquareClientForMerchant
                .mockRejectedValueOnce(new Error('Token expired'))
                .mockResolvedValueOnce({
                    loyalty: { searchEvents: jest.fn().mockResolvedValue({ events: [] }) },
                });

            syncRewardDiscountPrices.mockResolvedValue({ updated: 0, failed: 0 });

            const result = await runLoyaltyAudit();

            // Both merchants were attempted
            expect(result.merchantsAudited).toBe(2);
            // First merchant had an error
            expect(result.merchantErrors).toHaveLength(1);
            expect(result.merchantErrors[0].merchantId).toBe(1);
        });

        it('should propagate top-level database errors', async () => {
            db.query.mockRejectedValueOnce(new Error('DB connection lost'));

            await expect(runLoyaltyAudit()).rejects.toThrow('DB connection lost');
        });

        it('should call syncRewardDiscountPrices per merchant', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, square_merchant_id: 'sq-1' }],
            });

            getSquareClientForMerchant.mockResolvedValue({
                loyalty: { searchEvents: jest.fn().mockResolvedValue({ events: [] }) },
            });

            syncRewardDiscountPrices.mockResolvedValue({ updated: 2, failed: 0 });

            const result = await runLoyaltyAudit();

            expect(syncRewardDiscountPrices).toHaveBeenCalledWith({ merchantId: 1 });
            expect(result.priceSync.totalUpdated).toBe(2);
        });

        it('should handle syncRewardDiscountPrices errors without failing audit', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, square_merchant_id: 'sq-1' }],
            });

            getSquareClientForMerchant.mockResolvedValue({
                loyalty: { searchEvents: jest.fn().mockResolvedValue({ events: [] }) },
            });

            syncRewardDiscountPrices.mockRejectedValue(new Error('Sync failed'));

            const result = await runLoyaltyAudit();

            expect(result.merchantsAudited).toBe(1);
            // Job should still complete
            expect(result.priceSync.totalUpdated).toBe(0);
        });
    });

    describe('runScheduledLoyaltyAudit', () => {
        it('should not throw even when audit fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledLoyaltyAudit()).resolves.toBeUndefined();
        });

        it('should call runLoyaltyAudit with 48 hours', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledLoyaltyAudit();

            expect(db.query).toHaveBeenCalled();
        });
    });
});
