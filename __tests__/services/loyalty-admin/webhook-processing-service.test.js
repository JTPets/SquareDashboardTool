/**
 * Tests for services/loyalty-admin/webhook-processing-service.js
 *
 * Covers: processOrderRefundsForLoyalty — return parsing, transaction handling,
 * free item skip, post-commit cleanup.
 */

const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn().mockResolvedValue(mockClient),
    },
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const mockProcessRefund = jest.fn();
jest.mock('../../../services/loyalty-admin/refund-service', () => ({
    processRefund: mockProcessRefund,
}));

const mockCleanupDiscount = jest.fn();
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    cleanupSquareCustomerGroupDiscount: mockCleanupDiscount,
}));

const db = require('../../../utils/database');
const { processOrderRefundsForLoyalty } = require('../../../services/loyalty-admin/webhook-processing-service');

const MERCHANT_ID = 1;

function makeOrder(overrides = {}) {
    return {
        id: 'order-1',
        customer_id: 'cust-1',
        location_id: 'loc-1',
        updated_at: '2026-01-01T00:00:00Z',
        returns: [],
        ...overrides,
    };
}

function makeReturn(items) {
    return {
        created_at: '2026-01-01T12:00:00Z',
        return_line_items: items,
    };
}

describe('webhook-processing-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockResolvedValue({ rows: [] });
    });

    // ========================================================================
    // processOrderRefundsForLoyalty
    // ========================================================================

    describe('processOrderRefundsForLoyalty', () => {
        test('throws if merchantId is missing', async () => {
            await expect(processOrderRefundsForLoyalty(makeOrder(), null))
                .rejects.toThrow('merchantId is required');
        });

        test('returns not processed when no returns', async () => {
            const result = await processOrderRefundsForLoyalty(makeOrder(), MERCHANT_ID);

            expect(result).toEqual({ processed: false, reason: 'no_returns' });
            expect(db.pool.connect).not.toHaveBeenCalled();
        });

        test('returns not processed when returns have no qualifying items', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    { catalog_object_id: null, quantity: '1' }, // no variation
                ])],
            });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result).toEqual({ processed: false, reason: 'no_qualifying_returns' });
        });

        test('processes refund items in a single transaction', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR1',
                        quantity: '2',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 2000n },
                        uid: 'uid-1',
                    },
                ])],
            });

            mockProcessRefund.mockResolvedValue({ processed: true, rewardAffected: false });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result.processed).toBe(true);
            expect(result.refundsProcessed).toHaveLength(1);
            expect(result.refundsProcessed[0].variationId).toBe('VAR1');
            expect(result.refundsProcessed[0].quantity).toBe(2);

            // Verify transaction lifecycle
            expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(mockClient.release).toHaveBeenCalled();
        });

        test('skips free items (unitPrice > 0 but totalMoney = 0)', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR_FREE',
                        quantity: '1',
                        base_price_money: { amount: 500n },
                        total_money: { amount: 0n },
                        uid: 'uid-free',
                    },
                ])],
            });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result).toEqual({ processed: false, reason: 'no_qualifying_returns' });
            expect(mockProcessRefund).not.toHaveBeenCalled();
        });

        test('processes non-free items alongside free items', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR_FREE',
                        quantity: '1',
                        base_price_money: { amount: 500n },
                        total_money: { amount: 0n },
                        uid: 'uid-free',
                    },
                    {
                        catalog_object_id: 'VAR_PAID',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n },
                        uid: 'uid-paid',
                    },
                ])],
            });

            mockProcessRefund.mockResolvedValue({ processed: true, rewardAffected: false });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result.processed).toBe(true);
            expect(result.refundsProcessed).toHaveLength(1);
            expect(result.refundsProcessed[0].variationId).toBe('VAR_PAID');
        });

        test('skips items with quantity <= 0', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR1',
                        quantity: '0',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n },
                    },
                ])],
            });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result).toEqual({ processed: false, reason: 'no_qualifying_returns' });
        });

        test('runs Square cleanup for revoked rewards after commit', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR1',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n },
                        uid: 'uid-1',
                    },
                ])],
            });

            mockProcessRefund.mockResolvedValue({
                processed: true,
                rewardAffected: true,
                revokedReward: { id: 'reward-1', offer_id: 'offer-1' },
            });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result.revokedRewards).toHaveLength(1);
            expect(mockCleanupDiscount).toHaveBeenCalledWith({
                merchantId: MERCHANT_ID,
                squareCustomerId: 'cust-1',
                internalRewardId: 'reward-1',
            });
        });

        test('does not throw on cleanup failure', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR1',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n },
                        uid: 'uid-1',
                    },
                ])],
            });

            mockProcessRefund.mockResolvedValue({
                processed: true,
                revokedReward: { id: 'r1', offer_id: 'o1' },
            });
            mockCleanupDiscount.mockRejectedValue(new Error('Square API error'));

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            // Should still succeed — cleanup error is swallowed
            expect(result.processed).toBe(true);
        });

        test('rolls back transaction on refund processing error', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR1',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n },
                        uid: 'uid-1',
                    },
                ])],
            });

            mockProcessRefund.mockRejectedValue(new Error('DB constraint'));

            await expect(processOrderRefundsForLoyalty(order, MERCHANT_ID))
                .rejects.toThrow('DB constraint');

            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalled();
        });

        test('handles BigInt amounts from Square SDK v43+', async () => {
            const order = makeOrder({
                returns: [makeReturn([
                    {
                        catalog_object_id: 'VAR1',
                        quantity: '3',
                        base_price_money: { amount: BigInt(1500) },
                        total_money: { amount: BigInt(4500) },
                        uid: 'uid-1',
                    },
                ])],
            });

            mockProcessRefund.mockResolvedValue({ processed: true });

            const result = await processOrderRefundsForLoyalty(order, MERCHANT_ID);

            expect(result.processed).toBe(true);
            // Verify the refund was called with numeric amount, not BigInt
            const refundArg = mockProcessRefund.mock.calls[0][0];
            expect(typeof refundArg.unitPriceCents).toBe('number');
            expect(refundArg.unitPriceCents).toBe(1500);
        });
    });
});
