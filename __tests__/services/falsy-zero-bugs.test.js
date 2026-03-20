/**
 * Falsy-zero bug fixes tests
 *
 * Verifies that numeric fields where 0 is a valid value use nullish coalescing (??)
 * instead of logical OR (||), which incorrectly coerces 0 to null.
 *
 * Also verifies that discount-service.js UPDATE queries include merchant_id filters.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../utils/square-catalog-cleanup', () => ({
    deleteCatalogObjects: jest.fn(),
}));

jest.mock('../../services/square', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    getSquareClientForMerchant: jest.fn(),
}));

jest.mock('../../services/square/square-client', () => ({
    getMerchantToken: jest.fn().mockResolvedValue('test-token'),
    makeSquareRequest: jest.fn(),
    sleep: jest.fn(),
}));

jest.mock('../../services/square/square-vendors', () => ({
    ensureVendorsExist: jest.fn(),
}));

jest.mock('../../config/constants', () => ({
    SQUARE: { MAX_PAGINATION_ITERATIONS: 10 },
    SYNC: { BATCH_DELAY_MS: 0 },
}));

const db = require('../../utils/database');

describe('Falsy-zero bug fixes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== GROUP 1: || vs ?? on numeric fields ====================

    describe('discount-service.js — daysUntilExpiry ?? null', () => {
        test('stores daysUntilExpiry=0 as 0, not null (expires today)', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const { logAuditEvent } = require('../../services/expiry/discount-service');
            await logAuditEvent({
                merchantId: 1,
                variationId: 'VAR_1',
                action: 'TIER_ASSIGNED',
                daysUntilExpiry: 0,
                triggeredBy: 'SYSTEM'
            });

            const call = db.query.mock.calls[0];
            const params = call[1];
            // daysUntilExpiry is param index 7 (8th param, 0-indexed)
            expect(params[7]).toBe(0);
            expect(params[7]).not.toBeNull();
        });

        test('stores daysUntilExpiry=undefined as null', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const { logAuditEvent } = require('../../services/expiry/discount-service');
            await logAuditEvent({
                merchantId: 1,
                variationId: 'VAR_1',
                action: 'TIER_ASSIGNED',
                triggeredBy: 'SYSTEM'
            });

            const call = db.query.mock.calls[0];
            const params = call[1];
            expect(params[7]).toBeNull();
        });

        test('stores oldPriceCents=0 as 0, not null', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const { logAuditEvent } = require('../../services/expiry/discount-service');
            await logAuditEvent({
                merchantId: 1,
                variationId: 'VAR_1',
                action: 'DISCOUNT_APPLIED',
                oldPriceCents: 0,
                newPriceCents: 500,
                triggeredBy: 'SYSTEM'
            });

            const call = db.query.mock.calls[0];
            const params = call[1];
            // oldPriceCents is param index 5, newPriceCents is 6
            expect(params[5]).toBe(0);
            expect(params[5]).not.toBeNull();
        });
    });

    describe('square-catalog-sync.js — price_money.amount ?? null', () => {
        test('uses ?? null for price_money.amount, not || null', () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/square/square-catalog-sync'),
                'utf8'
            );

            // Verify price_money?.amount uses ?? null
            expect(source).toContain('price_money?.amount ?? null');
            expect(source).not.toContain('price_money?.amount || null');
        });
    });

    describe('square-catalog-sync.js — inventory_alert_threshold ?? null', () => {
        test('uses ?? null for inventory_alert_threshold, not || null', () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/square/square-catalog-sync'),
                'utf8'
            );

            // Verify all inventory_alert_threshold uses ?? null
            expect(source).toContain('inventory_alert_threshold ?? null');
            expect(source).not.toContain('inventory_alert_threshold || null');
        });
    });

    describe('square-vendors.js — unit_cost_money.amount ?? null', () => {
        test('uses ?? null for unit_cost_money.amount, not || null', () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/square/square-vendors'),
                'utf8'
            );

            expect(source).toContain('unit_cost_money?.amount ?? null');
            expect(source).not.toContain('unit_cost_money?.amount || null');
        });
    });

    // ==================== GROUP 2: Missing merchant_id on UPDATEs ====================

    describe('discount-service.js — merchant_id on UPDATE queries', () => {
        test('evaluateAllVariations days_until_expiry UPDATE includes merchant_id', () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/expiry/discount-service'),
                'utf8'
            );

            // The days_until_expiry UPDATE must include merchant_id filter
            const daysUpdatePattern = /UPDATE variation_discount_status\s+SET days_until_expiry = \$1, last_evaluated_at = NOW\(\)\s+WHERE variation_id = \$2 AND merchant_id = \$3/;
            expect(source).toMatch(daysUpdatePattern);
        });

        test('applyDiscounts UPDATE includes merchant_id filter', () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/expiry/discount-service'),
                'utf8'
            );

            // Check the discounted_price_cents UPDATE has merchant_id
            const discountUpdatePattern = /UPDATE variation_discount_status\s+SET discounted_price_cents.*?WHERE variation_id = \$2 AND merchant_id = \$3/s;
            expect(source).toMatch(discountUpdatePattern);
        });

        test('removeDiscounts UPDATE includes merchant_id filter', () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/expiry/discount-service'),
                'utf8'
            );

            // Check the discount removal UPDATE has merchant_id
            const removeUpdatePattern = /UPDATE variation_discount_status\s+SET discounted_price_cents = NULL.*?WHERE variation_id = \$1 AND merchant_id = \$2/s;
            expect(source).toMatch(removeUpdatePattern);
        });
    });

    // ==================== Additional codebase-wide fixes ====================

    describe('bundle-service.js — cost/price ?? null', () => {
        test('stores individual_cost_cents=0 as 0, not null', async () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/bundle-service'),
                'utf8'
            );

            // Verify the fix: individual_cost_cents uses ?? null
            expect(source).toContain('individual_cost_cents ?? null');
            expect(source).not.toContain('individual_cost_cents || null');
        });

        test('stores bundle_sell_price_cents=0 as 0, not null', async () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/bundle-service'),
                'utf8'
            );

            expect(source).toContain('bundle_sell_price_cents ?? null');
            expect(source).not.toContain('bundle_sell_price_cents || null');
        });
    });

    describe('cart-activity-service.js — shippingCharge.amount ?? null', () => {
        test('stores shippingCharge.amount=0 as 0, not null (free shipping)', async () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/cart/cart-activity-service'),
                'utf8'
            );

            expect(source).toContain('shippingCharge?.amount ?? null');
            expect(source).not.toContain('shippingCharge?.amount || null');
        });
    });

    describe('loyalty-handler.js — discount amount ?? null', () => {
        test('stores discount amount=0 as 0, not null', async () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/webhook-handlers/loyalty-handler'),
                'utf8'
            );

            expect(source).toContain('applied_money?.amount ?? d.amount_money?.amount ?? null');
            expect(source).not.toContain('applied_money?.amount || d.amount_money?.amount || null');
        });
    });

    describe('purchase-service.js — totalPriceCents ?? null', () => {
        test('stores totalPriceCents=0 as 0, not null (fully discounted)', async () => {
            const fs = require('fs');
            const source = fs.readFileSync(
                require.resolve('../../services/loyalty-admin/purchase-service'),
                'utf8'
            );

            expect(source).toContain('totalPriceCents ?? null');
            expect(source).not.toContain('totalPriceCents || null');
        });
    });
});
