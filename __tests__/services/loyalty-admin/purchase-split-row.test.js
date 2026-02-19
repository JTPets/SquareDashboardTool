/**
 * Tests for split-row rollover logic in purchase-service.js
 *
 * Verifies that updateRewardProgress correctly splits crossing rows,
 * preserves rollover units, and handles multi-threshold scenarios.
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn(),
    },
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/constants', () => ({
    RewardStatus: {
        IN_PROGRESS: 'in_progress',
        EARNED: 'earned',
        REDEEMED: 'redeemed',
        REVOKED: 'revoked',
    },
    AuditActions: {
        PURCHASE_RECORDED: 'PURCHASE_RECORDED',
        REWARD_PROGRESS_UPDATED: 'REWARD_PROGRESS_UPDATED',
        REWARD_EARNED: 'REWARD_EARNED',
        REFUND_PROCESSED: 'REFUND_PROCESSED',
        REWARD_REVOKED: 'REWARD_REVOKED',
    },
}));

jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/variation-admin-service', () => ({
    getOfferForVariation: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: jest.fn().mockResolvedValue({ success: true }),
}));

const { updateRewardProgress } = require('../../../services/loyalty-admin/purchase-service');
const { logAuditEvent } = require('../../../services/loyalty-admin/audit-service');
const { createSquareCustomerGroupDiscount } = require('../../../services/loyalty-admin/square-discount-service');

describe('updateRewardProgress — split-row rollover', () => {
    let mockClient;

    const merchantId = 1;
    const offerId = 10;
    const squareCustomerId = 'CUST_ABC';
    const offer = {
        id: 10,
        offer_name: 'Buy 12 Get 1 Free',
        required_quantity: 12,
        window_months: 12,
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockClient = {
            query: jest.fn(),
        };
    });

    // Helper: mock a sequence of client.query calls
    function mockQuerySequence(...results) {
        results.forEach(result => {
            mockClient.query.mockResolvedValueOnce(result);
        });
    }

    test('exact threshold — 12 purchases of qty=1, no rollover', async () => {
        // Progress query: 12 unlocked units
        mockQuerySequence(
            { rows: [{ total_quantity: '12' }] },           // SUM query
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 11 }] }, // SELECT FOR UPDATE
            { rows: [] },                                     // UPDATE current_quantity (void)
        );

        // Inside the while loop (threshold crossed):
        mockQuerySequence(
            // Step 1: Lock fully-consumed rows (12 rows, cumulative all <= 12)
            { rows: [
                { id: 'p1', quantity: 1, cumulative_qty: 1 },
                { id: 'p2', quantity: 1, cumulative_qty: 2 },
                { id: 'p3', quantity: 1, cumulative_qty: 3 },
                { id: 'p4', quantity: 1, cumulative_qty: 4 },
                { id: 'p5', quantity: 1, cumulative_qty: 5 },
                { id: 'p6', quantity: 1, cumulative_qty: 6 },
                { id: 'p7', quantity: 1, cumulative_qty: 7 },
                { id: 'p8', quantity: 1, cumulative_qty: 8 },
                { id: 'p9', quantity: 1, cumulative_qty: 9 },
                { id: 'p10', quantity: 1, cumulative_qty: 10 },
                { id: 'p11', quantity: 1, cumulative_qty: 11 },
                { id: 'p12', quantity: 1, cumulative_qty: 12 },
            ] },
            // neededFromCrossing = 12 - 12 = 0 → skip Step 2
            // Transition to earned
            { rows: [] },                                     // UPDATE status = earned
        );

        // Audit log for REWARD_EARNED
        // (logAuditEvent is mocked)

        // Re-count for multi-threshold check
        mockQuerySequence(
            { rows: [{ total_quantity: '0' }] },              // 0 remaining → break
        );

        // updateCustomerSummary mocks (5 queries)
        mockQuerySequence(
            { rows: [{ current_quantity: 0, lifetime_purchases: 12, last_purchase: new Date(), window_start: null, window_end: null }] },
            { rows: [{ count: 0 }] },        // earned count
            { rows: [{ count: 0 }] },        // redeemed count
            { rows: [{ count: 1 }] },        // total earned
            { rows: [{ required_quantity: 12 }] }, // offer query
            { rows: [] },                     // UPSERT summary
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        expect(result.status).toBe('earned');
        expect(result.currentQuantity).toBe(0);

        // No split INSERT should have been called (neededFromCrossing = 0)
        const insertCalls = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('split_locked')
        );
        expect(insertCalls).toHaveLength(0);

        // Audit event should have been logged
        expect(logAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'REWARD_EARNED',
                rewardId: 'reward-1',
            }),
            mockClient
        );
    });

    test('rollover case — 14 units toward buy 12, 2 units carry over', async () => {
        // Progress query: 14 unlocked units
        mockQuerySequence(
            { rows: [{ total_quantity: '14' }] },
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 11 }] },
            { rows: [] },  // UPDATE current_quantity
        );

        // Inside while loop:
        mockQuerySequence(
            // Step 1: Lock fully-consumed rows (10 rows of qty=1, all cumulative <= 12)
            { rows: [
                { id: 'p1', quantity: 1, cumulative_qty: 1 },
                { id: 'p2', quantity: 1, cumulative_qty: 2 },
                { id: 'p3', quantity: 1, cumulative_qty: 3 },
                { id: 'p4', quantity: 1, cumulative_qty: 4 },
                { id: 'p5', quantity: 1, cumulative_qty: 5 },
                { id: 'p6', quantity: 1, cumulative_qty: 6 },
                { id: 'p7', quantity: 1, cumulative_qty: 7 },
                { id: 'p8', quantity: 1, cumulative_qty: 8 },
                { id: 'p9', quantity: 1, cumulative_qty: 9 },
                { id: 'p10', quantity: 1, cumulative_qty: 10 },
            ] },
            // neededFromCrossing = 12 - 10 = 2
            // Step 2: Find crossing row (qty=4 at cumulative=14)
            { rows: [{
                id: 'p11', quantity: 4, square_order_id: 'ORD-1',
                variation_id: 'VAR-1', unit_price_cents: 500,
                purchased_at: new Date(), idempotency_key: 'key-11',
                window_start_date: '2026-01-01', window_end_date: '2027-01-01',
                square_location_id: 'LOC-1', receipt_url: null,
                customer_source: 'order', payment_type: 'CARD',
            }] },
            // Insert locked child (qty=2)
            { rows: [] },
            // Insert unlocked excess (qty=2)
            { rows: [] },
            // Transition to earned
            { rows: [] },
        );

        // Re-count for multi-threshold check
        mockQuerySequence(
            { rows: [{ total_quantity: '2' }] },  // 2 remaining < 12 → break
        );

        // updateCustomerSummary (6 queries)
        mockQuerySequence(
            { rows: [{ current_quantity: 2, lifetime_purchases: 14, last_purchase: new Date(), window_start: '2026-01-01', window_end: '2027-01-01' }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 1 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        expect(result.status).toBe('earned');
        expect(result.currentQuantity).toBe(2);

        // Verify split inserts were called — check params array for idempotency keys
        const insertCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_locked'))
        );
        expect(insertCalls).toHaveLength(1);
        // locked portion = 2 (neededFromCrossing)
        expect(insertCalls[0][1]).toContain(2);

        const excessCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_excess'))
        );
        expect(excessCalls).toHaveLength(1);
        // excess portion = 2
        expect(excessCalls[0][1]).toContain(2);
    });

    test('single large purchase crossing threshold — 1 row qty=14 toward buy 12', async () => {
        // Progress query: 14 unlocked units
        mockQuerySequence(
            { rows: [{ total_quantity: '14' }] },
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 0 }] },
            { rows: [] },  // UPDATE current_quantity
        );

        // Inside while loop:
        mockQuerySequence(
            // Step 1: Lock fully-consumed rows — none! (single row cumulative=14 > 12)
            { rows: [] },
            // neededFromCrossing = 12 - 0 = 12
            // Step 2: Find crossing row (qty=14)
            { rows: [{
                id: 'p1', quantity: 14, square_order_id: 'ORD-BIG',
                variation_id: 'VAR-1', unit_price_cents: 500,
                purchased_at: new Date(), idempotency_key: 'key-big',
                window_start_date: '2026-01-01', window_end_date: '2027-01-01',
                square_location_id: 'LOC-1', receipt_url: null,
                customer_source: 'order', payment_type: 'CARD',
            }] },
            // Insert locked child (qty=12)
            { rows: [] },
            // Insert unlocked excess (qty=2)
            { rows: [] },
            // Transition to earned
            { rows: [] },
        );

        // Re-count for multi-threshold check
        mockQuerySequence(
            { rows: [{ total_quantity: '2' }] },  // 2 remaining < 12 → break
        );

        // updateCustomerSummary
        mockQuerySequence(
            { rows: [{ current_quantity: 2, lifetime_purchases: 14, last_purchase: new Date(), window_start: '2026-01-01', window_end: '2027-01-01' }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 1 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        expect(result.status).toBe('earned');
        expect(result.currentQuantity).toBe(2);

        // Verify locked child got qty=12
        const insertCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_locked'))
        );
        expect(insertCalls).toHaveLength(1);
        expect(insertCalls[0][1]).toContain(12);  // neededFromCrossing = 12

        // Verify excess child got qty=2
        const excessCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_excess'))
        );
        expect(excessCalls).toHaveLength(1);
        expect(excessCalls[0][1]).toContain(2);
    });

    test('multiple small purchases — last one crosses (10 + 2 + 2 = 14)', async () => {
        // Progress query: 14 unlocked units
        mockQuerySequence(
            { rows: [{ total_quantity: '14' }] },
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 12 }] },
            { rows: [] },  // UPDATE current_quantity
        );

        // Inside while loop:
        mockQuerySequence(
            // Step 1: Lock fully-consumed rows (10 + 2 = 12 ≤ 12)
            { rows: [
                { id: 'p1', quantity: 10, cumulative_qty: 10 },
                { id: 'p2', quantity: 2, cumulative_qty: 12 },
            ] },
            // neededFromCrossing = 12 - 12 = 0 → no split needed
            // Transition to earned
            { rows: [] },
        );

        // Re-count: 2 remaining
        mockQuerySequence(
            { rows: [{ total_quantity: '2' }] },
        );

        // updateCustomerSummary
        mockQuerySequence(
            { rows: [{ current_quantity: 2, lifetime_purchases: 14, last_purchase: new Date(), window_start: '2026-01-01', window_end: '2027-01-01' }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 1 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        expect(result.status).toBe('earned');
        expect(result.currentQuantity).toBe(2);

        // No splits needed — all rows locked exactly
        const insertCalls = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('split_locked')
        );
        expect(insertCalls).toHaveLength(0);
    });

    test('multi-threshold — 26 units toward buy 12 earns 2 rewards', async () => {
        // Progress query: 26 unlocked units
        mockQuerySequence(
            { rows: [{ total_quantity: '26' }] },
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 25 }] },
            { rows: [] },  // UPDATE current_quantity
        );

        // === First reward cycle ===
        mockQuerySequence(
            // Step 1: Lock 12 fully-consumed rows
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1,
            })) },
            // neededFromCrossing = 12 - 12 = 0 → no split
            // Transition reward-1 to earned
            { rows: [] },
        );

        // Re-count after first reward: 26 - 12 = 14 remaining
        mockQuerySequence(
            { rows: [{ total_quantity: '14' }] },
        );

        // 14 >= 12 → create next in_progress reward
        mockQuerySequence(
            { rows: [{ id: 'reward-2', status: 'in_progress', current_quantity: 14 }] },
        );

        // === Second reward cycle ===
        mockQuerySequence(
            // Step 1: Lock 12 fully-consumed rows
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 13}`, quantity: 1, cumulative_qty: i + 1,
            })) },
            // neededFromCrossing = 12 - 12 = 0
            // Transition reward-2 to earned
            { rows: [] },
        );

        // Re-count after second reward: 14 - 12 = 2 remaining
        mockQuerySequence(
            { rows: [{ total_quantity: '2' }] },
            // 2 < 12 → break
        );

        // updateCustomerSummary
        mockQuerySequence(
            { rows: [{ current_quantity: 2, lifetime_purchases: 26, last_purchase: new Date(), window_start: '2026-01-01', window_end: '2027-01-01' }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 2 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        // Final state: second reward earned, 2 units remaining
        expect(result.status).toBe('earned');
        expect(result.currentQuantity).toBe(2);

        // Should have 2 REWARD_EARNED audit events
        expect(logAuditEvent).toHaveBeenCalledTimes(3);  // 1 progress update + 2 earned
        const earnedCalls = logAuditEvent.mock.calls.filter(
            c => c[0].action === 'REWARD_EARNED'
        );
        expect(earnedCalls).toHaveLength(2);

        // Should have called createSquareCustomerGroupDiscount twice
        expect(createSquareCustomerGroupDiscount).toHaveBeenCalledTimes(2);
    });

    test('below threshold — no reward earned, progress updated', async () => {
        // Progress query: 8 unlocked units (below 12 threshold)
        mockQuerySequence(
            { rows: [{ total_quantity: '8' }] },
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 7 }] },
            { rows: [] },  // UPDATE current_quantity
        );

        // While loop condition fails: 8 < 12
        // Straight to updateCustomerSummary
        mockQuerySequence(
            { rows: [{ current_quantity: 8, lifetime_purchases: 8, last_purchase: new Date(), window_start: '2026-01-01', window_end: '2027-01-01' }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        expect(result.status).toBe('in_progress');
        expect(result.currentQuantity).toBe(8);
        expect(logAuditEvent).toHaveBeenCalledTimes(1);  // Only progress update
        expect(createSquareCustomerGroupDiscount).not.toHaveBeenCalled();
    });

    test('zero quantity — no progress, no reward', async () => {
        // Progress query: 0 unlocked units
        mockQuerySequence(
            { rows: [{ total_quantity: '0' }] },
            { rows: [] },  // No in_progress reward
        );

        // No reward, no while loop
        // updateCustomerSummary
        mockQuerySequence(
            { rows: [{ current_quantity: 0, lifetime_purchases: 0, last_purchase: null, window_start: null, window_end: null }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        const result = await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        expect(result.status).toBe('no_progress');
        expect(result.currentQuantity).toBe(0);
        expect(logAuditEvent).not.toHaveBeenCalled();
        expect(createSquareCustomerGroupDiscount).not.toHaveBeenCalled();
    });

    test('post-threshold actions fire — audit, Square discount, customer summary', async () => {
        // Progress query: 12 exact
        mockQuerySequence(
            { rows: [{ total_quantity: '12' }] },
            { rows: [{ id: 'reward-1', status: 'in_progress', current_quantity: 11 }] },
            { rows: [] },  // UPDATE current_quantity
        );

        // Lock all 12
        mockQuerySequence(
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1,
            })) },
            { rows: [] },  // Transition to earned
        );

        // Re-count: 0 remaining
        mockQuerySequence(
            { rows: [{ total_quantity: '0' }] },
        );

        // updateCustomerSummary
        mockQuerySequence(
            { rows: [{ current_quantity: 0, lifetime_purchases: 12, last_purchase: new Date(), window_start: null, window_end: null }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 0 }] },
            { rows: [{ count: 1 }] },
            { rows: [{ required_quantity: 12 }] },
            { rows: [] },
        );

        await updateRewardProgress(mockClient, {
            merchantId, offerId, squareCustomerId, offer
        });

        // Audit logged
        expect(logAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'REWARD_EARNED',
                rewardId: 'reward-1',
                offerId: 10,
                squareCustomerId: 'CUST_ABC',
            }),
            mockClient
        );

        // Square discount created
        expect(createSquareCustomerGroupDiscount).toHaveBeenCalledWith({
            merchantId: 1,
            squareCustomerId: 'CUST_ABC',
            internalRewardId: 'reward-1',
            offerId: 10,
        });
    });
});
