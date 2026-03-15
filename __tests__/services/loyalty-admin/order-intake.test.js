/**
 * Tests for services/loyalty-admin/order-intake.js
 *
 * Validates the consolidated order intake function:
 * - Idempotency (duplicate calls return alreadyProcessed: true)
 * - Line item aggregation (Mar 7 fix — same variation across multiple line items)
 * - shouldSkipLineItem (free, no variation, zero qty, loyalty discount)
 * - Price handling (base_price_money, aggregation keeps higher unitPrice)
 * - Error handling (partial failures roll back, retryable flag)
 * - Transaction integrity (all calls share same client)
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => {
    const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
    };
    return {
        query: jest.fn(),
        pool: {
            connect: jest.fn().mockResolvedValue(mockClient),
        },
        _mockClient: mockClient,
    };
});

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: {
        debug: jest.fn(),
        audit: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('../../../services/loyalty-admin/purchase-service', () => ({
    processQualifyingPurchase: jest.fn(),
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');
const { processLoyaltyOrder, isOrderAlreadyProcessed } = require('../../../services/loyalty-admin/order-intake');
const { processQualifyingPurchase } = require('../../../services/loyalty-admin/purchase-service');

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

/**
 * Build a realistic Square order shape. Square SDK v43+ returns BigInt for
 * money amounts, so all amount fields use BigInt literals.
 */
const makeLineItem = (overrides = {}) => ({
    uid: 'li_default',
    catalog_object_id: 'VAR_1',
    quantity: '1',
    base_price_money: { amount: 1699n, currency: 'CAD' },
    gross_sales_money: { amount: 1699n, currency: 'CAD' },
    total_money: { amount: 1699n, currency: 'CAD' },
    total_discount_money: { amount: 0n, currency: 'CAD' },
    ...overrides,
});

const makeOrder = (overrides = {}) => ({
    id: 'ORDER_123',
    location_id: 'LOC_1',
    customer_id: 'CUST_ABC',
    state: 'COMPLETED',
    created_at: '2026-03-15T14:00:00Z',
    line_items: [makeLineItem()],
    tenders: [{ type: 'CARD', receipt_url: 'https://receipt.example.com/r1' }],
    ...overrides,
});

// ---------------------------------------------------------------------------
// Helpers to set up the mockClient query sequence
// ---------------------------------------------------------------------------

/**
 * Standard "happy path" mock sequence for mockClient.query:
 *   BEGIN → INSERT loyalty_processed_orders (returns id) → ...processing...
 *   → UPDATE final result → COMMIT
 *
 * The discount-map query goes through db.query (not mockClient).
 */
function setupStandardTransaction(mockClient, { claimId = 99 } = {}) {
    mockClient.query
        .mockResolvedValueOnce({})                           // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: claimId }] }); // INSERT claim
    // Caller must mock UPDATE + COMMIT after processing calls.
}

