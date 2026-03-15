/**
 * Cycle Count Service Tests
 *
 * Tests for daily batch generation and cycle count email reporting.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../../../utils/database');
const emailNotifier = require('../../../utils/email-notifier');
const cycleCountService = require('../../../services/inventory/cycle-count-service');

describe('Cycle Count Service', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    // ==================== generateDailyBatch ====================
    describe('generateDailyBatch', () => {
        test('throws if merchantId is missing', async () => {
            await expect(cycleCountService.generateDailyBatch(null))
                .rejects.toThrow('merchantId is required');
        });

        test('generates batch with new items and inaccurate recounts', async () => {
            db.query
                // Create session
                .mockResolvedValueOnce({})
                // Recent inaccurate counts
                .mockResolvedValueOnce({
                    rows: [
                        { catalog_object_id: 'v1', sku: 'SKU1', item_name: 'Item 1', count_date: new Date(Date.now() - 86400000) },
                    ],
                })
                // Insert priority item
                .mockResolvedValueOnce({})
                // Uncompleted count
                .mockResolvedValueOnce({ rows: [{ count: '5' }] })
                // New items to add
                .mockResolvedValueOnce({
                    rows: [{ id: 'v2' }, { id: 'v3' }],
                })
                // Insert new items (2 inserts)
                .mockResolvedValueOnce({})
                .mockResolvedValueOnce({});

            const result = await cycleCountService.generateDailyBatch(1);

            expect(result.success).toBe(true);
            expect(result.uncompleted).toBe(5);
            expect(result.new_items_added).toBe(2);
            expect(result.yesterday_inaccurate_added).toBe(1);
            expect(result.total_in_batch).toBe(7);
        });

        test('handles no inaccurate counts', async () => {
            db.query
                .mockResolvedValueOnce({}) // session
                .mockResolvedValueOnce({ rows: [] }) // no inaccurate
                .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // uncompleted
                .mockResolvedValueOnce({ rows: [{ id: 'v1' }] }) // new items
                .mockResolvedValueOnce({}); // insert

            const result = await cycleCountService.generateDailyBatch(1);
            expect(result.yesterday_inaccurate_added).toBe(0);
        });

        test('handles no new items available', async () => {
            db.query
                .mockResolvedValueOnce({}) // session
                .mockResolvedValueOnce({ rows: [] }) // no inaccurate
                .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // uncompleted
                .mockResolvedValueOnce({ rows: [] }); // no new items

            const result = await cycleCountService.generateDailyBatch(1);
            expect(result.new_items_added).toBe(0);
            expect(result.total_in_batch).toBe(10);
        });

        test('uses DAILY_COUNT_TARGET env var', async () => {
            process.env.DAILY_COUNT_TARGET = '50';

            db.query
                .mockResolvedValueOnce({}) // session
                .mockResolvedValueOnce({ rows: [] }) // no inaccurate
                .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // uncompleted
                .mockResolvedValueOnce({ rows: [] }); // no new items

            await cycleCountService.generateDailyBatch(1);

            // Check session insert uses dailyTarget = 50
            expect(db.query.mock.calls[0][1]).toEqual([50, 1]);
        });

        test('rethrows DB errors', async () => {
            db.query.mockRejectedValue(new Error('DB down'));
            await expect(cycleCountService.generateDailyBatch(1)).rejects.toThrow('DB down');
        });
    });

    // ==================== sendCycleCountReport ====================
    describe('sendCycleCountReport', () => {
        test('returns not sent when email disabled', async () => {
            process.env.EMAIL_ENABLED = 'false';
            const result = await cycleCountService.sendCycleCountReport(1);
            expect(result.sent).toBe(false);
            expect(result.reason).toBe('Email reporting disabled');
        });

        test('returns not sent when report email disabled', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'false';
            const result = await cycleCountService.sendCycleCountReport(1);
            expect(result.sent).toBe(false);
        });

        test('returns not sent when no session data', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'true';

            db.query.mockResolvedValueOnce({ rows: [] });

            const result = await cycleCountService.sendCycleCountReport(1);
            expect(result.sent).toBe(false);
            expect(result.reason).toBe('No session data');
        });

        test('sends report email with accuracy data', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'true';

            db.query
                .mockResolvedValueOnce({
                    rows: [{
                        session_date: '2026-03-15',
                        items_expected: 30,
                        items_completed: 28,
                        completion_rate: 93,
                    }],
                })
                .mockResolvedValueOnce({
                    rows: [
                        { sku: 'SK1', item_name: 'Dog Food', variation_name: 'Small', is_accurate: true, actual_quantity: 10, expected_quantity: 10, variance: 0, notes: null, counted_by: 'Staff', last_counted_date: new Date() },
                        { sku: 'SK2', item_name: 'Cat Food', variation_name: null, is_accurate: false, actual_quantity: 8, expected_quantity: 10, variance: -2, notes: 'Missing', counted_by: 'Staff', last_counted_date: new Date() },
                    ],
                });

            const result = await cycleCountService.sendCycleCountReport(1);
            expect(result.sent).toBe(true);
            expect(result.items_count).toBe(2);
            expect(result.accuracy_rate).toBe('50.0');
            expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
            expect(emailNotifier.sendAlert.mock.calls[0][0]).toContain('Cycle Count Report');
        });

        test('sends to additional email if configured', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'true';
            process.env.ADDITIONAL_CYCLE_COUNT_REPORT_EMAIL = 'extra@test.com';

            db.query
                .mockResolvedValueOnce({
                    rows: [{ session_date: '2026-03-15', items_expected: 10, items_completed: 10, completion_rate: 100 }],
                })
                .mockResolvedValueOnce({ rows: [] });

            await cycleCountService.sendCycleCountReport(1);
            expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(2);
        });

        test('handles additional email failure gracefully', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'true';
            process.env.ADDITIONAL_CYCLE_COUNT_REPORT_EMAIL = 'bad@test.com';

            db.query
                .mockResolvedValueOnce({
                    rows: [{ session_date: '2026-03-15', items_expected: 10, items_completed: 10, completion_rate: 100 }],
                })
                .mockResolvedValueOnce({ rows: [] });

            emailNotifier.sendAlert
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('SMTP error'));

            const result = await cycleCountService.sendCycleCountReport(1);
            expect(result.sent).toBe(true); // Primary email still succeeded
        });

        test('filters by merchantId when provided', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'true';

            db.query
                .mockResolvedValueOnce({ rows: [] }); // No session

            await cycleCountService.sendCycleCountReport(5);
            expect(db.query.mock.calls[0][0]).toContain('merchant_id = $1');
            expect(db.query.mock.calls[0][1]).toEqual([5]);
        });

        test('works without merchantId (no filter)', async () => {
            process.env.EMAIL_ENABLED = 'true';
            process.env.CYCLE_COUNT_REPORT_EMAIL = 'true';

            db.query.mockResolvedValueOnce({ rows: [] });

            await cycleCountService.sendCycleCountReport();
            expect(db.query.mock.calls[0][1]).toEqual([]);
        });
    });
});
