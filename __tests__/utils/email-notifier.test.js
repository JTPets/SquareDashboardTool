/**
 * Tests for email-notifier.js MT-2 fix:
 * Per-merchant email routing via admin_email column
 *
 * Uses jest.requireActual to bypass the global mock in setup.js
 */

process.env.NODE_ENV = 'test';
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret-for-jest-tests';
process.env.EMAIL_TO = 'platform-admin@system.com';
process.env.EMAIL_ENABLED = 'false'; // Disable actual email sending

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
        sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' })
    }))
}), { virtual: true });

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// Unmock email-notifier so we get the real implementation
jest.unmock('../../utils/email-notifier');

const db = require('../../utils/database');

describe('EmailNotifier._resolveRecipient', () => {
    let emailNotifier;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.EMAIL_TO = 'platform-admin@system.com';
        emailNotifier = require('../../utils/email-notifier');
    });

    test('returns merchant admin_email when merchantId provided and has email', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ admin_email: 'merchant@store.com' }]
        });

        const result = await emailNotifier._resolveRecipient(42);

        expect(result).toBe('merchant@store.com');
        expect(db.query).toHaveBeenCalledWith(
            'SELECT admin_email FROM merchants WHERE id = $1',
            [42]
        );
    });

    test('falls back to EMAIL_TO when merchant has no admin_email', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ admin_email: null }]
        });

        const result = await emailNotifier._resolveRecipient(42);

        expect(result).toBe('platform-admin@system.com');
    });

    test('falls back to EMAIL_TO when merchantId is null', async () => {
        const result = await emailNotifier._resolveRecipient(null);

        expect(result).toBe('platform-admin@system.com');
    });

    test('falls back to EMAIL_TO when merchantId is undefined', async () => {
        const result = await emailNotifier._resolveRecipient(undefined);

        expect(result).toBe('platform-admin@system.com');
    });

    test('falls back to EMAIL_TO when merchant not found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await emailNotifier._resolveRecipient(999);

        expect(result).toBe('platform-admin@system.com');
    });

    test('falls back to EMAIL_TO when db query fails', async () => {
        db.query.mockRejectedValueOnce(new Error('connection error'));

        const result = await emailNotifier._resolveRecipient(42);

        expect(result).toBe('platform-admin@system.com');
    });
});

describe('EmailNotifier.sendAlert backward compatibility', () => {
    let emailNotifier;

    beforeEach(() => {
        emailNotifier = require('../../utils/email-notifier');
    });

    test('sendAlert accepts 2-arg signature without options', async () => {
        // Should not throw - sendAlert(subject, body) with no options
        await expect(emailNotifier.sendAlert('Test', 'body')).resolves.not.toThrow();
    });

    test('sendAlert accepts 3-arg signature with options', async () => {
        await expect(
            emailNotifier.sendAlert('Test', 'body', { merchantId: 1 })
        ).resolves.not.toThrow();
    });
});
