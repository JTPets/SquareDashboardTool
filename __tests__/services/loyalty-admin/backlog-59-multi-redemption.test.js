/**
 * Tests for BACKLOG-59: Multi-redemption support in detectRewardRedemptionFromOrder
 *
 * Verifies that when a customer redeems multiple earned rewards in one order,
 * all matched rewards are detected and processed (not just the first).
 */

const mockClient = {
    query: jest.fn(),
    release: jest.fn()
};

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn().mockResolvedValue(mockClient)
    }
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const mockLogAuditEvent = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: mockLogAuditEvent
}));

const mockCleanupDiscount = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    cleanupSquareCustomerGroupDiscount: mockCleanupDiscount
}));

const mockUpdateCustomerSummary = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: mockUpdateCustomerSummary
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const {
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount,
    MAX_REDEMPTIONS_PER_ORDER
} = require('../../../services/loyalty-admin/reward-service');

// Helper: mock redeemReward transaction to succeed
function mockRedeemRewardSuccess(rewardId) {
    // logAuditEvent and updateCustomerSummary are mocked at module level,
    // so they don't call mockClient.query — only 5 calls needed
    mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({   // SELECT FOR UPDATE
            rows: [{
                id: rewardId,
                status: 'earned',
                offer_id: 10,
                square_customer_id: 'cust_1',
                offer_name: 'Test Offer'
            }]
        })
        .mockResolvedValueOnce({ rows: [{ id: 100 + rewardId, reward_id: rewardId }] }) // INSERT redemption
        .mockResolvedValueOnce({}) // UPDATE reward
        .mockResolvedValueOnce({}); // COMMIT
}

describe('BACKLOG-59: Multi-redemption in detectRewardRedemptionFromOrder', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should detect and return a single earned reward (regression)', async () => {
        const order = {
            id: 'ord_single',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{
                uid: 'd1',
                catalog_object_id: 'disc_1',
                applied_money: { amount: 3999 }
            }],
            line_items: []
        };

        // Strategy 1: single match
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 42, offer_id: 10, square_customer_id: 'cust_1',
                offer_name: 'Buy 12 Get 1 Free', status: 'earned',
                square_discount_id: 'disc_1', square_pricing_rule_id: null
            }]
        });

        mockRedeemRewardSuccess(42);

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions).toHaveLength(1);
        expect(result.redemptions[0].rewardId).toBe(42);
        expect(result.redemptions[0].offerName).toBe('Buy 12 Get 1 Free');
        expect(result.redemptions[0].detectionMethod).toBe('catalog_object_id');
    });

    it('should detect and return two earned rewards on same order', async () => {
        const order = {
            id: 'ord_multi',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [
                { uid: 'd1', catalog_object_id: 'disc_1', applied_money: { amount: 3999 } },
                { uid: 'd2', catalog_object_id: 'disc_2', applied_money: { amount: 2499 } }
            ],
            line_items: []
        };

        // Strategy 1: two matches
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    id: 42, offer_id: 10, square_customer_id: 'cust_1',
                    offer_name: 'Buy 12 Get 1 Free', status: 'earned',
                    square_discount_id: 'disc_1', square_pricing_rule_id: null
                },
                {
                    id: 55, offer_id: 20, square_customer_id: 'cust_1',
                    offer_name: 'Buy 8 Get 1 Free', status: 'earned',
                    square_discount_id: 'disc_2', square_pricing_rule_id: null
                }
            ]
        });

        // redeemReward called twice
        mockRedeemRewardSuccess(42);
        mockRedeemRewardSuccess(55);

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions).toHaveLength(2);
        expect(result.redemptions[0].rewardId).toBe(42);
        expect(result.redemptions[0].offerName).toBe('Buy 12 Get 1 Free');
        expect(result.redemptions[1].rewardId).toBe(55);
        expect(result.redemptions[1].offerName).toBe('Buy 8 Get 1 Free');
    });

    it('should return detected: false with empty redemptions array when zero matches', async () => {
        const order = {
            id: 'ord_none',
            customer_id: 'cust_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_unrelated' }],
            line_items: []
        };

        // Strategy 1: no match
        db.query.mockResolvedValueOnce({ rows: [] });
        // Strategy 2: no match (no free items)
        // Strategy 3: no match
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]);
    });

    it('should not call Strategy 2/3 when Strategy 1 finds matches', async () => {
        const order = {
            id: 'ord_strat1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_1', applied_money: { amount: 3999 } }],
            line_items: [
                // Free item that would trigger Strategy 2 if it ran
                { catalog_object_id: 'var_free', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        // Strategy 1: match found
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 42, offer_id: 10, square_customer_id: 'cust_1',
                offer_name: 'Buy 12 Get 1 Free', status: 'earned',
                square_discount_id: 'disc_1', square_pricing_rule_id: null
            }]
        });

        mockRedeemRewardSuccess(42);

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions).toHaveLength(1);
        // Only 1 db.query call (Strategy 1 batch lookup) — Strategies 2 & 3 not called
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should cap at MAX_REDEMPTIONS_PER_ORDER and log error', async () => {
        const order = {
            id: 'ord_cap',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_1', applied_money: { amount: 100 } }],
            line_items: []
        };

        // Strategy 1: 11 matches (exceeds cap of 10)
        const rows = [];
        for (let i = 1; i <= 11; i++) {
            rows.push({
                id: i, offer_id: i, square_customer_id: 'cust_1',
                offer_name: `Offer ${i}`, status: 'earned',
                square_discount_id: 'disc_1', square_pricing_rule_id: null
            });
        }
        db.query.mockResolvedValueOnce({ rows });

        // Mock redeemReward for 10 calls (not 11)
        for (let i = 1; i <= 10; i++) {
            mockRedeemRewardSuccess(i);
        }

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        // Only 10 processed, not 11
        expect(result.redemptions).toHaveLength(MAX_REDEMPTIONS_PER_ORDER);
        expect(result.redemptions).toHaveLength(10);
        // Error logged for exceeding cap
        expect(logger.error).toHaveBeenCalledWith(
            'MAX_REDEMPTIONS_PER_ORDER exceeded — breaking',
            expect.objectContaining({
                orderId: 'ord_cap',
                totalMatched: 11,
                cap: 10
            })
        );
    });

    it('should call redeemReward once per matched reward', async () => {
        const order = {
            id: 'ord_count',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [
                { uid: 'd1', catalog_object_id: 'disc_1', applied_money: { amount: 3999 } },
                { uid: 'd2', catalog_object_id: 'disc_2', applied_money: { amount: 2499 } }
            ],
            line_items: []
        };

        // Strategy 1: two matches
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    id: 42, offer_id: 10, square_customer_id: 'cust_1',
                    offer_name: 'Offer A', status: 'earned',
                    square_discount_id: 'disc_1', square_pricing_rule_id: null
                },
                {
                    id: 55, offer_id: 20, square_customer_id: 'cust_1',
                    offer_name: 'Offer B', status: 'earned',
                    square_discount_id: 'disc_2', square_pricing_rule_id: null
                }
            ]
        });

        mockRedeemRewardSuccess(42);
        mockRedeemRewardSuccess(55);

        await detectRewardRedemptionFromOrder(order, 1);

        // db.pool.connect called twice (once per redeemReward)
        expect(db.pool.connect).toHaveBeenCalledTimes(2);
    });
});
