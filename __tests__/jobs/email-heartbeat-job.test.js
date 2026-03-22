/**
 * Tests for email heartbeat job (BACKLOG-80)
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendHeartbeat: jest.fn().mockResolvedValue(),
    sendCritical: jest.fn().mockResolvedValue(),
    sendAlert: jest.fn().mockResolvedValue(),
    enabled: false,
}));

const emailNotifier = require('../../utils/email-notifier');
const logger = require('../../utils/logger');

describe('email-heartbeat-job', () => {
    let runScheduledHeartbeat, isHeartbeatEnabled;

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.EMAIL_HEARTBEAT_ENABLED;
        jest.resetModules();

        // Re-mock after resetModules
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }));
        jest.mock('../../utils/email-notifier', () => ({
            sendHeartbeat: jest.fn().mockResolvedValue(),
            sendCritical: jest.fn().mockResolvedValue(),
            sendAlert: jest.fn().mockResolvedValue(),
            enabled: false,
        }));

        const job = require('../../jobs/email-heartbeat-job');
        runScheduledHeartbeat = job.runScheduledHeartbeat;
        isHeartbeatEnabled = job.isHeartbeatEnabled;
    });

    test('isHeartbeatEnabled returns false by default', () => {
        expect(isHeartbeatEnabled()).toBe(false);
    });

    test('isHeartbeatEnabled returns true when env set', () => {
        process.env.EMAIL_HEARTBEAT_ENABLED = 'true';
        expect(isHeartbeatEnabled()).toBe(true);
    });

    test('runScheduledHeartbeat does nothing when disabled', async () => {
        const notifier = require('../../utils/email-notifier');
        await runScheduledHeartbeat();
        expect(notifier.sendHeartbeat).not.toHaveBeenCalled();
    });

    test('runScheduledHeartbeat sends heartbeat when enabled', async () => {
        process.env.EMAIL_HEARTBEAT_ENABLED = 'true';
        jest.resetModules();
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }));
        jest.mock('../../utils/email-notifier', () => ({
            sendHeartbeat: jest.fn().mockResolvedValue(),
            sendCritical: jest.fn().mockResolvedValue(),
            sendAlert: jest.fn().mockResolvedValue(),
            enabled: true,
        }));

        const job = require('../../jobs/email-heartbeat-job');
        const notifier = require('../../utils/email-notifier');
        await job.runScheduledHeartbeat();
        expect(notifier.sendHeartbeat).toHaveBeenCalledTimes(1);
    });

    test('runScheduledHeartbeat handles sendHeartbeat error gracefully', async () => {
        process.env.EMAIL_HEARTBEAT_ENABLED = 'true';
        jest.resetModules();
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }));
        jest.mock('../../utils/email-notifier', () => ({
            sendHeartbeat: jest.fn().mockRejectedValue(new Error('SMTP down')),
            sendCritical: jest.fn().mockResolvedValue(),
            sendAlert: jest.fn().mockResolvedValue(),
            enabled: true,
        }));

        const job = require('../../jobs/email-heartbeat-job');
        const log = require('../../utils/logger');
        await job.runScheduledHeartbeat();
        expect(log.error).toHaveBeenCalledWith(
            'Scheduled email heartbeat failed',
            expect.objectContaining({ error: 'SMTP down' })
        );
    });
});
