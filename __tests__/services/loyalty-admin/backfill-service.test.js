/**
 * Tests for backfill-service.js - getCustomerOrderHistoryForAudit
 *
 * Focuses on the redeemed_reward cross-reference: when a loyalty_redemptions
 * record exists for an order but the free item isn't visible in Square's
 * order data (e.g., discount removed during manual fix).
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        squareApi: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: jest.fn(),
    getSquareAccessToken: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/webhook-processing-service', () => ({
    processOrderForLoyalty: jest.fn(),
}));

const { getCustomerOrderHistoryForAudit } = require('../../../services/loyalty-admin/backfill-service');
const db = require('../../../utils/database');
const { fetchWithTimeout, getSquareAccessToken } = require('../../../services/loyalty-admin/shared-utils');

// --- Test Data Fixtures ---

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'CUST_DANNY_BOOTH';
const ORDER_ID = 'ORDER_JAN30';
const LOCATION_ID = 'LOC_001';
const VARIATION_ID = 'VAR_BCR_CHICKEN_4LB';

/** Square order with 3 paid line items, none 100% discounted */
function makeSquareOrderAllPaid(orderId = ORDER_ID) {
    return {
        id: orderId,
        customer_id: CUSTOMER_ID,
        state: 'COMPLETED',
        closed_at: '2026-01-30T21:07:25Z',
        location_id: LOCATION_ID,
        tenders: [{ id: 'tender-1', receipt_url: 'https://squareup.com/receipt/1' }],
        line_items: [
            {
                uid: 'li-1',
                name: 'Big Country Raw Chicken Dinner - 4 x 1 lb',
                catalog_object_id: VARIATION_ID,
                quantity: '3',
                base_price_money: { amount: 1699, currency: 'CAD' },
                gross_sales_money: { amount: 5097, currency: 'CAD' },
                total_discount_money: { amount: 0, currency: 'CAD' },
                total_money: { amount: 5097, currency: 'CAD' },
            },
        ],
        total_money: { amount: 5097, currency: 'CAD' },
        discounts: [],
    };
}

/** Active offer that matches the variation */
const OFFERS_ROWS = [{
    id: 'offer-uuid-1',
    offer_name: 'Big Country Raw 4lb - Buy 12 get 13th Free',
    brand_name: 'Big Country Raw',
    size_group: '4lb',
    required_quantity: 12,
    variation_ids: [VARIATION_ID],
}];

/** Redemption record linking to an order */
function makeRedemptionRow(orderId = ORDER_ID) {
    return {
        square_order_id: orderId,
        redeemed_item_name: 'Big Country Raw Chicken Dinner - 4 x 1 lb',
        redeemed_variation_id: VARIATION_ID,
        redeemed_variation_name: 'BCR Chicken 4lb',
        redeemed_value_cents: 1699,
        offer_name: 'Big Country Raw 4lb - Buy 12 get 13th Free',
    };
}

// --- Helpers ---

/**
 * Set up db.query to return specific rows for the known query sequence
 * in getCustomerOrderHistoryForAudit. The order of calls is:
 *   1. Active offers with variations
 *   2. Tracked orders
 *   3. Redemption records   <-- the new query
 *   4. Current rewards
 *   5. Active locations
 */
function setupDbMocks({
    offers = OFFERS_ROWS,
    trackedOrders = [],
    redemptions = [],
    rewards = [],
    locations = [{ id: LOCATION_ID }],
} = {}) {
    db.query
        .mockResolvedValueOnce({ rows: offers })         // 1. offers
        .mockResolvedValueOnce({ rows: trackedOrders })   // 2. tracked orders
        .mockResolvedValueOnce({ rows: redemptions })     // 3. redemptions
        .mockResolvedValueOnce({ rows: rewards })         // 4. rewards
        .mockResolvedValueOnce({ rows: locations });      // 5. locations
}

/** Mock the Square Orders Search API response */
function setupSquareOrdersResponse(orders) {
    getSquareAccessToken.mockResolvedValue('fake-token');
    fetchWithTimeout.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ orders, cursor: null }),
    });
}

// --- Tests ---

