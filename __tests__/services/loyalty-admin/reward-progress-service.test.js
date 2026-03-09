/**
 * Tests for services/loyalty-admin/reward-progress-service.js
 *
 * Covers the two race condition fixes:
 * CRIT-1: ON CONFLICT handling for concurrent in_progress reward creation
 * CRIT-2: FOR UPDATE SKIP LOCKED on purchase event reads
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockClient = {
    query: jest.fn()
};

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
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

const mockLogAuditEvent = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/audit-service', () => ({
    logAuditEvent: mockLogAuditEvent
}));

const mockUpdateCustomerStats = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: mockUpdateCustomerStats
}));

const mockCreateDiscount = jest.fn().mockResolvedValue({ success: true, groupId: 'g1', discountId: 'd1' });
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: mockCreateDiscount
}));

const mockUpdateCustomerSummary = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-summary-service', () => ({
    updateCustomerSummary: mockUpdateCustomerSummary
}));

const { updateRewardProgress } = require('../../../services/loyalty-admin/reward-progress-service');

// ============================================================================
// TEST DATA
// ============================================================================

const MERCHANT_ID = 1;
const OFFER_ID = 'offer-uuid-1';
const CUSTOMER_ID = 'sq-cust-1';
const REWARD_ID = 'reward-uuid-1';
const REWARD_ID_2 = 'reward-uuid-2';

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

// Note: logAuditEvent, updateCustomerStats, createSquareCustomerGroupDiscount,
// and updateCustomerSummary are all module-mocked and do NOT go through
// client.query. Only actual SQL queries need mock responses on client.query.

// ============================================================================
// TESTS
// ============================================================================

describe('reward-progress-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('CRIT-2: FOR UPDATE SKIP LOCKED on purchase event queries', () => {
        test('quantity calculation query includes FOR UPDATE SKIP LOCKED', async () => {
            // Queries: 1) quantity, 2) reward SELECT FOR UPDATE
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            await updateRewardProgress(mockClient, makeData());

            const firstCall = mockClient.query.mock.calls[0][0];
            expect(firstCall).toContain('FOR UPDATE SKIP LOCKED');
        });

        test('crossing row fetch query includes FOR UPDATE SKIP LOCKED', async () => {
            // Queries:
            // 1) quantity calc -> 11
            // 2) reward SELECT FOR UPDATE -> existing in_progress
            // 3) UPDATE reward quantity
            // 4) CTE lock rows (9 locked, need 1 more from crossing)
            // 5) crossing row fetch (FOR UPDATE SKIP LOCKED)
            // 6) INSERT locked child
            // 7) INSERT excess child
            // 8) UPDATE reward to earned
            // 9) re-count remaining
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '11' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 9, cumulative_qty: 9 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [{ id: 'pe-2', quantity: 3, square_order_id: 'ord-1', variation_id: 'var-1',
                    unit_price_cents: 100, total_price_cents: 300, purchased_at: '2026-01-01',
                    idempotency_key: 'key1', window_start_date: '2026-01-01', window_end_date: '2026-07-01',
                    square_location_id: 'loc-1', receipt_url: null, customer_source: 'order', payment_type: 'CARD' }] }) // crossing row
                .mockResolvedValueOnce({ rows: [] }) // INSERT locked child
                .mockResolvedValueOnce({ rows: [] }) // INSERT excess child
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '1' }] }); // re-count (1 < 10 = break)

            await updateRewardProgress(mockClient, makeData());

            // Find the crossing row fetch query
            const crossingCall = mockClient.query.mock.calls.find(call =>
                call[0].includes('LIMIT 1') && call[0].includes('FOR UPDATE SKIP LOCKED')
            );
            expect(crossingCall).toBeDefined();
        });

        test('reward row fetch includes FOR UPDATE (not SKIP LOCKED)', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            await updateRewardProgress(mockClient, makeData());

            // Second query is the reward SELECT FOR UPDATE
            const rewardQuery = mockClient.query.mock.calls[1][0];
            expect(rewardQuery).toContain('FOR UPDATE');
            // Should NOT have SKIP LOCKED on the reward row (we want to wait for it)
            expect(rewardQuery).not.toContain('SKIP LOCKED');
        });
    });

    describe('CRIT-1: ON CONFLICT on in_progress reward INSERT', () => {
        test('initial in_progress INSERT includes ON CONFLICT clause', async () => {
            // Queries: 1) quantity=5, 2) no existing reward, 3) window dates, 4) INSERT ON CONFLICT
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: false }] });

            await updateRewardProgress(mockClient, makeData());

            const insertCall = mockClient.query.mock.calls.find(call =>
                call[0].includes('INSERT INTO loyalty_rewards') && call[0].includes('ON CONFLICT')
            );
            expect(insertCall).toBeDefined();
            expect(insertCall[0]).toContain("ON CONFLICT (merchant_id, offer_id, square_customer_id) WHERE status = 'in_progress'");
            expect(insertCall[0]).toContain('GREATEST(loyalty_rewards.current_quantity, EXCLUDED.current_quantity)');
        });

        test('multi-threshold in_progress INSERT includes ON CONFLICT clause', async () => {
            // 10 units toward 10 required:
            // Queries:
            // 1) quantity=10, 2) existing reward, 3) UPDATE quantity
            // 4) CTE lock (10 locked), 5) UPDATE to earned
            // 6) re-count=5, break (5 < 10)
            // This doesn't trigger multi-threshold. Need 20+ units.
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '20' }] }) // quantity
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 15,
                    merchant_id: MERCHANT_ID }] }) // existing reward
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                // earn loop iteration 1
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                // neededFromCrossing = 10 - 10 = 0, skip crossing
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] }) // re-count = 10 >= 10
                // new in_progress INSERT (ON CONFLICT)
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID_2, status: 'in_progress', current_quantity: 10,
                    conflict_occurred: false }] })
                // earn loop iteration 2 (10 >= 10, in_progress)
                .mockResolvedValueOnce({ rows: [{ id: 'pe-3', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] }); // re-count = 0, break

            await updateRewardProgress(mockClient, makeData());

            const insertCalls = mockClient.query.mock.calls.filter(call =>
                call[0].includes('INSERT INTO loyalty_rewards') && call[0].includes('ON CONFLICT')
            );
            expect(insertCalls.length).toBeGreaterThanOrEqual(1);
        });

        test('conflict on initial INSERT logs WARN with structured fields', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: true
                }] });

            await updateRewardProgress(mockClient, makeData());

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Concurrent in_progress reward conflict resolved',
                expect.objectContaining({
                    event: 'in_progress_conflict',
                    customerId: CUSTOMER_ID,
                    offerId: OFFER_ID,
                    merchantId: MERCHANT_ID,
                    rewardId: REWARD_ID
                })
            );
        });

        test('conflict on multi-threshold INSERT logs WARN with structured fields', async () => {
            // Earn a reward, then re-count >= required triggers ON CONFLICT INSERT
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '15' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 10,
                    merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                // earn loop
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '12' }] }) // re-count 12 >= 10
                // INSERT ON CONFLICT — conflict!
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID_2, status: 'in_progress', current_quantity: 12,
                    conflict_occurred: true
                }] })
                // Next earn loop iteration (12 >= 10, in_progress)
                .mockResolvedValueOnce({ rows: [{ id: 'pe-5', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '2' }] }); // re-count 2 < 10, break

            await updateRewardProgress(mockClient, makeData());

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Concurrent in_progress reward conflict resolved',
                expect.objectContaining({
                    event: 'in_progress_conflict',
                    customerId: CUSTOMER_ID,
                    offerId: OFFER_ID,
                    merchantId: MERCHANT_ID
                })
            );
        });

        test('no WARN logged when no conflict occurs', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: false
                }] });

            await updateRewardProgress(mockClient, makeData());

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('Concurrent webhook simulation', () => {
        test('two concurrent calls with same customer+offer — ON CONFLICT ensures only one in_progress reward', async () => {
            // Call 1 (wins the race — no conflict)
            const client1 = { query: jest.fn() };
            client1.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '3' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 3,
                    conflict_occurred: false
                }] });

            // Call 2 (loses the race — conflict absorbed)
            const client2 = { query: jest.fn() };
            client2.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: true
                }] });

            const data = makeData();

            const [result1, result2] = await Promise.all([
                updateRewardProgress(client1, data),
                updateRewardProgress(client2, data)
            ]);

            // Both should succeed (no thrown exceptions)
            expect(result1.status).toBe('in_progress');
            expect(result2.status).toBe('in_progress');

            // Both reference the same reward ID
            expect(result1.rewardId).toBe(REWARD_ID);
            expect(result2.rewardId).toBe(REWARD_ID);

            // Call 2's conflict should be logged at WARN
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Concurrent in_progress reward conflict resolved',
                expect.objectContaining({
                    event: 'in_progress_conflict',
                    customerId: CUSTOMER_ID,
                    offerId: OFFER_ID,
                    merchantId: MERCHANT_ID
                })
            );
        });

        test('purchase events are not lost when ON CONFLICT fires', async () => {
            const client = { query: jest.fn() };
            client.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '7' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 7,
                    conflict_occurred: true
                }] });

            const result = await updateRewardProgress(client, makeData());

            // Transaction did NOT throw — purchase events preserved
            expect(result.rewardId).toBe(REWARD_ID);
            expect(result.currentQuantity).toBe(7);
            expect(result.status).toBe('in_progress');

            // The INSERT query included ON CONFLICT
            const insertCall = client.query.mock.calls.find(call =>
                call[0].includes('INSERT INTO loyalty_rewards') && call[0].includes('ON CONFLICT')
            );
            expect(insertCall).toBeDefined();
        });

        test('CRIT-2: FOR UPDATE SKIP LOCKED prevents double-earn on concurrent webhooks', async () => {
            // Transaction 1: sees 10 units, triggers earn
            const client1 = { query: jest.fn() };
            client1.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress',
                    current_quantity: 8, merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                // earn loop
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] }); // re-count = 0, break

            // Transaction 2: rows are SKIP LOCKED — sees only 3 units
            const client2 = { query: jest.fn() };
            client2.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '3' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress',
                    current_quantity: 8, merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                ; // 3 < 10, while loop doesn't execute

            const data = makeData();

            const [result1, result2] = await Promise.all([
                updateRewardProgress(client1, data),
                updateRewardProgress(client2, data)
            ]);

            expect(result1.status).toBe('earned');
            expect(result2.status).toBe('in_progress');
            expect(result2.currentQuantity).toBe(3);
        });
    });

    describe('basic progress tracking', () => {
        test('returns no_progress when no purchases exist', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await updateRewardProgress(mockClient, makeData());

            expect(result.status).toBe('no_progress');
            expect(result.currentQuantity).toBe(0);
        });

        test('updates existing in_progress reward quantity', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '7' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    merchant_id: MERCHANT_ID
                }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                ; // 7 < 10, while loop doesn't execute

            const result = await updateRewardProgress(mockClient, makeData());

            expect(result.status).toBe('in_progress');
            expect(result.currentQuantity).toBe(7);
        });
    });
});
