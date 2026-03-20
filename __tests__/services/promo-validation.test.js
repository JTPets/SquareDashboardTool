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

    it('should scope query to merchant_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await validatePromoCode({ code: 'TEST', merchantId: 42 });

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('merchant_id = $2'),
            ['TEST', 42]
        );
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
});
