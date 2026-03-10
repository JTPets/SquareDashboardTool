/**
 * Tests for LOW-2/3/6/7 batch fixes
 *
 * LOW-2: expiration-service.js — expiry loop reuses single DB connection
 * LOW-3: order-intake.js — buildDiscountMap filters by status = 'earned'
 * LOW-6: order-loyalty.js — all 6 customer identification methods mapped
 * LOW-7: reward-progress-service.js — markSyncPendingIfRewardExists logs error
 */

// ============================================================================
// LOW-2: Expiry loop connection reuse
// ============================================================================

describe('LOW-2: processExpiredEarnedRewards connection reuse', () => {
    let db, mockClient, processExpiredEarnedRewards;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../../../utils/logger', () => ({
            info: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }));
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

        db = require('../../../utils/database');
        mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        };
        db.pool = { connect: jest.fn().mockResolvedValue(mockClient) };

        ({ processExpiredEarnedRewards } = require('../../../services/loyalty-admin/expiration-service'));
    });

    test('acquires only one DB connection regardless of reward count', async () => {
        const rewards = [
            { id: 1, offer_id: 'o1', offer_name: 'A', square_customer_id: 'C1', earned_at: '2025-01-01', square_discount_id: null, square_group_id: null },
            { id: 2, offer_id: 'o2', offer_name: 'B', square_customer_id: 'C2', earned_at: '2025-01-01', square_discount_id: null, square_group_id: null },
            { id: 3, offer_id: 'o3', offer_name: 'C', square_customer_id: 'C3', earned_at: '2025-01-01', square_discount_id: null, square_group_id: null },
        ];

        db.query.mockResolvedValueOnce({ rows: rewards });

        await processExpiredEarnedRewards(42);

        // pool.connect should be called exactly ONCE, not 3 times
        expect(db.pool.connect).toHaveBeenCalledTimes(1);
        // client.release should be called exactly once
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    test('releases connection even when no expired rewards found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await processExpiredEarnedRewards(42);

        expect(db.pool.connect).toHaveBeenCalledTimes(1);
        expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// LOW-3: buildDiscountMap earned filter
// ============================================================================

describe('LOW-3: buildDiscountMap includes status = earned filter', () => {
    let db;

    let processQualifyingPurchaseMock;

    beforeEach(() => {
        jest.resetModules();
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
        processQualifyingPurchaseMock = jest.fn().mockResolvedValue({
            processed: true,
            purchaseEvent: { id: 1001, variation_id: 'V1' },
            reward: { status: 'in_progress' },
        });
        jest.mock('../../../services/loyalty-admin/purchase-service', () => ({
            processQualifyingPurchase: processQualifyingPurchaseMock,
        }));

        db = require('../../../utils/database');
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({}) // BEGIN
                .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT claim
                .mockResolvedValueOnce({}) // UPDATE
                .mockResolvedValueOnce({}), // COMMIT
            release: jest.fn(),
        };
        db.pool = { connect: jest.fn().mockResolvedValue(mockClient) };
    });

    test('discount map query filters by status = earned', async () => {
        // isOrderAlreadyProcessed — no match
        db.query
            .mockResolvedValueOnce({ rows: [] })
            // buildDiscountMap query — return empty
            .mockResolvedValueOnce({ rows: [] });

        const { processLoyaltyOrder } = require('../../../services/loyalty-admin/order-intake');

        const order = {
            id: 'ORDER_1',
            line_items: [{ uid: 'li1', catalog_object_id: 'V1', quantity: '1', base_price_money: { amount: 100 }, total_money: { amount: 100 } }],
            tenders: [],
            discounts: [{ uid: 'd1', catalog_object_id: 'DISC_1', applied_money: { amount: 100 } }],
        };

        await processLoyaltyOrder({
            order,
            merchantId: 1,
            squareCustomerId: 'CUST_1',
        });

        // Find the buildDiscountMap query (the one that queries loyalty_rewards for discount IDs)
        const discountMapCall = db.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('square_discount_id') && sql.includes('loyalty_rewards')
        );

        expect(discountMapCall).toBeDefined();
        const [sql] = discountMapCall;
        expect(sql).toContain("status = 'earned'");
    });
});

// ============================================================================
// LOW-6: Customer source mapping covers all 6 methods
// ============================================================================

describe('LOW-6: identifyCustomerForOrder source mapping', () => {
    let identifyCustomerForOrder, LoyaltyCustomerServiceMock;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../../../utils/logger', () => ({
            info: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }));
        jest.mock('../../../services/loyalty-admin', () => ({
            detectRewardRedemptionFromOrder: jest.fn().mockResolvedValue({ detected: false, redemptions: [] }),
            processOrderRefundsForLoyalty: jest.fn().mockResolvedValue({ processed: false }),
        }));
        jest.mock('../../../services/loyalty-admin/order-intake', () => ({
            processLoyaltyOrder: jest.fn(),
        }));
        jest.mock('../../../middleware/merchant', () => ({
            getSquareClientForMerchant: jest.fn(),
        }));
        jest.mock('../../../utils/ttl-cache', () => {
            return jest.fn().mockImplementation(() => ({
                get: jest.fn().mockReturnValue(null),
                set: jest.fn(),
                delete: jest.fn(),
            }));
        });
        jest.mock('../../../utils/database', () => ({ query: jest.fn() }));

        LoyaltyCustomerServiceMock = {
            initialize: jest.fn().mockResolvedValue(),
            identifyCustomerFromOrder: jest.fn(),
        };
        jest.mock('../../../services/loyalty-admin/customer-identification-service', () => ({
            LoyaltyCustomerService: jest.fn().mockImplementation(() => LoyaltyCustomerServiceMock),
        }));

        ({ identifyCustomerForOrder } = require('../../../services/webhook-handlers/order-handler/order-loyalty'));
    });

    const methodMappings = [
        ['ORDER_CUSTOMER_ID', 'order'],
        ['TENDER_CUSTOMER_ID', 'tender'],
        ['LOYALTY_API', 'loyalty_api'],
        ['ORDER_REWARDS', 'order_rewards'],
        ['FULFILLMENT_RECIPIENT', 'fulfillment'],
        ['LOYALTY_DISCOUNT', 'loyalty_discount'],
    ];

    test.each(methodMappings)(
        'maps method %s to customerSource %s',
        async (method, expectedSource) => {
            LoyaltyCustomerServiceMock.identifyCustomerFromOrder.mockResolvedValue({
                customerId: 'CUST_1',
                method,
                success: true,
            });

            const result = await identifyCustomerForOrder({ id: 'order_1' }, 42);

            expect(result.customerId).toBe('CUST_1');
            expect(result.customerSource).toBe(expectedSource);
        }
    );

    test('returns unknown when no customer identified', async () => {
        LoyaltyCustomerServiceMock.identifyCustomerFromOrder.mockResolvedValue({
            customerId: null,
            method: 'NONE',
            success: false,
        });

        const result = await identifyCustomerForOrder({ id: 'order_1' }, 42);

        expect(result.customerId).toBeNull();
        expect(result.customerSource).toBe('unknown');
    });
});

