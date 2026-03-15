/**
 * Tests for services/loyalty-admin/line-item-filter.js
 *
 * Unit tests for the extracted line item qualification logic:
 * - shouldSkipLineItem: determines if a line item should be skipped
 * - buildDiscountMap: fetches loyalty discount IDs and builds discount map
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        debug: jest.fn(),
        audit: jest.fn(),
        error: jest.fn(),
    },
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const { shouldSkipLineItem, buildDiscountMap } = require('../../../services/loyalty-admin/line-item-filter');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeLineItem = (overrides = {}) => ({
    uid: 'li_default',
    catalog_object_id: 'VAR_1',
    quantity: '1',
    base_price_money: { amount: 1699n, currency: 'CAD' },
    gross_sales_money: { amount: 1699n, currency: 'CAD' },
    total_money: { amount: 1699n, currency: 'CAD' },
    total_discount_money: { amount: 0n, currency: 'CAD' },
    ...overrides,
});

// ---------------------------------------------------------------------------
// shouldSkipLineItem
// ---------------------------------------------------------------------------

describe('shouldSkipLineItem', () => {
    const emptyDiscountMap = new Map();
    const orderId = 'ORDER_TEST';
    const merchantId = 1;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('no catalog_object_id → SKIP_NO_VARIATION', () => {
        const item = makeLineItem({ catalog_object_id: undefined });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        expect(result.skip).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    test('zero quantity → SKIP_ZERO_QUANTITY', () => {
        const item = makeLineItem({ quantity: '0' });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        expect(result.skip).toBe(true);
    });

    test('negative quantity → SKIP_ZERO_QUANTITY', () => {
        const item = makeLineItem({ quantity: '-1' });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        expect(result.skip).toBe(true);
    });

    test('100% discounted (gross > 0, total = 0) → SKIP_FREE', () => {
        const item = makeLineItem({
            base_price_money: { amount: 2500n, currency: 'CAD' },
            gross_sales_money: { amount: 2500n, currency: 'CAD' },
            total_money: { amount: 0n, currency: 'CAD' },
            total_discount_money: { amount: 2500n, currency: 'CAD' },
        });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        expect(result.skip).toBe(true);
        expect(result.reason).toBe('fully_discounted_to_zero');
        expect(result.variationId).toBe('VAR_1');
        expect(result.quantity).toBe(1);
    });

    test('line item with our loyalty discount applied → SKIP_OUR_LOYALTY', () => {
        const discountMap = new Map();
        discountMap.set('DISC_UID_1', { isOurLoyaltyDiscount: true, amount: 500n });

        const item = makeLineItem({
            applied_discounts: [{ discount_uid: 'DISC_UID_1' }],
        });
        const result = shouldSkipLineItem(item, discountMap, orderId, merchantId);

        expect(result.skip).toBe(true);
        expect(result.reason).toBe('loyalty_reward_redemption');
        expect(result.variationId).toBe('VAR_1');
    });

    test('regular qualifying item → not skipped', () => {
        const item = makeLineItem({
            catalog_object_id: 'VAR_REGULAR',
            quantity: '2',
            base_price_money: { amount: 4999n, currency: 'CAD' },
            gross_sales_money: { amount: 9998n, currency: 'CAD' },
            total_money: { amount: 9998n, currency: 'CAD' },
        });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        expect(result.skip).toBe(false);
        expect(result.reason).toBeUndefined();
    });

    test('item with base_price_money = 0 (truly free catalog item) → NOT skipped', () => {
        // A truly free item has gross_sales = 0, so the "grossSalesCents > 0 && totalMoneyCents === 0"
        // check does NOT trigger — it's not "discounted to zero", it was never priced.
        const item = makeLineItem({
            catalog_object_id: 'VAR_FREE_SAMPLE',
            quantity: '1',
            base_price_money: { amount: 0n, currency: 'CAD' },
            gross_sales_money: { amount: 0n, currency: 'CAD' },
            total_money: { amount: 0n, currency: 'CAD' },
            total_discount_money: { amount: 0n, currency: 'CAD' },
        });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        // Not skipped because grossSalesCents is 0, so the free-item check doesn't trigger
        expect(result.skip).toBe(false);
    });

    test('BigInt money amounts (Square SDK v43+) → handled correctly', () => {
        const item = makeLineItem({
            catalog_object_id: 'VAR_BIG',
            quantity: '3',
            base_price_money: { amount: 12999n, currency: 'CAD' },
            gross_sales_money: { amount: 38997n, currency: 'CAD' },
            total_money: { amount: 38997n, currency: 'CAD' },
            total_discount_money: { amount: 0n, currency: 'CAD' },
        });
        const result = shouldSkipLineItem(item, emptyDiscountMap, orderId, merchantId);

        expect(result.skip).toBe(false);
    });

    test('discount map with non-loyalty discount → not skipped', () => {
        const discountMap = new Map();
        discountMap.set('DISC_UID_PROMO', { isOurLoyaltyDiscount: false, amount: 200n });

        const item = makeLineItem({
            applied_discounts: [{ discount_uid: 'DISC_UID_PROMO' }],
        });
        const result = shouldSkipLineItem(item, discountMap, orderId, merchantId);

        expect(result.skip).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// buildDiscountMap
// ---------------------------------------------------------------------------

describe('buildDiscountMap', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockReset();
    });

    test('order with no discounts → empty map', async () => {
        const order = { id: 'ORDER_1', discounts: [] };
        const result = await buildDiscountMap(order, 1);

        expect(result.lineItemDiscountMap.size).toBe(0);
        expect(result.orderUsedOurDiscount).toBe(false);
        // Should not query DB when there are no discounts
        expect(db.query).not.toHaveBeenCalled();
    });

    test('order with undefined discounts → empty map', async () => {
        const order = { id: 'ORDER_1' };
        const result = await buildDiscountMap(order, 1);

        expect(result.lineItemDiscountMap.size).toBe(0);
        expect(result.orderUsedOurDiscount).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('order with loyalty discount matching earned reward → map contains the discount', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { square_discount_id: 'SQ_DISC_123', square_pricing_rule_id: null },
            ],
        });

        const order = {
            id: 'ORDER_1',
            discounts: [
                {
                    uid: 'DISC_UID_1',
                    catalog_object_id: 'SQ_DISC_123',
                    applied_money: { amount: 1000n },
                },
            ],
        };

        const result = await buildDiscountMap(order, 1);

        expect(result.lineItemDiscountMap.size).toBe(1);
        const entry = result.lineItemDiscountMap.get('DISC_UID_1');
        expect(entry.isOurLoyaltyDiscount).toBe(true);
        expect(entry.amount).toBe(1000n);
        expect(result.orderUsedOurDiscount).toBe(true);
    });

    test('order with non-loyalty discount → map has entry but not marked as loyalty', async () => {
        // DB returns no loyalty discount IDs for this merchant
        db.query.mockResolvedValueOnce({ rows: [] });

        const order = {
            id: 'ORDER_1',
            discounts: [
                {
                    uid: 'DISC_UID_PROMO',
                    catalog_object_id: 'PROMO_DISC_456',
                    applied_money: { amount: 500n },
                },
            ],
        };

        const result = await buildDiscountMap(order, 1);

        expect(result.lineItemDiscountMap.size).toBe(1);
        const entry = result.lineItemDiscountMap.get('DISC_UID_PROMO');
        expect(entry.isOurLoyaltyDiscount).toBe(false);
        expect(result.orderUsedOurDiscount).toBe(false);
    });

    test('DB error → returns empty Set with warning logged', async () => {
        db.query.mockRejectedValueOnce(new Error('connection refused'));

        const order = {
            id: 'ORDER_1',
            discounts: [
                {
                    uid: 'DISC_UID_1',
                    catalog_object_id: 'SQ_DISC_123',
                    applied_money: { amount: 500n },
                },
            ],
        };

        const result = await buildDiscountMap(order, 1);

        // Should not throw — error is caught
        expect(result.lineItemDiscountMap.size).toBe(1);
        const entry = result.lineItemDiscountMap.get('DISC_UID_1');
        // Without DB data, discount is not recognized as loyalty
        expect(entry.isOurLoyaltyDiscount).toBe(false);
        expect(result.orderUsedOurDiscount).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            'Could not fetch loyalty discount IDs for free item detection',
            expect.objectContaining({ error: 'connection refused' })
        );
    });

    test('query filters by status = earned and merchant_id', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const order = {
            id: 'ORDER_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'X', applied_money: { amount: 100n } }],
        };

        await buildDiscountMap(order, 42);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("status = 'earned'");
        expect(sql).toContain('merchant_id = $1');
        expect(params).toEqual([42]);
    });

    test('pricing_rule_id is also tracked in ourLoyaltyDiscountIds', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { square_discount_id: null, square_pricing_rule_id: 'PRICING_RULE_789' },
            ],
        });

        const order = {
            id: 'ORDER_1',
            discounts: [
                {
                    uid: 'DISC_UID_1',
                    catalog_object_id: 'PRICING_RULE_789',
                    applied_money: { amount: 800n },
                },
            ],
        };

        const result = await buildDiscountMap(order, 1);

        const entry = result.lineItemDiscountMap.get('DISC_UID_1');
        expect(entry.isOurLoyaltyDiscount).toBe(true);
        expect(result.orderUsedOurDiscount).toBe(true);
    });
});
