/**
 * Tests for services/loyalty-admin/order-intake.js
 *
 * Validates the consolidated order intake function:
 * - Idempotency (duplicate calls return alreadyProcessed: true)
 * - Atomic writes (both tables in one transaction)
 * - Source tagging
 * - Free item detection and skipping
 * - Error handling (line-item failures don't abort the order)
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
        _mockClient: mockClient, // expose for test setup
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
const { processLoyaltyOrder, isOrderAlreadyProcessed } = require('../../../services/loyalty-admin/order-intake');
const { processQualifyingPurchase } = require('../../../services/loyalty-admin/purchase-service');

describe('processLoyaltyOrder', () => {
    let mockClient;

    const baseOrder = {
        id: 'ORDER_123',
        customer_id: 'CUST_456',
        location_id: 'LOC_789',
        created_at: '2026-02-19T10:00:00Z',
        line_items: [
            {
                uid: 'li-1',
                catalog_object_id: 'VAR_001',
                quantity: '2',
                base_price_money: { amount: 500 },
                gross_sales_money: { amount: 1000 },
                total_money: { amount: 1000 },
            },
        ],
        tenders: [
            { type: 'CARD', receipt_url: 'https://receipt.example.com' },
        ],
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = db._mockClient;

        // Default: no existing records (not already processed)
        db.query.mockResolvedValue({ rows: [] });
    });

    test('returns alreadyProcessed when order exists in loyalty_processed_orders', async () => {
        // isOrderAlreadyProcessed finds a match
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

        const result = await processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
            source: 'webhook',
        });

        expect(result.alreadyProcessed).toBe(true);
        expect(result.purchaseEvents).toEqual([]);
        expect(result.rewardEarned).toBe(false);
        // Should NOT have opened a transaction
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    test('returns alreadyProcessed when concurrent insert loses ON CONFLICT', async () => {
        // isOrderAlreadyProcessed: no match
        db.query.mockResolvedValueOnce({ rows: [] });

        // Transaction: BEGIN
        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [] }); // INSERT ON CONFLICT returns nothing

        const result = await processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
        });

        expect(result.alreadyProcessed).toBe(true);
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
    });

    test('processes order with qualifying line items', async () => {
        // isOrderAlreadyProcessed: no match
        db.query
            .mockResolvedValueOnce({ rows: [] }) // idempotency check
            .mockResolvedValueOnce({ rows: [] }); // discount map query

        // Transaction queries
        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT loyalty_processed_orders
            .mockResolvedValueOnce({}) // UPDATE final result
            .mockResolvedValueOnce({}); // COMMIT

        // processQualifyingPurchase returns success
        processQualifyingPurchase.mockResolvedValueOnce({
            processed: true,
            purchaseEvent: { id: 1001, variation_id: 'VAR_001' },
            reward: { status: 'in_progress', currentQuantity: 2 },
        });

        const result = await processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
            source: 'webhook',
            customerSource: 'order',
        });

        expect(result.alreadyProcessed).toBe(false);
        expect(result.purchaseEvents).toHaveLength(1);
        expect(result.purchaseEvents[0].id).toBe(1001);
        expect(result.rewardEarned).toBe(false);

        // Verify processQualifyingPurchase was called with transactionClient
        expect(processQualifyingPurchase).toHaveBeenCalledWith(
            expect.objectContaining({
                merchantId: 1,
                squareOrderId: 'ORDER_123',
                squareCustomerId: 'CUST_456',
                variationId: 'VAR_001',
                quantity: 2,
                customerSource: 'order',
            }),
            { transactionClient: mockClient }
        );

        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    test('sets rewardEarned when reward status is earned', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT
            .mockResolvedValueOnce({}) // UPDATE
            .mockResolvedValueOnce({}); // COMMIT

        processQualifyingPurchase.mockResolvedValueOnce({
            processed: true,
            purchaseEvent: { id: 1001 },
            reward: { status: 'earned' },
        });

        const result = await processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
        });

        expect(result.rewardEarned).toBe(true);
    });

    test('handles no customer gracefully', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT
            .mockResolvedValueOnce({}) // UPDATE result_type = no_customer
            .mockResolvedValueOnce({}); // COMMIT

        const result = await processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: null,
            source: 'webhook',
        });

        expect(result.alreadyProcessed).toBe(false);
        expect(result.purchaseEvents).toEqual([]);
        // Should have written loyalty_processed_orders with result_type 'no_customer'
        const updateCall = mockClient.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('UPDATE loyalty_processed_orders')
        );
        expect(updateCall[1]).toContain('no_customer');
    });

    test('skips free items (100% discounted)', async () => {
        const orderWithFreeItem = {
            ...baseOrder,
            line_items: [
                {
                    uid: 'li-free',
                    catalog_object_id: 'VAR_FREE',
                    quantity: '1',
                    base_price_money: { amount: 500 },
                    gross_sales_money: { amount: 500 },
                    total_money: { amount: 0 }, // 100% discounted
                },
            ],
        };

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT
            .mockResolvedValueOnce({}) // UPDATE
            .mockResolvedValueOnce({}); // COMMIT

        const result = await processLoyaltyOrder({
            order: orderWithFreeItem,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
        });

        expect(result.purchaseEvents).toEqual([]);
        // processQualifyingPurchase should NOT have been called
        expect(processQualifyingPurchase).not.toHaveBeenCalled();
    });

    test('continues processing when one line item fails', async () => {
        const orderWithTwoItems = {
            ...baseOrder,
            line_items: [
                {
                    uid: 'li-1',
                    catalog_object_id: 'VAR_001',
                    quantity: '1',
                    base_price_money: { amount: 500 },
                    gross_sales_money: { amount: 500 },
                    total_money: { amount: 500 },
                },
                {
                    uid: 'li-2',
                    catalog_object_id: 'VAR_002',
                    quantity: '1',
                    base_price_money: { amount: 300 },
                    gross_sales_money: { amount: 300 },
                    total_money: { amount: 300 },
                },
            ],
        };

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT
            .mockResolvedValueOnce({}) // UPDATE
            .mockResolvedValueOnce({}); // COMMIT

        // First item fails, second succeeds
        processQualifyingPurchase
            .mockRejectedValueOnce(new Error('DB constraint violation'))
            .mockResolvedValueOnce({
                processed: true,
                purchaseEvent: { id: 1002 },
                reward: { status: 'in_progress' },
            });

        const result = await processLoyaltyOrder({
            order: orderWithTwoItems,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
        });

        // Should have one successful purchase event despite the first item failing
        expect(result.purchaseEvents).toHaveLength(1);
        expect(result.purchaseEvents[0].id).toBe(1002);
        // Transaction should still commit
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    test('rolls back on transaction-level error', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockRejectedValueOnce(new Error('Connection lost')); // INSERT fails

        await expect(processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
        })).rejects.toThrow('Connection lost');

        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });

    test('accepts different source tags', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        mockClient.query
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT
            .mockResolvedValueOnce({}) // UPDATE
            .mockResolvedValueOnce({}); // COMMIT

        processQualifyingPurchase.mockResolvedValueOnce({
            processed: false,
            reason: 'variation_not_qualifying',
        });

        await processLoyaltyOrder({
            order: baseOrder,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
            source: 'catchup',
        });

        // Verify the source tag was written to loyalty_processed_orders
        const insertCall = mockClient.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO loyalty_processed_orders')
        );
        expect(insertCall[1]).toContain('CATCHUP');
    });

    test('throws on missing order', async () => {
        await expect(processLoyaltyOrder({
            order: null,
            merchantId: 1,
            squareCustomerId: 'CUST_456',
        })).rejects.toThrow('order with id is required');
    });

    test('throws on missing merchantId', async () => {
        await expect(processLoyaltyOrder({
            order: baseOrder,
            merchantId: null,
            squareCustomerId: 'CUST_456',
        })).rejects.toThrow('merchantId is required');
    });
});

describe('isOrderAlreadyProcessed', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset persistent mock so tests start clean
        db.query.mockReset();
    });

    test('returns true when order exists in either table', async () => {
        db.query.mockResolvedValue({ rows: [{ found: 1 }] });

        const result = await isOrderAlreadyProcessed(1, 'ORDER_123');
        expect(result).toBe(true);
    });

    test('returns false when order is not found', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const result = await isOrderAlreadyProcessed(1, 'ORDER_NEW');
        expect(result).toBe(false);
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
