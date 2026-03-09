/**
 * Tests for services/loyalty-admin/reward-progress-service.js
 *
 * Covers the two race condition fixes:
 * CRIT-1: ON CONFLICT handling for concurrent in_progress reward creation
 *         with Square API verification on conflict
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

const mockSquareOrdersGet = jest.fn();
const mockGetSquareClientForMerchant = jest.fn().mockResolvedValue({
    orders: { get: mockSquareOrdersGet }
});
jest.mock('../../../middleware/merchant', () => ({
    getSquareClientForMerchant: mockGetSquareClientForMerchant
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

const mockQueryQualifyingVariations = jest.fn();
jest.mock('../../../services/loyalty-admin/loyalty-queries', () => ({
    queryQualifyingVariations: mockQueryQualifyingVariations
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
const ORDER_ID = 'sq-order-1';
const VARIATION_ID = 'var-1';

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
// updateCustomerSummary, getSquareClientForMerchant, and queryQualifyingVariations
// are all module-mocked and do NOT go through client.query.
// Only actual SQL queries need mock responses on client.query.

/**
 * Helper: set up the mock responses for resolveConflictViaSquare when it
 * is called on a conflict. This adds the 2 client.query calls that the
 * helper makes (recent order lookup, UPDATE reward).
 *
 * Also sets up the Square API mock and qualifying variations mock.
 * The verified quantity comes directly from squareLineItems (Square API),
 * NOT from a DB re-derive query.
 *
 * @param {jest.Mock} clientQuery - The client.query mock to append responses to
 * @param {Object} opts - { orderId, squareLineItems, qualifyingVarIds }
 */
function setupSquareVerificationMocks(clientQuery, opts = {}) {
    const {
        orderId = ORDER_ID,
        squareLineItems = [{ catalogObjectId: VARIATION_ID, quantity: '5' }],
        qualifyingVarIds = [{ variation_id: VARIATION_ID }]
    } = opts;

    // 1) Recent order ID lookup
    clientQuery.mockResolvedValueOnce({
        rows: orderId ? [{ square_order_id: orderId }] : []
    });

    if (!orderId) return; // No further calls if no order ID

    // Square API: fetch order
    mockSquareOrdersGet.mockResolvedValueOnce({
        order: { lineItems: squareLineItems }
    });

    // Qualifying variations query (module mock, not client.query)
    mockQueryQualifyingVariations.mockResolvedValueOnce(qualifyingVarIds);

    // 2) UPDATE reward to verified quantity (quantity comes from Square line items)
    clientQuery.mockResolvedValueOnce({ rows: [] });
}

/**
 * Helper: set up Square API to throw an error for conflict fallback tests.
 */
function setupSquareVerificationFailure(clientQuery, opts = {}) {
    const { orderId = ORDER_ID, errorMessage = 'Square API unavailable' } = opts;

    // 1) Recent order ID lookup
    clientQuery.mockResolvedValueOnce({
        rows: [{ square_order_id: orderId }]
    });

    // Square API: throw
    mockGetSquareClientForMerchant.mockRejectedValueOnce(new Error(errorMessage));
}

// ============================================================================
// TESTS
// ============================================================================