describe('getCustomerOrderHistoryForAudit - redemption cross-reference', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('adds redeemed_reward when redemption record exists but order has no free line items', async () => {
        const order = makeSquareOrderAllPaid();

        setupDbMocks({
            trackedOrders: [{ square_order_id: ORDER_ID, customer_source: 'order' }],
            redemptions: [makeRedemptionRow()],
        });
        setupSquareOrdersResponse([order]);

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: CUSTOMER_ID,
            merchantId: MERCHANT_ID,
            startMonthsAgo: 0,
            endMonthsAgo: 3,
        });

        expect(result.orders).toHaveLength(1);
        const auditOrder = result.orders[0];

        // The 3 paid items should still be qualifying
        expect(auditOrder.qualifyingItems).toHaveLength(1); // 1 line item, qty=3
        expect(auditOrder.qualifyingItems[0].quantity).toBe(3);

        // The redeemed item should appear in nonQualifyingItems
        const redeemedItems = auditOrder.nonQualifyingItems.filter(
            i => i.skipReason === 'redeemed_reward'
        );
        expect(redeemedItems).toHaveLength(1);
        expect(redeemedItems[0]).toMatchObject({
            variationId: VARIATION_ID,
            name: 'Big Country Raw Chicken Dinner - 4 x 1 lb',
            quantity: 1,
            isFree: true,
            skipReason: 'redeemed_reward',
            offerName: 'Big Country Raw 4lb - Buy 12 get 13th Free',
        });
    });

    test('does NOT add redeemed_reward when free item is already detected from Square data', async () => {
        // Order has a separate free line item that Square data shows as $0
        const order = makeSquareOrderAllPaid();
        order.line_items.push({
            uid: 'li-free',
            name: 'Big Country Raw Chicken Dinner - 4 x 1 lb',
            catalog_object_id: VARIATION_ID,
            quantity: '1',
            base_price_money: { amount: 1699, currency: 'CAD' },
            gross_sales_money: { amount: 1699, currency: 'CAD' },
            total_discount_money: { amount: 1699, currency: 'CAD' },
            total_money: { amount: 0, currency: 'CAD' },
        });

        setupDbMocks({
            redemptions: [makeRedemptionRow()],
        });
        setupSquareOrdersResponse([order]);

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: CUSTOMER_ID,
            merchantId: MERCHANT_ID,
            startMonthsAgo: 0,
            endMonthsAgo: 3,
        });

        const auditOrder = result.orders[0];

        // Should have the free_item from line item detection, NOT a duplicate redeemed_reward
        const freeItems = auditOrder.nonQualifyingItems.filter(i => i.skipReason === 'free_item');
        const redeemedItems = auditOrder.nonQualifyingItems.filter(i => i.skipReason === 'redeemed_reward');
        expect(freeItems).toHaveLength(1);
        expect(redeemedItems).toHaveLength(0);
    });

    test('does NOT match redemption when square_order_id is NULL', async () => {
        const order = makeSquareOrderAllPaid();

        // Redemption has null order ID (manual redemption, not linked to an order)
        setupDbMocks({
            redemptions: [],  // NULL order_id filtered by SQL WHERE clause
        });
        setupSquareOrdersResponse([order]);

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: CUSTOMER_ID,
            merchantId: MERCHANT_ID,
            startMonthsAgo: 0,
            endMonthsAgo: 3,
        });

        const auditOrder = result.orders[0];

        // All 3 items should be qualifying, no redeemed_reward
        expect(auditOrder.qualifyingItems).toHaveLength(1);
        expect(auditOrder.qualifyingItems[0].quantity).toBe(3);
        expect(auditOrder.nonQualifyingItems.filter(i => i.skipReason === 'redeemed_reward')).toHaveLength(0);
    });

    test('redemption for a different order does not bleed into unrelated order', async () => {
        const order = makeSquareOrderAllPaid('ORDER_FEB05');

        // Redemption is linked to a DIFFERENT order
        setupDbMocks({
            redemptions: [makeRedemptionRow('ORDER_JAN30_DIFFERENT')],
        });
        setupSquareOrdersResponse([order]);

        const result = await getCustomerOrderHistoryForAudit({
            squareCustomerId: CUSTOMER_ID,
            merchantId: MERCHANT_ID,
            startMonthsAgo: 0,
            endMonthsAgo: 3,
        });

        const auditOrder = result.orders[0];
        expect(auditOrder.nonQualifyingItems.filter(i => i.skipReason === 'redeemed_reward')).toHaveLength(0);
    });

    test('redemption query includes merchant_id and customer_id filters', async () => {
        setupDbMocks();
        setupSquareOrdersResponse([]);

        await getCustomerOrderHistoryForAudit({
            squareCustomerId: CUSTOMER_ID,
            merchantId: MERCHANT_ID,
            startMonthsAgo: 0,
            endMonthsAgo: 3,
        });

        // The 3rd db.query call should be the redemptions query
        const redemptionCall = db.query.mock.calls[2];
        expect(redemptionCall[0]).toContain('loyalty_redemptions');
        expect(redemptionCall[0]).toContain('merchant_id = $1');
        expect(redemptionCall[0]).toContain('square_customer_id = $2');
        expect(redemptionCall[0]).toContain('square_order_id IS NOT NULL');
        expect(redemptionCall[1]).toEqual([MERCHANT_ID, CUSTOMER_ID]);
    });
});
