/**
 * Tests for Square webhook subscription management
 * Verifies that webhook management uses the app-level access token (SQUARE_ACCESS_TOKEN),
 * NOT individual merchant OAuth tokens.
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../services/square/square-client', () => ({
    generateIdempotencyKey: jest.fn(() => 'test-idempotency-key')
}));

// Do NOT mock database — square-webhooks should not use it at all

const FAKE_APP_TOKEN = 'sq0atp-FAKE_APP_TOKEN_FOR_TESTING';

describe('square-webhooks', () => {
    let squareWebhooks;
    const originalEnv = process.env.SQUARE_ACCESS_TOKEN;
    const originalAppUrl = process.env.PUBLIC_APP_URL;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.SQUARE_ACCESS_TOKEN = FAKE_APP_TOKEN;
        process.env.PUBLIC_APP_URL = 'https://example.com';
        // Re-require to pick up env changes
        jest.resetModules();
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        }));
        jest.mock('../../services/square/square-client', () => ({
            generateIdempotencyKey: jest.fn(() => 'test-idempotency-key')
        }));
        squareWebhooks = require('../../utils/square-webhooks');
    });

    afterAll(() => {
        if (originalEnv !== undefined) {
            process.env.SQUARE_ACCESS_TOKEN = originalEnv;
        } else {
            delete process.env.SQUARE_ACCESS_TOKEN;
        }
        if (originalAppUrl !== undefined) {
            process.env.PUBLIC_APP_URL = originalAppUrl;
        } else {
            delete process.env.PUBLIC_APP_URL;
        }
    });

    describe('app-level token usage', () => {
        test('listWebhookSubscriptions uses SQUARE_ACCESS_TOKEN, not getMerchantToken', async () => {
            // Mock fetch to capture the Authorization header
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ subscriptions: [] })
            });
            global.fetch = mockFetch;

            await squareWebhooks.listWebhookSubscriptions(1);

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers.Authorization).toBe(`Bearer ${FAKE_APP_TOKEN}`);
        });

        test('getWebhookSubscription uses SQUARE_ACCESS_TOKEN', async () => {
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ subscription: { id: 'sub-123' } })
            });
            global.fetch = mockFetch;

            await squareWebhooks.getWebhookSubscription(1, 'sub-123');

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers.Authorization).toBe(`Bearer ${FAKE_APP_TOKEN}`);
        });

        test('createWebhookSubscription uses SQUARE_ACCESS_TOKEN', async () => {
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ subscription: { id: 'sub-new' } })
            });
            global.fetch = mockFetch;

            await squareWebhooks.createWebhookSubscription(1, {
                notificationUrl: 'https://example.com/webhooks'
            });

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers.Authorization).toBe(`Bearer ${FAKE_APP_TOKEN}`);
        });

        test('updateWebhookSubscription uses SQUARE_ACCESS_TOKEN', async () => {
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ subscription: { id: 'sub-123' } })
            });
            global.fetch = mockFetch;

            await squareWebhooks.updateWebhookSubscription(1, 'sub-123', { enabled: false });

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers.Authorization).toBe(`Bearer ${FAKE_APP_TOKEN}`);
        });

        test('deleteWebhookSubscription uses SQUARE_ACCESS_TOKEN', async () => {
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({})
            });
            global.fetch = mockFetch;

            await squareWebhooks.deleteWebhookSubscription(1, 'sub-123');

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers.Authorization).toBe(`Bearer ${FAKE_APP_TOKEN}`);
        });

        test('testWebhookSubscription uses SQUARE_ACCESS_TOKEN', async () => {
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({})
            });
            global.fetch = mockFetch;

            await squareWebhooks.testWebhookSubscription(1, 'sub-123');

            const [, options] = mockFetch.mock.calls[0];
            expect(options.headers.Authorization).toBe(`Bearer ${FAKE_APP_TOKEN}`);
        });
    });

    describe('SQUARE_ACCESS_TOKEN guard', () => {
        test('throws clear error when SQUARE_ACCESS_TOKEN is not set', async () => {
            delete process.env.SQUARE_ACCESS_TOKEN;
            jest.resetModules();
            jest.mock('../../utils/logger', () => ({
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            }));
            jest.mock('../../services/square/square-client', () => ({
                generateIdempotencyKey: jest.fn(() => 'test-idempotency-key')
            }));
            const webhooks = require('../../utils/square-webhooks');

            await expect(webhooks.listWebhookSubscriptions(1))
                .rejects.toThrow('SQUARE_ACCESS_TOKEN environment variable is required');
        });
    });

    describe('event type helpers', () => {
        test('getAllEventTypes returns flat deduplicated array', () => {
            const types = squareWebhooks.getAllEventTypes();
            expect(Array.isArray(types)).toBe(true);
            expect(types.length).toBeGreaterThan(0);
            // No duplicates
            expect(types.length).toBe(new Set(types).size);
        });

        test('getRecommendedEventTypes returns array', () => {
            const types = squareWebhooks.getRecommendedEventTypes();
            expect(Array.isArray(types)).toBe(true);
            expect(types).toContain('order.created');
        });
    });
});
