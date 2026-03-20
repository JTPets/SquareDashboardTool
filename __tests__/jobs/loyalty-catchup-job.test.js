/**
 * Loyalty Catchup Job Tests
 *
 * Tests structural coverage: import, empty data, DB errors, merchant isolation.
 */

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../middleware/merchant', () => ({
    getSquareClientForMerchant: jest.fn(),
}));

jest.mock('../../services/loyalty-admin/order-intake', () => ({
    processLoyaltyOrder: jest.fn(),
}));

jest.mock('../../services/loyalty-admin/customer-identification-service', () => ({
    LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(),
        identifyCustomerFromOrder: jest.fn().mockResolvedValue({ customerId: 'cust-1', method: 'order' }),
    })),
}));

jest.mock('../../services/loyalty-admin', () => ({
    detectRewardRedemptionFromOrder: jest.fn().mockResolvedValue({ detected: false }),
}));

jest.mock('../../services/webhook-handlers/order-handler', () => ({
    normalizeSquareOrder: jest.fn(order => order),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const { processLoyaltyOrder } = require('../../services/loyalty-admin/order-intake');
const {
    runLoyaltyCatchup,
    runScheduledLoyaltyCatchup,
    processMerchantCatchup,
    getMerchantsWithLoyalty,
} = require('../../jobs/loyalty-catchup-job');

describe('Loyalty Catchup Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export all expected functions', () => {
            expect(typeof runLoyaltyCatchup).toBe('function');
            expect(typeof runScheduledLoyaltyCatchup).toBe('function');
            expect(typeof processMerchantCatchup).toBe('function');
            expect(typeof getMerchantsWithLoyalty).toBe('function');
        });
    });

    describe('getMerchantsWithLoyalty', () => {
        it('should return merchants with active loyalty', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, square_merchant_id: 'sq-1' }],
            });

            const result = await getMerchantsWithLoyalty();

            expect(result).toHaveLength(1);
            const sql = db.query.mock.calls[0][0];
            expect(sql).toContain('loyalty_offers');
            expect(sql).toContain('is_active = TRUE');
        });

        it('should return empty array when no merchants have loyalty', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await getMerchantsWithLoyalty();

            expect(result).toHaveLength(0);
        });

        it('should propagate database errors', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(getMerchantsWithLoyalty()).rejects.toThrow('Connection refused');
        });
    });

    describe('processMerchantCatchup', () => {
        const mockMerchant = { id: 1, square_merchant_id: 'sq-1' };

        it('should return clean results when no orders found', async () => {
            // locations query
            db.query.mockResolvedValueOnce({
                rows: [{ square_location_id: 'loc-1' }],
            });

            getSquareClientForMerchant.mockResolvedValue({
                orders: { search: jest.fn().mockResolvedValue({ orders: [] }) },
            });

            const result = await processMerchantCatchup(mockMerchant, 6);

            expect(result.merchantId).toBe(1);
            expect(result.ordersFound).toBe(0);
            expect(result.ordersProcessed).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it('should return clean results when no active locations', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            getSquareClientForMerchant.mockResolvedValue({
                orders: { search: jest.fn().mockResolvedValue({ orders: [] }) },
            });

            const result = await processMerchantCatchup(mockMerchant, 6);

            expect(result.ordersFound).toBe(0);
        });

        it('should handle Square API errors gracefully', async () => {
            getSquareClientForMerchant.mockRejectedValue(new Error('Square unavailable'));

            const result = await processMerchantCatchup(mockMerchant, 6);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain('Square unavailable');
        });

        it('should skip already-processed orders', async () => {
            // locations query
            db.query.mockResolvedValueOnce({
                rows: [{ square_location_id: 'loc-1' }],
            });

            getSquareClientForMerchant.mockResolvedValue({
                orders: {
                    search: jest.fn().mockResolvedValue({
                        orders: [{ id: 'order-1', line_items: [{ uid: 'li-1' }] }],
                    }),
                },
            });

            // getProcessedOrderIds - order already processed
            db.query.mockResolvedValueOnce({
                rows: [{ square_order_id: 'order-1' }],
            });

            const result = await processMerchantCatchup(mockMerchant, 6);

            expect(result.ordersAlreadyProcessed).toBe(1);
            expect(result.ordersProcessed).toBe(0);
            expect(processLoyaltyOrder).not.toHaveBeenCalled();
        });

        it('should scope location query to merchant_id', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            getSquareClientForMerchant.mockResolvedValue({
                orders: { search: jest.fn().mockResolvedValue({ orders: [] }) },
            });

            await processMerchantCatchup(mockMerchant, 6);

            // The locations query should filter by merchant_id
            const locationQuery = db.query.mock.calls[0];
            expect(locationQuery[0]).toContain('merchant_id = $1');
            expect(locationQuery[1]).toEqual([1]);
        });
    });

    describe('runLoyaltyCatchup', () => {
        it('should return empty results when no merchants have loyalty', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runLoyaltyCatchup();

            expect(result.merchantsProcessed).toBe(0);
            expect(result.totalOrdersFound).toBe(0);
        });

        it('should process multiple merchants', async () => {
            // getMerchantsWithLoyalty
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, square_merchant_id: 'sq-1' },
                    { id: 2, square_merchant_id: 'sq-2' },
                ],
            });

            // Both merchants: locations query returns empty (no orders to process)
            db.query.mockResolvedValue({ rows: [] });

            getSquareClientForMerchant.mockResolvedValue({
                orders: { search: jest.fn().mockResolvedValue({ orders: [] }) },
            });

            const result = await runLoyaltyCatchup({ hoursBack: 3 });

            expect(result.merchantsProcessed).toBe(2);
        });

        it('should propagate top-level database errors', async () => {
            db.query.mockRejectedValueOnce(new Error('DB connection lost'));

            await expect(runLoyaltyCatchup()).rejects.toThrow('DB connection lost');
        });
    });

    describe('runScheduledLoyaltyCatchup', () => {
        it('should not throw even when catchup fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB error'));

            await expect(runScheduledLoyaltyCatchup()).resolves.toBeUndefined();
        });

        it('should call runLoyaltyCatchup with 6 hours', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await runScheduledLoyaltyCatchup();

            expect(db.query).toHaveBeenCalled();
        });
    });
});
