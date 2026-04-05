/**
 * Tests for jobs/promo-expiry-job.js
 *
 * Verifies that the weekly promo expiry check correctly identifies
 * subscribers with elapsed promotional pricing and logs warnings.
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const {
    runPromoExpiryCheck,
    runScheduledPromoExpiryCheck,
    getExpiredPromoSubscribers
} = require('../../jobs/promo-expiry-job');

beforeEach(() => jest.clearAllMocks());

describe('getExpiredPromoSubscribers', () => {
    it('queries for active subscribers with promo_expires_at in the past', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getExpiredPromoSubscribers();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('promo_expires_at < NOW()');
        expect(sql).toContain("subscription_status = 'active'");
        expect(sql).toContain('promo_expires_at IS NOT NULL');
    });

    it('returns rows from the database', async () => {
        const mockRows = [
            { id: 1, email: 'a@test.com', promo_expires_at: new Date('2026-01-01'), subscription_plan: 'monthly', merchant_id: 5 }
        ];
        db.query.mockResolvedValueOnce({ rows: mockRows });

        const result = await getExpiredPromoSubscribers();

        expect(result).toEqual(mockRows);
    });
});

describe('runPromoExpiryCheck', () => {
    it('returns { flagged: 0 } and logs info when no expired promos found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runPromoExpiryCheck();

        expect(result).toEqual({ flagged: 0 });
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('no expired promos found')
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs a warning for each expired subscriber', async () => {
        const expiredSubs = [
            { id: 3, email: 'x@test.com', merchant_id: 10, promo_expires_at: new Date('2026-01-15'), subscription_plan: 'monthly' },
            { id: 4, email: 'y@test.com', merchant_id: 11, promo_expires_at: new Date('2026-02-01'), subscription_plan: 'annual' }
        ];
        db.query.mockResolvedValueOnce({ rows: expiredSubs });

        const result = await runPromoExpiryCheck();

        expect(result).toEqual({ flagged: 2 });
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('manual review required'),
            expect.objectContaining({ subscriberId: 3, merchantId: 10 })
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('manual review required'),
            expect.objectContaining({ subscriberId: 4, merchantId: 11 })
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('2 subscriber(s) flagged')
        );
    });
});

describe('runScheduledPromoExpiryCheck', () => {
    it('returns { flagged: 0 } and logs error on DB failure without throwing', async () => {
        db.query.mockRejectedValueOnce(new Error('Connection lost'));

        const result = await runScheduledPromoExpiryCheck();

        expect(result).toEqual({ flagged: 0 });
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Promo expiry job failed'),
            expect.any(Object)
        );
    });

    it('delegates to runPromoExpiryCheck on success', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runScheduledPromoExpiryCheck();

        expect(result).toEqual({ flagged: 0 });
    });
});
