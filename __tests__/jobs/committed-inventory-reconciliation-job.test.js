/**
 * Committed Inventory Reconciliation Job Tests
 *
 * Tests import, no merchants, sync error per merchant, and successful reconciliation.
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

jest.mock('../../services/square', () => ({
    syncCommittedInventory: jest.fn(),
}));

const db = require('../../utils/database');
const squareApi = require('../../services/square');
const logger = require('../../utils/logger');
const {
    runCommittedInventoryReconciliation,
    runScheduledReconciliation,
} = require('../../jobs/committed-inventory-reconciliation-job');

describe('Committed Inventory Reconciliation Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        it('should export runCommittedInventoryReconciliation as a function', () => {
            expect(typeof runCommittedInventoryReconciliation).toBe('function');
        });

        it('should export runScheduledReconciliation as a function', () => {
            expect(typeof runScheduledReconciliation).toBe('function');
        });
    });

    describe('runCommittedInventoryReconciliation', () => {
        it('should handle no merchants gracefully', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await runCommittedInventoryReconciliation();

            expect(result.merchantCount).toBe(0);
            expect(result.results).toEqual([]);
            expect(squareApi.syncCommittedInventory).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'No merchants for committed inventory reconciliation'
            );
        });

        it('should call syncCommittedInventory with correct merchant_id', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 7, business_name: 'Test Store' }],
            });
            squareApi.syncCommittedInventory.mockResolvedValueOnce({
                rows_before: 10,
                rows_deleted: 2,
                rows_remaining: 8,
            });

            const result = await runCommittedInventoryReconciliation();

            expect(squareApi.syncCommittedInventory).toHaveBeenCalledWith(7);
            expect(result.merchantCount).toBe(1);
            expect(result.results[0].success).toBe(true);
            expect(result.results[0].merchantId).toBe(7);
        });

        it('should continue processing when one merchant sync fails', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                ],
            });
            squareApi.syncCommittedInventory
                .mockRejectedValueOnce(new Error('API timeout'))
                .mockResolvedValueOnce({ rows_before: 5, rows_deleted: 1, rows_remaining: 4 });

            const result = await runCommittedInventoryReconciliation();

            expect(result.merchantCount).toBe(2);
            expect(result.results[0].success).toBe(false);
            expect(result.results[0].error).toBe('API timeout');
            expect(result.results[1].success).toBe(true);
            expect(logger.error).toHaveBeenCalledWith(
                'Committed inventory reconciliation failed for merchant',
                expect.objectContaining({ merchantId: 1 })
            );
        });

        it('should handle DB query error by throwing', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(runCommittedInventoryReconciliation()).rejects.toThrow('Connection refused');
        });

        it('should process multiple merchants successfully', async () => {
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, business_name: 'Store A' },
                    { id: 2, business_name: 'Store B' },
                    { id: 3, business_name: 'Store C' },
                ],
            });
            squareApi.syncCommittedInventory.mockResolvedValue({
                rows_before: 3,
                rows_deleted: 0,
                rows_remaining: 3,
            });

            const result = await runCommittedInventoryReconciliation();

            expect(result.merchantCount).toBe(3);
            expect(result.results).toHaveLength(3);
            expect(result.results.every(r => r.success)).toBe(true);
            expect(squareApi.syncCommittedInventory).toHaveBeenCalledTimes(3);
        });
    });

    describe('runScheduledReconciliation', () => {
        it('should catch errors and not throw', async () => {
            db.query.mockRejectedValueOnce(new Error('DB down'));

            await expect(runScheduledReconciliation()).resolves.toBeUndefined();

            expect(logger.error).toHaveBeenCalledWith(
                'Scheduled committed inventory reconciliation failed',
                expect.objectContaining({ error: 'DB down' })
            );
        });
    });
});
