/**
 * Tests for reward-service.js - matchEarnedRewardByDiscountAmount (Strategy 3)
 *
 * Tests the discount-amount fallback redemption detection. When a pricing rule
 * auto-applies a FIXED_AMOUNT catalog discount spread across multiple qualifying
 * items, no single item ends up $0 (so Strategy 2 misses it). This strategy sums
 * total_discount_money on qualifying variations and compares against the expected
 * reward value from purchase history.
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    cleanupSquareCustomerGroupDiscount: jest.fn(),
    createSquareCustomerGroupDiscount: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/purchase-service', () => ({
    updateCustomerSummary: jest.fn(),
}));

const { matchEarnedRewardByDiscountAmount } = require('../../../services/loyalty-admin/reward-service');
const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

// --- Test Data Fixtures ---

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'RZ6E21NQC92SH7XZQYV49WRA68';
const ORDER_ID = 'ORDER_FEB15';
const REWARD_ID = 'reward-uuid-123';
const REWARD_ID_2 = 'reward-uuid-456';
const OFFER_ID = 'offer-uuid-789';
const OFFER_ID_2 = 'offer-uuid-012';
const VAR_CARAVAN_1 = 'VAR_CARAVAN_TURKEY_1LB';
const VAR_CARAVAN_2 = 'VAR_CARAVAN_CHICKEN_1LB';
const VAR_CARAVAN_3 = 'VAR_CARAVAN_DUCK_1LB';
const VAR_OTHER = 'VAR_TREATS_BEEF';
const VAR_ACANA_1 = 'VAR_ACANA_LAMB_2KG';

/**
 * Order with FIXED_AMOUNT discount spread across 3 qualifying items.
 * Total discount = $13.99 spread: $4.67 + $4.66 + $4.66
 */
function makeOrderWithSpreadDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [
            {
                uid: 'discount-uid-1',
                catalog_object_id: 'CATALOG_DISCOUNT_XYZ',
                pricing_rule_id: 'PRICING_RULE_ABC',
                name: 'Loyalty: Caravan 1lb (Reward)',
                type: 'FIXED_AMOUNT',
                applied_money: { amount: 1399, currency: 'CAD' },
                scope: 'LINE_ITEM',
            }
        ],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VAR_CARAVAN_1,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 932, currency: 'CAD' },
                total_discount_money: { amount: 467, currency: 'CAD' },
            },
            {
                uid: 'li-2',
                catalog_object_id: VAR_CARAVAN_2,
                name: 'Caravan Chicken 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 933, currency: 'CAD' },
                total_discount_money: { amount: 466, currency: 'CAD' },
            },
            {
                uid: 'li-3',
                catalog_object_id: VAR_CARAVAN_3,
                name: 'Caravan Duck 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 933, currency: 'CAD' },
                total_discount_money: { amount: 466, currency: 'CAD' },
            },
        ],
        tenders: [{ customer_id: CUSTOMER_ID }],
    };
}

/**
 * Order with FIXED_AMOUNT discount on 1 qualifying item (partial, not free).
 * Discount = $13.99 on a $27.98 item (quantity 2).
 */
function makeOrderWithPartialDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [
            {
                uid: 'discount-uid-1',
                catalog_object_id: 'CATALOG_DISCOUNT_XYZ',
                name: 'Loyalty: Caravan 1lb (Reward)',
                type: 'FIXED_AMOUNT',
                applied_money: { amount: 1399, currency: 'CAD' },
                scope: 'LINE_ITEM',
            }
        ],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VAR_CARAVAN_1,
                name: 'Caravan Turkey 1lb',
                quantity: '2',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 1399, currency: 'CAD' },
                total_discount_money: { amount: 1399, currency: 'CAD' },
            },
        ],
        tenders: [{ customer_id: CUSTOMER_ID }],
    };
}

/**
 * Order with small seniors day discount ($2 off) — should NOT match a $13.99 reward.
 */
function makeOrderWithSmallDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [
            {
                uid: 'discount-uid-1',
                name: 'Seniors Day 10% Off',
                type: 'FIXED_PERCENTAGE',
                applied_money: { amount: 200, currency: 'CAD' },
                scope: 'ORDER',
            }
        ],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VAR_CARAVAN_1,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 1199, currency: 'CAD' },
                total_discount_money: { amount: 200, currency: 'CAD' },
            },
        ],
        tenders: [{ customer_id: CUSTOMER_ID }],
    };
}

/**
 * Order with no discounts on qualifying items.
 */
function makeOrderWithNoDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VAR_CARAVAN_1,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 1399, currency: 'CAD' },
            },
        ],
        tenders: [{ customer_id: CUSTOMER_ID }],
    };
}

/**
 * Order where non-qualifying items are discounted, qualifying items are not.
 */
function makeOrderWithNonQualifyingDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [
            {
                uid: 'discount-uid-1',
                name: '$5 off treats',
                type: 'FIXED_AMOUNT',
                applied_money: { amount: 500, currency: 'CAD' },
                scope: 'LINE_ITEM',
            }
        ],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VAR_CARAVAN_1,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 1399, currency: 'CAD' },
                // No discount on qualifying item
            },
            {
                uid: 'li-2',
                catalog_object_id: VAR_OTHER,
                name: 'Beef Treats',
                quantity: '1',
                base_price_money: { amount: 899, currency: 'CAD' },
                total_money: { amount: 399, currency: 'CAD' },
                total_discount_money: { amount: 500, currency: 'CAD' },
            },
        ],
        tenders: [{ customer_id: CUSTOMER_ID }],
    };
}

