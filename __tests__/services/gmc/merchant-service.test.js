/**
 * Tests for GMC merchant-service
 * Covers: merchantApiRequest retry/rate-limit, duplicate token listener guard, batch settings insert
 */

// Mock googleapis — { virtual: true } allows mocking even if module isn't installed
const mockOAuth2Instance = {
    setCredentials: jest.fn(),
    on: jest.fn(),
    listenerCount: jest.fn().mockReturnValue(0),
    getAccessToken: jest.fn().mockResolvedValue({ token: 'test-token' })
};

jest.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: jest.fn().mockImplementation(() => mockOAuth2Instance)
        }
    }
}), { virtual: true });

// Mock fs.promises
jest.mock('fs', () => ({
    promises: {
        writeFile: jest.fn().mockResolvedValue(),
        appendFile: jest.fn().mockResolvedValue(),
        mkdir: jest.fn().mockResolvedValue()
    }
}));

const db = require('../../../utils/database');
const logger = require('../../../utils/logger');

const merchantService = require('../../../services/gmc/merchant-service');

describe('GMC Merchant Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset OAuth2 mock defaults
        mockOAuth2Instance.listenerCount.mockReturnValue(0);
        mockOAuth2Instance.on.mockReset();
        mockOAuth2Instance.setCredentials.mockReset();
        mockOAuth2Instance.getAccessToken.mockResolvedValue({ token: 'test-token' });
        // Reset global fetch mock
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    /**
     * Helper: set up db.query mocks for testConnection flow.
     * testConnection calls: getGmcApiSettings (1 query) → getAuthClient (1 query)
     */
    function mockTestConnectionDeps(settings = { gmc_merchant_id: '12345' }) {
        // First query: getGmcApiSettings
        db.query.mockResolvedValueOnce({
            rows: Object.entries(settings).map(([k, v]) => ({
                setting_key: k, setting_value: v
            }))
        });
        // Second query: getAuthClient
        db.query.mockResolvedValueOnce({
            rows: [{
                access_token: 'test-token',
                refresh_token: 'test-refresh',
                expiry_date: Date.now() + 3600000
            }]
        });
    }

    describe('merchantApiRequest - rate limit handling (I-1)', () => {
        it('should retry on 429 with Retry-After header', async () => {
            mockTestConnectionDeps();

            // First call returns 429, second succeeds
            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    status: 429,
                    ok: false,
                    headers: { get: (h) => h === 'retry-after' ? '1' : null }
                })
                .mockResolvedValueOnce({
                    status: 200,
                    ok: true,
                    json: () => Promise.resolve({ accountName: 'Test Account' })
                });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API rate limited, retrying',
                expect.objectContaining({ attempt: 1, retryAfterSeconds: 1 })
            );
        });

        it('should use default 5s retry-after when header is missing', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    status: 429,
                    ok: false,
                    headers: { get: () => null }
                })
                .mockResolvedValueOnce({
                    status: 200,
                    ok: true,
                    json: () => Promise.resolve({ accountName: 'Test' })
                });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API rate limited, retrying',
                expect.objectContaining({ retryAfterSeconds: 5 })
            );
        }, 15000);

        it('should not retry on 4xx client errors (other than 429)', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 403,
                ok: false,
                json: () => Promise.resolve({ error: { message: 'Forbidden' } })
            });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('should retry on 5xx server errors with exponential backoff', async () => {
            mockTestConnectionDeps();

            // Two 500s then success
            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    status: 500,
                    ok: false,
                    json: () => Promise.resolve({ error: { message: 'Internal Server Error' } })
                })
                .mockResolvedValueOnce({
                    status: 500,
                    ok: false,
                    json: () => Promise.resolve({ error: { message: 'Internal Server Error' } })
                })
                .mockResolvedValueOnce({
                    status: 200,
                    ok: true,
                    json: () => Promise.resolve({ accountName: 'Test' })
                });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(3);
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API server error, retrying',
                expect.objectContaining({ attempt: 1, delayMs: 1000 })
            );
            expect(logger.warn).toHaveBeenCalledWith(
                'GMC API server error, retrying',
                expect.objectContaining({ attempt: 2, delayMs: 2000 })
            );
        });

        it('should fail after max retries on persistent 429', async () => {
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValue({
                status: 429,
                ok: false,
                headers: { get: (h) => h === 'retry-after' ? '1' : null }
            });

            const result = await merchantService.testConnection(1);

            expect(result.success).toBe(false);
            expect(global.fetch).toHaveBeenCalledTimes(3); // MAX_RETRIES = 3
        });
    });

    describe('getAuthClient - duplicate listener guard (P-5)', () => {
        it('should attach token listener only when none exists', async () => {
            mockOAuth2Instance.listenerCount.mockReturnValue(0);
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ accountName: 'Test' })
            });

            await merchantService.testConnection(1);

            expect(mockOAuth2Instance.listenerCount).toHaveBeenCalledWith('tokens');
            expect(mockOAuth2Instance.on).toHaveBeenCalledWith('tokens', expect.any(Function));
        });

        it('should NOT attach token listener when one already exists', async () => {
            mockOAuth2Instance.listenerCount.mockReturnValue(1);
            mockTestConnectionDeps();

            global.fetch = jest.fn().mockResolvedValueOnce({
                status: 200,
                ok: true,
                json: () => Promise.resolve({ accountName: 'Test' })
            });

            await merchantService.testConnection(1);

            expect(mockOAuth2Instance.listenerCount).toHaveBeenCalledWith('tokens');
            expect(mockOAuth2Instance.on).not.toHaveBeenCalled();
        });
    });

    describe('saveGmcApiSettings - batch insert (P-6)', () => {
        it('should insert all settings in a single query using UNNEST', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await merchantService.saveGmcApiSettings(1, {
                gmc_merchant_id: '12345',
                feed_label: 'CA',
                content_language: 'en'
            });

            expect(db.query).toHaveBeenCalledTimes(1);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UNNEST'),
                [
                    1,
                    ['gmc_merchant_id', 'feed_label', 'content_language'],
                    ['12345', 'CA', 'en']
                ]
            );
        });

        it('should not execute query when settings object is empty', async () => {
            await merchantService.saveGmcApiSettings(1, {});

            expect(db.query).not.toHaveBeenCalled();
        });

        it('should handle single setting correctly', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await merchantService.saveGmcApiSettings(1, { gmc_merchant_id: '99' });

            expect(db.query).toHaveBeenCalledTimes(1);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UNNEST'),
                [1, ['gmc_merchant_id'], ['99']]
            );
        });
    });
});
