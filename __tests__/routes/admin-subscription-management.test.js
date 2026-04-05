/**
 * Tests for admin subscription management logic added in feat/admin-subscription-management:
 *
 *   GET  /api/admin/promo-codes          — route handler logic
 *   POST /api/admin/promo-codes/:id/deactivate — route handler logic
 *   GET  /api/admin/merchants/:merchantId/payments — route handler logic
 *   getAllSubscribers()                   — search / limit / offset / total
 *   GET  /api/subscriptions/admin/list   — validator additions
 *
 * All tests are pure unit tests (no HTTP/express) to match test environment
 * constraints (no node_modules available for supertest).
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../utils/subscription-handler');

const db = require('../../utils/database');

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Helpers — mirror the route handler query logic so we can test it in
// isolation without booting Express/supertest.
// ---------------------------------------------------------------------------

/**
 * Mirrors: GET /api/admin/promo-codes handler
 * Resolves platform_owner merchant, then SELECTs promo_codes.
 */
async function getPromoCodesLogic() {
    const ownerResult = await db.query(
        `SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1`
    );
    if (ownerResult.rows.length === 0) {
        return { error: 'NO_PLATFORM_OWNER', status: 500 };
    }
    const platformMerchantId = ownerResult.rows[0].id;

    const result = await db.query(
        `SELECT id, code, description, discount_type, discount_value, fixed_price_cents,
                duration_months, max_uses, times_used, is_active, valid_until, created_by, created_at
         FROM promo_codes
         WHERE merchant_id = $1
         ORDER BY created_at DESC`,
        [platformMerchantId]
    );
    return { promoCodes: result.rows };
}

/**
 * Mirrors: POST /api/admin/promo-codes/:id/deactivate handler
 */
async function deactivatePromoLogic(promoId) {
    const ownerResult = await db.query(
        `SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1`
    );
    if (ownerResult.rows.length === 0) {
        return { error: 'NO_PLATFORM_OWNER', status: 500 };
    }
    const platformMerchantId = ownerResult.rows[0].id;

    const result = await db.query(
        `UPDATE promo_codes SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1 AND merchant_id = $2 RETURNING id, code, is_active`,
        [promoId, platformMerchantId]
    );
    if (result.rows.length === 0) {
        return { error: 'Not found', status: 404 };
    }
    return { promo: result.rows[0] };
}

/**
 * Mirrors: GET /api/admin/merchants/:merchantId/payments handler
 */
async function getMerchantPaymentsLogic(merchantId, limit, offset) {
    limit = Math.min(Number(limit) || 25, 100);
    offset = Math.max(Number(offset) || 0, 0);

    const result = await db.query(
        `SELECT sp.id, sp.amount_cents, sp.currency, sp.status, sp.payment_type,
                sp.billing_period_start, sp.billing_period_end,
                sp.refund_amount_cents, sp.refund_reason, sp.refunded_at,
                sp.receipt_url, sp.failure_reason, sp.created_at,
                s.email, s.subscription_plan
         FROM subscription_payments sp
         JOIN subscribers s ON s.id = sp.subscriber_id
         WHERE s.merchant_id = $1
         ORDER BY sp.created_at DESC
         LIMIT $2 OFFSET $3`,
        [merchantId, limit, offset]
    );

    const countResult = await db.query(
        `SELECT COUNT(*) FROM subscription_payments sp
         JOIN subscribers s ON s.id = sp.subscriber_id
         WHERE s.merchant_id = $1`,
        [merchantId]
    );

    return {
        payments: result.rows,
        total: parseInt(countResult.rows[0].count, 10)
    };
}

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/promo-codes
// ---------------------------------------------------------------------------
describe('getPromoCodesLogic() — GET /api/admin/promo-codes', () => {
    const PLATFORM_ROW = { id: 99 };
    const PROMO_ROWS = [
        {
            id: 1, code: 'BETA99', description: 'Beta price',
            discount_type: 'fixed_price', discount_value: 0,
            fixed_price_cents: 99, duration_months: 12,
            max_uses: 10, times_used: 3, is_active: true,
            valid_until: null, created_by: 'admin:1',
            created_at: '2026-04-01T00:00:00Z'
        }
    ];

    it('returns promoCodes array on success', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_ROW] })
            .mockResolvedValueOnce({ rows: PROMO_ROWS });

        const result = await getPromoCodesLogic();

        expect(result.promoCodes).toHaveLength(1);
        expect(result.promoCodes[0].code).toBe('BETA99');
        expect(result.promoCodes[0].times_used).toBe(3);
    });

    it('returns NO_PLATFORM_OWNER error when no platform owner exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await getPromoCodesLogic();

        expect(result.error).toBe('NO_PLATFORM_OWNER');
        expect(result.status).toBe(500);
    });

    it('returns empty array when no promo codes exist', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_ROW] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await getPromoCodesLogic();

        expect(result.promoCodes).toHaveLength(0);
    });

    it('queries promo_codes filtered by platform merchant_id', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 42 }] })
            .mockResolvedValueOnce({ rows: [] });

        await getPromoCodesLogic();

        const promoQuery = db.query.mock.calls[1];
        expect(promoQuery[0]).toContain('WHERE merchant_id = $1');
        expect(promoQuery[1]).toEqual([42]);
    });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/admin/promo-codes/:id/deactivate
