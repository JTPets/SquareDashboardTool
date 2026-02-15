/**
 * Tests for reward-service.js - matchEarnedRewardByFreeItem
 *
 * Tests the fallback redemption detection that matches 100% discounted
 * line items to earned rewards via qualifying variations. This catches
 * manual discounts, re-applied discounts, and migrated discount objects
 * that the catalog_object_id matching path misses.
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

const { matchEarnedRewardByFreeItem, detectRewardRedemptionFromOrder } = require('../../../services/loyalty-admin/reward-service');
const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

// --- Test Data Fixtures ---

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'RZ6E21NQC92SH7XZQYV49WRA68';
const ORDER_ID = 'ORDER_FEB15';
const REWARD_ID = 'reward-uuid-123';
const OFFER_ID = 'offer-uuid-456';
const VARIATION_ID = 'VAR_CARAVAN_TURKEY_1LB';

function makeOrderWithManualDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [
            {
                uid: 'discount-uid-1',
                name: '$13.99 off',
                type: 'FIXED_AMOUNT',
                amount_money: { amount: 1399, currency: 'CAD' },
                applied_money: { amount: 1399, currency: 'CAD' },
                scope: 'LINE_ITEM',
                // No catalog_object_id — this is a manual discount
            }
        ],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VARIATION_ID,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 0, currency: 'CAD' },
            },
            {
                uid: 'li-2',
                catalog_object_id: 'VAR_OTHER_ITEM',
                name: 'Dog Treats',
                quantity: '2',
                base_price_money: { amount: 899, currency: 'CAD' },
                total_money: { amount: 1798, currency: 'CAD' },
            }
        ],
        tenders: [
            { customer_id: CUSTOMER_ID }
        ],
    };
}

function makeOrderWithNoFreeItems() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VARIATION_ID,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 1399, currency: 'CAD' },
            }
        ],
    };
}

function makeOrderWithCatalogDiscount() {
    return {
        id: ORDER_ID,
        customer_id: CUSTOMER_ID,
        location_id: 'LOC_001',
        state: 'COMPLETED',
        discounts: [
            {
                uid: 'discount-uid-1',
                catalog_object_id: 'SQUARE_DISCOUNT_ABC',
                name: 'Loyalty: Caravan 1lb (Reward 42)',
                type: 'FIXED_AMOUNT',
                applied_money: { amount: 1399, currency: 'CAD' },
                scope: 'LINE_ITEM',
            }
        ],
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: VARIATION_ID,
                name: 'Caravan Turkey 1lb',
                quantity: '1',
                base_price_money: { amount: 1399, currency: 'CAD' },
                total_money: { amount: 0, currency: 'CAD' },
            }
        ],
    };
}

// --- Tests ---

describe('matchEarnedRewardByFreeItem', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('detects manual discount as redemption when customer has earned reward', async () => {
        const order = makeOrderWithManualDiscount();

        // Mock: find earned reward matching the free item's variation
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: REWARD_ID,
                offer_id: OFFER_ID,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
                matched_variation_id: VARIATION_ID,
            }]
        });

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(REWARD_ID);
        expect(result.offer_id).toBe(OFFER_ID);
        expect(result.matched_variation_id).toBe(VARIATION_ID);
        expect(result.square_customer_id).toBe(CUSTOMER_ID);

        // Verify query used correct parameters
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('loyalty_qualifying_variations'),
            [MERCHANT_ID, [VARIATION_ID], CUSTOMER_ID]
        );
    });

    test('returns null when no free items on order', async () => {
        const order = makeOrderWithNoFreeItems();

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    test('returns null when no customer_id on order', async () => {
        const order = makeOrderWithManualDiscount();
        order.customer_id = null;
        order.tenders = [];

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    test('falls back to tender customer_id when order has no customer_id', async () => {
        const order = makeOrderWithManualDiscount();
        order.customer_id = null;
        // customer_id is on the tender

        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: REWARD_ID,
                offer_id: OFFER_ID,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
                matched_variation_id: VARIATION_ID,
            }]
        });

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).not.toBeNull();
        expect(db.query).toHaveBeenCalledWith(
            expect.any(String),
            [MERCHANT_ID, [VARIATION_ID], CUSTOMER_ID]
        );
    });

    test('returns null when free item does not match any earned reward', async () => {
        const order = makeOrderWithManualDiscount();

        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).toBeNull();
    });

    test('returns null when order has no line items', async () => {
        const order = makeOrderWithManualDiscount();
        order.line_items = [];

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).toBeNull();
    });

    test('handles BigInt amounts from Square SDK v43+', async () => {
        const order = makeOrderWithManualDiscount();
        // Square SDK v43+ may return BigInt
        order.line_items[0].base_price_money.amount = BigInt(1399);
        order.line_items[0].total_money.amount = BigInt(0);

        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: REWARD_ID,
                offer_id: OFFER_ID,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Test Offer',
                matched_variation_id: VARIATION_ID,
            }]
        });

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe(REWARD_ID);
    });

    test('does not match partially discounted items', async () => {
        const order = makeOrderWithManualDiscount();
        // Item is only 50% discounted, not free
        order.line_items[0].total_money.amount = 700;

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        // Only the first item could be free, but it's not
        // Second item (Dog Treats) has full price
        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    test('does not match items with $0 base price', async () => {
        const order = makeOrderWithManualDiscount();
        // Item has $0 base price (not a discounted item)
        order.line_items[0].base_price_money.amount = 0;
        order.line_items[0].total_money.amount = 0;

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('detectRewardRedemptionFromOrder - fallback path', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('uses catalog_object_id match first (strategy 1)', async () => {
        const order = makeOrderWithCatalogDiscount();

        // Strategy 1: catalog_object_id match succeeds
        db.query.mockResolvedValueOnce({
            rows: [{
                id: REWARD_ID,
                offer_id: OFFER_ID,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
                status: 'earned',
            }]
        });

        // Mock redeemReward transaction
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({}) // BEGIN
                .mockResolvedValueOnce({   // SELECT FOR UPDATE
                    rows: [{
                        id: REWARD_ID,
                        offer_id: OFFER_ID,
                        square_customer_id: CUSTOMER_ID,
                        status: 'earned',
                        brand_name: 'Caravan',
                        size_group: '1lb',
                        offer_name: 'Caravan 1lb',
                    }]
                })
                .mockResolvedValueOnce({ rows: [{ id: 'redemption-1' }] }) // INSERT redemption
                .mockResolvedValueOnce({}) // UPDATE reward
                .mockResolvedValueOnce({}) // Audit log
                .mockResolvedValueOnce({}) // Update summary
                .mockResolvedValueOnce({}), // COMMIT
            release: jest.fn(),
        };
        db.pool.connect.mockResolvedValueOnce(mockClient);

        const result = await detectRewardRedemptionFromOrder(order, MERCHANT_ID);

        expect(result.detected).toBe(true);
        expect(result.detectionMethod).toBe('catalog_object_id');
        expect(result.rewardId).toBe(REWARD_ID);
    });

    test('falls back to free item matching when no catalog_object_id match', async () => {
        const order = makeOrderWithManualDiscount();

        // Strategy 1: no catalog discount IDs to match (all manual)
        // Strategy 2: free item fallback — matchEarnedRewardByFreeItem calls db.query
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: REWARD_ID,
                offer_id: OFFER_ID,
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Caravan 1lb - Buy 12 get 13th Free',
                matched_variation_id: VARIATION_ID,
            }]
        });

        // Mock redeemReward transaction (called after fallback match)
        // Sequence: BEGIN, SELECT FOR UPDATE, SELECT variation details
        //           (because redeemedVariationId is set), INSERT redemption,
        //           UPDATE reward, COMMIT
        // Note: logAuditEvent and updateCustomerSummary are mocked as no-ops
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({}) // BEGIN
                .mockResolvedValueOnce({   // SELECT FOR UPDATE
                    rows: [{
                        id: REWARD_ID,
                        offer_id: OFFER_ID,
                        square_customer_id: CUSTOMER_ID,
                        status: 'earned',
                        brand_name: 'Caravan',
                        size_group: '1lb',
                        offer_name: 'Caravan 1lb',
                    }]
                })
                .mockResolvedValueOnce({   // SELECT variation details (redeemedVariationId is set)
                    rows: [{ item_name: 'Caravan Turkey', variation_name: '1lb' }]
                })
                .mockResolvedValueOnce({ rows: [{ id: 'redemption-1' }] }) // INSERT redemption
                .mockResolvedValueOnce({}) // UPDATE reward
                .mockResolvedValueOnce({}), // COMMIT
            release: jest.fn(),
        };
        db.pool.connect.mockResolvedValueOnce(mockClient);

        const result = await detectRewardRedemptionFromOrder(order, MERCHANT_ID);

        expect(result.detected).toBe(true);
        expect(result.detectionMethod).toBe('free_item_fallback');
        expect(result.rewardId).toBe(REWARD_ID);
    });

    test('returns detected:false when neither strategy matches', async () => {
        const order = makeOrderWithNoFreeItems();

        const result = await detectRewardRedemptionFromOrder(order, MERCHANT_ID);

        expect(result.detected).toBe(false);
    });

    test('handles errors gracefully', async () => {
        const order = makeOrderWithManualDiscount();

        db.query.mockRejectedValueOnce(new Error('DB connection failed'));

        const result = await detectRewardRedemptionFromOrder(order, MERCHANT_ID);

        expect(result.detected).toBe(false);
        expect(result.error).toBe('DB connection failed');
        expect(logger.error).toHaveBeenCalledWith(
            'Error detecting reward redemption',
            expect.objectContaining({ error: 'DB connection failed' })
        );
    });
});
