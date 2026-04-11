/**
 * Auto Min/Max Job Tests
 *
 * Verifies the weekly cron job iterates all active merchants,
 * calls applyWeeklyAdjustments, handles errors gracefully, and logs summary.
 * Includes Square sync wiring: syncMinsToSquare is called after a clean commit,
 * results appear in the email, and sync errors are caught without crashing.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/inventory/auto-min-max-service', () => ({
    applyWeeklyAdjustments: jest.fn(),
}));

jest.mock('../../services/inventory/auto-min-max-square-sync', () => ({
    syncMinsToSquare: jest.fn(),
}));

const db = require('../../utils/database');
const emailNotifier = require('../../utils/email-notifier');
const autoMinMax = require('../../services/inventory/auto-min-max-service');
const squareSync = require('../../services/inventory/auto-min-max-square-sync');
const job = require('../../jobs/auto-min-max-job');
const logger = require('../../utils/logger');

// Default sync result used in most tests
const DEFAULT_SYNC = { synced: 2, failed: 0, repairedParents: 0, errors: [] };

// Default successful adjustment result
function adjustmentResult(overrides = {}) {
    return {
        reduced: 2, increased: 1, skipped: 0, pinned: 0, tooNew: 0,
        adjustments: [
            { variationId: 'var1', locationId: 'loc1', newMin: 1, previousMin: 2 },
            { variationId: 'var2', locationId: 'loc1', newMin: 3, previousMin: 2 },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    squareSync.syncMinsToSquare.mockResolvedValue(DEFAULT_SYNC);
});

// ==================== import check ====================

describe('auto-min-max-job module', () => {
    test('exports runAutoMinMaxForMerchant', () => {
        expect(typeof job.runAutoMinMaxForMerchant).toBe('function');
    });

    test('exports runAutoMinMaxForAllMerchants', () => {
        expect(typeof job.runAutoMinMaxForAllMerchants).toBe('function');
    });

    test('exports runScheduledAutoMinMax', () => {
        expect(typeof job.runScheduledAutoMinMax).toBe('function');
    });
});

// ==================== runAutoMinMaxForAllMerchants ====================

describe('runAutoMinMaxForAllMerchants', () => {
    test('returns empty results when no active merchants', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const result = await job.runAutoMinMaxForAllMerchants();
        expect(result.merchantCount).toBe(0);
        expect(result.results).toHaveLength(0);
        expect(autoMinMax.applyWeeklyAdjustments).not.toHaveBeenCalled();
    });

    test('calls applyWeeklyAdjustments for each active merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
            { id: 2, business_name: 'Shop B' },
        ]});
        autoMinMax.applyWeeklyAdjustments
            .mockResolvedValueOnce(adjustmentResult({ reduced: 2, increased: 1 }))
            .mockResolvedValueOnce(adjustmentResult({ reduced: 0, increased: 3, skipped: 2, pinned: 0, tooNew: 1 }));

        const result = await job.runAutoMinMaxForAllMerchants();
        expect(result.merchantCount).toBe(2);
        expect(autoMinMax.applyWeeklyAdjustments).toHaveBeenCalledTimes(2);
        expect(autoMinMax.applyWeeklyAdjustments).toHaveBeenCalledWith(1);
        expect(autoMinMax.applyWeeklyAdjustments).toHaveBeenCalledWith(2);
    });

    test('handles per-merchant errors gracefully and continues', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
            { id: 2, business_name: 'Shop B' },
        ]});
        autoMinMax.applyWeeklyAdjustments
            .mockRejectedValueOnce(new Error('DB error'))
            .mockResolvedValueOnce(adjustmentResult({ reduced: 1, increased: 0 }));

        const result = await job.runAutoMinMaxForAllMerchants();
        expect(result.merchantCount).toBe(2);
        expect(result.results[0].error).toBe('DB error');
        expect(result.results[1].reduced).toBe(1);
        expect(logger.error).toHaveBeenCalled();
    });
});

// ==================== runAutoMinMaxForMerchant — Square sync wiring ====================

describe('runAutoMinMaxForMerchant — Square sync', () => {
    test('syncMinsToSquare called with adjustments after successful adjustment', async () => {
        const adj = adjustmentResult();
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(adj);

        await job.runAutoMinMaxForMerchant(1, 'Shop A');

        expect(squareSync.syncMinsToSquare).toHaveBeenCalledWith(1, adj.adjustments);
    });

    test('syncMinsToSquare NOT called when circuit breaker aborts', async () => {
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce({
            aborted: true,
            reason: 'Circuit breaker — 25% of items would be reduced'
        });

        await job.runAutoMinMaxForMerchant(1, 'Shop A');

        expect(squareSync.syncMinsToSquare).not.toHaveBeenCalled();
    });

    test('syncMinsToSquare NOT called when stale velocity aborts', async () => {
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce({
            aborted: true,
            reason: 'Velocity data stale — last sync never'
        });

        await job.runAutoMinMaxForMerchant(1, 'Shop A');

        expect(squareSync.syncMinsToSquare).not.toHaveBeenCalled();
    });

    test('syncMinsToSquare NOT called when adjustments array is empty', async () => {
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ adjustments: [], reduced: 0, increased: 0 })
        );

        await job.runAutoMinMaxForMerchant(1, 'Shop A');

        expect(squareSync.syncMinsToSquare).not.toHaveBeenCalled();
    });

    test('syncResult included in return value', async () => {
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(adjustmentResult());
        squareSync.syncMinsToSquare.mockResolvedValueOnce({ synced: 2, failed: 0, repairedParents: 0, errors: [] });

        const result = await job.runAutoMinMaxForMerchant(1, 'Shop A');

        expect(result.syncResult).toEqual({ synced: 2, failed: 0, repairedParents: 0, errors: [] });
    });

    test('Square sync error is caught, logged, and emailed — does not throw', async () => {
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(adjustmentResult());
        squareSync.syncMinsToSquare.mockRejectedValueOnce(new Error('Square unavailable'));

        // Must not throw
        await expect(job.runAutoMinMaxForMerchant(1, 'Shop A')).resolves.not.toThrow();

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Square min sync failed'),
            expect.objectContaining({ merchantId: 1 })
        );
        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            expect.stringContaining('Square Sync Failed'),
            expect.stringContaining('Square unavailable')
        );
    });

    test('Square sync error does not affect audit log (local commit already done)', async () => {
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(adjustmentResult({ reduced: 2, increased: 0 }));
        squareSync.syncMinsToSquare.mockRejectedValueOnce(new Error('Square unavailable'));

        const result = await job.runAutoMinMaxForMerchant(1, 'Shop A');

        // Local counts are unaffected
        expect(result.reduced).toBe(2);
        expect(result.aborted).toBeUndefined();
    });
});

// ==================== runScheduledAutoMinMax ====================

describe('runScheduledAutoMinMax', () => {
    test('sends summary email when adjustments are made', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ reduced: 3, increased: 2 })
        );

        await job.runScheduledAutoMinMax();
        expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
        const subject = emailNotifier.sendAlert.mock.calls[0][0];
        expect(subject).toContain('3 reduced');
        expect(subject).toContain('2 increased');
    });

    test('email body includes Square sync result line', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ reduced: 2, increased: 1 })
        );
        squareSync.syncMinsToSquare.mockResolvedValueOnce({ synced: 2, failed: 1, repairedParents: 0, errors: ['1 variation(s) failed'] });

        await job.runScheduledAutoMinMax();

        const body = emailNotifier.sendAlert.mock.calls[0][1];
        expect(body).toContain('Synced to Square: 2 (1 failed)');
    });

    test('email body includes repairedParents line when parents were repaired', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ reduced: 2, increased: 1 })
        );
        squareSync.syncMinsToSquare.mockResolvedValueOnce({ synced: 16, failed: 0, repairedParents: 4, errors: [] });

        await job.runScheduledAutoMinMax();

        const body = emailNotifier.sendAlert.mock.calls[0][1];
        expect(body).toContain('Repaired 4 parent item location mismatch(es) before sync');
    });

    test('email body does NOT include repairedParents line when zero repairs', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ reduced: 2, increased: 1 })
        );
        squareSync.syncMinsToSquare.mockResolvedValueOnce({ synced: 2, failed: 0, repairedParents: 0, errors: [] });

        await job.runScheduledAutoMinMax();

        const body = emailNotifier.sendAlert.mock.calls[0][1];
        expect(body).not.toContain('parent item location mismatch');
    });

    test('does not send email when no adjustments are made', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ reduced: 0, increased: 0, skipped: 5, pinned: 2, tooNew: 3, adjustments: [] })
        );

        await job.runScheduledAutoMinMax();
        expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
    });

    test('sends error alert and logs on top-level failure', async () => {
        db.query.mockRejectedValueOnce(new Error('connection failed'));

        await job.runScheduledAutoMinMax();
        expect(logger.error).toHaveBeenCalled();
        expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
            expect.stringContaining('Failed'),
            expect.stringContaining('connection failed')
        );
    });

    test('Square sync error in one merchant does not prevent email for that merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce(
            adjustmentResult({ reduced: 1, increased: 0 })
        );
        squareSync.syncMinsToSquare.mockRejectedValueOnce(new Error('Square unavailable'));

        await job.runScheduledAutoMinMax();

        // Summary email still sent (sync error is handled inside runAutoMinMaxForMerchant)
        const summaryCall = emailNotifier.sendAlert.mock.calls.find(c => c[0].includes('reduced'));
        expect(summaryCall).toBeDefined();
    });
});