function setupCommit(mockClient) {
    mockClient.query
        .mockResolvedValueOnce({})  // UPDATE loyalty_processed_orders
        .mockResolvedValueOnce({}); // COMMIT
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processLoyaltyOrder', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = db._mockClient;
        // mockReset clears the mockResolvedValueOnce queue (clearAllMocks does not)
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        processQualifyingPurchase.mockReset();
        db.query.mockReset();
        db.pool.connect.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
        // Default: not already processed
        db.query.mockResolvedValue({ rows: [] });
    });

    // ===================================================================
    // Group 1: Idempotency
    // ===================================================================

    describe('Group 1: Idempotency', () => {
        test('order already in loyalty_processed_orders → returns early, no processing', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

            const result = await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
                source: 'webhook',
            });

            expect(result).toEqual({
                alreadyProcessed: true,
                purchaseEvents: [],
                rewardEarned: false,
            });
            expect(db.pool.connect).not.toHaveBeenCalled();
            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });

        test('concurrent duplicate → ON CONFLICT claim returns no rows, treated as already processed', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // idempotency check: not found

            mockClient.query
                .mockResolvedValueOnce({})             // BEGIN
                .mockResolvedValueOnce({ rows: [] })   // INSERT ON CONFLICT DO NOTHING → 0 rows
                .mockResolvedValueOnce({});             // COMMIT

            const result = await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(result.alreadyProcessed).toBe(true);
            expect(result.purchaseEvents).toEqual([]);
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(mockClient.release).toHaveBeenCalled();
            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });
    });

    // ===================================================================
    // Group 2: Line item aggregation (the Mar 7 fix)
    // ===================================================================

    describe('Group 2: Line item aggregation', () => {
        test('single line item, qty=1 → one call to processQualifyingPurchase with qty=1', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 1001, variation_id: 'VAR_1' },
                reward: { status: 'in_progress' },
            });

            await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledTimes(1);
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    variationId: 'VAR_1',
                    quantity: 1,
                    unitPriceCents: 1699,
                    totalPriceCents: 1699,
                }),
                { transactionClient: mockClient }
            );
        });

        test('single line item, qty=3 → one call with qty=3', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({ uid: 'li_1', quantity: '3' }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 1001 },
                reward: { status: 'in_progress' },
            });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledTimes(1);
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    variationId: 'VAR_1',
                    quantity: 3,
                    unitPriceCents: 1699,
                    totalPriceCents: 5097,
                }),
                { transactionClient: mockClient }
            );
        });

        test('THREE line items same catalog_object_id, each qty=1 → ONE call with qty=3 (aggregated)', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({ uid: 'li_1', catalog_object_id: 'VAR_FOOD', quantity: '1', base_price_money: { amount: 3999n, currency: 'CAD' }, gross_sales_money: { amount: 3999n, currency: 'CAD' }, total_money: { amount: 3999n, currency: 'CAD' } }),
                    makeLineItem({ uid: 'li_2', catalog_object_id: 'VAR_FOOD', quantity: '1', base_price_money: { amount: 3999n, currency: 'CAD' }, gross_sales_money: { amount: 3999n, currency: 'CAD' }, total_money: { amount: 3999n, currency: 'CAD' } }),
                    makeLineItem({ uid: 'li_3', catalog_object_id: 'VAR_FOOD', quantity: '1', base_price_money: { amount: 3999n, currency: 'CAD' }, gross_sales_money: { amount: 3999n, currency: 'CAD' }, total_money: { amount: 3999n, currency: 'CAD' } }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 2001, variation_id: 'VAR_FOOD', quantity: 3 },
                reward: { status: 'in_progress', currentQuantity: 3 },
            });

            const result = await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledTimes(1);
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    variationId: 'VAR_FOOD',
                    quantity: 3,
                    unitPriceCents: 3999,
                    totalPriceCents: 11997,
                }),
                { transactionClient: mockClient }
            );
            expect(result.purchaseEvents).toHaveLength(1);
        });

        test('two different variations in same order → two separate calls', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({ uid: 'li_1', catalog_object_id: 'VAR_DOG_FOOD', quantity: '2', base_price_money: { amount: 5499n, currency: 'CAD' }, gross_sales_money: { amount: 10998n, currency: 'CAD' }, total_money: { amount: 10998n, currency: 'CAD' } }),
                    makeLineItem({ uid: 'li_2', catalog_object_id: 'VAR_CAT_FOOD', quantity: '1', base_price_money: { amount: 2999n, currency: 'CAD' }, gross_sales_money: { amount: 2999n, currency: 'CAD' }, total_money: { amount: 2999n, currency: 'CAD' } }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase
                .mockResolvedValueOnce({
                    processed: true,
                    purchaseEvent: { id: 3001 },
                    reward: { status: 'in_progress' },
                })
                .mockResolvedValueOnce({
                    processed: true,
                    purchaseEvent: { id: 3002 },
                    reward: { status: 'in_progress' },
                });

            const result = await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledTimes(2);
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({ variationId: 'VAR_DOG_FOOD', quantity: 2 }),
                { transactionClient: mockClient }
            );
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({ variationId: 'VAR_CAT_FOOD', quantity: 1 }),
                { transactionClient: mockClient }
            );
            expect(result.purchaseEvents).toHaveLength(2);
        });

        test('mix of qualifying and non-qualifying variations → only qualifying ones processed', async () => {
            const order = makeOrder({
                line_items: [
                    // Qualifying item
                    makeLineItem({ uid: 'li_1', catalog_object_id: 'VAR_QUALIFYING', quantity: '2' }),
                    // Non-qualifying: no catalog_object_id (custom/ad-hoc item)
                    makeLineItem({ uid: 'li_2', catalog_object_id: null, quantity: '1' }),
                    // Non-qualifying: zero quantity
                    makeLineItem({ uid: 'li_3', catalog_object_id: 'VAR_ZERO', quantity: '0' }),
                    // Non-qualifying: 100% discounted (free)
                    makeLineItem({
                        uid: 'li_4',
                        catalog_object_id: 'VAR_FREE',
                        quantity: '1',
                        base_price_money: { amount: 1000n, currency: 'CAD' },
                        gross_sales_money: { amount: 1000n, currency: 'CAD' },
                        total_money: { amount: 0n, currency: 'CAD' },
                    }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 4001 },
                reward: { status: 'in_progress' },
            });

            const result = await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            // Only VAR_QUALIFYING should be processed
            expect(processQualifyingPurchase).toHaveBeenCalledTimes(1);
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({ variationId: 'VAR_QUALIFYING', quantity: 2 }),
                { transactionClient: mockClient }
            );
            expect(result.purchaseEvents).toHaveLength(1);
        });
    });

    // ===================================================================
    // Group 3: shouldSkipLineItem
    // ===================================================================

    describe('Group 3: shouldSkipLineItem', () => {
        // Helper: run processLoyaltyOrder with a single line item and see
        // whether processQualifyingPurchase was called.
        async function processWithSingleItem(lineItem) {
            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 9999 },
                reward: { status: 'in_progress' },
            });

            const order = makeOrder({ line_items: [lineItem] });
            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });
        }

        test('item with no catalog_object_id → skipped', async () => {
            await processWithSingleItem(
                makeLineItem({ uid: 'li_no_var', catalog_object_id: undefined })
            );
            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });

        test('item with quantity=0 → skipped', async () => {
            await processWithSingleItem(
                makeLineItem({ uid: 'li_zero', quantity: '0' })
            );
            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });

        test('item with total_money=0 (100% discounted / free) → skipped', async () => {
            await processWithSingleItem(
                makeLineItem({
                    uid: 'li_free',
                    base_price_money: { amount: 2500n, currency: 'CAD' },
                    gross_sales_money: { amount: 2500n, currency: 'CAD' },
                    total_money: { amount: 0n, currency: 'CAD' },
                    total_discount_money: { amount: 2500n, currency: 'CAD' },
                })
            );
            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });

        test('item matching our loyalty discount (in buildDiscountMap) → skipped', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({
                        uid: 'li_loyalty_reward',
                        catalog_object_id: 'VAR_REWARD_ITEM',
                        applied_discounts: [{ discount_uid: 'DISC_UID_1' }],
                    }),
                ],
                discounts: [
                    {
                        uid: 'DISC_UID_1',
                        catalog_object_id: 'LOYALTY_PRICING_RULE_123',
                        applied_money: { amount: 500n },
                    },
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                // discount map: our loyalty_rewards table returns matching discount
                .mockResolvedValueOnce({
                    rows: [
                        { square_discount_id: null, square_pricing_rule_id: 'LOYALTY_PRICING_RULE_123' },
                    ],
                });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });

        test('regular qualifying item → NOT skipped', async () => {
            await processWithSingleItem(
                makeLineItem({
                    uid: 'li_regular',
                    catalog_object_id: 'VAR_REGULAR',
                    quantity: '1',
                    base_price_money: { amount: 4999n, currency: 'CAD' },
                    gross_sales_money: { amount: 4999n, currency: 'CAD' },
                    total_money: { amount: 4999n, currency: 'CAD' },
                })
            );
            expect(processQualifyingPurchase).toHaveBeenCalledTimes(1);
            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({ variationId: 'VAR_REGULAR', quantity: 1 }),
                expect.anything()
            );
        });
    });

    // ===================================================================
    // Group 4: Price handling
    // ===================================================================

    describe('Group 4: Price handling', () => {
        test('unitPriceCents comes from base_price_money.amount (not total_money)', async () => {
            // base_price_money = 1699, total_money = 1500 (after discount)
            const order = makeOrder({
                line_items: [
                    makeLineItem({
                        uid: 'li_1',
                        quantity: '1',
                        base_price_money: { amount: 1699n, currency: 'CAD' },
                        gross_sales_money: { amount: 1699n, currency: 'CAD' },
                        total_money: { amount: 1500n, currency: 'CAD' },
                        total_discount_money: { amount: 199n, currency: 'CAD' },
                    }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 5001 },
                reward: { status: 'in_progress' },
            });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    unitPriceCents: 1699,  // from base_price_money, NOT 1500 from total_money
                    totalPriceCents: 1699, // 1 * 1699
                }),
                expect.anything()
            );
        });

        test('totalPriceCents = quantity * unitPriceCents', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({
                        uid: 'li_1',
                        catalog_object_id: 'VAR_BULK',
                        quantity: '5',
                        base_price_money: { amount: 2000n, currency: 'CAD' },
                        gross_sales_money: { amount: 10000n, currency: 'CAD' },
                        total_money: { amount: 10000n, currency: 'CAD' },
                    }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 5002 },
                reward: { status: 'in_progress' },
            });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    unitPriceCents: 2000,
                    totalPriceCents: 10000, // 5 * 2000
                }),
                expect.anything()
            );
        });

        test('aggregated items: higher unitPriceCents is kept', async () => {
            // Two line items for same variation but different unit prices
            // (possible if price changed mid-transaction or manual override)
            const order = makeOrder({
                line_items: [
                    makeLineItem({
                        uid: 'li_1',
                        catalog_object_id: 'VAR_MIXED_PRICE',
                        quantity: '1',
                        base_price_money: { amount: 1500n, currency: 'CAD' },
                        gross_sales_money: { amount: 1500n, currency: 'CAD' },
                        total_money: { amount: 1500n, currency: 'CAD' },
                    }),
                    makeLineItem({
                        uid: 'li_2',
                        catalog_object_id: 'VAR_MIXED_PRICE',
                        quantity: '2',
                        base_price_money: { amount: 1800n, currency: 'CAD' },
                        gross_sales_money: { amount: 3600n, currency: 'CAD' },
                        total_money: { amount: 3600n, currency: 'CAD' },
                    }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 5003 },
                reward: { status: 'in_progress' },
            });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    variationId: 'VAR_MIXED_PRICE',
                    quantity: 3,                       // 1 + 2
                    unitPriceCents: 1800,              // max(1500, 1800)
                    totalPriceCents: 1500 + 3600,      // sum of individual totalPriceCents
                }),
                expect.anything()
            );
        });
    });

    // ===================================================================
    // Group 5: Error handling
    // ===================================================================

    describe('Group 5: Error handling', () => {
        test('single variation fails → entire transaction rolls back, error thrown with retryable=true', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map (order has no discounts → early return, not consumed)

            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim
                .mockResolvedValue({});                              // ROLLBACK (inner + outer catch both call it)

            processQualifyingPurchase.mockRejectedValueOnce(
                new Error('DB deadlock detected')
            );

            let thrownError;
            try {
                await processLoyaltyOrder({
                    order: makeOrder(),
                    merchantId: 1,
                    squareCustomerId: 'CUST_ABC',
                });
            } catch (e) {
                thrownError = e;
            }

            expect(thrownError).toBeDefined();
            expect(thrownError.message).toMatch(/Order intake failed for 1 variation/);
            expect(thrownError.retryable).toBe(true);
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalled();
        });

        test('DB error on claim INSERT → handled gracefully, rolls back', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // idempotency

            mockClient.query
                .mockResolvedValueOnce({})                                  // BEGIN
                .mockRejectedValueOnce(new Error('connection terminated')); // INSERT claim fails

            await expect(processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            })).rejects.toThrow('connection terminated');

            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalled();
        });

        test('processQualifyingPurchase returns already_processed → continues without error', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: false,
                reason: 'already_processed',
            });

            const result = await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            // Should not throw — already_processed is not an error
            expect(result.alreadyProcessed).toBe(false);
            expect(result.purchaseEvents).toEqual([]);
            expect(result.rewardEarned).toBe(false);
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        });

        test('two variations: first succeeds, second fails → entire transaction rolls back', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({ uid: 'li_1', catalog_object_id: 'VAR_A', quantity: '1' }),
                    makeLineItem({ uid: 'li_2', catalog_object_id: 'VAR_B', quantity: '1' }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map (not consumed — no discounts)

            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim
                .mockResolvedValue({});                              // ROLLBACK (inner + outer)

            processQualifyingPurchase
                .mockResolvedValueOnce({
                    processed: true,
                    purchaseEvent: { id: 6001 },
                    reward: { status: 'in_progress' },
                })
                .mockRejectedValueOnce(new Error('Unique violation'));

            await expect(processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            })).rejects.toThrow(/Order intake failed for 1 variation/);

            // Even though VAR_A succeeded, the whole transaction should roll back
            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        });
    });

    // ===================================================================
    // Group 6: Transaction integrity
    // ===================================================================

    describe('Group 6: Transaction integrity', () => {
        test('all processQualifyingPurchase calls happen within same transaction (same client)', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({ uid: 'li_1', catalog_object_id: 'VAR_X', quantity: '1' }),
                    makeLineItem({ uid: 'li_2', catalog_object_id: 'VAR_Y', quantity: '1' }),
                    makeLineItem({ uid: 'li_3', catalog_object_id: 'VAR_Z', quantity: '1' }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase
                .mockResolvedValue({
                    processed: true,
                    purchaseEvent: { id: 7001 },
                    reward: { status: 'in_progress' },
                });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            // All 3 calls must receive the same mockClient as transactionClient
            expect(processQualifyingPurchase).toHaveBeenCalledTimes(3);
            for (const call of processQualifyingPurchase.mock.calls) {
                expect(call[1]).toEqual({ transactionClient: mockClient });
            }
        });

        test('loyalty_processed_orders claim written before processing starts', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map (not consumed)

            // BEGIN + INSERT claim + UPDATE + COMMIT (use mockResolvedValue for flexibility)
            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim
                .mockResolvedValue({});                              // UPDATE + COMMIT

            let claimInsertedBeforeProcessing = false;
            processQualifyingPurchase.mockImplementationOnce(() => {
                // At this point, mockClient.query should have been called with
                // BEGIN and the INSERT INTO loyalty_processed_orders
                const calls = mockClient.query.mock.calls;
                const hasBegin = calls.some(c => c[0] === 'BEGIN');
                const hasInsert = calls.some(c =>
                    typeof c[0] === 'string' && c[0].includes('INSERT INTO loyalty_processed_orders')
                );
                claimInsertedBeforeProcessing = hasBegin && hasInsert;
                return Promise.resolve({
                    processed: true,
                    purchaseEvent: { id: 8001 },
                    reward: { status: 'in_progress' },
                });
            });

            await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(claimInsertedBeforeProcessing).toBe(true);
        });

        test('reward earned flag set when processQualifyingPurchase returns earned status', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 8002 },
                reward: { status: 'earned' },
            });

            const result = await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(result.rewardEarned).toBe(true);
        });

        test('loyalty_processed_orders is updated with qualifying count on commit', async () => {
            const order = makeOrder({
                line_items: [
                    makeLineItem({ uid: 'li_1', catalog_object_id: 'VAR_A', quantity: '1' }),
                    makeLineItem({ uid: 'li_2', catalog_object_id: 'VAR_B', quantity: '1' }),
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);

            // We need to capture the UPDATE call, so don't use setupCommit helper
            mockClient.query
                .mockResolvedValueOnce({})  // UPDATE loyalty_processed_orders
                .mockResolvedValueOnce({}); // COMMIT

            processQualifyingPurchase
                .mockResolvedValueOnce({
                    processed: true,
                    purchaseEvent: { id: 9001 },
                    reward: { status: 'in_progress' },
                })
                .mockResolvedValueOnce({
                    processed: true,
                    purchaseEvent: { id: 9002 },
                    reward: { status: 'in_progress' },
                });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            // Find the UPDATE loyalty_processed_orders call
            const updateCall = mockClient.query.mock.calls.find(
                c => typeof c[0] === 'string' && c[0].includes('UPDATE loyalty_processed_orders')
                    && c[0].includes('result_type')
            );
            expect(updateCall).toBeDefined();
            // Should be 'qualifying' with 2 qualifying items
            expect(updateCall[1]).toContain('qualifying');
            expect(updateCall[1]).toContain(2);
        });

        test('no customer → writes no_customer result_type and returns early', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim
                .mockResolvedValueOnce({})                           // UPDATE result_type
                .mockResolvedValueOnce({});                          // COMMIT

            const result = await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: null,
            });

            expect(result.alreadyProcessed).toBe(false);
            expect(result.purchaseEvents).toEqual([]);
            expect(processQualifyingPurchase).not.toHaveBeenCalled();

            const updateCall = mockClient.query.mock.calls.find(
                c => typeof c[0] === 'string' && c[0].includes('UPDATE loyalty_processed_orders')
            );
            expect(updateCall[1]).toContain('no_customer');
        });

        test('client is always released even on error', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // idempotency

            mockClient.query
                .mockResolvedValueOnce({})                                  // BEGIN
                .mockRejectedValueOnce(new Error('connection terminated'))  // INSERT claim fails
                .mockResolvedValueOnce({});                                 // ROLLBACK

            await expect(processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            })).rejects.toThrow('connection terminated');

            expect(mockClient.release).toHaveBeenCalledTimes(1);
        });
    });

    // ===================================================================
    // Additional edge cases
    // ===================================================================

    describe('Edge cases', () => {
        test('throws on missing order', async () => {
            await expect(processLoyaltyOrder({
                order: null,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            })).rejects.toThrow('order with id is required');
        });

        test('throws on missing merchantId', async () => {
            await expect(processLoyaltyOrder({
                order: makeOrder(),
                merchantId: null,
                squareCustomerId: 'CUST_ABC',
            })).rejects.toThrow('merchantId is required');
        });

        test('order with no line_items → writes no_line_items early exit when customer present but empty items', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // idempotency

            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim (total_line_items = 0)
                .mockResolvedValueOnce({})                           // UPDATE result_type = no_line_items
                .mockResolvedValueOnce({});                          // COMMIT

            const result = await processLoyaltyOrder({
                order: makeOrder({ line_items: [] }),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(result.purchaseEvents).toEqual([]);
            expect(processQualifyingPurchase).not.toHaveBeenCalled();
        });

        test('source tag is uppercased in the claim insert', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map (not consumed)

            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim
                .mockResolvedValue({});                              // UPDATE + COMMIT

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: false,
                reason: 'variation_not_qualifying',
            });

            await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
                source: 'backfill',
            });

            const insertCall = mockClient.query.mock.calls.find(
                c => typeof c[0] === 'string' && c[0].includes('INSERT INTO loyalty_processed_orders')
            );
            expect(insertCall[1]).toContain('BACKFILL');
        });

        test('tender receipt_url and paymentType passed through to processQualifyingPurchase', async () => {
            const order = makeOrder({
                tenders: [
                    { type: 'CASH' },
                    { type: 'CARD', receipt_url: 'https://squareup.com/receipt/xyz' },
                ],
            });

            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            setupStandardTransaction(mockClient);
            setupCommit(mockClient);

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 10001 },
                reward: { status: 'in_progress' },
            });

            await processLoyaltyOrder({
                order,
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(processQualifyingPurchase).toHaveBeenCalledWith(
                expect.objectContaining({
                    // paymentType should come from first tender
                    paymentType: 'CASH',
                    // receiptUrl comes from the first tender that has one
                    receiptUrl: 'https://squareup.com/receipt/xyz',
                }),
                expect.anything()
            );
        });

        test('non-qualifying variation (processQualifyingPurchase returns processed=false) → result_type is non_qualifying', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })  // idempotency
                .mockResolvedValueOnce({ rows: [] }); // discount map (not consumed)

            mockClient.query
                .mockResolvedValueOnce({})                           // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] })      // INSERT claim
                .mockResolvedValue({});                              // UPDATE + COMMIT

            processQualifyingPurchase.mockResolvedValueOnce({
                processed: false,
                reason: 'variation_not_qualifying',
            });

            const result = await processLoyaltyOrder({
                order: makeOrder(),
                merchantId: 1,
                squareCustomerId: 'CUST_ABC',
            });

            expect(result.purchaseEvents).toEqual([]);

            const updateCall = mockClient.query.mock.calls.find(
                c => typeof c[0] === 'string' && c[0].includes('UPDATE loyalty_processed_orders')
                    && c[0].includes('result_type')
            );
            expect(updateCall[1]).toContain('non_qualifying');
        });
    });
});

describe('isOrderAlreadyProcessed', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockReset();
    });

    test('returns true when order exists in either table', async () => {
        db.query.mockResolvedValue({ rows: [{ found: 1 }] });
        expect(await isOrderAlreadyProcessed(1, 'ORDER_123')).toBe(true);
    });

    test('returns false when order is not found', async () => {
        db.query.mockResolvedValue({ rows: [] });
        expect(await isOrderAlreadyProcessed(1, 'ORDER_NEW')).toBe(false);
    });

    test('includes merchant_id in both table checks', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await isOrderAlreadyProcessed(42, 'ORDER_XYZ');

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('loyalty_processed_orders'),
            [42, 'ORDER_XYZ']
        );
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('loyalty_purchase_events'),
            [42, 'ORDER_XYZ']
        );
    });
});
