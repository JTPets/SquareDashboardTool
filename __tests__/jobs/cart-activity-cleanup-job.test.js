/**
 * Cart Activity Cleanup Job Tests
 *
 * Tests import, no merchants, service error, and merchant iteration.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../services/cart/cart-activity-service', () => ({
    markAbandoned: jest.fn(),
    purgeOld: jest.fn(),
}));

const db = require('../../utils/database');
const cartActivityService = require('../../services/cart/cart-activity-service');
const logger = require('../../utils/logger');
const {
    runCartActivityCleanup,
    runScheduledCartActivityCleanup,
} = require('../../jobs/cart-activity-cleanup-job');

describe('Cart Activity Cleanup Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runCartActivityCleanup as a function', () => {
            expect(typeof runCartActivityCleanup).toBe('function');
        });

        it('should export runScheduledCartActivityCleanup as a function', () => {
            expect(typeof runScheduledCartActivityCleanup).toBe('function');
        });
    });

    describe('runCartActivityCleanup', () => {
        it('should handle no merchants gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runCartActivityCleanup();

            expect(result.success).toBe(true);
            expect(result.merchantCount).toBe(0);
            expect(result.abandonedCount).toBe(0);
            expect(result.purgedCount).toBe(0);
            expect(cartActivityService.markAbandoned).not.toHaveBeenCalled();
            expect(cartActivityService.purgeOld).not.toHaveBeenCalled();
        });

        it('should iterate through each merchant', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
            });
            cartActivityService.markAbandoned.mockResolvedValue(2);
            cartActivityService.purgeOld.mockResolvedValue(5);

            const result = await runCartActivityCleanup();

            expect(result.success).toBe(true);
            expect(result.merchantCount).toBe(3);
            expect(result.abandonedCount).toBe(6); // 2 * 3 merchants
            expect(result.purgedCount).toBe(15); // 5 * 3 merchants
            expect(cartActivityService.markAbandoned).toHaveBeenCalledTimes(3);
            expect(cartActivityService.purgeOld).toHaveBeenCalledTimes(3);
        });

        it('should pass correct merchant_id to service calls', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
            cartActivityService.markAbandoned.mockResolvedValue(0);
            cartActivityService.purgeOld.mockResolvedValue(0);

            await runCartActivityCleanup();

            expect(cartActivityService.markAbandoned).toHaveBeenCalledWith(42, 7);
            expect(cartActivityService.purgeOld).toHaveBeenCalledWith(42, 30);
        });

        it('should continue processing other merchants when one fails', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1 }, { id: 2 }],
            });
            cartActivityService.markAbandoned
                .mockRejectedValueOnce(new Error('Service error'))
                .mockResolvedValueOnce(3);
            cartActivityService.purgeOld.mockResolvedValue(1);

            const result = await runCartActivityCleanup();

            expect(result.success).toBe(true);
            expect(result.abandonedCount).toBe(3); // Only merchant 2 succeeded
            expect(logger.error).toHaveBeenCalledWith(
                'Cart cleanup failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should handle DB query error gracefully', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            const result = await runCartActivityCleanup();

            expect(result.success).toBe(false);
            expect(result.error).toBe('Connection refused');
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('runScheduledCartActivityCleanup', () => {
        it('should not throw even when cleanup fails', async () => {
            db.query.mockRejectedValueOnce(new Error('DB down'));

            await expect(runScheduledCartActivityCleanup()).resolves.toBeUndefined();
        });
    });
});
