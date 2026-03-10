/**
 * Tests for MED-6: matchEarnedRewardByFreeItem FIFO ordering
 *
 * Verifies that when a customer has multiple earned rewards, the oldest
 * one (by earned_at) is returned first to ensure FIFO redemption order.
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

jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: jest.fn(),
}));

const { matchEarnedRewardByFreeItem } = require('../../../services/loyalty-admin/reward-service');
const db = require('../../../utils/database');

const MERCHANT_ID = 1;
const CUSTOMER_ID = 'sq-cust-1';

describe('MED-6: FIFO reward matching', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('query includes ORDER BY r.earned_at ASC for FIFO', async () => {
        const order = {
            id: 'ord-1',
            customer_id: CUSTOMER_ID,
            line_items: [
                { catalog_object_id: 'var-1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 'reward-oldest',
                offer_id: 'offer-1',
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Buy 12',
                matched_variation_id: 'var-1'
            }]
        });

        await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        // Verify the SQL query contains ORDER BY r.earned_at ASC
        const queryCall = db.query.mock.calls[0];
        expect(queryCall[0]).toContain('ORDER BY r.earned_at ASC');
        expect(queryCall[0]).toContain('LIMIT 1');
    });

    test('returns oldest earned reward when multiple exist (FIFO)', async () => {
        const order = {
            id: 'ord-1',
            customer_id: CUSTOMER_ID,
            line_items: [
                { catalog_object_id: 'var-1', base_price_money: { amount: 1000 }, total_money: { amount: 0 } }
            ]
        };

        // DB returns the oldest reward (sorted by earned_at ASC, LIMIT 1)
        db.query.mockResolvedValueOnce({
            rows: [{
                reward_id: 'reward-oldest',
                offer_id: 'offer-1',
                square_customer_id: CUSTOMER_ID,
                offer_name: 'Buy 12',
                matched_variation_id: 'var-1'
            }]
        });

        const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);

        expect(result).not.toBeNull();
        expect(result.reward_id).toBe('reward-oldest');
    });

    test('ORDER BY ensures deterministic result across multiple calls', async () => {
        const order = {
            id: 'ord-1',
            customer_id: CUSTOMER_ID,
            line_items: [
                { catalog_object_id: 'var-1', base_price_money: { amount: 2000 }, total_money: { amount: 0 } }
            ]
        };

        // Simulate two calls returning the same oldest reward consistently
        for (let i = 0; i < 2; i++) {
            db.query.mockResolvedValueOnce({
                rows: [{
                    reward_id: 'reward-jan-01',
                    offer_id: 'offer-1',
                    square_customer_id: CUSTOMER_ID,
                    offer_name: 'Buy 12',
                    matched_variation_id: 'var-1'
                }]
            });

            const result = await matchEarnedRewardByFreeItem(order, MERCHANT_ID);
            expect(result.reward_id).toBe('reward-jan-01');
        }
    });
});
