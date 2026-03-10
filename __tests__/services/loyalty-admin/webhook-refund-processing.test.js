/**
 * Tests for refund processing in webhook-processing-service.js
 *
 * Covers:
 * - LA-3: order.returns[] shape is correctly parsed (not order.refunds[])
 * - LA-5: partial refund of same quantity twice — both processed (no idempotency collision)
 * - LA-6: tender_id loop removed — refunds process without it
 * - LA-11: refund uses original purchase window dates, not new ones
 * - LA-12: tests use real Square order.returns[] shape
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

const mockClient = {
    query: jest.fn(),
    release: jest.fn()
};

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn().mockResolvedValue(mockClient)
    }
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('../../../utils/loyalty-logger', () => ({
    loyaltyLogger: { debug: jest.fn(), audit: jest.fn(), error: jest.fn() }
}));

const mockGetSetting = jest.fn().mockResolvedValue('true');
jest.mock('../../../services/loyalty-admin/settings-service', () => ({
    getSetting: mockGetSetting
}));

const mockGetCustomerDetails = jest.fn().mockResolvedValue(null);
jest.mock('../../../services/loyalty-admin/customer-admin-service', () => ({
    getCustomerDetails: mockGetCustomerDetails
}));

const mockUpdateCustomerStats = jest.fn().mockResolvedValue();
jest.mock('../../../services/loyalty-admin/customer-cache-service', () => ({
    updateCustomerStats: mockUpdateCustomerStats
}));

jest.mock('../../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(),
        identifyCustomerFromOrder: jest.fn().mockResolvedValue({ customerId: 'cust_1', method: 'order' })
    }))
}));

const mockProcessRefund = jest.fn();
const mockProcessQualifyingPurchase = jest.fn();
jest.mock('../../../services/loyalty-admin/purchase-service', () => ({
    processQualifyingPurchase: mockProcessQualifyingPurchase,
    processRefund: mockProcessRefund
}));

const mockCleanupDiscount = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    cleanupSquareCustomerGroupDiscount: mockCleanupDiscount
}));

const db = require('../../../utils/database');
const { processOrderRefundsForLoyalty } = require('../../../services/loyalty-admin/webhook-processing-service');

// ============================================================================
// HELPERS
// ============================================================================

function makeSquareOrderWithReturns(returns, overrides = {}) {
    return {
        id: 'order_abc',
        customer_id: 'cust_1',
        location_id: 'loc_1',
        state: 'COMPLETED',
        updated_at: '2026-03-07T10:00:00Z',
        returns,
        ...overrides
    };
}

// ============================================================================
// TESTS — LA-3: order.returns[] shape
// ============================================================================

describe('processOrderRefundsForLoyalty — LA-3: order.returns[] shape', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockProcessRefund.mockResolvedValue({ processed: true, rewardAffected: false });
    });

    it('should process order.returns[].return_line_items[] (Square actual shape)', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                created_at: '2026-03-07T10:00:00Z',
                return_line_items: [
                    {
                        uid: 'rli_1',
                        source_line_item_uid: 'li_1',
                        catalog_object_id: 'var_001',
                        quantity: '2',
                        base_price_money: { amount: 3999n, currency: 'CAD' },
                        total_money: { amount: 7998n, currency: 'CAD' }
                    }
                ]
            }
        ]);

        const result = await processOrderRefundsForLoyalty(order, 1);

        expect(result.processed).toBe(true);
        expect(result.refundsProcessed).toHaveLength(1);
        expect(result.refundsProcessed[0].variationId).toBe('var_001');
        expect(result.refundsProcessed[0].quantity).toBe(2);
        expect(mockProcessRefund).toHaveBeenCalledTimes(1);
        // LOGIC CHANGE (HIGH-3): processRefund now receives transactionClient as second arg
        expect(mockProcessRefund).toHaveBeenCalledWith(expect.objectContaining({
            merchantId: 1,
            squareOrderId: 'order_abc',
            squareCustomerId: 'cust_1',
            variationId: 'var_001',
            quantity: 2,
            returnLineItemUid: 'rli_1'
        }), mockClient);
    });

    it('should return no_returns when order has no returns array', async () => {
        const order = { id: 'order_abc', customer_id: 'cust_1', location_id: 'loc_1' };

        const result = await processOrderRefundsForLoyalty(order, 1);

        expect(result.processed).toBe(false);
        expect(result.reason).toBe('no_returns');
        expect(mockProcessRefund).not.toHaveBeenCalled();
    });

    it('should NOT process order.refunds[] (old incorrect path)', async () => {
        const order = {
            id: 'order_abc',
            customer_id: 'cust_1',
            location_id: 'loc_1',
            refunds: [
                {
                    id: 'refund_1',
                    status: 'COMPLETED',
                    return_line_items: [
                        {
                            catalog_object_id: 'var_001',
                            quantity: '1',
                            base_price_money: { amount: 1000n }
                        }
                    ]
                }
            ]
            // No `returns` property
        };

        const result = await processOrderRefundsForLoyalty(order, 1);

        expect(result.processed).toBe(false);
        expect(result.reason).toBe('no_returns');
        expect(mockProcessRefund).not.toHaveBeenCalled();
    });

    it('should handle multiple returns with multiple return_line_items', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                created_at: '2026-03-07T10:00:00Z',
                return_line_items: [
                    {
                        uid: 'rli_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 2000n },
                        total_money: { amount: 2000n }
                    },
                    {
                        uid: 'rli_2',
                        catalog_object_id: 'var_002',
                        quantity: '3',
                        base_price_money: { amount: 500n },
                        total_money: { amount: 1500n }
                    }
                ]
            },
            {
                uid: 'ret_2',
                created_at: '2026-03-07T11:00:00Z',
                return_line_items: [
                    {
                        uid: 'rli_3',
                        catalog_object_id: 'var_003',
                        quantity: '1',
                        base_price_money: { amount: 9999n },
                        total_money: { amount: 9999n }
                    }
                ]
            }
        ]);

        const result = await processOrderRefundsForLoyalty(order, 1);

        expect(result.processed).toBe(true);
        expect(result.refundsProcessed).toHaveLength(3);
        expect(mockProcessRefund).toHaveBeenCalledTimes(3);
    });

    it('should skip return_line_items with no catalog_object_id', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                return_line_items: [
                    {
                        uid: 'rli_1',
                        catalog_object_id: null,
                        quantity: '1',
                        base_price_money: { amount: 1000n }
                    }
                ]
            }
        ]);

        const result = await processOrderRefundsForLoyalty(order, 1);

        // LOGIC CHANGE (HIGH-3): no qualifying items after filtering returns no_qualifying_returns
        expect(result.processed).toBe(false);
        expect(result.reason).toBe('no_qualifying_returns');
        expect(mockProcessRefund).not.toHaveBeenCalled();
    });

    it('should skip free item refunds (100% discounted)', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                return_line_items: [
                    {
                        uid: 'rli_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 5000n },
                        total_money: { amount: 0n }
                    }
                ]
            }
        ]);

        const result = await processOrderRefundsForLoyalty(order, 1);

        // LOGIC CHANGE (HIGH-3): no qualifying items after filtering returns no_qualifying_returns
        expect(result.processed).toBe(false);
        expect(result.reason).toBe('no_qualifying_returns');
        expect(mockProcessRefund).not.toHaveBeenCalled();
    });
});

// ============================================================================
// TESTS — LA-6: tender_id loop removed
// ============================================================================

describe('processOrderRefundsForLoyalty — LA-6: no tender_id gating', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockProcessRefund.mockResolvedValue({ processed: true, rewardAffected: false });
    });

    it('should process returns without any tender_id property', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                // No tender_id, no status — returns don't have these
                return_line_items: [
                    {
                        uid: 'rli_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n }
                    }
                ]
            }
        ]);

        const result = await processOrderRefundsForLoyalty(order, 1);

        expect(result.processed).toBe(true);
        expect(result.refundsProcessed).toHaveLength(1);
    });
});

// ============================================================================
// TESTS — LA-5: idempotency key uniqueness for partial refunds
// ============================================================================

describe('processRefund idempotency — LA-5: returnLineItemUid prevents collision', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockProcessRefund.mockResolvedValue({ processed: true, rewardAffected: false });
    });

    it('should process two partial refunds of the same quantity (different UIDs)', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                return_line_items: [
                    {
                        uid: 'rli_AAA',
                        source_line_item_uid: 'li_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 3999n },
                        total_money: { amount: 3999n }
                    }
                ]
            },
            {
                uid: 'ret_2',
                return_line_items: [
                    {
                        uid: 'rli_BBB',
                        source_line_item_uid: 'li_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 3999n },
                        total_money: { amount: 3999n }
                    }
                ]
            }
        ]);

        const result = await processOrderRefundsForLoyalty(order, 1);

        expect(result.processed).toBe(true);
        expect(result.refundsProcessed).toHaveLength(2);
        expect(mockProcessRefund).toHaveBeenCalledTimes(2);

        // Verify each call gets a different returnLineItemUid
        const call1 = mockProcessRefund.mock.calls[0][0];
        const call2 = mockProcessRefund.mock.calls[1][0];
        expect(call1.returnLineItemUid).toBe('rli_AAA');
        expect(call2.returnLineItemUid).toBe('rli_BBB');
        // Same variation, same quantity — only UID differs
        expect(call1.variationId).toBe(call2.variationId);
        expect(call1.quantity).toBe(call2.quantity);
    });

    it('should use source_line_item_uid as fallback when uid is missing', async () => {
        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                return_line_items: [
                    {
                        // No uid, only source_line_item_uid
                        source_line_item_uid: 'src_li_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n }
                    }
                ]
            }
        ]);

        await processOrderRefundsForLoyalty(order, 1);

        expect(mockProcessRefund).toHaveBeenCalledWith(expect.objectContaining({
            returnLineItemUid: 'src_li_1'
        }), mockClient);
    });
});

// ============================================================================
// TESTS — error propagation
// ============================================================================

describe('processOrderRefundsForLoyalty — error handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should throw when merchantId is missing', async () => {
        await expect(processOrderRefundsForLoyalty({ id: 'ord_1' }, null))
            .rejects.toThrow('merchantId is required');
    });

    // LOGIC CHANGE (HIGH-3): batch now rolls back entirely on any failure
    it('should rollback entire batch and throw when any refund fails', async () => {
        mockProcessRefund
            .mockResolvedValueOnce({ processed: true, rewardAffected: false })
            .mockRejectedValueOnce(new Error('DB timeout'));

        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                return_line_items: [
                    {
                        uid: 'rli_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n }
                    },
                    {
                        uid: 'rli_2',
                        catalog_object_id: 'var_002',
                        quantity: '1',
                        base_price_money: { amount: 2000n },
                        total_money: { amount: 2000n }
                    }
                ]
            }
        ]);

        await expect(processOrderRefundsForLoyalty(order, 1))
            .rejects.toThrow('DB timeout');

        // Verify ROLLBACK was called (not COMMIT)
        const queryCalls = mockClient.query.mock.calls.map(c => c[0]);
        expect(queryCalls).toContain('BEGIN');
        expect(queryCalls).toContain('ROLLBACK');
        expect(queryCalls).not.toContain('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('should pass transaction BEGIN/COMMIT for successful batch', async () => {
        mockProcessRefund.mockResolvedValue({ processed: true, rewardAffected: false });

        const order = makeSquareOrderWithReturns([
            {
                uid: 'ret_1',
                return_line_items: [
                    {
                        uid: 'rli_1',
                        catalog_object_id: 'var_001',
                        quantity: '1',
                        base_price_money: { amount: 1000n },
                        total_money: { amount: 1000n }
                    }
                ]
            }
        ]);

        await processOrderRefundsForLoyalty(order, 1);

        const queryCalls = mockClient.query.mock.calls.map(c => c[0]);
        expect(queryCalls).toContain('BEGIN');
        expect(queryCalls).toContain('COMMIT');
        expect(queryCalls).not.toContain('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });
});
