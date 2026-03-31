/**
 * Tests for services/promo-validation.js
 *
 * Shared promo code validation extracted from routes/subscriptions.js (BACKLOG-74).
 * Covers: valid code, invalid code, expired code, wrong merchant, wrong plan,
 * minimum purchase, discount types (percent/fixed), discount cap.
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn()
}));

const db = require('../../utils/database');
const { validatePromoCode } = require('../../services/promo-validation');

describe('validatePromoCode', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should return invalid when code is missing', async () => {
        const result = await validatePromoCode({ merchantId: 1 });

        expect(result.valid).toBe(false);
        expect(result.error).toBe('Code and merchant are required');
    });

    it('should return invalid when merchantId is missing', async () => {
        const result = await validatePromoCode({ code: 'TEST' });

        expect(result.valid).toBe(false);
        expect(result.error).toBe('Code and merchant are required');
    });

    it('should return invalid when promo code not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await validatePromoCode({ code: 'INVALID', merchantId: 1 });

        expect(result.valid).toBe(false);
        expect(result.error).toBe('Invalid or expired promo code');
    });

    it('should validate a valid percent promo code', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 1, code: 'SAVE20', discount_type: 'percent',
                discount_value: 20, applies_to_plans: null,
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'SAVE20', merchantId: 1, plan: 'monthly', priceCents: 5000
        });

        expect(result.valid).toBe(true);
        expect(result.discount).toBe(1000); // 20% of 5000
        expect(result.finalPrice).toBe(4000);
        expect(result.promo.code).toBe('SAVE20');
    });

    it('should validate a valid fixed-amount promo code', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 2, code: 'FLAT10', discount_type: 'fixed',
                discount_value: 1000, applies_to_plans: null,
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'FLAT10', merchantId: 1, priceCents: 5000
        });

        expect(result.valid).toBe(true);
        expect(result.discount).toBe(1000);
        expect(result.finalPrice).toBe(4000);
    });

    it('should reject code that does not apply to selected plan', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 3, code: 'ANNUAL', discount_type: 'percent',
                discount_value: 10, applies_to_plans: ['annual'],
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'ANNUAL', merchantId: 1, plan: 'monthly', priceCents: 5000
        });

        expect(result.valid).toBe(false);
        expect(result.error).toBe('This code does not apply to the selected plan');
    });

    it('should accept code when plan matches applies_to_plans', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 3, code: 'ANNUAL', discount_type: 'percent',
                discount_value: 10, applies_to_plans: ['annual'],
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'ANNUAL', merchantId: 1, plan: 'annual', priceCents: 10000
        });

        expect(result.valid).toBe(true);
        expect(result.discount).toBe(1000);
    });

    it('should reject when price is below minimum purchase', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 4, code: 'MIN50', discount_type: 'fixed',
                discount_value: 500, applies_to_plans: null,
                min_purchase_cents: 5000
            }]
        });

        const result = await validatePromoCode({
            code: 'MIN50', merchantId: 1, priceCents: 3000
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Minimum purchase');
    });

    it('should cap discount at price (100% off scenario)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 5, code: 'BIGOFF', discount_type: 'fixed',
                discount_value: 99999, applies_to_plans: null,
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'BIGOFF', merchantId: 1, priceCents: 5000
        });

        expect(result.valid).toBe(true);
        expect(result.discount).toBe(5000); // capped at price
        expect(result.finalPrice).toBe(0);
    });

    it('should scope query to merchant_id with platform_owner fallback', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await validatePromoCode({ code: 'TEST', merchantId: 42 });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/merchant_id = \$2/);
        expect(sql).toMatch(/platform_owner/);
        expect(params).toEqual(['TEST', 42]);
    });

    it('should handle percent discount with no priceCents (defaults to 0)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 6, code: 'FREE', discount_type: 'percent',
                discount_value: 100, applies_to_plans: null,
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'FREE', merchantId: 1
        });

        expect(result.valid).toBe(true);
        expect(result.discount).toBe(0);
        expect(result.finalPrice).toBe(0);
    });

    it('should skip plan check when applies_to_plans is empty array', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 7, code: 'ALL', discount_type: 'fixed',
                discount_value: 500, applies_to_plans: [],
                min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'ALL', merchantId: 1, plan: 'monthly', priceCents: 5000
        });

        expect(result.valid).toBe(true);
    });

    it('should apply fixed_price discount type (flat rate replaces price)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 8, code: 'BETA99', discount_type: 'fixed_price',
                discount_value: 0, fixed_price_cents: 99,
                applies_to_plans: null, min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'BETA99', merchantId: 1, priceCents: 5999
        });

        expect(result.valid).toBe(true);
        expect(result.finalPrice).toBe(99);
        expect(result.discount).toBe(5900); // 5999 - 99
    });

    it('should set finalPrice to fixed_price_cents even when priceCents not provided', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 9, code: 'BETA99', discount_type: 'fixed_price',
                discount_value: 0, fixed_price_cents: 99,
                applies_to_plans: null, min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'BETA99', merchantId: 1
        });

        expect(result.valid).toBe(true);
        expect(result.finalPrice).toBe(99);
        expect(result.discount).toBe(0); // max(0, 0 - 99) clamped to 0
    });

    it('should not let fixed_price discount go negative when flat rate > price', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 10, code: 'CHEAP', discount_type: 'fixed_price',
                discount_value: 0, fixed_price_cents: 9999,
                applies_to_plans: null, min_purchase_cents: null
            }]
        });

        const result = await validatePromoCode({
            code: 'CHEAP', merchantId: 1, priceCents: 999
        });

        expect(result.valid).toBe(true);
        expect(result.discount).toBe(0); // max(0, 999 - 9999) = 0
        expect(result.finalPrice).toBe(9999);
    });
});
