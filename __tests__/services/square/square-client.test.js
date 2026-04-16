/**
 * Square Client Service Tests
 *
 * Tests for shared Square API infrastructure: token resolution, HTTP client,
 * retry logic, rate limiting, and error handling.
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

jest.mock('../../../utils/token-encryption', () => ({
    decryptToken: jest.fn(),
    isEncryptedToken: jest.fn(),
    encryptToken: jest.fn(),
}));

jest.mock('../../../utils/idempotency', () => ({
    generateIdempotencyKey: jest.fn(() => 'idem-key-123'),
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { API_VERSION: '2024-01-01' },
    RETRY: { MAX_ATTEMPTS: 3, BASE_DELAY_MS: 0, MAX_DELAY_MS: 30000 },
}));

jest.mock('node-fetch', () => jest.fn());

// Force a fresh require of square-client so it loads with the mocked constants
// above rather than a cached instance from a previous test file in the same worker.
jest.resetModules();

const db = require('../../../utils/database');
const { decryptToken, isEncryptedToken, encryptToken } = require('../../../utils/token-encryption');
const fetch = require('node-fetch');
const squareClient = require('../../../services/square/square-client');

describe('Square Client Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==================== getMerchantToken ====================
    describe('getMerchantToken', () => {
        test('throws if merchantId is missing', async () => {
            await expect(squareClient.getMerchantToken(null))
                .rejects.toThrow('merchantId is required');
        });

        test('throws if merchant not found', async () => {
            db.query.mockResolvedValue({ rows: [] });
            await expect(squareClient.getMerchantToken(1))
                .rejects.toThrow('Merchant 1 not found or inactive');
        });

        test('throws if no access token configured', async () => {
            db.query.mockResolvedValue({ rows: [{ square_access_token: null }] });
            await expect(squareClient.getMerchantToken(1))
                .rejects.toThrow('Merchant 1 has no access token configured');
        });

        test('decrypts encrypted token', async () => {
            db.query.mockResolvedValue({ rows: [{ square_access_token: 'enc:abcdef' }] });
            isEncryptedToken.mockReturnValue(true);
            decryptToken.mockReturnValue('decrypted-token');

            const token = await squareClient.getMerchantToken(1);
            expect(token).toBe('decrypted-token');
            expect(decryptToken).toHaveBeenCalledWith('enc:abcdef');
        });

        test('encrypts legacy unencrypted token and returns raw', async () => {
            db.query.mockResolvedValue({ rows: [{ square_access_token: 'raw-token' }] });
            isEncryptedToken.mockReturnValue(false);
            encryptToken.mockReturnValue('enc:encrypted');
            // Second query: update token
            db.query.mockResolvedValueOnce({ rows: [{ square_access_token: 'raw-token' }] })
                     .mockResolvedValueOnce({});

            const token = await squareClient.getMerchantToken(1);
            expect(token).toBe('raw-token');
            expect(encryptToken).toHaveBeenCalledWith('raw-token');
        });

        test('handles encryption failure gracefully', async () => {
            db.query.mockResolvedValue({ rows: [{ square_access_token: 'raw-token' }] });
            isEncryptedToken.mockReturnValue(false);
            encryptToken.mockImplementation(() => { throw new Error('encrypt fail'); });

            const token = await squareClient.getMerchantToken(1);
            expect(token).toBe('raw-token'); // Still returns raw token
        });
    });

    // ==================== makeSquareRequest ====================
    describe('makeSquareRequest', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
        });

        afterEach(() => {
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        test('throws if accessToken is missing', async () => {
            await expect(squareClient.makeSquareRequest('/v2/locations', {}))
                .rejects.toThrow('accessToken is required');
        });

        test('makes successful request', async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ locations: [] }),
            });

            const data = await squareClient.makeSquareRequest('/v2/locations', { accessToken: 'tok' });
            expect(data).toEqual({ locations: [] });
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch.mock.calls[0][0]).toBe('https://connect.squareup.com/v2/locations');
        });

        test('sets correct headers', async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}),
            });

            await squareClient.makeSquareRequest('/v2/test', { accessToken: 'my-token' });
            const headers = fetch.mock.calls[0][1].headers;
            expect(headers['Authorization']).toBe('Bearer my-token');
            expect(headers['Square-Version']).toBe('2024-01-01');
            expect(headers['Content-Type']).toBe('application/json');
        });

        test('throws immediately on 401', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 401,
                json: () => Promise.resolve({ errors: [{ code: 'UNAUTHORIZED' }] }),
            });

            await expect(squareClient.makeSquareRequest('/v2/test', { accessToken: 'bad' }))
                .rejects.toThrow('Square API authentication failed');
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        test('does not retry 400 errors', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 400,
                json: () => Promise.resolve({ errors: [{ code: 'INVALID_REQUEST_ERROR' }] }),
            });

            await expect(squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' }))
                .rejects.toThrow('Square API error: 400');
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        test('does not retry 409 errors', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 409,
                json: () => Promise.resolve({ errors: [{ code: 'VERSION_MISMATCH' }] }),
            });

            await expect(squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' }))
                .rejects.toThrow('Square API error: 409');
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        test('retries on 429 rate limit', async () => {
            fetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    json: () => Promise.resolve({ errors: [] }),
                    headers: { get: () => '0' },
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });

            const promise = squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            await jest.runAllTimersAsync();
            const data = await promise;
            expect(data.success).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        test('retries on 500 server error', async () => {
            fetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    json: () => Promise.resolve({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ ok: true }),
                });

            const promise = squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            await jest.runAllTimersAsync();
            const data = await promise;
            expect(data.ok).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        test('throws last error after all retries exhausted', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }),
            });

            const promise = squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            // Attach rejection handler before advancing timers to avoid unhandled rejection
            const assertion = expect(promise).rejects.toThrow('Square API error: 500');
            await jest.runAllTimersAsync();
            await assertion;
            expect(fetch).toHaveBeenCalledTimes(3); // MAX_RETRIES
        });

        test('handles timeout (AbortError)', async () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            fetch
                .mockRejectedValueOnce(abortError)
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ recovered: true }),
                });

            const promise = squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            await jest.runAllTimersAsync();
            const data = await promise;
            expect(data.recovered).toBe(true);
        });

        test('marks nonRetryable errors on thrown errors', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 400,
                json: () => Promise.resolve({ errors: [{ code: 'INVALID_REQUEST_ERROR' }] }),
            });

            try {
                await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            } catch (e) {
                expect(e.nonRetryable).toBe(true);
                expect(e.squareErrors).toEqual([{ code: 'INVALID_REQUEST_ERROR' }]);
            }
        });

        // ==================== timeout option ====================
        test('default timeout is 30000ms when option omitted', async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}),
            });

            await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            expect(AbortSignal.timeout).toHaveBeenCalledWith(30000);
        });

        test('custom timeout option is passed to AbortSignal.timeout', async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}),
            });

            await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok', timeout: 5000 });
            expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
        });

        test('custom timeout surfaces in timeout error message and triggers abort path', async () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            fetch.mockRejectedValue(abortError);

            const promise = squareClient.makeSquareRequest('/v2/slow', {
                accessToken: 'tok',
                timeout: 7500,
            });
            const assertion = expect(promise).rejects.toThrow('timed out after 7500ms: /v2/slow');
            await jest.runAllTimersAsync();
            await assertion;
            // All three attempts should have used the custom timeout
            expect(AbortSignal.timeout).toHaveBeenCalledWith(7500);
            expect(AbortSignal.timeout).not.toHaveBeenCalledWith(30000);
        });

        test('timeout option is not forwarded to fetch', async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}),
            });

            await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok', timeout: 1234 });
            const fetchOpts = fetch.mock.calls[0][1];
            expect(fetchOpts).not.toHaveProperty('timeout');
            expect(fetchOpts).not.toHaveProperty('accessToken');
        });

        // ==================== SquareApiError ====================
        test('throws SquareApiError with status/endpoint/details on non-2xx', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 404,
                json: () => Promise.resolve({ errors: [{ code: 'NOT_FOUND', detail: 'Customer missing' }] }),
            });

            const promise = squareClient.makeSquareRequest('/v2/customers/abc', { accessToken: 'tok' });
            const assertion = promise.catch((e) => e);
            await jest.runAllTimersAsync();
            const err = await assertion;

            expect(err).toBeInstanceOf(squareClient.SquareApiError);
            expect(err.status).toBe(404);
            expect(err.endpoint).toBe('/v2/customers/abc');
            expect(err.details).toEqual([{ code: 'NOT_FOUND', detail: 'Customer missing' }]);
            expect(err.nonRetryable).toBe(false);
            // Backward-compat alias still populated
            expect(err.squareErrors).toEqual([{ code: 'NOT_FOUND', detail: 'Customer missing' }]);
        });

        test('401 throws SquareApiError with nonRetryable: true', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 401,
                json: () => Promise.resolve({ errors: [{ code: 'UNAUTHORIZED' }] }),
            });

            let caught;
            try {
                await squareClient.makeSquareRequest('/v2/secured', { accessToken: 'bad' });
            } catch (e) {
                caught = e;
            }

            expect(caught).toBeInstanceOf(squareClient.SquareApiError);
            expect(caught.status).toBe(401);
            expect(caught.endpoint).toBe('/v2/secured');
            expect(caught.details).toEqual([{ code: 'UNAUTHORIZED' }]);
            expect(caught.nonRetryable).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        test('400 throws SquareApiError with nonRetryable: true', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 400,
                json: () => Promise.resolve({ errors: [{ code: 'INVALID_REQUEST_ERROR' }] }),
            });

            let caught;
            try {
                await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(squareClient.SquareApiError);
            expect(caught.status).toBe(400);
            expect(caught.endpoint).toBe('/v2/test');
            expect(caught.nonRetryable).toBe(true);
        });

        test('429 still retries (SquareApiError behavior unchanged)', async () => {
            fetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    json: () => Promise.resolve({ errors: [] }),
                    headers: { get: () => '0' },
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    json: () => Promise.resolve({ errors: [] }),
                    headers: { get: () => '0' },
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ ok: true }),
                });

            const promise = squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            await jest.runAllTimersAsync();
            const data = await promise;
            expect(data.ok).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(3);
        });
    });

    // ==================== sleep ====================
    describe('sleep', () => {
        test('resolves after delay', async () => {
            jest.useFakeTimers();
            const promise = squareClient.sleep(1000);
            jest.advanceTimersByTime(1000);
            await promise;
            jest.useRealTimers();
        });
    });

    // ==================== exports ====================
    describe('exports', () => {
        test('exports expected constants', () => {
            expect(squareClient.SQUARE_BASE_URL).toBe('https://connect.squareup.com');
            expect(squareClient.MAX_RETRIES).toBe(3);
            expect(squareClient.RETRY_DELAY_MS).toBe(0);
        });

        test('exports generateIdempotencyKey', () => {
            expect(typeof squareClient.generateIdempotencyKey).toBe('function');
        });

        test('exports SquareApiError class', () => {
            expect(typeof squareClient.SquareApiError).toBe('function');
            const err = new squareClient.SquareApiError('boom', {
                status: 500,
                endpoint: '/v2/x',
                details: [{ code: 'X' }],
                nonRetryable: false,
            });
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe('SquareApiError');
            expect(err.message).toBe('boom');
            expect(err.status).toBe(500);
            expect(err.endpoint).toBe('/v2/x');
            expect(err.details).toEqual([{ code: 'X' }]);
            expect(err.nonRetryable).toBe(false);
            expect(err.squareErrors).toEqual([{ code: 'X' }]);
        });
    });
});
