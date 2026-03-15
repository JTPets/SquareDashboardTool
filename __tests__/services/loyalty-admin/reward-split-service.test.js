/**
 * Tests for services/loyalty-admin/reward-split-service.js
 *
 * Covers processThresholdCrossing():
 * 1. Exact threshold (12 units, buy 12) → earns, no split needed
 * 2. Over threshold (14 units, buy 12) → earns, crossing row split into 12+2
 * 3. Multi-threshold (26 units, buy 12) → earns twice, 2 rollover
 * 4. Single large purchase crossing boundary (qty=14, buy 12) → split into 12+2
 * 5. Zero excess after lock (exactly fills) → no excess child created
 * 6. Crossing row with FOR UPDATE SKIP LOCKED → verify query includes it
 * 7. New in_progress reward created with correct initial quantity on rollover
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() }
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

const mockUpdateCustomerStats = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: mockUpdateCustomerStats
}));

const { processThresholdCrossing } = require('../../../services/loyalty-admin/reward-split-service');

// ============================================================================
// TEST DATA
// ============================================================================

const MERCHANT_ID = 1;
const OFFER_ID = 10;
const CUSTOMER_ID = 'CUST_ABC';

const offer = {
    id: 10,
    offer_name: 'Buy 12 Get 1 Free',
    required_quantity: 12,
    window_months: 12
};

function makeMockClient() {
    return { query: jest.fn() };
}

function mockQuerySequence(client, ...results) {
    results.forEach(r => client.query.mockResolvedValueOnce(r));
}

function makeCrossingRow(overrides = {}) {
    return {
        id: 'p-cross', quantity: 4, square_order_id: 'ORD-1',
        variation_id: 'VAR-1', unit_price_cents: 500,
        purchased_at: new Date('2026-03-01'), idempotency_key: 'key-cross',
        window_start_date: '2026-01-01', window_end_date: '2027-01-01',
        square_location_id: 'LOC-1', receipt_url: null,
        customer_source: 'order', payment_type: 'CARD',
        ...overrides
    };
}

// ============================================================================
// TESTS
// ============================================================================

describe('processThresholdCrossing', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = makeMockClient();
    });

    test('1. exact threshold — 12 units, buy 12 → earns, no split needed', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 12 };

        // CTE lock: all 12 rows fully consumed
        mockQuerySequence(mockClient,
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // neededFromCrossing = 12 - 12 = 0 → skip crossing row
            // Transition to earned
            { rows: [] },
            // Re-count: 0 remaining → break
            { rows: [{ total_quantity: '0' }] }
        );

        const result = await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 12
        });

        expect(result.earnedRewardIds).toEqual(['reward-1']);
        expect(result.currentQuantity).toBe(0);
        expect(reward.status).toBe('earned');

        // No split INSERT calls
        const splitCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_locked'))
        );
        expect(splitCalls).toHaveLength(0);

        // Audit event fired
        expect(mockLogAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'REWARD_EARNED', rewardId: 'reward-1' }),
            mockClient
        );
    });

    test('2. over threshold — 14 units, buy 12 → earns, crossing row split into 12+2', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 14 };

        // CTE lock: 10 rows fully consumed (cumulative 1-10)
        mockQuerySequence(mockClient,
            { rows: Array.from({ length: 10 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // neededFromCrossing = 12 - 10 = 2
            // Crossing row: qty=4
            { rows: [makeCrossingRow({ quantity: 4 })] },
            // Insert locked child (qty=2)
            { rows: [] },
            // Insert excess child (qty=2)
            { rows: [] },
            // Transition to earned
            { rows: [] },
            // Re-count: 2 remaining < 12 → break
            { rows: [{ total_quantity: '2' }] }
        );

        const result = await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 14
        });

        expect(result.earnedRewardIds).toEqual(['reward-1']);
        expect(result.currentQuantity).toBe(2);

        // Verify locked child INSERT (qty=2)
        const lockedCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_locked'))
        );
        expect(lockedCalls).toHaveLength(1);
        expect(lockedCalls[0][1]).toContain(2); // neededFromCrossing

        // Verify excess child INSERT (qty=2)
        const excessCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_excess'))
        );
        expect(excessCalls).toHaveLength(1);
        expect(excessCalls[0][1]).toContain(2); // excessQty = 4 - 2
    });

    test('3. multi-threshold — 26 units, buy 12 → earns twice, 2 rollover', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 26 };
        const mockResolveConflict = jest.fn();

        // === First reward cycle ===
        mockQuerySequence(mockClient,
            // CTE lock: 12 fully-consumed
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // Transition to earned
            { rows: [] },
            // Re-count: 14 remaining >= 12
            { rows: [{ total_quantity: '14' }] },
            // Create new in_progress reward for next cycle (no conflict)
            { rows: [{ id: 'reward-2', status: 'in_progress', current_quantity: 14, conflict_occurred: false }] }
        );

        // === Second reward cycle ===
        mockQuerySequence(mockClient,
            // CTE lock: 12 fully-consumed
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 13}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // Transition to earned
            { rows: [] },
            // Re-count: 2 remaining < 12 → break
            { rows: [{ total_quantity: '2' }] }
        );

        const result = await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 26,
            resolveConflictFn: mockResolveConflict
        });

        expect(result.earnedRewardIds).toEqual(['reward-1', 'reward-2']);
        expect(result.currentQuantity).toBe(2);

        // 2 REWARD_EARNED audit events
        const earnedCalls = mockLogAuditEvent.mock.calls.filter(
            c => c[0].action === 'REWARD_EARNED'
        );
        expect(earnedCalls).toHaveLength(2);

        // resolveConflictFn not called (no conflict)
        expect(mockResolveConflict).not.toHaveBeenCalled();
    });

    test('4. single large purchase crossing — qty=14 → split into 12+2', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 14 };

        // CTE lock: no fully-consumed rows (single row cumulative=14 > 12)
        mockQuerySequence(mockClient,
            { rows: [] },
            // neededFromCrossing = 12 - 0 = 12
            // Crossing row: qty=14
            { rows: [makeCrossingRow({ id: 'p1', quantity: 14, idempotency_key: 'key-big' })] },
            // Insert locked child (qty=12)
            { rows: [] },
            // Insert excess child (qty=2)
            { rows: [] },
            // Transition to earned
            { rows: [] },
            // Re-count: 2 remaining < 12 → break
            { rows: [{ total_quantity: '2' }] }
        );

        const result = await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 14
        });

        expect(result.earnedRewardIds).toEqual(['reward-1']);
        expect(result.currentQuantity).toBe(2);

        // Verify locked child got qty=12
        const lockedCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_locked'))
        );
        expect(lockedCalls).toHaveLength(1);
        expect(lockedCalls[0][1]).toContain(12);

        // Verify excess child got qty=2
        const excessCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_excess'))
        );
        expect(excessCalls).toHaveLength(1);
        expect(excessCalls[0][1]).toContain(2);
    });

    test('5. zero excess after lock — exactly fills, no excess child created', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 13 };

        // CTE lock: 10 rows fully consumed
        mockQuerySequence(mockClient,
            { rows: Array.from({ length: 10 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // neededFromCrossing = 12 - 10 = 2
            // Crossing row: qty=2 exactly (excessQty = 0)
            { rows: [makeCrossingRow({ quantity: 2, idempotency_key: 'key-exact' })] },
            // Insert locked child (qty=2) — the whole crossing row
            { rows: [] },
            // NO excess child INSERT (excessQty = 0)
            // Transition to earned
            { rows: [] },
            // Re-count: 1 remaining < 12 → break
            { rows: [{ total_quantity: '1' }] }
        );

        const result = await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 13
        });

        expect(result.earnedRewardIds).toEqual(['reward-1']);

        // Locked child created
        const lockedCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_locked'))
        );
        expect(lockedCalls).toHaveLength(1);

        // NO excess child created
        const excessCalls = mockClient.query.mock.calls.filter(
            c => Array.isArray(c[1]) && c[1].some(p => typeof p === 'string' && p.includes('split_excess'))
        );
        expect(excessCalls).toHaveLength(0);
    });

    test('6. crossing row query includes FOR UPDATE SKIP LOCKED', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 13 };

        // CTE lock: 11 fully consumed
        mockQuerySequence(mockClient,
            { rows: Array.from({ length: 11 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // neededFromCrossing = 12 - 11 = 1
            // Crossing row with FOR UPDATE SKIP LOCKED
            { rows: [makeCrossingRow({ quantity: 2 })] },
            // Insert locked child (qty=1)
            { rows: [] },
            // Insert excess child (qty=1)
            { rows: [] },
            // Transition to earned
            { rows: [] },
            // Re-count: 1 remaining < 12 → break
            { rows: [{ total_quantity: '1' }] }
        );

        await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 13
        });

        // Find the crossing row query
        const crossingCall = mockClient.query.mock.calls.find(call =>
            typeof call[0] === 'string' &&
            call[0].includes('LIMIT 1') &&
            call[0].includes('FOR UPDATE SKIP LOCKED')
        );
        expect(crossingCall).toBeDefined();
        expect(crossingCall[0]).toContain('reward_id IS NULL');
        expect(crossingCall[0]).toContain('ORDER BY purchased_at ASC, id ASC');
    });

    test('7. new in_progress reward created with correct initial quantity on rollover', async () => {
        const reward = { id: 'reward-1', status: 'in_progress', current_quantity: 15 };
        const mockResolveConflict = jest.fn();

        // CTE lock: 12 fully consumed
        mockQuerySequence(mockClient,
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 1}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // Transition to earned
            { rows: [] },
            // Re-count: 3 remaining (not enough for another reward, but let's test 15 to trigger creation)
            // Actually, we need >= 12 to trigger creation. Use 14.
            { rows: [{ total_quantity: '14' }] },
            // Create new in_progress reward — verify ON CONFLICT + initial quantity
            { rows: [{ id: 'reward-2', status: 'in_progress', current_quantity: 14, conflict_occurred: false }] }
        );

        // Second cycle: 14 >= 12
        mockQuerySequence(mockClient,
            // CTE lock: 12 fully consumed
            { rows: Array.from({ length: 12 }, (_, i) => ({
                id: `p${i + 13}`, quantity: 1, cumulative_qty: i + 1
            })) },
            // Transition to earned
            { rows: [] },
            // Re-count: 2 remaining < 12 → break
            { rows: [{ total_quantity: '2' }] }
        );

        const result = await processThresholdCrossing(mockClient, {
            reward, offer, merchantId: MERCHANT_ID, offerId: OFFER_ID,
            squareCustomerId: CUSTOMER_ID, currentQuantity: 26,
            resolveConflictFn: mockResolveConflict
        });

        // Verify the new in_progress reward INSERT query
        const insertCall = mockClient.query.mock.calls.find(call =>
            typeof call[0] === 'string' &&
            call[0].includes('INSERT INTO loyalty_rewards') &&
            call[0].includes('ON CONFLICT')
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[0]).toContain("ON CONFLICT (merchant_id, offer_id, square_customer_id) WHERE status = 'in_progress'");
        expect(insertCall[0]).toContain('GREATEST(loyalty_rewards.current_quantity, EXCLUDED.current_quantity)');

        // The INSERT params should include currentQuantity (14) and required_quantity (12)
        expect(insertCall[1]).toContain(14); // currentQuantity at time of INSERT
        expect(insertCall[1]).toContain(12); // offer.required_quantity

        // Both rewards earned
        expect(result.earnedRewardIds).toEqual(['reward-1', 'reward-2']);
        expect(result.currentQuantity).toBe(2);
        expect(result.reward.id).toBe('reward-2');
    });
});
