/**
 * Tests for LA-4 fix: Square sync retry for failed discount creation
 *
 * Tests cover:
 * 1. square-sync-retry-service.js: retry logic for pending syncs
 * 2. loyalty-sync-retry-job.js: cron job wrapper
 * 3. reward-progress-service.js: markSyncPending called on failure
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

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn().mockResolvedValue()
}));

jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: jest.fn().mockResolvedValue()
}));

jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: jest.fn().mockResolvedValue()
}));

const mockCreateDiscount = jest.fn();
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: mockCreateDiscount
}));

const mockUpdateCustomerStats = require('../../../services/loyalty-admin/customer-cache-service').updateCustomerStats;
const mockUpdateCustomerSummary = require('../../../services/loyalty-admin/customer-summary-service').updateCustomerSummary;

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

// ============================================================================
// TEST SUITE: square-sync-retry-service.js — retry logic
// ============================================================================

describe('square-sync-retry-service: retryPendingSquareSyncs', () => {
    const { retryPendingSquareSyncs } = require('../../../services/loyalty-admin/square-sync-retry-service');

    beforeEach(() => {
        jest.resetAllMocks();
    });

    it('should return zero counts when no pending syncs exist', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await retryPendingSquareSyncs(1);

        expect(result).toEqual({
            retried: 0,
            succeeded: 0,
            failed: 0,
            errors: []
        });
    });

    it('should retry and clear flag on success', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 'reward-1',
                    square_customer_id: 'cust-1',
                    offer_id: 'offer-1'
                }]
            })
            .mockResolvedValueOnce({ rows: [] }); // clear flag

        mockCreateDiscount.mockResolvedValueOnce({
            success: true,
            groupId: 'grp-1',
            discountId: 'disc-1'
        });

        const result = await retryPendingSquareSyncs(1);

        expect(result.retried).toBe(1);
        expect(result.succeeded).toBe(1);
        expect(result.failed).toBe(0);

        // Verify flag was cleared
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('square_sync_pending = FALSE'),
            ['reward-1', 1]
        );

        // Verify discount was called with correct params
        expect(mockCreateDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'cust-1',
            internalRewardId: 'reward-1',
            offerId: 'offer-1'
        });
    });

    it('should keep flag set when retry returns success: false', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'reward-1',
                square_customer_id: 'cust-1',
                offer_id: 'offer-1'
            }]
        });

        mockCreateDiscount.mockResolvedValueOnce({
            success: false,
            error: 'Still failing'
        });

        const result = await retryPendingSquareSyncs(1);

        expect(result.retried).toBe(1);
        expect(result.succeeded).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.errors[0].error).toBe('Still failing');

        // Should NOT have cleared the flag (only 1 db.query call — the initial SELECT)
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should handle thrown exceptions during retry', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                id: 'reward-1',
                square_customer_id: 'cust-1',
                offer_id: 'offer-1'
            }]
        });

        mockCreateDiscount.mockRejectedValueOnce(new Error('Connection refused'));

        const result = await retryPendingSquareSyncs(1);

        expect(result.failed).toBe(1);
        expect(result.errors[0].error).toBe('Connection refused');
    });

    it('should process multiple pending rewards — partial success', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 'reward-1', square_customer_id: 'cust-1', offer_id: 'offer-1' },
                { id: 'reward-2', square_customer_id: 'cust-2', offer_id: 'offer-2' }
            ]
        });

        // First succeeds, second fails
        mockCreateDiscount
            .mockResolvedValueOnce({ success: true, groupId: 'g1', discountId: 'd1' })
            .mockResolvedValueOnce({ success: false, error: 'API error' });

        db.query.mockResolvedValueOnce({ rows: [] }); // clear flag for reward-1

        const result = await retryPendingSquareSyncs(1);

        expect(result.retried).toBe(2);
        expect(result.succeeded).toBe(1);
        expect(result.failed).toBe(1);
    });

    it('should throw if merchantId is missing', async () => {
        await expect(retryPendingSquareSyncs(undefined))
            .rejects.toThrow('merchantId is required');
    });
});

// ============================================================================
// TEST SUITE: loyalty-sync-retry-job.js — cron job
// ============================================================================

describe('loyalty-sync-retry-job', () => {
    const { runLoyaltySyncRetry, runScheduledLoyaltySyncRetry } = require('../../../jobs/loyalty-sync-retry-job');

    beforeEach(() => {
        jest.resetAllMocks();
    });

    it('should return zero counts when no merchants have pending syncs', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runLoyaltySyncRetry();

        expect(result.merchantsProcessed).toBe(0);
        expect(result.totalRetried).toBe(0);
    });

    it('should process merchants with pending syncs', async () => {
        // getMerchantsWithPendingSyncs
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

        // retryPendingSquareSyncs query finds 1 pending reward
        db.query.mockResolvedValueOnce({
            rows: [{ id: 'reward-1', square_customer_id: 'cust-1', offer_id: 'offer-1' }]
        });

        mockCreateDiscount.mockResolvedValueOnce({
            success: true,
            groupId: 'g1',
            discountId: 'd1'
        });

        // clear flag
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await runLoyaltySyncRetry();

        expect(result.merchantsProcessed).toBe(1);
        expect(result.totalSucceeded).toBe(1);
    });

    it('should not throw from scheduled wrapper on DB error', async () => {
        db.query.mockRejectedValueOnce(new Error('DB down'));

        await expect(runScheduledLoyaltySyncRetry()).resolves.toBeUndefined();
    });
});

// ============================================================================
// TEST SUITE: reward-progress-service.js — earnedRewardIds return
// ============================================================================

describe('reward-progress-service: returns earnedRewardIds for post-commit handling', () => {
    const { updateRewardProgress } = require('../../../services/loyalty-admin/reward-progress-service');

    const mockClient = { query: jest.fn() };

    const baseData = {
        merchantId: 1,
        offerId: 'offer-1',
        squareCustomerId: 'cust-1',
        offer: {
            offer_name: 'Test Offer',
            required_quantity: 3
        }
    };

    beforeEach(() => {
        jest.resetAllMocks();
        // Restore mock implementations cleared by resetAllMocks
        mockUpdateCustomerStats.mockResolvedValue();
        mockUpdateCustomerSummary.mockResolvedValue();
    });

    /**
     * Helper: set up mockClient to simulate earning a reward.
     */
    function setupEarnReward(rewardId) {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: 3 }] })    // quantity check
            .mockResolvedValueOnce({ rows: [{                            // existing in_progress reward
                id: rewardId,
                current_quantity: 2,
                status: 'in_progress'
            }] })
            .mockResolvedValueOnce({ rows: [] })                         // update quantity
            .mockResolvedValueOnce({                                     // lock rows
                rows: [{ id: 'lock-1', quantity: 3, cumulative_qty: 3 }]
            })
            .mockResolvedValueOnce({ rows: [] })                         // transition to earned
            .mockResolvedValueOnce({ rows: [{ total_quantity: 0 }] });   // recount
    }

    // LOGIC CHANGE (MED-1): updateRewardProgress no longer fires discount
    // creation — it returns earnedRewardIds for the caller (purchase-service)
    // to handle post-commit.

    it('should return earnedRewardIds when reward transitions to earned', async () => {
        setupEarnReward('reward-earned');

        const result = await updateRewardProgress(mockClient, baseData);

        expect(result.earnedRewardIds).toEqual(['reward-earned']);
        expect(result.status).toBe('earned');
    });

    it('should return empty earnedRewardIds when no reward earned', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: 2 }] })    // below threshold
            .mockResolvedValueOnce({ rows: [{
                id: 'reward-ip',
                current_quantity: 1,
                status: 'in_progress'
            }] })
            .mockResolvedValueOnce({ rows: [] });                        // update quantity

        const result = await updateRewardProgress(mockClient, baseData);

        expect(result.earnedRewardIds).toEqual([]);
        expect(result.status).toBe('in_progress');
    });

    it('should NOT call createSquareCustomerGroupDiscount directly', async () => {
        setupEarnReward('reward-ok');

        await updateRewardProgress(mockClient, baseData);
        await new Promise(resolve => setTimeout(resolve, 100));

        // discount creation should NOT be called from updateRewardProgress
        expect(mockCreateDiscount).not.toHaveBeenCalled();

        // db.query should NOT have been called with sync_pending
        const syncPendingCalls = db.query.mock.calls.filter(
            call => typeof call[0] === 'string' && call[0].includes('square_sync_pending')
        );
        expect(syncPendingCalls).toHaveLength(0);
    });
});
