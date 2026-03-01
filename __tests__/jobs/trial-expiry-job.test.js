/**
 * Trial Expiry Notification Job Tests
 *
 * Tests the query logic, notification sending, and date helpers.
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

jest.mock('../../utils/email-notifier', () => ({
    sendAlert: jest.fn().mockResolvedValue(),
    sendCritical: jest.fn().mockResolvedValue(),
    enabled: false,
}));

const db = require('../../utils/database');
const emailNotifier = require('../../utils/email-notifier');
const logger = require('../../utils/logger');
const {
    runTrialExpiryNotifications,
    getTrialExpiryMerchants,
    formatDate,
    daysUntil
} = require('../../jobs/trial-expiry-job');

describe('Trial Expiry Notification Job', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getTrialExpiryMerchants', () => {
        it('should query expiring and recently expired merchants', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 2, business_name: 'Beta Store', trial_ends_at: '2026-03-10T00:00:00Z' }]
                })
                .mockResolvedValueOnce({
                    rows: [{ id: 3, business_name: 'Expired Store', trial_ends_at: '2026-02-28T00:00:00Z' }]
                });

            const result = await getTrialExpiryMerchants();

            expect(result.expiring).toHaveLength(1);
            expect(result.recentlyExpired).toHaveLength(1);

            // Verify expiring query checks: is_active, trial status, trial_ends_at > NOW, <= NOW + 14 days
            const expiringQuery = db.query.mock.calls[0][0];
            expect(expiringQuery).toContain('is_active = TRUE');
            expect(expiringQuery).toContain("subscription_status = 'trial'");
            expect(expiringQuery).toContain('trial_ends_at > NOW()');
            expect(expiringQuery).toContain("INTERVAL '14 days'");

            // Verify expired query checks: trial_ends_at <= NOW, > NOW - 24 hours
            const expiredQuery = db.query.mock.calls[1][0];
            expect(expiredQuery).toContain('trial_ends_at <= NOW()');
            expect(expiredQuery).toContain("INTERVAL '24 hours'");
        });

        it('should return empty arrays when no merchants match', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await getTrialExpiryMerchants();

            expect(result.expiring).toHaveLength(0);
            expect(result.recentlyExpired).toHaveLength(0);
        });
    });

    describe('runTrialExpiryNotifications', () => {
        it('should send email when merchants are expiring', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [
                        { id: 2, business_name: 'Beta Store', trial_ends_at: new Date(Date.now() + 5 * 86400000).toISOString() },
                        { id: 3, business_name: 'Another Store', trial_ends_at: new Date(Date.now() + 10 * 86400000).toISOString() }
                    ]
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await runTrialExpiryNotifications();

            expect(result.expiring).toBe(2);
            expect(result.recentlyExpired).toBe(0);
            expect(emailNotifier.sendAlert).toHaveBeenCalledTimes(1);
            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                expect.stringContaining('2 expiring'),
                expect.stringContaining('Beta Store')
            );
        });

        it('should log warning for recently expired merchants', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({
                    rows: [
                        { id: 4, business_name: 'Expired Store', trial_ends_at: new Date(Date.now() - 3600000).toISOString() }
                    ]
                });

            await runTrialExpiryNotifications();

            expect(logger.warn).toHaveBeenCalledWith(
                'Merchant trial expired in last 24 hours',
                expect.objectContaining({ merchantId: 4 })
            );
        });

        it('should not send email when no merchants are expiring or expired', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [] });

            await runTrialExpiryNotifications();

            expect(emailNotifier.sendAlert).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith('No expiring or recently expired trials');
        });

        it('should handle database errors gracefully', async () => {
            db.query.mockRejectedValueOnce(new Error('Connection refused'));

            await expect(runTrialExpiryNotifications()).rejects.toThrow('Connection refused');
            expect(logger.error).toHaveBeenCalledWith(
                'Trial expiry notification job failed',
                expect.objectContaining({ error: 'Connection refused' })
            );
        });

        it('should include both expiring and expired in same email', async () => {
            db.query
                .mockResolvedValueOnce({
                    rows: [{ id: 2, business_name: 'Expiring Store', trial_ends_at: new Date(Date.now() + 86400000).toISOString() }]
                })
                .mockResolvedValueOnce({
                    rows: [{ id: 3, business_name: 'Expired Store', trial_ends_at: new Date(Date.now() - 3600000).toISOString() }]
                });

            await runTrialExpiryNotifications();

            expect(emailNotifier.sendAlert).toHaveBeenCalledWith(
                expect.stringContaining('1 expiring, 1 expired'),
                expect.stringContaining('EXPIRING SOON')
            );
        });
    });

    describe('helper functions', () => {
        it('formatDate should format dates in Canadian English', () => {
            const result = formatDate('2026-09-01T12:00:00Z');
            // Should contain the year 2026 and September (noon UTC avoids TZ boundary issues)
            expect(result).toContain('2026');
            expect(result).toMatch(/September|Sep/);
        });

        it('daysUntil should calculate positive days for future dates', () => {
            const futureDate = new Date(Date.now() + 5 * 86400000); // 5 days from now
            const days = daysUntil(futureDate);
            expect(days).toBeGreaterThanOrEqual(4);
            expect(days).toBeLessThanOrEqual(6);
        });

        it('daysUntil should return negative for past dates', () => {
            const pastDate = new Date(Date.now() - 3 * 86400000); // 3 days ago
            const days = daysUntil(pastDate);
            expect(days).toBeLessThan(0);
        });
    });
});