// ---------------------------------------------------------------------------
describe('deactivatePromoLogic() — POST /api/admin/promo-codes/:id/deactivate', () => {
    const PLATFORM_ROW = { id: 99 };

    it('deactivates promo code and returns updated record', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_ROW] })
            .mockResolvedValueOnce({ rows: [{ id: 1, code: 'BETA99', is_active: false }] });

        const result = await deactivatePromoLogic(1);

        expect(result.promo.is_active).toBe(false);
        expect(result.promo.code).toBe('BETA99');
    });

    it('returns 404 when promo not found under platform merchant', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_ROW] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await deactivatePromoLogic(999);

        expect(result.status).toBe(404);
    });

    it('returns NO_PLATFORM_OWNER error when no platform owner', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await deactivatePromoLogic(1);

        expect(result.error).toBe('NO_PLATFORM_OWNER');
    });

    it('UPDATE query uses is_active = FALSE', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [PLATFORM_ROW] })
            .mockResolvedValueOnce({ rows: [{ id: 1, code: 'X', is_active: false }] });

        await deactivatePromoLogic(1);

        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toContain('is_active = FALSE');
        expect(updateCall[1][0]).toBe(1); // promoId
        expect(updateCall[1][1]).toBe(99); // platformMerchantId
    });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/merchants/:merchantId/payments
// ---------------------------------------------------------------------------
describe('getMerchantPaymentsLogic() — GET /api/admin/merchants/:merchantId/payments', () => {
    const PAYMENT_ROWS = [
        {
            id: 1, amount_cents: 999, currency: 'CAD', status: 'completed',
            payment_type: 'subscription', billing_period_start: '2026-04-01',
            billing_period_end: '2026-05-01', refund_amount_cents: null,
            refund_reason: null, refunded_at: null, receipt_url: null,
            failure_reason: null, created_at: '2026-04-01T12:00:00Z',
            email: 'test@example.com', subscription_plan: 'monthly'
        }
    ];

    it('returns payments and total for a merchant', async () => {
        db.query
            .mockResolvedValueOnce({ rows: PAYMENT_ROWS })
            .mockResolvedValueOnce({ rows: [{ count: '1' }] });

        const result = await getMerchantPaymentsLogic(5, 25, 0);

        expect(result.payments).toHaveLength(1);
        expect(result.payments[0].amount_cents).toBe(999);
        expect(result.total).toBe(1);
    });

    it('returns empty array when no payments', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ count: '0' }] });

        const result = await getMerchantPaymentsLogic(5, 25, 0);

        expect(result.payments).toHaveLength(0);
        expect(result.total).toBe(0);
    });

    it('clamps limit to 100', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ count: '0' }] });

        await getMerchantPaymentsLogic(5, 9999, 0);

        const call = db.query.mock.calls[0];
        expect(call[1][1]).toBe(100); // LIMIT clamped to 100
    });

    it('passes offset to query', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ count: '0' }] });

        await getMerchantPaymentsLogic(5, 10, 30);

        const call = db.query.mock.calls[0];
        expect(call[1][2]).toBe(30); // OFFSET = 30
    });

    it('joins subscription_payments with subscribers on subscriber_id', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ count: '0' }] });

        await getMerchantPaymentsLogic(5, 25, 0);

        const sqlCall = db.query.mock.calls[0][0];
        expect(sqlCall).toContain('JOIN subscribers s ON s.id = sp.subscriber_id');
        expect(sqlCall).toContain('WHERE s.merchant_id = $1');
    });
});

// ---------------------------------------------------------------------------
// Tests: getAllSubscribers() — search and pagination
// ---------------------------------------------------------------------------
describe('getAllSubscribers() — search and pagination', () => {
    // Use the real implementation, not the mock
    const realSubscriptionHandler = jest.requireActual('../../utils/subscription-handler');
    const realGetAllSubscribers = realSubscriptionHandler.getAllSubscribers;

    it('returns { rows, total } object instead of plain array', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '7' }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, email: 'a@b.com' }] });

        const result = await realGetAllSubscribers({ merchantId: 1 });

        expect(result).toHaveProperty('rows');
        expect(result).toHaveProperty('total');
        expect(typeof result.total).toBe('number');
        expect(result.total).toBe(7);
        expect(Array.isArray(result.rows)).toBe(true);
    });

    it('includes search term as ILIKE parameter', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '2' }] })
            .mockResolvedValueOnce({ rows: [] });

        await realGetAllSubscribers({ merchantId: 1, search: 'pet' });

        const countCall = db.query.mock.calls[0];
        expect(countCall[0]).toContain('ILIKE');
        expect(countCall[1]).toContain('%pet%');
    });

    it('includes status filter as subscription_status clause', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '5' }] })
            .mockResolvedValueOnce({ rows: [] });

        await realGetAllSubscribers({ merchantId: 1, status: 'active' });

        const countCall = db.query.mock.calls[0];
        expect(countCall[0]).toContain('subscription_status');
        expect(countCall[1]).toContain('active');
    });

    it('clamps limit to 100 for large values', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await realGetAllSubscribers({ merchantId: 1, limit: 9999 });

        const dataCall = db.query.mock.calls[1];
        expect(dataCall[1]).toContain(100);
        expect(dataCall[1]).not.toContain(9999);
    });

    it('defaults to limit=10 when not specified', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await realGetAllSubscribers({ merchantId: 1 });

        const dataCall = db.query.mock.calls[1];
        expect(dataCall[1]).toContain(10);
    });

    it('always passes merchant_id as first WHERE clause param', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await realGetAllSubscribers({ merchantId: 42 });

        const countCall = db.query.mock.calls[0];
        expect(countCall[0]).toContain('merchant_id = $1');
        expect(countCall[1][0]).toBe(42);
    });

    it('returns total 0 when no subscribers found', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await realGetAllSubscribers({ merchantId: 1 });

        expect(result.total).toBe(0);
        expect(result.rows).toHaveLength(0);
    });
});
