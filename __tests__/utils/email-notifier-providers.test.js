/**
 * Tests for email-notifier.js multi-provider support (BACKLOG-80)
 *
 * Verifies SMTP, Resend, and Mailgun provider routing,
 * _send delegation, heartbeat, and backward compatibility.
 */

process.env.NODE_ENV = 'test';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret-for-jest-tests';
process.env.EMAIL_TO = 'admin@test.com';
process.env.EMAIL_ENABLED = 'false';

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
        sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-test-id' })
    }))
}), { virtual: true });

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.unmock('../../utils/email-notifier');

const db = require('../../utils/database');

describe('EmailNotifier multi-provider', () => {

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        delete process.env.EMAIL_PROVIDER;
        delete process.env.EMAIL_API_KEY;
        delete process.env.MAILGUN_DOMAIN;
        delete process.env.EMAIL_FROM_NAME;
        process.env.EMAIL_ENABLED = 'false';
    });

    describe('provider selection', () => {
        test('defaults to smtp when EMAIL_PROVIDER not set', () => {
            const notifier = require('../../utils/email-notifier');
            expect(notifier.getProvider()).toBe('smtp');
        });

        test('selects resend provider', () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'resend';
            process.env.EMAIL_API_KEY = 'test-key';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            expect(notifier.getProvider()).toBe('resend');
        });

        test('selects mailgun provider', () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'mailgun';
            process.env.EMAIL_API_KEY = 'test-key';
            process.env.MAILGUN_DOMAIN = 'mg.test.com';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            expect(notifier.getProvider()).toBe('mailgun');
        });

        test('handles uppercase EMAIL_PROVIDER gracefully', () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'RESEND';
            process.env.EMAIL_API_KEY = 'test-key';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            expect(notifier.getProvider()).toBe('resend');
        });
    });

    describe('from address formatting', () => {
        test('includes EMAIL_FROM_NAME in from address', () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            process.env.EMAIL_FROM_NAME = 'My Alerts';
            const notifier = require('../../utils/email-notifier');
            expect(notifier.fromAddress).toBe('My Alerts <alerts@sqtools.ca>');
        });

        test('defaults EMAIL_FROM_NAME to SqTools Alerts', () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            delete process.env.EMAIL_FROM_NAME;
            const notifier = require('../../utils/email-notifier');
            expect(notifier.fromAddress).toBe('SqTools Alerts <alerts@sqtools.ca>');
        });
    });

    describe('_send delegation', () => {
        test('smtp provider calls transporter.sendMail', async () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            const sendMail = notifier.transporter.sendMail;

            await notifier._send({ to: 'test@test.com', subject: 'test', html: '<p>hi</p>' });
            expect(sendMail).toHaveBeenCalledTimes(1);
        });

        test('resend provider calls fetch', async () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'resend';
            process.env.EMAIL_API_KEY = 're_test_key';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';

            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 'resend-123' })
            });
            global.fetch = mockFetch;

            const notifier = require('../../utils/email-notifier');
            await notifier._send({ to: 'test@test.com', subject: 'test', html: '<p>hi</p>' });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch.mock.calls[0][0]).toBe('https://api.resend.com/emails');
            const fetchOptions = mockFetch.mock.calls[0][1];
            expect(fetchOptions.headers['Authorization']).toBe('Bearer re_test_key');

            delete global.fetch;
        });

        test('mailgun provider calls fetch', async () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'mailgun';
            process.env.EMAIL_API_KEY = 'mg_test_key';
            process.env.MAILGUN_DOMAIN = 'mg.test.com';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';

            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 'mailgun-123', message: 'Queued' })
            });
            global.fetch = mockFetch;

            const notifier = require('../../utils/email-notifier');
            await notifier._send({ to: 'test@test.com', subject: 'test', html: '<p>hi</p>' });

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch.mock.calls[0][0]).toBe('https://api.mailgun.net/v3/mg.test.com/messages');

            delete global.fetch;
        });

        test('resend throws on API error', async () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'resend';
            process.env.EMAIL_API_KEY = 're_bad_key';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';

            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 401,
                text: () => Promise.resolve('Unauthorized')
            });

            const notifier = require('../../utils/email-notifier');
            await expect(
                notifier._send({ to: 'test@test.com', subject: 'test', html: '<p>hi</p>' })
            ).rejects.toThrow('Resend API error 401: Unauthorized');

            delete global.fetch;
        });

        test('mailgun throws on API error', async () => {
            jest.resetModules();
            process.env.EMAIL_PROVIDER = 'mailgun';
            process.env.EMAIL_API_KEY = 'mg_bad_key';
            process.env.MAILGUN_DOMAIN = 'mg.test.com';
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';

            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 403,
                text: () => Promise.resolve('Forbidden')
            });

            const notifier = require('../../utils/email-notifier');
            await expect(
                notifier._send({ to: 'test@test.com', subject: 'test', html: '<p>hi</p>' })
            ).rejects.toThrow('Mailgun API error 403: Forbidden');

            delete global.fetch;
        });
    });

    describe('sendHeartbeat', () => {
        test('does nothing when email disabled', async () => {
            const notifier = require('../../utils/email-notifier');
            // enabled is false by default in test
            await expect(notifier.sendHeartbeat()).resolves.not.toThrow();
        });

        test('sends heartbeat when enabled', async () => {
            jest.resetModules();
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            const sendMail = notifier.transporter.sendMail;

            await notifier.sendHeartbeat();
            expect(sendMail).toHaveBeenCalledTimes(1);
            const mailOpts = sendMail.mock.calls[0][0];
            expect(mailOpts.subject).toContain('Heartbeat');
            expect(mailOpts.html).toContain('System Heartbeat');
        });
    });

    describe('testEmail', () => {
        test('throws when email disabled', async () => {
            const notifier = require('../../utils/email-notifier');
            await expect(notifier.testEmail()).rejects.toThrow('Email notifications are disabled');
        });

        test('sends test email with provider info when enabled', async () => {
            jest.resetModules();
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            const sendMail = notifier.transporter.sendMail;

            await notifier.testEmail();
            expect(sendMail).toHaveBeenCalledTimes(1);
            const mailOpts = sendMail.mock.calls[0][0];
            expect(mailOpts.subject).toContain('Test Email');
            expect(mailOpts.html).toContain('smtp');
        });
    });

    describe('sendCritical uses _send', () => {
        test('routes through _send when enabled', async () => {
            jest.resetModules();
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            const sendMail = notifier.transporter.sendMail;

            await notifier.sendCritical('DB down', new Error('connection lost'));
            expect(sendMail).toHaveBeenCalledTimes(1);
            expect(sendMail.mock.calls[0][0].subject).toContain('CRITICAL');
        });
    });

    describe('sendAlert uses _send', () => {
        test('routes through _send when enabled', async () => {
            jest.resetModules();
            process.env.EMAIL_ENABLED = 'true';
            process.env.EMAIL_PROVIDER = 'smtp';
            process.env.EMAIL_FROM = 'alerts@sqtools.ca';
            const notifier = require('../../utils/email-notifier');
            const sendMail = notifier.transporter.sendMail;

            await notifier.sendAlert('Sync failed', 'Details here');
            expect(sendMail).toHaveBeenCalledTimes(1);
            expect(sendMail.mock.calls[0][0].subject).toContain('ALERT');
        });
    });

    describe('backward compatibility', () => {
        test('sendAlert accepts 2-arg signature', async () => {
            const notifier = require('../../utils/email-notifier');
            await expect(notifier.sendAlert('Test', 'body')).resolves.not.toThrow();
        });

        test('sendAlert accepts 3-arg signature with merchantId', async () => {
            const notifier = require('../../utils/email-notifier');
            await expect(
                notifier.sendAlert('Test', 'body', { merchantId: 1 })
            ).resolves.not.toThrow();
        });
    });
});