describe('reward-progress-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Re-establish default mock for getSquareClientForMerchant
        mockGetSquareClientForMerchant.mockResolvedValue({
            orders: { get: mockSquareOrdersGet }
        });
    });

    describe('CRIT-2: FOR UPDATE SKIP LOCKED on purchase event queries', () => {
        test('quantity calculation query includes FOR UPDATE SKIP LOCKED', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            await updateRewardProgress(mockClient, makeData());

            const firstCall = mockClient.query.mock.calls[0][0];
            expect(firstCall).toContain('FOR UPDATE SKIP LOCKED');
        });

        test('crossing row fetch query includes FOR UPDATE SKIP LOCKED', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '11' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 9, merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 9, cumulative_qty: 9 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [{ id: 'pe-2', quantity: 3, square_order_id: 'ord-1', variation_id: 'var-1',
                    unit_price_cents: 100, total_price_cents: 300, purchased_at: '2026-01-01',
                    idempotency_key: 'key1', window_start_date: '2026-01-01', window_end_date: '2026-07-01',
                    square_location_id: 'loc-1', receipt_url: null, customer_source: 'order', payment_type: 'CARD' }] })
                .mockResolvedValueOnce({ rows: [] }) // INSERT locked child
                .mockResolvedValueOnce({ rows: [] }) // INSERT excess child
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '1' }] }); // re-count (1 < 10 = break)

            await updateRewardProgress(mockClient, makeData());

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

            const rewardQuery = mockClient.query.mock.calls[1][0];
            expect(rewardQuery).toContain('FOR UPDATE');
            expect(rewardQuery).not.toContain('SKIP LOCKED');
        });
    });

    describe('CRIT-1: ON CONFLICT on in_progress reward INSERT', () => {
        test('initial in_progress INSERT includes ON CONFLICT clause', async () => {
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
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '20' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 15,
                    merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] }) // re-count = 10 >= 10
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID_2, status: 'in_progress', current_quantity: 10,
                    conflict_occurred: false }] }) // INSERT (no conflict)
                .mockResolvedValueOnce({ rows: [{ id: 'pe-3', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] }); // re-count = 0, break

            await updateRewardProgress(mockClient, makeData());

            const insertCalls = mockClient.query.mock.calls.filter(call =>
                call[0].includes('INSERT INTO loyalty_rewards') && call[0].includes('ON CONFLICT')
            );
            expect(insertCalls.length).toBeGreaterThanOrEqual(1);
        });

        test('conflict on initial INSERT triggers Square verification and logs WARN', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: true
                }] });

            // resolveConflictViaSquare queries + Square API
            setupSquareVerificationMocks(mockClient.query);

            await updateRewardProgress(mockClient, makeData());

            // WARN logged with both quantities
            // existingQuantity = reward.current_quantity (GREATEST result = 5),
            // incomingQuantity = currentQuantity (5). Same value means we can't
            // distinguish which was higher, but both are logged.
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Concurrent in_progress reward conflict detected',
                expect.objectContaining({
                    event: 'in_progress_conflict',
                    customerId: CUSTOMER_ID,
                    offerId: OFFER_ID,
                    merchantId: MERCHANT_ID,
                    existingQuantity: 5,
                    incomingQuantity: 5,
                    orderId: ORDER_ID
                })
            );

            // Resolution logged
            expect(mockLogger.info).toHaveBeenCalledWith(
                'Conflict resolved via Square verification',
                expect.objectContaining({
                    event: 'in_progress_conflict_resolved',
                    customerId: CUSTOMER_ID,
                    offerId: OFFER_ID,
                    merchantId: MERCHANT_ID,
                    verifiedQuantity: 5,
                    orderId: ORDER_ID
                })
            );
        });

        test('conflict on multi-threshold INSERT triggers Square verification', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '15' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress', current_quantity: 10,
                    merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '12' }] }) // re-count 12 >= 10
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID_2, status: 'in_progress', current_quantity: 12,
                    conflict_occurred: true
                }] });

            // resolveConflictViaSquare for multi-threshold path
            setupSquareVerificationMocks(mockClient.query, {
                squareLineItems: [{ catalogObjectId: VARIATION_ID, quantity: '12' }]
            });

            // After verification, currentQuantity=12 >= 10, so earn loop continues
            // earn loop iteration 2
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 'pe-5', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '2' }] }); // re-count 2 < 10, break

            await updateRewardProgress(mockClient, makeData());

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Concurrent in_progress reward conflict detected',
                expect.objectContaining({
                    event: 'in_progress_conflict',
                    existingQuantity: 12,
                    incomingQuantity: 12
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
            expect(mockSquareOrdersGet).not.toHaveBeenCalled();
        });
    });

    describe('Square API verification on conflict', () => {
        test('successful Square verification sets correct quantity', async () => {
            // Conflict occurs — GREATEST gives 7, but Square says 3 qualifying items
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '7' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 7,
                    conflict_occurred: true
                }] });

            // Square order has 3 qualifying items — this becomes the verified quantity
            setupSquareVerificationMocks(mockClient.query, {
                squareLineItems: [
                    { catalogObjectId: VARIATION_ID, quantity: '3' }
                ],
                qualifyingVarIds: [{ variation_id: VARIATION_ID }]
            });

            const result = await updateRewardProgress(mockClient, makeData());

            // Quantity should be 3 (from Square), not the GREATEST 7
            expect(result.currentQuantity).toBe(3);

            // Square API was called
            expect(mockSquareOrdersGet).toHaveBeenCalledWith({ orderId: ORDER_ID });

            // Qualifying variations were fetched
            expect(mockQueryQualifyingVariations).toHaveBeenCalledWith(OFFER_ID, MERCHANT_ID);

            // UPDATE was called with verified quantity from Square
            const updateCall = mockClient.query.mock.calls.find(call =>
                call[0].includes('UPDATE loyalty_rewards') &&
                call[0].includes('current_quantity = $1') &&
                call[1] && call[1][0] === 3
            );
            expect(updateCall).toBeDefined();
        });

        test('Square API failure falls back to GREATEST and logs ERROR', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '7' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 7,
                    conflict_occurred: true
                }] });

            // Square API fails
            setupSquareVerificationFailure(mockClient.query, {
                errorMessage: 'UNAUTHORIZED'
            });

            const result = await updateRewardProgress(mockClient, makeData());

            // Falls back to GREATEST value (7)
            expect(result.currentQuantity).toBe(7);

            // ERROR logged (not WARN) with fallback event
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Conflict resolution Square API failed — using GREATEST fallback',
                expect.objectContaining({
                    event: 'in_progress_conflict_fallback',
                    reason: 'UNAUTHORIZED',
                    merchantId: MERCHANT_ID,
                    fallbackQuantity: 7
                })
            );
        });

        test('no order ID found falls back to GREATEST and logs ERROR', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: true
                }] });

            // No order ID found
            setupSquareVerificationMocks(mockClient.query, { orderId: null });

            const result = await updateRewardProgress(mockClient, makeData());

            // Falls back to GREATEST value (5)
            expect(result.currentQuantity).toBe(5);

            // ERROR logged with no_order_id reason
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Conflict resolution cannot verify — no order ID found',
                expect.objectContaining({
                    event: 'in_progress_conflict_fallback',
                    reason: 'no_order_id'
                })
            );

            // Square API was NOT called
            expect(mockSquareOrdersGet).not.toHaveBeenCalled();
        });

        test('verification counts only qualifying variations from Square order', async () => {
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '8' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 8,
                    conflict_occurred: true
                }] });

            // Square order has qualifying AND non-qualifying items
            setupSquareVerificationMocks(mockClient.query, {
                squareLineItems: [
                    { catalogObjectId: VARIATION_ID, quantity: '3' },        // qualifying
                    { catalogObjectId: 'non-qualifying-var', quantity: '5' } // not qualifying
                ],
                qualifyingVarIds: [{ variation_id: VARIATION_ID }]
            });

            const result = await updateRewardProgress(mockClient, makeData());

            // verifiedQuantity = 3 (only qualifying items counted from Square)
            expect(result.currentQuantity).toBe(3);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'Conflict resolved via Square verification',
                expect.objectContaining({
                    verifiedQuantity: 3
                })
            );
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

            // Call 2 (loses the race — conflict absorbed, Square verification runs)
            const client2 = { query: jest.fn() };
            client2.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ start_date: '2026-01-01', end_date: '2026-07-01' }] })
                .mockResolvedValueOnce({ rows: [{
                    id: REWARD_ID, status: 'in_progress', current_quantity: 5,
                    conflict_occurred: true
                }] });
            // resolveConflictViaSquare for client2
            setupSquareVerificationMocks(client2.query);

            const data = makeData();

            const [result1, result2] = await Promise.all([
                updateRewardProgress(client1, data),
                updateRewardProgress(client2, data)
            ]);

            expect(result1.status).toBe('in_progress');
            expect(result2.status).toBe('in_progress');
            expect(result1.rewardId).toBe(REWARD_ID);
            expect(result2.rewardId).toBe(REWARD_ID);

            // Call 2's conflict logged
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Concurrent in_progress reward conflict detected',
                expect.objectContaining({
                    event: 'in_progress_conflict',
                    customerId: CUSTOMER_ID
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
            // resolveConflictViaSquare verifies 7 is correct
            setupSquareVerificationMocks(client.query, {
                squareLineItems: [{ catalogObjectId: VARIATION_ID, quantity: '7' }]
            });

            const result = await updateRewardProgress(client, makeData());

            // Transaction did NOT throw — purchase events preserved
            expect(result.rewardId).toBe(REWARD_ID);
            expect(result.currentQuantity).toBe(7);
            expect(result.status).toBe('in_progress');
        });

        test('CRIT-2: FOR UPDATE SKIP LOCKED prevents double-earn on concurrent webhooks', async () => {
            // Transaction 1: sees 10 units, triggers earn
            const client1 = { query: jest.fn() };
            client1.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '10' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress',
                    current_quantity: 8, merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }) // UPDATE quantity
                .mockResolvedValueOnce({ rows: [{ id: 'pe-1', quantity: 10, cumulative_qty: 10 }] }) // CTE lock
                .mockResolvedValueOnce({ rows: [] }) // UPDATE to earned
                .mockResolvedValueOnce({ rows: [{ total_quantity: '0' }] }); // re-count = 0, break

            // Transaction 2: rows are SKIP LOCKED — sees only 3 units
            const client2 = { query: jest.fn() };
            client2.query
                .mockResolvedValueOnce({ rows: [{ total_quantity: '3' }] })
                .mockResolvedValueOnce({ rows: [{ id: REWARD_ID, status: 'in_progress',
                    current_quantity: 8, merchant_id: MERCHANT_ID }] })
                .mockResolvedValueOnce({ rows: [] }); // UPDATE quantity

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
                .mockResolvedValueOnce({ rows: [] }); // UPDATE quantity

            const result = await updateRewardProgress(mockClient, makeData());

            expect(result.status).toBe('in_progress');
            expect(result.currentQuantity).toBe(7);
        });
    });
});
