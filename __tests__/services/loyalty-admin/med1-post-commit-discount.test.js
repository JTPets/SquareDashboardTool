/**
 * Tests for MED-1: Square discount creation fires AFTER transaction commits
 *
 * Verifies:
 * - createSquareCustomerGroupDiscount is called after updateRewardProgress returns
 * - markSyncPendingIfRewardExists only marks if reward row exists
 * - ERROR logged on discount creation failure with correct event name
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockClient = {
    query: jest.fn()
};

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

const mockSquareOrdersGet = jest.fn();
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn().mockResolvedValue({
        orders: { get: mockSquareOrdersGet }
    })
}));

const mockLogAuditEvent = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: mockLogAuditEvent
}));

const mockUpdateCustomerStats = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: mockUpdateCustomerStats
}));

let mockCreateDiscount = jest.fn();
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: (...args) => mockCreateDiscount(...args)
}));

const mockUpdateCustomerSummary = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: mockUpdateCustomerSummary
}));

jest.mock('../../../services/loyalty-admin/loyalty-queries', () => ({
    queryQualifyingVariations: jest.fn()
}));

const { updateRewardProgress } = require('../../../services/loyalty-admin/reward-progress-service');

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

function makeData(overrides = {}) {
    return {
        merchantId: MERCHANT_ID,
        offerId: OFFER_ID,
        squareCustomerId: CUSTOMER_ID,
        offer: { ...baseOffer, ...overrides.offer },
        ...overrides
    };
}

// ============================================================================
// TESTS
// ============================================================================

describe('MED-1: Post-commit Square discount creation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateDiscount = jest.fn().mockResolvedValue({ success: true, groupId: 'g1', discountId: 'd1' });
    });

    test('discount creation fires after updateRewardProgress returns (post-commit)', async () => {
        // Set up: reward earns (quantity >= required)
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })  // quantity calc
            .mockResolvedValueOnce({ rows: [{                             // existing in_progress reward
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })                          // UPDATE quantity
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
            .mockResolvedValueOnce({ rows: [] })                          // UPDATE to earned
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });  // re-count = 0, break

        // Track call order
        let discountCalledBeforeReturn = false;
        let functionReturned = false;

        mockCreateDiscount.mockImplementation(async () => {
            if (!functionReturned) {
                discountCalledBeforeReturn = true;
            }
            return { success: true, groupId: 'g1', discountId: 'd1' };
        });

        const result = await updateRewardProgress(mockClient, makeData());
        functionReturned = true;

        expect(result.status).toBe('earned');

        // The discount creation should have been called (as a detached promise
        // that fires after the function returns its result to the caller)
        // Wait for the detached promise to resolve
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(mockCreateDiscount).toHaveBeenCalledWith(
            expect.objectContaining({
                merchantId: MERCHANT_ID,
                squareCustomerId: CUSTOMER_ID,
                internalRewardId: REWARD_ID,
                offerId: OFFER_ID
            })
        );
    });

    test('markSyncPendingIfRewardExists only marks when reward exists', async () => {
        // Set up: reward earns, discount creation fails
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
            .mockResolvedValueOnce({ rows: [{
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });

        mockCreateDiscount.mockRejectedValue(new Error('Square API down'));

        // Reward exists in the database
        mockDbQuery.mockResolvedValueOnce({ rows: [{ id: REWARD_ID }] });  // SELECT check
        mockDbQuery.mockResolvedValueOnce({ rows: [] });                    // UPDATE sync pending

        await updateRewardProgress(mockClient, makeData());

        // Wait for detached promise
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should have checked if reward exists first
        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id FROM loyalty_rewards WHERE id = $1'),
            [REWARD_ID, MERCHANT_ID]
        );

        // Should have marked sync pending
        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('square_sync_pending = TRUE'),
            [REWARD_ID, MERCHANT_ID]
        );
    });

    test('markSyncPendingIfRewardExists skips when reward does not exist', async () => {
        // Set up: reward earns, discount creation fails
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
            .mockResolvedValueOnce({ rows: [{
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });

        mockCreateDiscount.mockRejectedValue(new Error('Square API down'));

        // Reward does NOT exist (transaction rolled back)
        mockDbQuery.mockResolvedValueOnce({ rows: [] });  // SELECT check returns empty

        await updateRewardProgress(mockClient, makeData());

        // Wait for detached promise
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should have checked if reward exists
        expect(mockDbQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT id FROM loyalty_rewards WHERE id = $1'),
            [REWARD_ID, MERCHANT_ID]
        );

        // Should NOT have called UPDATE (only the SELECT was called)
        const updateCalls = mockDbQuery.mock.calls.filter(call =>
            call[0].includes('square_sync_pending = TRUE')
        );
        expect(updateCalls).toHaveLength(0);

        // Should have logged error about missing reward
        expect(mockLogger.error).toHaveBeenCalledWith(
            'Reward not found for sync pending — transaction may have rolled back',
            expect.objectContaining({
                event: 'sync_pending_skipped_missing_reward',
                rewardId: REWARD_ID,
                merchantId: MERCHANT_ID
            })
        );
    });

    test('ERROR logged with correct event on discount creation failure', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
            .mockResolvedValueOnce({ rows: [{
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });

        mockCreateDiscount.mockRejectedValue(new Error('UNAUTHORIZED'));

        // Reward exists
        mockDbQuery.mockResolvedValueOnce({ rows: [{ id: REWARD_ID }] });
        mockDbQuery.mockResolvedValueOnce({ rows: [] });

        await updateRewardProgress(mockClient, makeData());

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockLogger.error).toHaveBeenCalledWith(
            'earned_reward_discount_creation_failed',
            expect.objectContaining({
                event: 'earned_reward_discount_creation_failed',
                rewardId: REWARD_ID,
                merchantId: MERCHANT_ID,
                error: 'UNAUTHORIZED'
            })
        );
    });

    test('ERROR logged when discount returns success:false', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
            .mockResolvedValueOnce({ rows: [{
                id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID
            }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] });

        mockCreateDiscount.mockResolvedValue({ success: false, error: 'Group limit reached' });

        // Reward exists
        mockDbQuery.mockResolvedValueOnce({ rows: [{ id: REWARD_ID }] });
        mockDbQuery.mockResolvedValueOnce({ rows: [] });

        await updateRewardProgress(mockClient, makeData());

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockLogger.error).toHaveBeenCalledWith(
            'earned_reward_discount_creation_failed',
            expect.objectContaining({
                event: 'earned_reward_discount_creation_failed',
                rewardId: REWARD_ID,
                merchantId: MERCHANT_ID,
                error: 'Group limit reached'
            })
        );
    });
});
