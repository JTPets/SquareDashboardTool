/**
 * Tests for expiration-service.js
 *
 * Validates tenant isolation (merchant_id) on all UPDATE/DELETE queries
 * in processExpiredEarnedRewards (LA-10 fix).
 * Validates updateCustomerSummary is called after revocation (LA-24 fix).
 * Validates MED-2: per-iteration error handling in processExpiredWindowEntries.
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

jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: jest.fn().mockResolvedValue(),
}));

const { processExpiredEarnedRewards, processExpiredWindowEntries } = require('../../../services/loyalty-admin/expiration-service');
const { updateCustomerSummary } = require('../../../services/loyalty-admin/customer-summary-service');
const { logAuditEvent } = require('../../../services/loyalty-admin/audit-service');
const { updateRewardProgress } = require('../../../services/loyalty-admin/reward-progress-service');

const MERCHANT_ID = 42;

describe('processExpiredEarnedRewards', () => {
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

        db.query.mockResolvedValueOnce({ rows: [expiredReward] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        // Find the UPDATE loyalty_rewards call on the transaction client
        const revokeCalls = mockClient.query.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('UPDATE loyalty_rewards')
        );
        expect(revokeCalls).toHaveLength(1);
        const [revokeSql, revokeParams] = revokeCalls[0];
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

        db.query.mockResolvedValueOnce({ rows: [expiredReward] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        const unlockCalls = mockClient.query.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('UPDATE loyalty_purchase_events')
        );
        expect(unlockCalls).toHaveLength(1);
        const [unlockSql, unlockParams] = unlockCalls[0];
        expect(unlockSql).toContain('AND merchant_id = $2');
        expect(unlockParams).toEqual([expiredReward.id, MERCHANT_ID]);
    });

    test('LA-24: calls updateCustomerSummary after reward revocation', async () => {
        const expiredReward = {
            id: 10,
            offer_id: 'offer-uuid-5',
            offer_name: 'Test Offer',
            square_customer_id: 'CUST_1',
            earned_at: '2025-01-01',
            square_discount_id: null,
            square_group_id: null
        };

        db.query.mockResolvedValueOnce({ rows: [expiredReward] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        expect(updateCustomerSummary).toHaveBeenCalledTimes(1);
        expect(updateCustomerSummary).toHaveBeenCalledWith(
            mockClient,
            MERCHANT_ID,
            'CUST_1',
            'offer-uuid-5'
        );
    });

    test('LA-24: calls updateCustomerSummary for each expired reward', async () => {
        const rewards = [
            { id: 10, offer_id: 'offer-5', offer_name: 'Offer A', square_customer_id: 'CUST_1', earned_at: '2025-01-01', square_discount_id: null, square_group_id: null },
            { id: 20, offer_id: 'offer-6', offer_name: 'Offer B', square_customer_id: 'CUST_2', earned_at: '2025-02-01', square_discount_id: null, square_group_id: null }
        ];

        db.query.mockResolvedValueOnce({ rows: rewards });

        const result = await processExpiredEarnedRewards(MERCHANT_ID);

        expect(result.processedCount).toBe(2);
        expect(result.revokedRewards).toHaveLength(2);
        expect(updateCustomerSummary).toHaveBeenCalledTimes(2);
        expect(updateCustomerSummary).toHaveBeenCalledWith(mockClient, MERCHANT_ID, 'CUST_1', 'offer-5');
        expect(updateCustomerSummary).toHaveBeenCalledWith(mockClient, MERCHANT_ID, 'CUST_2', 'offer-6');
    });

    test('LA-24: audit event uses transaction client', async () => {
        const expiredReward = {
            id: 10,
            offer_id: 'offer-5',
            offer_name: 'Test Offer',
            square_customer_id: 'CUST_1',
            earned_at: '2025-01-01',
            square_discount_id: null,
            square_group_id: null
        };

        db.query.mockResolvedValueOnce({ rows: [expiredReward] });

        await processExpiredEarnedRewards(MERCHANT_ID);

        expect(logAuditEvent).toHaveBeenCalledTimes(1);
        // Second argument should be the transaction client
        expect(logAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                merchantId: MERCHANT_ID,
                action: expect.any(String),
                rewardId: 10,
                squareCustomerId: 'CUST_1'
            }),
            mockClient
        );
    });

    test('processes multiple expired rewards with correct merchant_id', async () => {
        const rewards = [
            { id: 10, offer_id: 'offer-5', offer_name: 'Offer A', square_customer_id: 'CUST_1', earned_at: '2025-01-01', square_discount_id: null, square_group_id: null },
            { id: 20, offer_id: 'offer-6', offer_name: 'Offer B', square_customer_id: 'CUST_2', earned_at: '2025-02-01', square_discount_id: null, square_group_id: null }
        ];

        db.query.mockResolvedValueOnce({ rows: rewards });

        const result = await processExpiredEarnedRewards(MERCHANT_ID);

        expect(result.processedCount).toBe(2);
        expect(result.revokedRewards).toHaveLength(2);

        // Verify all UPDATE queries on the client include merchant_id
        const updateCalls = mockClient.query.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('UPDATE')
        );
        for (const [, params] of updateCalls) {
            expect(params).toContain(MERCHANT_ID);
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

    // MED-2 tests: per-iteration error handling

    test('MED-2: continues processing after one record fails', async () => {
        const rows = [
            { offer_id: 1, square_customer_id: 'CUST_A' },
            { offer_id: 2, square_customer_id: 'CUST_B' },
            { offer_id: 3, square_customer_id: 'CUST_C' }
        ];
        db.query.mockResolvedValueOnce({ rows });

        // First record: BEGIN, then offer query succeeds
        // Second record: will throw
        // Third record: succeeds
        let callCount = 0;
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            // Offer query
            if (typeof sql === 'string' && sql.includes('SELECT * FROM loyalty_offers')) {
                callCount++;
                if (callCount === 2) {
                    throw new Error('DB connection lost');
                }
                return { rows: [{ id: callCount, required_quantity: 12 }] };
            }
            return { rows: [] };
        });

        const result = await processExpiredWindowEntries(MERCHANT_ID);

        // Should have processed 2 out of 3 (first and third)
        expect(result.processedCount).toBe(2);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].squareCustomerId).toBe('CUST_B');
        expect(result.errors[0].offerId).toBe(2);
        expect(result.errors[0].error).toBe('DB connection lost');
    });

    test('MED-2: does not throw when individual record fails', async () => {
        const rows = [
            { offer_id: 1, square_customer_id: 'CUST_A' }
        ];
        db.query.mockResolvedValueOnce({ rows });

        // Simulate updateRewardProgress throwing
        updateRewardProgress.mockRejectedValueOnce(new Error('reward progress failed'));
        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
            if (typeof sql === 'string' && sql.includes('SELECT * FROM loyalty_offers')) {
                return { rows: [{ id: 1 }] };
            }
            return { rows: [] };
        });

        // Should NOT throw
        const result = await processExpiredWindowEntries(MERCHANT_ID);

        expect(result.processedCount).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toBe('reward progress failed');
    });

    test('MED-2: logs error with structured fields for failed records', async () => {
        const logger = require('../../../utils/logger');
        const rows = [
            { offer_id: 7, square_customer_id: 'CUST_X' }
        ];
        db.query.mockResolvedValueOnce({ rows });

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
            if (typeof sql === 'string' && sql.includes('SELECT * FROM loyalty_offers')) {
                throw new Error('table not found');
            }
            return { rows: [] };
        });

        await processExpiredWindowEntries(MERCHANT_ID);

        expect(logger.error).toHaveBeenCalledWith(
            'Error processing expired entry',
            expect.objectContaining({
                event: 'expiration_processing_error',
                squareCustomerId: 'CUST_X',
                offerId: 7,
                merchantId: MERCHANT_ID,
                error: 'table not found'
            })
        );
    });

    test('MED-2: rolls back per-record transaction on failure', async () => {
        const rows = [
            { offer_id: 1, square_customer_id: 'CUST_A' }
        ];
        db.query.mockResolvedValueOnce({ rows });

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
            if (typeof sql === 'string' && sql.includes('SELECT * FROM loyalty_offers')) {
                throw new Error('some error');
            }
            return { rows: [] };
        });

        await processExpiredWindowEntries(MERCHANT_ID);

        const rollbackCalls = mockClient.query.mock.calls.filter(
            ([sql]) => sql === 'ROLLBACK'
        );
        expect(rollbackCalls).toHaveLength(1);
    });

    test('MED-2: returns empty errors array when all records succeed', async () => {
        const rows = [
            { offer_id: 1, square_customer_id: 'CUST_A' }
        ];
        db.query.mockResolvedValueOnce({ rows });

        mockClient.query.mockImplementation(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT') return {};
            if (typeof sql === 'string' && sql.includes('SELECT * FROM loyalty_offers')) {
                return { rows: [{ id: 1 }] };
            }
            return { rows: [] };
        });

        const result = await processExpiredWindowEntries(MERCHANT_ID);

        expect(result.processedCount).toBe(1);
        expect(result.errors).toEqual([]);
    });
});
