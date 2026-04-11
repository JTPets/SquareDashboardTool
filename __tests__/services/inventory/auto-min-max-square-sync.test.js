/**
 * Auto Min/Max Square Sync Tests
 *
 * Tests for syncMinsToSquare — the function that pushes adjusted min-stock
 * thresholds to Square after a successful weekly applyWeeklyAdjustments() run.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/square/square-inventory', () => ({
    pushMinStockThresholdsToSquare: jest.fn(),
}));

const logger = require('../../../utils/logger');
const squareInventory = require('../../../services/square/square-inventory');
const { syncMinsToSquare } = require('../../../services/inventory/auto-min-max-square-sync');

const MERCHANT_ID = 1;

function makeAdjustment(overrides = {}) {
    return {
        variationId: 'var1',
        locationId: 'loc1',
        newMin: 2,
        previousMin: 3,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== syncMinsToSquare ====================

describe('syncMinsToSquare', () => {
    test('throws if merchantId is missing', async () => {
        await expect(syncMinsToSquare(null, [makeAdjustment()]))
            .rejects.toThrow('merchantId is required');
    });

    test('returns zero counts for empty adjustments array', async () => {
        const result = await syncMinsToSquare(MERCHANT_ID, []);
        expect(result).toEqual({ synced: 0, failed: 0, repairedParents: 0, errors: [] });
        expect(squareInventory.pushMinStockThresholdsToSquare).not.toHaveBeenCalled();
    });

    test('returns zero counts for null adjustments', async () => {
        const result = await syncMinsToSquare(MERCHANT_ID, null);
        expect(result).toEqual({ synced: 0, failed: 0, repairedParents: 0, errors: [] });
        expect(squareInventory.pushMinStockThresholdsToSquare).not.toHaveBeenCalled();
    });

    test('calls pushMinStockThresholdsToSquare with correct variationIds', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 2, failed: 0, repairedParents: 0 });

        const adjustments = [
            makeAdjustment({ variationId: 'var1', locationId: 'loc1', newMin: 1, previousMin: 2 }),
            makeAdjustment({ variationId: 'var2', locationId: 'loc1', newMin: 3, previousMin: 5 }),
        ];

        await syncMinsToSquare(MERCHANT_ID, adjustments);

        expect(squareInventory.pushMinStockThresholdsToSquare).toHaveBeenCalledWith(
            MERCHANT_ID,
            [
                { variationId: 'var1', locationId: 'loc1', newMin: 1 },
                { variationId: 'var2', locationId: 'loc1', newMin: 3 },
            ]
        );
    });

    test('previousMin is not forwarded to Square (catalog does not use it)', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 1, failed: 0, repairedParents: 0 });

        await syncMinsToSquare(MERCHANT_ID, [makeAdjustment({ previousMin: 99 })]);

        const passedChanges = squareInventory.pushMinStockThresholdsToSquare.mock.calls[0][1];
        expect(passedChanges[0]).not.toHaveProperty('previousMin');
    });

    test('returns synced count from pushMinStockThresholdsToSquare on full success', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 3, failed: 0, repairedParents: 0 });

        const result = await syncMinsToSquare(MERCHANT_ID, [
            makeAdjustment({ variationId: 'v1' }),
            makeAdjustment({ variationId: 'v2' }),
            makeAdjustment({ variationId: 'v3' }),
        ]);

        expect(result).toEqual({ synced: 3, failed: 0, repairedParents: 0, errors: [] });
    });

    test('partial Square failure: logs error, does not throw, returns failed count', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 2, failed: 1, repairedParents: 0 });

        const result = await syncMinsToSquare(MERCHANT_ID, [
            makeAdjustment({ variationId: 'v1' }),
            makeAdjustment({ variationId: 'v2' }),
            makeAdjustment({ variationId: 'v3' }),
        ]);

        expect(result.synced).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/1 variation/);
        // Must not throw — partial failure is logged, not re-raised
    });

    test('total Square failure: catches error, returns failed=count, does not throw', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockRejectedValueOnce(
            new Error('Token fetch failed')
        );

        const adjustments = [makeAdjustment({ variationId: 'v1' }), makeAdjustment({ variationId: 'v2' })];
        const result = await syncMinsToSquare(MERCHANT_ID, adjustments);

        expect(result.synced).toBe(0);
        expect(result.failed).toBe(2);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Token fetch failed');
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('push failed entirely'),
            expect.objectContaining({ merchantId: MERCHANT_ID })
        );
    });

    test('logs completion with synced/failed/repairedParents counts', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 5, failed: 0, repairedParents: 2 });

        await syncMinsToSquare(MERCHANT_ID, [
            makeAdjustment({ variationId: 'v1' }),
            makeAdjustment({ variationId: 'v2' }),
        ]);

        expect(logger.info).toHaveBeenCalledWith(
            'syncMinsToSquare complete',
            expect.objectContaining({ merchantId: MERCHANT_ID, synced: 5, failed: 0, repairedParents: 2 })
        );
    });

    test('repairedParents is passed through from pushMinStockThresholdsToSquare', async () => {
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 16, failed: 0, repairedParents: 3 });

        const adjustments = Array.from({ length: 16 }, (_, i) =>
            makeAdjustment({ variationId: `v${i}` })
        );
        const result = await syncMinsToSquare(MERCHANT_ID, adjustments);

        expect(result.repairedParents).toBe(3);
    });

    test('repairedParents defaults to 0 when not returned by inner function', async () => {
        // Simulate older call that does not return repairedParents
        squareInventory.pushMinStockThresholdsToSquare.mockResolvedValueOnce({ pushed: 2, failed: 0 });

        const result = await syncMinsToSquare(MERCHANT_ID, [makeAdjustment()]);

        expect(result.repairedParents).toBe(0);
    });
});