// --- Helper to mock earned rewards query ---
function mockEarnedRewardsQuery(rewards) {
    db.query.mockResolvedValueOnce({ rows: rewards });
}

// --- Helper to mock price lookup query ---
function mockPriceLookup(expectedValueCents) {
    db.query.mockResolvedValueOnce({
        rows: [{ expected_value_cents: expectedValueCents }]
    });
}

// --- Tests ---

describe('matchEarnedRewardByDiscountAmount (Strategy 3)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('detects FIXED_AMOUNT spread across 3 qualifying items', async () => {
        const order = makeOrderWithSpreadDiscount();

        // Mock: earned rewards with qualifying variations
        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        // Mock: expected reward value = $13.99
        mockPriceLookup(1399);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(REWARD_ID);
        expect(result.offer_id).toBe(OFFER_ID);
        expect(result.totalDiscountCents).toBe(1399); // 467 + 466 + 466
        expect(result.expectedValueCents).toBe(1399);
    });

    test('detects FIXED_AMOUNT on 1 qualifying item (partial discount)', async () => {
        const order = makeOrderWithPartialDiscount();

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        mockPriceLookup(1399);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(REWARD_ID);
        expect(result.totalDiscountCents).toBe(1399);
    });

    test('does NOT match small discount well below reward value', async () => {
        const order = makeOrderWithSmallDiscount();

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        // Expected value = $13.99, but discount is only $2.00
        mockPriceLookup(1399);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).toBeNull();
    });

    test('does NOT match when no discount on qualifying items', async () => {
        const order = makeOrderWithNoDiscount();

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        // Price lookup should not even be called since totalDiscountCents = 0
        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).toBeNull();
        // Only the earned rewards query should have been called, not the price lookup
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('returns null when customer has no earned rewards', async () => {
        const order = makeOrderWithSpreadDiscount();

        mockEarnedRewardsQuery([]);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).toBeNull();
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('detects with rounding tolerance: 99% of value', async () => {
        const order = makeOrderWithSpreadDiscount();
        // Simulate rounding: total discount = $13.86 (99.1% of $13.99)
        order.line_items[0].total_discount_money.amount = 462;
        order.line_items[1].total_discount_money.amount = 462;
        order.line_items[2].total_discount_money.amount = 462;
        // Total = 1386

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        mockPriceLookup(1399);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        // 1386 / 1399 = 0.9907 >= 0.95 threshold → detected
        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(REWARD_ID);
        expect(result.totalDiscountCents).toBe(1386);
    });

    test('does NOT match below tolerance: 92% of value', async () => {
        const order = makeOrderWithSpreadDiscount();
        // Simulate heavy rounding: total discount = $12.87 (92% of $13.99)
        order.line_items[0].total_discount_money.amount = 429;
        order.line_items[1].total_discount_money.amount = 429;
        order.line_items[2].total_discount_money.amount = 429;
        // Total = 1287

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        mockPriceLookup(1399);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        // 1287 / 1399 = 0.92 < 0.95 threshold → NOT detected
        expect(result).toBeNull();
    });

    test('matches correct reward when multiple earned rewards exist', async () => {
        const order = makeOrderWithSpreadDiscount();
        // Add a non-qualifying item that belongs to a different offer
        order.line_items.push({
            uid: 'li-4',
            catalog_object_id: VAR_ACANA_1,
            name: 'Acana Lamb 2kg',
            quantity: '1',
            base_price_money: { amount: 3499, currency: 'CAD' },
            total_money: { amount: 3499, currency: 'CAD' },
            // No discount on this item
        });

        // Two earned rewards: one for Caravan, one for Acana
        mockEarnedRewardsQuery([
            {
                reward_id: REWARD_ID_2,
                offer_id: OFFER_ID_2,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Acana 2kg - Buy 10 get 11th Free',
                qualifying_variation_ids: [VAR_ACANA_1],
            },
            {
                reward_id: REWARD_ID,
                offer_id: OFFER_ID,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
                qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
            },
        ]);

        // First reward (Acana): no discount on qualifying items → price lookup not called
        // Second reward (Caravan): $13.99 discount on qualifying items
        mockPriceLookup(1399);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(REWARD_ID);
        expect(result.offer_name).toBe('Caravan 1lb - Buy 12 get 13th Free');
    });

    test('does NOT match when non-qualifying items discounted but qualifying items are not', async () => {
        const order = makeOrderWithNonQualifyingDiscount();

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: MERCHANT_ID
        });

        expect(result).toBeNull();
        // Only the earned rewards query; no price lookup since totalDiscountCents = 0
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('returns null when squareCustomerId is null', async () => {
        const order = makeOrderWithSpreadDiscount();

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: null, merchantId: MERCHANT_ID
        });

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    test('queries use correct merchant_id for tenant isolation', async () => {
        const order = makeOrderWithSpreadDiscount();
        const specificMerchant = 42;

        mockEarnedRewardsQuery([{
            reward_id: REWARD_ID,
            offer_id: OFFER_ID,
            square_customer_id: CUSTOMER_ID,
            offer_name: 'Caravan 1lb',
            qualifying_variation_ids: [VAR_CARAVAN_1, VAR_CARAVAN_2, VAR_CARAVAN_3],
        }]);

        mockPriceLookup(1399);

        await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: CUSTOMER_ID, merchantId: specificMerchant
        });

        // Earned rewards query should include merchant_id
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('r.merchant_id = $1'),
            [specificMerchant, CUSTOMER_ID]
        );

        // Price lookup query should include merchant_id
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('merchant_id = $2'),
            [REWARD_ID, specificMerchant, OFFER_ID]
        );
    });
});