// ============================================================================
// LOW-7: markSyncPendingIfRewardExists error logging
// ============================================================================

describe('LOW-7: markSyncPendingIfRewardExists logs error on failure', () => {
    let db, logger;

    beforeEach(() => {
        jest.resetModules();
        // Undo LOW-2's mock of reward-progress-service so we can test the real module
        jest.unmock('../../../services/loyalty-admin/reward-progress-service');
        jest.doMock('../../../utils/database', () => ({
            query: jest.fn(),
            pool: { connect: jest.fn() },
        }));
        jest.doMock('../../../utils/logger', () => ({
            info: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }));
        jest.doMock('../../../services/loyalty-admin/constants', () => ({
            RewardStatus: { EARNED: 'earned', IN_PROGRESS: 'in_progress' },
            AuditActions: { REWARD_PROGRESS_UPDATED: 'REWARD_PROGRESS_UPDATED', REWARD_EARNED: 'REWARD_EARNED' },
        }));
        jest.doMock('../../../services/loyalty-admin/audit-service', () => ({
            logAuditEvent: jest.fn().mockResolvedValue(),
        }));
        jest.doMock('../../../services/loyalty-admin/customer-cache-service', () => ({
            updateCustomerStats: jest.fn().mockResolvedValue(),
        }));
        jest.doMock('../../../services/loyalty-admin/customer-summary-service', () => ({
            updateCustomerSummary: jest.fn().mockResolvedValue(),
        }));

        db = require('../../../utils/database');
        logger = require('../../../utils/logger');
    });

    test('logs at error level when DB update fails', async () => {
        const { markSyncPendingIfRewardExists } = require('../../../services/loyalty-admin/reward-progress-service');

        // First query (SELECT) succeeds — reward exists
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'reward-99' }] })
            // Second query (UPDATE) throws
            .mockRejectedValueOnce(new Error('connection reset'));

        await markSyncPendingIfRewardExists('reward-99', 42);

        // Should NOT throw (swallows)
        // Should log at error level with rewardId
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to mark reward for sync retry',
            expect.objectContaining({
                event: 'sync_pending_mark_failed',
                rewardId: 'reward-99',
                merchantId: 42,
                error: 'connection reset',
            })
        );
        // Should include stack trace
        const errorCallArgs = logger.error.mock.calls.find(
            c => c[0] === 'Failed to mark reward for sync retry'
        );
        expect(errorCallArgs[1].stack).toBeDefined();
    });

    test('does not throw when DB update fails', async () => {
        const { markSyncPendingIfRewardExists } = require('../../../services/loyalty-admin/reward-progress-service');

        db.query
            .mockResolvedValueOnce({ rows: [{ id: 'reward-99' }] })
            .mockRejectedValueOnce(new Error('timeout'));

        // Should resolve without throwing
        await expect(markSyncPendingIfRewardExists('reward-99', 42)).resolves.toBeUndefined();
    });
});
