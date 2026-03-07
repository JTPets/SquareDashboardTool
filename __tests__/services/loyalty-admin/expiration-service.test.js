/**
 * Tests for expiration-service.js
 *
 * Validates tenant isolation (merchant_id) on all UPDATE/DELETE queries
 * in processExpiredEarnedRewards (LA-10 fix).
 */

const db = require('../../../utils/database');

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn().mockResolvedValue(),
}));

jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    cleanupSquareCustomerGroupDiscount: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../services/loyalty-admin/reward-progress-service', () => ({
    updateRewardProgress: jest.fn().mockResolvedValue(),
}));

const { processExpiredEarnedRewards, processExpiredWindowEntries } = require('../../../services/loyalty-admin/expiration-service');

const MERCHANT_ID = 42;
const OTHER_MERCHANT_ID = 99;

describe('processExpiredEarnedRewards', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws if merchantId is missing', async () => {
        await expect(processExpiredEarnedRewards(null)).rejects.toThrow('merchantId is required');
        await expect(processExpiredEarnedRewards(undefined)).rejects.toThrow('merchantId is required');
    });

    test('includes merchant_id in the expired rewards SELECT query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('r.merchant_id = $1');
        expect(params).toEqual([MERCHANT_ID]);
    });

    test('includes merchant_id in NOT EXISTS subquery for purchase events', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('pe.merchant_id = $1');
    });

    test('includes merchant_id in UPDATE loyalty_rewards query', async () => {
        const expiredReward = {
            id: 10,
            offer_id: 5,
            offer_name: 'Test Offer',
            square_customer_id: 'CUST_1',
            earned_at: '2025-01-01',
            square_discount_id: null,
            square_group_id: null
        };

        // First call: SELECT expired rewards
        db.query.mockResolvedValueOnce({ rows: [expiredReward] });
        // Second call: UPDATE loyalty_rewards
        db.query.mockResolvedValueOnce({ rows: [] });
        // Third call: UPDATE loyalty_purchase_events (unlock)
        db.query.mockResolvedValueOnce({ rows: [] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        // The UPDATE loyalty_rewards call (second query)
        const [revokeSql, revokeParams] = db.query.mock.calls[1];
        expect(revokeSql).toContain('UPDATE loyalty_rewards');
        expect(revokeSql).toContain('AND merchant_id = $2');
        expect(revokeParams).toEqual([expiredReward.id, MERCHANT_ID]);
    });

    test('LA-10: includes merchant_id in UPDATE loyalty_purchase_events (unlock) query', async () => {
        const expiredReward = {
            id: 10,
            offer_id: 5,
            offer_name: 'Test Offer',
            square_customer_id: 'CUST_1',
            earned_at: '2025-01-01',
            square_discount_id: null,
            square_group_id: null
        };

        // First call: SELECT expired rewards
        db.query.mockResolvedValueOnce({ rows: [expiredReward] });
        // Second call: UPDATE loyalty_rewards
        db.query.mockResolvedValueOnce({ rows: [] });
        // Third call: UPDATE loyalty_purchase_events (unlock)
        db.query.mockResolvedValueOnce({ rows: [] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        // The UPDATE loyalty_purchase_events call (third query)
        const [unlockSql, unlockParams] = db.query.mock.calls[2];
        expect(unlockSql).toContain('UPDATE loyalty_purchase_events');
        expect(unlockSql).toContain('AND merchant_id = $2');
        expect(unlockParams).toEqual([expiredReward.id, MERCHANT_ID]);
    });

    test('processes multiple expired rewards with correct merchant_id', async () => {
        const rewards = [
            { id: 10, offer_id: 5, offer_name: 'Offer A', square_customer_id: 'CUST_1', earned_at: '2025-01-01', square_discount_id: null, square_group_id: null },
            { id: 20, offer_id: 6, offer_name: 'Offer B', square_customer_id: 'CUST_2', earned_at: '2025-02-01', square_discount_id: null, square_group_id: null }
        ];

        db.query.mockResolvedValueOnce({ rows: rewards });
        // For each reward: UPDATE rewards + UPDATE purchase_events = 2 queries
        db.query.mockResolvedValue({ rows: [] });

        const result = await processExpiredEarnedRewards(MERCHANT_ID);

        expect(result.processedCount).toBe(2);
        expect(result.revokedRewards).toHaveLength(2);

        // Verify all UPDATE queries include merchant_id
        for (let i = 1; i < db.query.mock.calls.length; i++) {
            const [sql, params] = db.query.mock.calls[i];
            if (sql.includes('UPDATE')) {
                expect(params).toContain(MERCHANT_ID);
            }
        }
    });
});

describe('processExpiredWindowEntries', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn()
        };
        db.pool = { connect: jest.fn().mockResolvedValue(mockClient) };
    });

    test('throws if merchantId is missing', async () => {
        await expect(processExpiredWindowEntries(null)).rejects.toThrow('merchantId is required');
    });

    test('includes merchant_id in expired entries SELECT query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await processExpiredWindowEntries(MERCHANT_ID);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('merchant_id = $1');
        expect(params).toEqual([MERCHANT_ID]);
    });
});
