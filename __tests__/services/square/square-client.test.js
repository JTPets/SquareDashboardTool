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
}));

jest.mock('node-fetch', () => jest.fn(), { virtual: true });

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
                    headers: { get: () => '1' },
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });

            const data = await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
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

            const data = await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
            expect(data.ok).toBe(true);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        test('throws last error after all retries exhausted', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }),
            });

            await expect(squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' }))
                .rejects.toThrow('Square API error: 500');
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

            const data = await squareClient.makeSquareRequest('/v2/test', { accessToken: 'tok' });
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
            expect(squareClient.RETRY_DELAY_MS).toBe(1000);
        });

        test('exports generateIdempotencyKey', () => {
            expect(typeof squareClient.generateIdempotencyKey).toBe('function');
        });
    });
});
