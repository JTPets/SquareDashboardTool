/**
 * Tests for services/loyalty-admin/redemption-audit-service.js
 *
 * Missed redemption audit: re-scans recent orders through all detection
 * strategies to catch missed reward redemptions.
 * Covers:
 * - auditMissedRedemptions: token handling, reward discovery, order filtering,
 *   detection logic, dry-run vs live, multi-redemption (BACKLOG-59)
 * - fetchOrderFromSquare: OK/error/throw paths
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../../utils/database', () => ({
    query: jest.fn()
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const mockFetchWithTimeout = jest.fn();
jest.mock('../../../services/loyalty-admin/shared-utils', () => ({
    fetchWithTimeout: mockFetchWithTimeout
}));

const mockDecryptToken = jest.fn(t => `decrypted_${t}`);
const mockIsEncryptedToken = jest.fn();
jest.mock('../../../utils/token-encryption', () => ({
    decryptToken: mockDecryptToken,
    isEncryptedToken: mockIsEncryptedToken
}));

jest.mock('../../../services/loyalty-admin/constants', () => ({
    RedemptionTypes: { AUTO_DETECTED: 'auto_detected' }
}));

const mockDetectRewardRedemptionFromOrder = jest.fn();
const mockRedeemReward = jest.fn();
jest.mock('../../../services/loyalty-admin/reward-service', () => ({
    detectRewardRedemptionFromOrder: mockDetectRewardRedemptionFromOrder,
    redeemReward: mockRedeemReward
}));

const db = require('../../../utils/database');
const { auditMissedRedemptions } = require('../../../services/loyalty-admin/redemption-audit-service');

// ============================================================================
// HELPERS
// ============================================================================

function mockMerchantToken(token = 'encrypted_token', isEncrypted = true) {
    db.query.mockResolvedValueOnce({
        rows: [{ square_access_token: token }]
    });
    mockIsEncryptedToken.mockReturnValueOnce(isEncrypted);
}

function mockEarnedRewards(rewards = []) {
    db.query.mockResolvedValueOnce({ rows: rewards });
}

function mockProcessedOrders(orders = []) {
    db.query.mockResolvedValueOnce({ rows: orders });
}

function mockRedeemedOrders(orderIds = []) {
    db.query.mockResolvedValueOnce({
        rows: orderIds.map(id => ({ square_order_id: id }))
    });
}

function mockCustomerName(name = null) {
    db.query.mockResolvedValueOnce({
        rows: name ? [{ display_name: name }] : []
    });
}

// ============================================================================
// TESTS — auditMissedRedemptions
// ============================================================================

describe('auditMissedRedemptions', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should throw when no access token configured', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(auditMissedRedemptions({ merchantId: 1 }))
            .rejects.toThrow('No Square access token configured');
    });

    it('should throw when merchant not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(auditMissedRedemptions({ merchantId: 999 }))
            .rejects.toThrow('No Square access token configured');
    });

    it('should decrypt encrypted tokens', async () => {
        mockMerchantToken('enc_token_123', true);
        mockEarnedRewards([]);

        await auditMissedRedemptions({ merchantId: 1 });

        expect(mockDecryptToken).toHaveBeenCalledWith('enc_token_123');
    });

    it('should use raw token when not encrypted', async () => {
        mockMerchantToken('raw_token', false);
        mockEarnedRewards([]);

        await auditMissedRedemptions({ merchantId: 1 });

        expect(mockDecryptToken).not.toHaveBeenCalled();
    });

    it('should return early with zero counts when no earned rewards exist', async () => {
        mockMerchantToken();
        mockEarnedRewards([]);

        const result = await auditMissedRedemptions({ merchantId: 1 });

        expect(result).toEqual({
            scanned: { rewards: 0, orders: 0 },
            matches: [],
            dryRun: true
        });
    });

    it('should use default 7 days and dryRun=true', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        // Orders for customer
        mockProcessedOrders([]);

        const result = await auditMissedRedemptions({ merchantId: 1 });

        expect(result.dryRun).toBe(true);
        expect(result.scanned.rewards).toBe(1);
    });

    it('should filter out orders that already have redemptions', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        // Two orders found
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' },
            { square_order_id: 'ORD_2', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        // ORD_1 already redeemed
        mockRedeemedOrders(['ORD_1']);

        // Only ORD_2 should be fetched
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_2', customer_id: 'CUST_1', created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });
        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({ detected: false });

        const result = await auditMissedRedemptions({ merchantId: 1 });

        expect(result.scanned.orders).toBe(1);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('should filter out orders outside the time window', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        // Order is 30 days old (outside default 7 day window)
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 30);
        mockProcessedOrders([
            { square_order_id: 'ORD_OLD', processed_at: oldDate.toISOString(), square_customer_id: 'CUST_1' }
        ]);

        const result = await auditMissedRedemptions({ merchantId: 1, days: 7 });

        // Order is outside window, so no orders to scan
        expect(result.scanned.orders).toBe(0);
    });

    it('should detect missed redemption and add to matches (dry run)', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Buy 10'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        // Fetch order from Square
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });

        // Detection finds a match
        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({
            detected: true,
            redemptions: [{
                rewardId: 1,
                squareCustomerId: 'CUST_1',
                offerName: 'Buy 10',
                detectionMethod: 'FREE_ITEM',
                discountDetails: { totalDiscountCents: 5999 }
            }]
        });

        // Customer name lookup
        mockCustomerName('John Doe');

        const result = await auditMissedRedemptions({ merchantId: 1, dryRun: true });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toEqual(expect.objectContaining({
            rewardId: 1,
            orderId: 'ORD_1',
            customerName: 'John Doe',
            strategy: 'FREE_ITEM',
            redeemed: false  // dry run — not redeemed
        }));
        expect(mockRedeemReward).not.toHaveBeenCalled();
    });

    it('should actually redeem reward when dryRun is false', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Buy 10'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T10:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });

        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({
            detected: true,
            redemptions: [{
                rewardId: 1,
                squareCustomerId: 'CUST_1',
                offerName: 'Buy 10',
                detectionMethod: 'CATALOG_ID',
                discountDetails: { totalDiscountCents: 5999 }
            }]
        });
        mockRedeemReward.mockResolvedValueOnce();
        mockCustomerName('Jane');

        const result = await auditMissedRedemptions({ merchantId: 1, dryRun: false });

        expect(result.matches[0].redeemed).toBe(true);
        expect(mockRedeemReward).toHaveBeenCalledWith(expect.objectContaining({
            merchantId: 1,
            rewardId: 1,
            squareOrderId: 'ORD_1',
            squareCustomerId: 'CUST_1',
            redemptionType: 'auto_detected',
            redeemedValueCents: 5999,
            squareLocationId: 'LOC_1',
            adminNotes: 'Audit remediation (Strategy: CATALOG_ID)',
            redeemedAt: '2026-03-14T10:00:00Z'
        }));
    });

    it('should handle redeemReward throwing an error gracefully', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Buy 10'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T10:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });

        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({
            detected: true,
            redemptions: [{
                rewardId: 1, squareCustomerId: 'CUST_1', offerName: 'Buy 10',
                detectionMethod: 'FREE_ITEM', discountDetails: { totalDiscountCents: 5999 }
            }]
        });
        mockRedeemReward.mockRejectedValueOnce(new Error('Already redeemed'));
        mockCustomerName(null);

        const result = await auditMissedRedemptions({ merchantId: 1, dryRun: false });

        expect(result.matches[0].redeemed).toBe(false);
        expect(result.matches).toHaveLength(1);
    });

    it('should handle multi-redemption results (BACKLOG-59)', async () => {
        mockMerchantToken();
        mockEarnedRewards([
            { reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Offer A' },
            { reward_id: 2, offer_id: 11, square_customer_id: 'CUST_1', offer_name: 'Offer B' }
        ]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });

        // Detection returns multiple redemptions for one order
        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({
            detected: true,
            redemptions: [
                {
                    rewardId: 1, squareCustomerId: 'CUST_1', offerName: 'Offer A',
                    detectionMethod: 'FREE_ITEM', discountDetails: { totalDiscountCents: 3000 }
                },
                {
                    rewardId: 2, squareCustomerId: 'CUST_1', offerName: 'Offer B',
                    detectionMethod: 'DISCOUNT_AMOUNT', discountDetails: { totalDiscountCents: 5000 }
                }
            ]
        });

        mockCustomerName('Multi Customer');
        mockCustomerName('Multi Customer');

        const result = await auditMissedRedemptions({ merchantId: 1, dryRun: true });

        expect(result.matches).toHaveLength(2);
        expect(result.matches[0].rewardId).toBe(1);
        expect(result.matches[0].strategy).toBe('FREE_ITEM');
        expect(result.matches[1].rewardId).toBe(2);
        expect(result.matches[1].strategy).toBe('DISCOUNT_AMOUNT');
    });

    it('should skip orders that cannot be fetched from Square', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        // Fetch returns non-OK
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: false, status: 404, statusText: 'Not Found'
        });

        const result = await auditMissedRedemptions({ merchantId: 1 });

        expect(result.scanned.orders).toBe(1);
        expect(result.matches).toHaveLength(0);
    });

    it('should skip orders where detection finds no match', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });
        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({ detected: false });

        const result = await auditMissedRedemptions({ merchantId: 1 });

        expect(result.matches).toHaveLength(0);
    });

    it('should handle errors during individual order processing gracefully', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        // Fetch succeeds but detection throws
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });
        mockDetectRewardRedemptionFromOrder.mockRejectedValueOnce(new Error('Unexpected DB error'));

        const result = await auditMissedRedemptions({ merchantId: 1 });

        // Should not throw — error is caught per-order
        expect(result.scanned.orders).toBe(1);
        expect(result.matches).toHaveLength(0);
    });

    it('should use appliedMoney fallback when totalDiscountCents is missing', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T10:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });

        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({
            detected: true,
            redemptions: [{
                rewardId: 1, squareCustomerId: 'CUST_1', offerName: 'Test',
                detectionMethod: 'DISCOUNT_AMOUNT',
                discountDetails: { appliedMoney: { amount: 4999 } }  // No totalDiscountCents
            }]
        });
        mockRedeemReward.mockResolvedValueOnce();
        mockCustomerName(null);

        const result = await auditMissedRedemptions({ merchantId: 1, dryRun: false });

        expect(mockRedeemReward).toHaveBeenCalledWith(expect.objectContaining({
            redeemedValueCents: 4999
        }));
        expect(result.matches[0].redeemed).toBe(true);
    });

    it('should pass known customerId from processed orders to detection', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_KNOWN', offer_name: 'Test'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_KNOWN' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: null,  // Square order lacks customer_id
                    created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });
        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({ detected: false });

        await auditMissedRedemptions({ merchantId: 1 });

        // Should pass the known customer ID from processed orders
        expect(mockDetectRewardRedemptionFromOrder).toHaveBeenCalledWith(
            expect.anything(),
            1,
            { dryRun: true, squareCustomerId: 'CUST_KNOWN' }
        );
    });

    it('should deduplicate customer IDs for batch order query', async () => {
        mockMerchantToken();
        // Two rewards for same customer
        mockEarnedRewards([
            { reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'A' },
            { reward_id: 2, offer_id: 11, square_customer_id: 'CUST_1', offer_name: 'B' }
        ]);
        mockProcessedOrders([]);

        await auditMissedRedemptions({ merchantId: 1 });

        // Batch query should use deduplicated customer IDs
        const batchCall = db.query.mock.calls[2]; // 3rd query
        expect(batchCall[1][1]).toEqual(['CUST_1']); // only one, deduplicated
    });

    it('should handle customer name lookup failure gracefully', async () => {
        mockMerchantToken();
        mockEarnedRewards([{
            reward_id: 1, offer_id: 10, square_customer_id: 'CUST_1', offer_name: 'Test'
        }]);
        mockProcessedOrders([
            { square_order_id: 'ORD_1', processed_at: new Date().toISOString(), square_customer_id: 'CUST_1' }
        ]);
        mockRedeemedOrders([]);

        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true, status: 200,
            json: async () => ({
                order: {
                    id: 'ORD_1', customer_id: 'CUST_1', created_at: '2026-03-14T12:00:00Z',
                    location_id: 'LOC_1', discounts: [], line_items: []
                }
            })
        });

        mockDetectRewardRedemptionFromOrder.mockResolvedValueOnce({
            detected: true,
            redemptions: [{
                rewardId: 1, squareCustomerId: 'CUST_1', offerName: 'Test',
                detectionMethod: 'FREE_ITEM', discountDetails: { totalDiscountCents: 1000 }
            }]
        });

        // Customer name lookup throws
        db.query.mockRejectedValueOnce(new Error('DB down'));

        const result = await auditMissedRedemptions({ merchantId: 1 });

        // Should still add the match, with null customerName
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].customerName).toBeNull();
    });
});
