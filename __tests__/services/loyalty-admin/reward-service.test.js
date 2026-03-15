/**
 * Tests for services/loyalty-admin/reward-service.js
 *
 * T-1: Financial/loyalty services — reward redemption and detection.
 * Focus on boundary conditions: duplicate redemptions, customer mismatch,
 * wrong status transitions, detection strategies (catalog ID, free item,
 * discount amount).
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

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
    redeemReward,
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount,
    MAX_REDEMPTIONS_PER_ORDER
} = require('../../../services/loyalty-admin/reward-service');

// ============================================================================
// TESTS — redeemReward
// ============================================================================

describe('redeemReward', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should throw when merchantId is missing', async () => {
        await expect(redeemReward({
            rewardId: 1,
            squareOrderId: 'ord_1'
        })).rejects.toThrow('merchantId is required');
    });

    it('should throw when reward not found', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1,
            rewardId: 999,
            squareOrderId: 'ord_1'
        })).rejects.toThrow('Reward not found or access denied');
    });

    it('should throw when reward is not in earned status', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 1, status: 'in_progress', offer_id: 10,
                        square_customer_id: 'cust_1', merchant_id: 1
                    }]
                };
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1'
        })).rejects.toThrow('Cannot redeem reward in status: in_progress');
    });

    it('should throw when reward is already redeemed', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 1, status: 'redeemed', offer_id: 10,
                        square_customer_id: 'cust_1'
                    }]
                };
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1'
        })).rejects.toThrow('Cannot redeem reward in status: redeemed');
    });

    it('should throw on customer ID mismatch', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 1, status: 'earned', offer_id: 10,
                        square_customer_id: 'cust_1', offer_name: 'Test'
                    }]
                };
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'different_cust'
        })).rejects.toThrow('Customer ID mismatch');
    });

    it('should allow redemption when squareCustomerId is null (admin path)', async () => {
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 1, status: 'earned', offer_id: 10,
                        square_customer_id: 'cust_1', offer_name: 'Buy 12'
                    }]
                };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) {
                return { rows: [{ item_name: 'Dog Food', variation_name: 'Large' }] };
            }
            if (sql.includes('INSERT INTO loyalty_redemptions')) {
                return { rows: [{ id: 50, reward_id: 1, offer_id: 10 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes("status = 'redeemed'")) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const result = await redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: null, // Null = admin, should NOT throw
            redemptionType: 'manual_admin',
            redeemedByUserId: 5,
            adminNotes: 'Manual redemption'
        });

        expect(result.success).toBe(true);
        expect(result.redemption).toBeDefined();
    });

    it('should redeem earned reward successfully', async () => {
        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 1, status: 'earned', offer_id: 10,
                        square_customer_id: 'cust_1', offer_name: 'Buy 12'
                    }]
                };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) {
                return { rows: [{ item_name: 'Dog Food', variation_name: 'Large' }] };
            }
            if (sql.includes('INSERT INTO loyalty_redemptions')) {
                return {
                    rows: [{
                        id: 50, reward_id: 1, offer_id: 10,
                        redeemed_value_cents: 3999
                    }]
                };
            }
            if (sql.includes('UPDATE loyalty_rewards') && sql.includes("status = 'redeemed'")) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const result = await redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1',
            redeemedVariationId: 'var_1',
            redeemedValueCents: 3999,
            squareLocationId: 'loc_1'
        });

        expect(result.success).toBe(true);
        expect(result.redemption.id).toBe(50);
        expect(result.reward.status).toBe('redeemed');

        // Verify discount cleanup was called
        expect(mockCleanupDiscount).toHaveBeenCalledWith(
            expect.objectContaining({
                merchantId: 1,
                squareCustomerId: 'cust_1',
                internalRewardId: 1
            })
        );
    });

    it('should still succeed if discount cleanup fails', async () => {
        mockCleanupDiscount.mockRejectedValueOnce(new Error('Square API down'));

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 1, status: 'earned', offer_id: 10,
                        square_customer_id: 'cust_1'
                    }]
                };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) {
                return { rows: [{ id: 50, reward_id: 1 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        // Should not throw even though cleanup fails
        const result = await redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1'
        });

        expect(result.success).toBe(true);
    });

    it('should rollback on database error', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN') return {};
            if (sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r')) {
                throw new Error('Connection lost');
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ord_1'
        })).rejects.toThrow('Connection lost');

        const queries = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
        expect(queries).toContain('ROLLBACK');
    });
});

// ============================================================================
// TESTS — matchEarnedRewardByFreeItem
// ============================================================================

describe('matchEarnedRewardByFreeItem', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return null when order has no customer_id', async () => {
        const order = {
            id: 'ord_1',
            line_items: [{ catalog_object_id: 'var_1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }]
        };

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
    });

    it('should use tender customer_id as fallback', async () => {
        const order = {
            id: 'ord_1',
            tenders: [{ customer_id: 'tender_cust' }],
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 5, offer_id: 10, square_customer_id: 'tender_cust',
                offer_name: 'Buy 12', matched_variation_id: 'var_1'
            }]
        });

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeDefined();
        expect(result.reward_id).toBe(5);
    });

    it('should use provided squareCustomerId override', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'order_cust',
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        db.query.mockResolvedValueOnce({ rows: [] });
        // Diagnostic query
        db.query.mockResolvedValueOnce({ rows: [] });

        await matchEarnedRewardByFreeItem(order, 1, { squareCustomerId: 'override_cust' });

        // Should use override_cust, not order_cust
        const firstCall = db.query.mock.calls[0];
        expect(firstCall[1][2]).toBe('override_cust');
    });

    it('should identify free items (base_price > 0, total_money = 0)', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_free', base_price_money: { amount: 3999 }, total_money: { amount: 0 } },
                { catalog_object_id: 'var_paid', base_price_money: { amount: 1500 }, total_money: { amount: 1500 } }
            ]
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 10, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Buy 12', matched_variation_id: 'var_free'
            }]
        });

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeDefined();
        expect(result.matched_variation_id).toBe('var_free');

        // Verify only free variation was queried
        const queryParams = db.query.mock.calls[0][1];
        expect(queryParams[1]).toEqual(['var_free']); // freeVariationIds
    });

    it('should return null when no free items found', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 1000 }, total_money: { amount: 1000 } }
            ]
        };

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('should return null when item has no base_price (base_price = 0)', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 0 }, total_money: { amount: 0 } }
            ]
        };

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
    });

    it('should handle items without catalog_object_id', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { name: 'Custom Item', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
    });

    it('should handle empty line_items', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: []
        };

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
    });

    it('should handle null total_money (defaults to base_price)', async () => {
        // When total_money is null/undefined, totalMoneyCents = unitPriceCents
        // So the item is NOT free (unitPrice > 0 && totalMoney == unitPrice)
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 1000 } }
                // No total_money
            ]
        };

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
    });
});

// ============================================================================
// TESTS — matchEarnedRewardByDiscountAmount
// ============================================================================

describe('matchEarnedRewardByDiscountAmount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return null when no squareCustomerId', async () => {
        const result = await matchEarnedRewardByDiscountAmount({
            order: { id: 'ord_1' },
            squareCustomerId: null,
            merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should return null when no earned rewards exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await matchEarnedRewardByDiscountAmount({
            order: { id: 'ord_1', line_items: [] },
            squareCustomerId: 'cust_1',
            merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should match when total discount >= 95% of expected value', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 10,
                offer_id: 5,
                square_customer_id: 'cust_1',
                offer_name: 'Buy 12',
                square_discount_id: 'disc_loyalty_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1', 'var_2']
            }]
        });

        // Expected value query
        db.query.mockResolvedValueOnce({
            rows: [{ expected_value_cents: 4000 }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_loyalty_1', applied_money: { amount: 3900 } }],
            line_items: [
                {
                    catalog_object_id: 'var_1',
                    total_discount_money: { amount: 3900 } // 97.5% of 4000
                },
                {
                    catalog_object_id: 'var_3', // Non-qualifying
                    total_discount_money: { amount: 500 }
                }
            ]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'cust_1',
            merchantId: 1
        });

        expect(result).toBeDefined();
        expect(result.reward_id).toBe(10);
        expect(result.totalDiscountCents).toBe(3900);
        expect(result.expectedValueCents).toBe(4000);
    });

    it('should not match when total discount < 95% of expected value', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 10,
                offer_id: 5,
                square_customer_id: 'cust_1',
                offer_name: 'Buy 12',
                square_discount_id: 'disc_loyalty_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        db.query.mockResolvedValueOnce({
            rows: [{ expected_value_cents: 4000 }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_loyalty_1', applied_money: { amount: 3700 } }],
            line_items: [
                {
                    catalog_object_id: 'var_1',
                    total_discount_money: { amount: 3700 } // 92.5% — below threshold
                }
            ]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'cust_1',
            merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should skip rewards with zero expected value', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 10,
                offer_id: 5,
                square_customer_id: 'cust_1',
                offer_name: 'Buy 12',
                square_discount_id: 'disc_loyalty_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        db.query.mockResolvedValueOnce({
            rows: [{ expected_value_cents: 0 }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_loyalty_1', applied_money: { amount: 3999 } }],
            line_items: [
                { catalog_object_id: 'var_1', total_discount_money: { amount: 3999 } }
            ]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'cust_1',
            merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should aggregate discount across multiple qualifying line items', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 10,
                offer_id: 5,
                square_customer_id: 'cust_1',
                offer_name: 'Buy 12',
                square_discount_id: 'disc_loyalty_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1', 'var_2']
            }]
        });

        db.query.mockResolvedValueOnce({
            rows: [{ expected_value_cents: 4000 }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_loyalty_1', applied_money: { amount: 4000 } }],
            line_items: [
                { catalog_object_id: 'var_1', total_discount_money: { amount: 2000 } },
                { catalog_object_id: 'var_2', total_discount_money: { amount: 2000 } }
            ]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order,
            squareCustomerId: 'cust_1',
            merchantId: 1
        });

        expect(result).toBeDefined();
        expect(result.totalDiscountCents).toBe(4000);
    });
});

// ============================================================================
// TESTS — detectRewardRedemptionFromOrder
// ============================================================================

describe('detectRewardRedemptionFromOrder', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should detect redemption via catalog_object_id (Strategy 1)', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{
                uid: 'd1',
                catalog_object_id: 'disc_cat_1',
                applied_money: { amount: 3999 }
            }],
            line_items: []
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                id: 42, offer_id: 10, square_customer_id: 'cust_1',
                offer_name: 'Buy 12', status: 'earned'
            }]
        });

        // Mock redeemReward (called internally via the module)
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return {
                    rows: [{
                        id: 42, status: 'earned', offer_id: 10,
                        square_customer_id: 'cust_1', offer_name: 'Buy 12'
                    }]
                };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) {
                return { rows: [{ id: 100, reward_id: 42 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        // LOGIC CHANGE (BACKLOG-59): Check redemptions array instead of singular rewardId
        expect(result.redemptions).toHaveLength(1);
        expect(result.redemptions[0].rewardId).toBe(42);
        expect(result.redemptions[0].detectionMethod).toBe('catalog_object_id');
    });

    it('should return detected: false when no discounts match', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            discounts: [{
                uid: 'd1',
                catalog_object_id: 'unrelated_disc'
            }],
            line_items: []
        };

        // Strategy 1 — no match
        db.query.mockResolvedValueOnce({ rows: [] });
        // Strategy 2 — matchEarnedRewardByFreeItem — no free items
        // Strategy 3 — matchEarnedRewardByDiscountAmount — no match
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]); // LOGIC CHANGE (BACKLOG-59)
    });

    it('should skip discounts without catalog_object_id', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            discounts: [
                { uid: 'd1', name: 'Manual Discount', applied_money: { amount: 500 } }
                // No catalog_object_id — should be skipped in Strategy 1
            ],
            line_items: []
        };

        // Strategy 2 — no free items
        // Strategy 3 — no match
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]); // LOGIC CHANGE (BACKLOG-59)
        // Strategy 1 query should not have been called
        // (first db.query call is Strategy 3's earned rewards query)
    });

    it('should support dryRun mode (detect without redeeming)', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{
                uid: 'd1',
                catalog_object_id: 'disc_cat_1',
                applied_money: { amount: 3999 }
            }],
            line_items: []
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                id: 42, offer_id: 10, square_customer_id: 'cust_1',
                offer_name: 'Buy 12', status: 'earned'
            }]
        });

        const result = await detectRewardRedemptionFromOrder(order, 1, { dryRun: true });

        expect(result.detected).toBe(true);
        // LOGIC CHANGE (BACKLOG-59): Check redemptions array
        expect(result.redemptions).toHaveLength(1);
        expect(result.redemptions[0].rewardId).toBe(42);
        // In dryRun, redeemReward should NOT be called
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    it('should handle empty order gracefully', async () => {
        const order = {
            id: 'ord_1',
            line_items: []
        };

        // Strategy 3
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]); // LOGIC CHANGE (BACKLOG-59)
    });

    it('should catch errors and return detected: false', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_1' }],
            line_items: []
        };

        db.query.mockRejectedValueOnce(new Error('DB connection lost'));

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]); // LOGIC CHANGE (BACKLOG-59)
        expect(result.error).toBe('DB connection lost');
    });

    it('should use squareCustomerId override for customer identification', async () => {
        const order = {
            id: 'ord_1',
            // No customer_id on order
            discounts: [],
            line_items: [],
            tenders: []
        };

        // Strategy 3 — matchEarnedRewardByDiscountAmount
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await detectRewardRedemptionFromOrder(order, 1, {
            squareCustomerId: 'override_cust'
        });

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]); // LOGIC CHANGE (BACKLOG-59)
    });

    it('should extract customer ID from tenders when order has no customer_id', async () => {
        const order = {
            id: 'ord_1',
            // No customer_id
            tenders: [{ id: 't1' }, { id: 't2', customer_id: 'tender_cust' }],
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_1', applied_money: { amount: 1000 } }],
            line_items: []
        };

        // Strategy 1 batch lookup finds a match
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 77, offer_id: 5, square_customer_id: 'tender_cust',
                offer_name: 'Test', status: 'earned',
                square_discount_id: 'disc_1'
            }]
        });

        // Mock redeemReward transaction
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 77, status: 'earned', offer_id: 5, square_customer_id: 'tender_cust' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 200, reward_id: 77 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions).toHaveLength(1);
    });

    it('should match via pricing_rule_id in order discount', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{
                uid: 'd1',
                catalog_object_id: null,
                pricing_rule_id: 'pr_loyalty_1',
                applied_money: { amount: 5000 }
            }],
            line_items: []
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                id: 55, offer_id: 10, square_customer_id: 'cust_1',
                offer_name: 'Buy 12', status: 'earned',
                square_pricing_rule_id: 'pr_loyalty_1'
            }]
        });

        // Mock redeemReward
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 55, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 300, reward_id: 55 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions[0].rewardId).toBe(55);
        expect(result.redemptions[0].detectionMethod).toBe('catalog_object_id');
    });

    it('should fall through Strategy 1 → 2 → 3 and detect via Strategy 3', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_loyalty_1' }],
            line_items: [
                {
                    catalog_object_id: 'var_1',
                    base_price_money: { amount: 5000 },
                    total_money: { amount: 1000 },
                    total_discount_money: { amount: 4000 }
                }
            ]
        };

        // Strategy 1: no earned reward match
        db.query.mockResolvedValueOnce({ rows: [] });

        // Strategy 2: matchEarnedRewardByFreeItem — no free items (total > 0)
        // (no db.query needed — function returns null before querying)

        // Strategy 3: matchEarnedRewardByDiscountAmount
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 88, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test Offer', square_discount_id: 'disc_loyalty_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });
        // Price query
        db.query.mockResolvedValueOnce({ rows: [{ expected_value_cents: 4000 }] });

        // Mock redeemReward
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 88, status: 'earned', offer_id: 5, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 400, reward_id: 88 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions[0].detectionMethod).toBe('discount_amount_fallback');
        expect(result.redemptions[0].rewardId).toBe(88);
    });

    it('should fall through Strategy 1 → detect via Strategy 2 (free item)', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'unrelated_disc' }],
            line_items: [
                {
                    catalog_object_id: 'var_free',
                    base_price_money: { amount: 3999 },
                    total_money: { amount: 0 }
                }
            ]
        };

        // Strategy 1: no match
        db.query.mockResolvedValueOnce({ rows: [] });

        // Strategy 2: matchEarnedRewardByFreeItem finds match
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 66, offer_id: 3, square_customer_id: 'cust_1',
                offer_name: 'Free Item Offer', matched_variation_id: 'var_free'
            }]
        });

        // Mock redeemReward
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 66, status: 'earned', offer_id: 3, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 500, reward_id: 66 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(true);
        expect(result.redemptions[0].detectionMethod).toBe('free_item_fallback');
        expect(result.redemptions[0].discountDetails.matchedVariationId).toBe('var_free');
    });

    it('should handle order with no discounts property', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: []
            // No discounts property at all
        };

        // Strategy 3
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        expect(result.detected).toBe(false);
        expect(result.redemptions).toEqual([]);
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — redeemReward edge cases
// ============================================================================

describe('redeemReward — additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should reject revoked reward', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'revoked', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1'
        })).rejects.toThrow('Cannot redeem reward in status: revoked');
    });

    it('should skip variation lookup when redeemedVariationId is null', async () => {
        const queryLog = [];
        mockClient.query.mockImplementation(async (sql, params) => {
            queryLog.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('INSERT INTO loyalty_redemptions')) {
                return { rows: [{ id: 50, reward_id: 1, offer_id: 10 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1'
            // No redeemedVariationId
        });

        // Verify no query for loyalty_qualifying_variations
        const varQuery = queryLog.find(q => q.includes('loyalty_qualifying_variations'));
        expect(varQuery).toBeUndefined();
    });

    it('should call updateCustomerSummary with transaction client', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1', offer_name: 'Test' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 50, reward_id: 1 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1',
            redeemedVariationId: 'var_1'
        });

        expect(mockUpdateCustomerSummary).toHaveBeenCalledWith(
            mockClient, 1, 'cust_1', 10
        );
    });

    it('should set triggeredBy to ADMIN when redeemedByUserId is provided', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 50, reward_id: 1 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1',
            redeemedByUserId: 99
        });

        expect(mockLogAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                triggeredBy: 'ADMIN',
                userId: 99
            }),
            mockClient
        );
    });

    it('should set triggeredBy to SYSTEM when no userId', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 50, reward_id: 1 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1'
        });

        expect(mockLogAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({ triggeredBy: 'SYSTEM' }),
            mockClient
        );
    });

    it('should pass redeemedAt to redemption insert and reward update', async () => {
        const customDate = '2026-03-01T12:00:00Z';
        const insertParams = [];

        mockClient.query.mockImplementation(async (sql, params) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('INSERT INTO loyalty_redemptions')) {
                insertParams.push(...params);
                return { rows: [{ id: 50, reward_id: 1 }] };
            }
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1',
            redeemedAt: customDate
        });

        // The COALESCE($14, NOW()) parameter should be the custom date
        expect(insertParams[13]).toBe(customDate);
    });

    it('should always release client even on audit event failure', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN') return {};
            if (sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 50 }] };
            if (sql.includes('UPDATE loyalty_rewards')) {
                throw new Error('Update failed');
            }
            return { rows: [] };
        });

        await expect(redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1'
        })).rejects.toThrow('Update failed');

        expect(mockClient.release).toHaveBeenCalled();
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — matchEarnedRewardByFreeItem edge cases
// ============================================================================

describe('matchEarnedRewardByFreeItem — additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should handle BigInt amounts from Square SDK v43+', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                {
                    catalog_object_id: 'var_1',
                    base_price_money: { amount: BigInt(3999) },
                    total_money: { amount: BigInt(0) }
                }
            ]
        };

        db.query.mockResolvedValueOnce({
            rows: [{ reward_id: 10, offer_id: 5, square_customer_id: 'cust_1', offer_name: 'Buy 12', matched_variation_id: 'var_1' }]
        });

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeDefined();
        expect(result.matched_variation_id).toBe('var_1');
    });

    it('should handle missing line_items key (undefined)', async () => {
        const order = { id: 'ord_1', customer_id: 'cust_1' };
        // No line_items property

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('should run diagnostic queries when no reward match found', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        // Main query: no match
        db.query.mockResolvedValueOnce({ rows: [] });

        // Diagnostic: qualifying variations exist but no earned reward
        db.query.mockResolvedValueOnce({
            rows: [{ variation_id: 'var_1', offer_id: 5, qv_active: true, offer_name: 'Test', offer_active: true }]
        });
        // Diagnostic: reward check
        db.query.mockResolvedValueOnce({
            rows: [{ reward_id: 99, offer_id: 5, square_customer_id: 'cust_1', status: 'redeemed' }]
        });

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
        // Verify diagnostic queries ran
        expect(db.query).toHaveBeenCalledTimes(3);
        expect(logger.warn).toHaveBeenCalledWith(
            'Strategy 2: free items found but no match — diagnostic',
            expect.objectContaining({ orderId: 'ord_1' })
        );
    });

    it('should handle diagnostic query failure without breaking', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        // Main query: no match
        db.query.mockResolvedValueOnce({ rows: [] });
        // Diagnostic: throws
        db.query.mockRejectedValueOnce(new Error('DB timeout'));

        const result = await matchEarnedRewardByFreeItem(order, 1);

        // Should not throw — diagnostic errors are swallowed
        expect(result).toBeNull();
    });

    it('should log when no qualifying variations found in diagnostic', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            line_items: [
                { catalog_object_id: 'var_orphan', base_price_money: { amount: 500 }, total_money: { amount: 0 } }
            ]
        };

        // Main: no match
        db.query.mockResolvedValueOnce({ rows: [] });
        // Diagnostic: no qualifying variations either
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await matchEarnedRewardByFreeItem(order, 1);

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Strategy 2: no qualifying variations found for free item IDs',
            expect.objectContaining({ freeVariationIds: ['var_orphan'] })
        );
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — matchEarnedRewardByDiscountAmount edge cases
// ============================================================================

describe('matchEarnedRewardByDiscountAmount — additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should match via pricing_rule_id (not just discount_id)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 20, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Buy 12', square_discount_id: null,
                square_pricing_rule_id: 'pr_loyalty_1',
                qualifying_variation_ids: ['var_1']
            }]
        });

        db.query.mockResolvedValueOnce({ rows: [{ expected_value_cents: 4000 }] });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'pr_loyalty_1', applied_money: { amount: 4000 } }],
            line_items: [{ catalog_object_id: 'var_1', total_discount_money: { amount: 4000 } }]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeDefined();
        expect(result.reward_id).toBe(20);
    });

    it('should skip reward when no discount IDs on reward (rewardDiscountIds empty)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 30, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: null,
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'some_disc' }],
            line_items: [{ catalog_object_id: 'var_1', total_discount_money: { amount: 5000 } }]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should skip reward when order discount is not from our loyalty (hasOurDiscount false)', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 40, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: 'disc_loyalty_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'unrelated_manual_disc' }],
            line_items: [{ catalog_object_id: 'var_1', total_discount_money: { amount: 5000 } }]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should skip reward when total discount on qualifying items is 0', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 50, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: 'disc_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_1' }],
            line_items: [{ catalog_object_id: 'var_1', total_discount_money: { amount: 0 } }]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should try second reward when first does not match', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                {
                    reward_id: 60, offer_id: 5, square_customer_id: 'cust_1',
                    offer_name: 'Offer A', square_discount_id: 'disc_a',
                    square_pricing_rule_id: null,
                    qualifying_variation_ids: ['var_a']
                },
                {
                    reward_id: 61, offer_id: 6, square_customer_id: 'cust_1',
                    offer_name: 'Offer B', square_discount_id: 'disc_b',
                    square_pricing_rule_id: null,
                    qualifying_variation_ids: ['var_b']
                }
            ]
        });

        // First reward: no qualifying line items with discount
        // Second reward: matches
        db.query.mockResolvedValueOnce({ rows: [{ expected_value_cents: 3000 }] });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_b', applied_money: { amount: 3000 } }],
            line_items: [
                { catalog_object_id: 'var_b', total_discount_money: { amount: 3000 } }
            ]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeDefined();
        expect(result.reward_id).toBe(61);
    });

    it('should handle order with empty discounts array', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 70, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: 'disc_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        const order = {
            id: 'ord_1',
            discounts: [],
            line_items: [{ catalog_object_id: 'var_1', total_discount_money: { amount: 5000 } }]
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeNull();
    });

    it('should handle line items without total_discount_money', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 80, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: 'disc_1',
                square_pricing_rule_id: null,
                qualifying_variation_ids: ['var_1']
            }]
        });

        const order = {
            id: 'ord_1',
            discounts: [{ catalog_object_id: 'disc_1' }],
            line_items: [{ catalog_object_id: 'var_1' }] // No total_discount_money
        };

        const result = await matchEarnedRewardByDiscountAmount({
            order, squareCustomerId: 'cust_1', merchantId: 1
        });

        expect(result).toBeNull();
    });
});

// ============================================================================
// BACKLOG-68: Square discount cleanup on redemption
// ============================================================================

describe('BACKLOG-68 — Square discount cleanup on redemption', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('redeemReward calls cleanupSquareCustomerGroupDiscount after successful redemption', async () => {
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 50, reward_id: 1 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1'
        });

        expect(mockCleanupDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'cust_1',
            internalRewardId: 1
        });
    });

    it('redeemReward still succeeds if cleanup throws (logs error, does not roll back)', async () => {
        mockCleanupDiscount.mockRejectedValueOnce(new Error('Square API timeout'));

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 1, status: 'earned', offer_id: 10, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 50, reward_id: 1 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await redeemReward({
            merchantId: 1, rewardId: 1, squareOrderId: 'ord_1',
            squareCustomerId: 'cust_1'
        });

        // Redemption succeeded despite cleanup failure
        expect(result.success).toBe(true);
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to cleanup Square discount after redemption (BACKLOG-68)',
            expect.objectContaining({ error: 'Square API timeout', rewardId: 1 })
        );
    });

    it('detectRewardRedemptionFromOrder calls cleanup after redemption (via redeemReward)', async () => {
        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_123' }],
            line_items: []
        };

        // Strategy 1: match by catalog_object_id
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 77, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: 'disc_123',
                square_pricing_rule_id: null, status: 'earned'
            }]
        });

        // Mock redeemReward internals
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 77, status: 'earned', offer_id: 5, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 300, reward_id: 77 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        await detectRewardRedemptionFromOrder(order, 1);

        expect(mockCleanupDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'cust_1',
            internalRewardId: 77
        });
    });

    it('detectRewardRedemptionFromOrder still succeeds if cleanup throws', async () => {
        mockCleanupDiscount.mockRejectedValueOnce(new Error('Network error'));

        const order = {
            id: 'ord_1',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            discounts: [{ uid: 'd1', catalog_object_id: 'disc_123' }],
            line_items: []
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                id: 77, offer_id: 5, square_customer_id: 'cust_1',
                offer_name: 'Test', square_discount_id: 'disc_123',
                square_pricing_rule_id: null, status: 'earned'
            }]
        });

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (sql.includes('FROM loyalty_rewards r') && sql.includes('FOR UPDATE')) {
                return { rows: [{ id: 77, status: 'earned', offer_id: 5, square_customer_id: 'cust_1' }] };
            }
            if (sql.includes('FROM loyalty_qualifying_variations')) return { rows: [] };
            if (sql.includes('INSERT INTO loyalty_redemptions')) return { rows: [{ id: 300, reward_id: 77 }] };
            if (sql.includes('UPDATE loyalty_rewards')) return { rows: [] };
            return { rows: [] };
        });

        const result = await detectRewardRedemptionFromOrder(order, 1);

        // Detection still succeeded despite cleanup failure
        expect(result.detected).toBe(true);
        expect(result.redemptions).toHaveLength(1);
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to cleanup Square discount after redemption (BACKLOG-68)',
            expect.objectContaining({ error: 'Network error' })
        );
    });
});

// ============================================================================
// ADDITIONAL COVERAGE — MAX_REDEMPTIONS_PER_ORDER constant
// ============================================================================

describe('MAX_REDEMPTIONS_PER_ORDER', () => {
    it('should be exported and be a positive integer', () => {
        expect(MAX_REDEMPTIONS_PER_ORDER).toBe(10);
        expect(Number.isInteger(MAX_REDEMPTIONS_PER_ORDER)).toBe(true);
    });
});
