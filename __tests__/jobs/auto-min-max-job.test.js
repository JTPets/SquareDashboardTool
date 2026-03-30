/**
 * Auto Min/Max Job Tests
 *
 * Verifies the weekly cron job iterates all active merchants,
 * calls applyWeeklyAdjustments, handles errors gracefully, and logs summary.
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

const db = require('../../utils/database');
const emailNotifier = require('../../utils/email-notifier');
const autoMinMax = require('../../services/inventory/auto-min-max-service');
const job = require('../../jobs/auto-min-max-job');
const logger = require('../../utils/logger');

beforeEach(() => {
    jest.clearAllMocks();
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
            .mockResolvedValueOnce({ reduced: 2, increased: 1, skipped: 0, pinned: 1, tooNew: 0 })
            .mockResolvedValueOnce({ reduced: 0, increased: 3, skipped: 2, pinned: 0, tooNew: 1 });

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
            .mockResolvedValueOnce({ reduced: 1, increased: 0, skipped: 0, pinned: 0, tooNew: 0 });

        const result = await job.runAutoMinMaxForAllMerchants();
        expect(result.merchantCount).toBe(2);
        expect(result.results[0].error).toBe('DB error');
        expect(result.results[1].reduced).toBe(1);
        expect(logger.error).toHaveBeenCalled();
    });
});

// ==================== runScheduledAutoMinMax ====================

describe('runScheduledAutoMinMax', () => {
    test('sends summary email when adjustments are made', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce({
            reduced: 3, increased: 2, skipped: 1, pinned: 0, tooNew: 0
        });

        await job.runScheduledAutoMinMax();
        expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
        const subject = emailNotifier.sendAlert.mock.calls[0][0];
        expect(subject).toContain('3 reduced');
        expect(subject).toContain('2 increased');
    });

    test('does not send email when no adjustments are made', async () => {
        db.query.mockResolvedValueOnce({ rows: [
            { id: 1, business_name: 'Shop A' },
        ]});
        autoMinMax.applyWeeklyAdjustments.mockResolvedValueOnce({
            reduced: 0, increased: 0, skipped: 5, pinned: 2, tooNew: 3
        });

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
});
