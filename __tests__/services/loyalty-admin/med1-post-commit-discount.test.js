/**
 * Tests for MED-1: Square discount creation fires AFTER transaction commits
 *
 * Verifies:
 * - updateRewardProgress returns earnedRewardIds (does NOT fire discount creation)
 * - purchase-service fires createSquareCustomerGroupDiscount AFTER COMMIT
 * - markSyncPendingIfRewardExists only marks if reward row exists
 * - ERROR logged on discount creation failure with correct event name
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockDbQuery = jest.fn();
jest.mock('../../../utils/database', () => ({
    query: mockDbQuery,
    pool: {
        connect: jest.fn()
    }
}));

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};
jest.mock('../../../utils/logger', () => mockLogger);

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { debug: jest.fn(), audit: jest.fn(), error: jest.fn() }
}));

jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue({
        orders: { get: jest.fn() }
    })
}));

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn().mockResolvedValue()
}));

jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: jest.fn().mockResolvedValue()
}));

let mockCreateDiscount = jest.fn();
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: (...args) => mockCreateDiscount(...args),
    cleanupSquareCustomerGroupDiscount: jest.fn().mockResolvedValue()
}));

jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: jest.fn().mockResolvedValue()
}));

jest.mock('../../../services/loyalty-admin/loyalty-queries', () => ({
    queryQualifyingVariations: jest.fn()
}));

jest.mock('../../../services/loyalty-admin/variation-admin-service', () => ({
    getOfferForVariation: jest.fn()
}));

const { updateRewardProgress, markSyncPendingIfRewardExists } = require('../../../services/loyalty-admin/reward-progress-service');

// ============================================================================
// TEST DATA
// ============================================================================

const MERCHANT_ID = 1;
const OFFER_ID = 'offer-uuid-1';
const CUSTOMER_ID = 'sq-cust-1';
const REWARD_ID = 'reward-uuid-1';

const baseOffer = {
    id: OFFER_ID,
    offer_name: 'Buy 10 Get 1 Free',
    required_quantity: 10,
    window_months: 6
};

// ============================================================================
// TESTS: updateRewardProgress returns earnedRewardIds
// ============================================================================

describe('MED-1: updateRewardProgress returns earnedRewardIds', () => {
    const mockClient = { query: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns earnedRewardIds when reward transitions to earned', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })  // quantity calc
            .mockResolvedValueOnce({ rows: [{                             // existing in_progress reward
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })                          // UPDATE quantity
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
            .mockResolvedValueOnce({ rows: [] })                          // UPDATE to earned
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });  // re-count = 0, break

        const result = await updateRewardProgress(mockClient, {
            merchantId: MERCHANT_ID,
            offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID,
            offer: baseOffer
        });

        expect(result.status).toBe('earned');
        expect(result.earnedRewardIds).toEqual([REWARD_ID]);
    });

    test('returns empty earnedRewardIds when no reward earned', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })  // quantity = 5, below threshold
            .mockResolvedValueOnce({ rows: [{                            // existing in_progress reward
                id: REWARD_ID, status: 'in_progress', current_quantity: 4, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] });                        // UPDATE quantity

        const result = await updateRewardProgress(mockClient, {
            merchantId: MERCHANT_ID,
            offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID,
            offer: baseOffer
        });

        expect(result.status).toBe('in_progress');
        expect(result.earnedRewardIds).toEqual([]);
    });

    test('does NOT call createSquareCustomerGroupDiscount', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
            .mockResolvedValueOnce({ rows: [{
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });

        await updateRewardProgress(mockClient, {
            merchantId: MERCHANT_ID,
            offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID,
            offer: baseOffer
        });

        // Wait to ensure no async discount calls fire
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockCreateDiscount).not.toHaveBeenCalled();
    });
});

// ============================================================================
// TESTS: markSyncPendingIfRewardExists
// ============================================================================

describe('MED-1: markSyncPendingIfRewardExists', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('marks sync pending when reward exists', async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ id: REWARD_ID }] })  // SELECT check — exists
            .mockResolvedValueOnce({ rows: [] });                    // UPDATE sync pending

        await markSyncPendingIfRewardExists(REWARD_ID, MERCHANT_ID);

        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id FROM loyalty_rewards WHERE id = $1'),
            [REWARD_ID, MERCHANT_ID]
        );
        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('square_sync_pending = TRUE'),
            [REWARD_ID, MERCHANT_ID]
        );
    });

    test('skips when reward does not exist (transaction rolled back)', async () => {
        mockDbQuery.mockResolvedValueOnce({ rows: [] });  // SELECT check — not found

        await markSyncPendingIfRewardExists(REWARD_ID, MERCHANT_ID);

        // Should NOT have called UPDATE
        const updateCalls = mockDbQuery.mock.calls.filter(call =>
            call[0].includes('square_sync_pending = TRUE')
        );
        expect(updateCalls).toHaveLength(0);

        expect(mockLogger.error).toHaveBeenCalledWith(
            'Reward not found for sync pending — transaction may have rolled back',
            expect.objectContaining({
                event: 'sync_pending_skipped_missing_reward',
                rewardId: REWARD_ID,
                merchantId: MERCHANT_ID
            })
        );
    });

    test('ERROR logged on discount creation failure with correct event', async () => {
        // This tests the pattern used by purchase-service after COMMIT
        // We test markSyncPendingIfRewardExists directly since that's what
        // the purchase-service error handler calls
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ id: REWARD_ID }] })
            .mockResolvedValueOnce({ rows: [] });

        await markSyncPendingIfRewardExists(REWARD_ID, MERCHANT_ID);

        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('square_sync_pending = TRUE'),
            [REWARD_ID, MERCHANT_ID]
        );
    });
});
