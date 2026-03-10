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
const {
    redeemReward,
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount
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
});
