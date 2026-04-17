/**
 * Tests for jobs/promo-expiry-job.js
 *
 * Verifies that the weekly promo expiry check correctly identifies
 * subscribers with elapsed promotional pricing, reverts billing to
 * base plan price, and supports dry-run mode.
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(undefined),
    sendCritical: jest.fn().mockResolvedValue(undefined),
    enabled: false
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const emailNotifier = require('../../utils/email-notifier');
const {
    runPromoExpiryCheck,
    runScheduledPromoExpiryCheck,
    getExpiredPromoSubscribers,
    getBasePlanPrice,
    revertSubscriberPromo
} = require('../../jobs/promo-expiry-job');

beforeEach(() => jest.clearAllMocks());

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSub(overrides = {}) {
    return {
        id: 1,
        email: 'a@test.com',
        business_name: 'Test Shop',
        promo_expires_at: new Date('2026-01-01'),
        subscription_plan: 'monthly',
        merchant_id: 5,
        promo_code_id: 10,
        discount_applied_cents: 900,
        price_cents: 99,
        ...overrides
    };
}

function mockTransaction() {
    db.transaction.mockImplementation(async (cb) => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        return cb(client);
    });
}

// ── getExpiredPromoSubscribers ───────────────────────────────────────────

describe('getExpiredPromoSubscribers', () => {
    it('queries for active subscribers with expired promo and promo_code_id set', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getExpiredPromoSubscribers();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('promo_expires_at < NOW()');
        expect(sql).toContain("subscription_status = 'active'");
        expect(sql).toContain('promo_expires_at IS NOT NULL');
        expect(sql).toContain('promo_code_id IS NOT NULL');
    });

    it('selects promo_code_id, discount_applied_cents, and price_cents', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await getExpiredPromoSubscribers();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('promo_code_id');
        expect(sql).toContain('discount_applied_cents');
        expect(sql).toContain('price_cents');
    });

    it('returns rows from the database', async () => {
        const mockRows = [makeSub()];
        db.query.mockResolvedValueOnce({ rows: mockRows });

        const result = await getExpiredPromoSubscribers();

        expect(result).toEqual(mockRows);
    });
});

// ── getBasePlanPrice ────────────────────────────────────────────────────

describe('getBasePlanPrice', () => {
    it('returns price_cents from subscription_plans', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });

        const price = await getBasePlanPrice('monthly', 5);

        expect(price).toBe(2999);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('subscription_plans'),
            ['monthly', 5]
        );
    });

    it('returns null when plan not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const price = await getBasePlanPrice('monthly', 999);

        expect(price).toBeNull();
    });
});

// ── revertSubscriberPromo ───────────────────────────────────────────────

describe('revertSubscriberPromo', () => {
    it('reverts subscriber to base price in a transaction', async () => {
        const sub = makeSub();
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        mockTransaction();

        const result = await revertSubscriberPromo(sub);

        expect(result).toEqual({ reverted: true, basePriceCents: 2999, previousPriceCents: 99 });
        expect(db.transaction).toHaveBeenCalledTimes(1);

        // Verify transaction callback runs UPDATE and INSERT
        const txCallback = db.transaction.mock.calls[0][0];
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await txCallback(client);

        // UPDATE subscribers
        const updateSql = client.query.mock.calls[0][0];
        expect(updateSql).toContain('promo_code_id = NULL');
        expect(updateSql).toContain('discount_applied_cents = 0');
        expect(updateSql).toContain('price_cents = $1');
        expect(client.query.mock.calls[0][1]).toEqual([2999, 1, 5]);

        // INSERT subscription_events
        const eventSql = client.query.mock.calls[1][0];
        expect(eventSql).toContain('subscription_events');
        const eventParams = client.query.mock.calls[1][1];
        expect(eventParams[2]).toBe('promo.expired_revert');
    });

    it('returns { reverted: false } when base plan not found', async () => {
        const sub = makeSub();
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await revertSubscriberPromo(sub);

        expect(result).toEqual({ reverted: false });
        expect(db.transaction).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('base plan price not found'),
            expect.objectContaining({ subscriberId: 1 })
        );
        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            'Promo Revert Failed — manual review required',
            expect.stringContaining('1')
        );
    });

    it('includes merchant_id in subscriber UPDATE for tenant isolation', async () => {
        const sub = makeSub({ merchant_id: 42 });
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        mockTransaction();

        await revertSubscriberPromo(sub);

        const txCallback = db.transaction.mock.calls[0][0];
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await txCallback(client);

        expect(client.query.mock.calls[0][0]).toContain('merchant_id = $3');
        expect(client.query.mock.calls[0][1][2]).toBe(42);
    });
});

// ── runPromoExpiryCheck ─────────────────────────────────────────────────

describe('runPromoExpiryCheck', () => {
    it('returns zeros and logs info when no expired promos found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runPromoExpiryCheck();

        expect(result).toEqual({ flagged: 0, reverted: 0, errors: 0, details: [] });
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('no expired promos found')
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('reverts expired subscribers and returns counts', async () => {
        const subs = [makeSub({ id: 3, merchant_id: 10 }), makeSub({ id: 4, merchant_id: 11 })];
        db.query.mockResolvedValueOnce({ rows: subs });
        // Two getBasePlanPrice lookups
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        mockTransaction();

        const result = await runPromoExpiryCheck();

        expect(result.flagged).toBe(2);
        expect(result.reverted).toBe(2);
        expect(result.errors).toBe(0);
        expect(result.details).toHaveLength(2);
        expect(result.details[0]).toEqual(expect.objectContaining({
            subscriberId: 3, action: 'reverted'
        }));
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('reverted to base price'),
            expect.objectContaining({ subscriberId: 3 })
        );
    });

    it('counts errors when revert fails for a subscriber', async () => {
        const sub = makeSub({ id: 7, merchant_id: 20 });
        db.query.mockResolvedValueOnce({ rows: [sub] });
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        db.transaction.mockRejectedValueOnce(new Error('DB write failed'));

        const result = await runPromoExpiryCheck();

        expect(result.flagged).toBe(1);
        expect(result.reverted).toBe(0);
        expect(result.errors).toBe(1);
        expect(result.details[0]).toEqual(expect.objectContaining({
            subscriberId: 7, action: 'error'
        }));
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to revert'),
            expect.objectContaining({ subscriberId: 7 })
        );
    });

    it('counts skipped_no_plan when base plan not found', async () => {
        const sub = makeSub({ id: 8, merchant_id: 30, subscription_plan: 'unknown' });
        db.query.mockResolvedValueOnce({ rows: [sub] });
        db.query.mockResolvedValueOnce({ rows: [] }); // no plan found

        const result = await runPromoExpiryCheck();

        expect(result.flagged).toBe(1);
        expect(result.reverted).toBe(0);
        expect(result.errors).toBe(1);
        expect(result.details[0]).toEqual(expect.objectContaining({
            subscriberId: 8, action: 'skipped_no_plan'
        }));
    });
});

// ── Dry-run mode ────────────────────────────────────────────────────────

describe('runPromoExpiryCheck (dry run)', () => {
    it('logs warnings but does not revert when dryRun is true', async () => {
        const subs = [makeSub({ id: 5 }), makeSub({ id: 6 })];
        db.query.mockResolvedValueOnce({ rows: subs });

        const result = await runPromoExpiryCheck({ dryRun: true });

        expect(result.flagged).toBe(2);
        expect(result.reverted).toBe(0);
        expect(result.errors).toBe(0);
        expect(result.details).toEqual([
            { subscriberId: 5, action: 'would_revert' },
            { subscriberId: 6, action: 'would_revert' }
        ]);
        // Should NOT call transaction or price lookup
        expect(db.transaction).not.toHaveBeenCalled();
        // Only the initial getExpiredPromoSubscribers query
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('includes [DRY RUN] prefix in log messages', async () => {
        db.query.mockResolvedValueOnce({ rows: [makeSub()] });

        await runPromoExpiryCheck({ dryRun: true });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('[DRY RUN]'),
            expect.objectContaining({ dryRun: true })
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('[DRY RUN]'),
            expect.objectContaining({ dryRun: true })
        );
    });
});

// ── Email notifications — Fix 1 ─────────────────────────────────────────

describe('runPromoExpiryCheck email notifications', () => {
    it('sends report email when subscribers are reverted', async () => {
        const sub = makeSub({ id: 10, business_name: 'Pet Palace', price_cents: 500 });
        db.query.mockResolvedValueOnce({ rows: [sub] });
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        mockTransaction();

        await runPromoExpiryCheck();

        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            expect.stringContaining('Promo Expiry Report — 1 subscriber(s) reverted to base pricing'),
            expect.stringContaining('REVERTED (1)')
        );
    });

    it('includes business name and formatted prices in report body', async () => {
        const sub = makeSub({ id: 11, business_name: 'Happy Paws', price_cents: 999, promo_expires_at: new Date('2026-01-15') });
        db.query.mockResolvedValueOnce({ rows: [sub] });
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] });
        mockTransaction();

        await runPromoExpiryCheck();

        const [, body] = emailNotifier.sendAlert.mock.calls[0];
        expect(body).toContain('Happy Paws');
        expect(body).toContain('$9.99');
        expect(body).toContain('$29.99');
    });

    it('includes error info in same report email when reverted > 0 and errors > 0', async () => {
        const goodSub = makeSub({ id: 20, business_name: 'Good Shop', price_cents: 500 });
        const badSub = makeSub({ id: 21, subscription_plan: 'unknown', merchant_id: 99 });
        db.query.mockResolvedValueOnce({ rows: [goodSub, badSub] });
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 2999 }] }); // good sub plan lookup
        mockTransaction();
        db.query.mockResolvedValueOnce({ rows: [] }); // bad sub plan lookup — not found

        await runPromoExpiryCheck();

        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            expect.stringContaining('1 subscriber(s) reverted'),
            expect.stringContaining('ERRORS (1)')
        );
        const [, body] = emailNotifier.sendAlert.mock.calls[emailNotifier.sendAlert.mock.calls.length - 1];
        expect(body).toContain('21');
    });

    it('sends error-only alert when reverted = 0 and errors > 0', async () => {
        const sub = makeSub({ id: 30, subscription_plan: 'unknown' });
        db.query.mockResolvedValueOnce({ rows: [sub] });
        db.query.mockResolvedValueOnce({ rows: [] }); // plan not found

        await runPromoExpiryCheck();

        const reportCall = emailNotifier.sendAlert.mock.calls.find(
            ([subject]) => subject.includes('Promo Expiry Report')
        );
        expect(reportCall).toBeDefined();
        expect(reportCall[0]).toContain('revert error(s)');
        expect(reportCall[1]).toContain('30');
    });

    it('does not send report email when no expired promos', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await runPromoExpiryCheck();

        expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
    });

    it('does not send email in dry-run mode', async () => {
        db.query.mockResolvedValueOnce({ rows: [makeSub({ id: 40 })] });

        await runPromoExpiryCheck({ dryRun: true });

        expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
    });
});

// ── Email notification — Fix 2 (revertSubscriberPromo missing plan) ─────

describe('revertSubscriberPromo email on missing plan', () => {
    it('sends manual review alert with subscriber ID in body', async () => {
        const sub = makeSub({ id: 50, business_name: 'Mystery Store', merchant_id: 7, subscription_plan: 'enterprise' });
        db.query.mockResolvedValueOnce({ rows: [] });

        await revertSubscriberPromo(sub);

        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            'Promo Revert Failed — manual review required',
            expect.stringContaining('50')
        );
        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            'Promo Revert Failed — manual review required',
            expect.stringContaining('Mystery Store')
        );
    });
});

// ── runScheduledPromoExpiryCheck ────────────────────────────────────────

describe('runScheduledPromoExpiryCheck', () => {
    it('returns defaults and logs error on DB failure without throwing', async () => {
        db.query.mockRejectedValueOnce(new Error('Connection lost'));

        const result = await runScheduledPromoExpiryCheck();

        expect(result).toEqual({ flagged: 0, reverted: 0, errors: 0, details: [] });
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Promo expiry job failed'),
            expect.any(Object)
        );
    });

    it('delegates to runPromoExpiryCheck on success', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runScheduledPromoExpiryCheck();

        expect(result).toEqual({ flagged: 0, reverted: 0, errors: 0, details: [] });
    });
});
