/**
 * Tests for services/loyalty-admin/shared-utils.js
 *
 * Covers: SquareApiError, fetchWithTimeout, squareApiRequest, getSquareAccessToken, getSquareApi
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../../../utils/token-encryption', () => ({
    decryptToken: jest.fn(token => `decrypted_${token}`),
    isEncryptedToken: jest.fn(token => token.startsWith('enc:')),
}));

jest.mock('../../../utils/idempotency', () => ({
    generateIdempotencyKey: jest.fn(() => 'idem-key-123'),
}));

jest.mock('../../../config/constants', () => ({
    SQUARE: { API_VERSION: '2024-01-01' },
}));

const db = require('../../../utils/database');
const { decryptToken, isEncryptedToken } = require('../../../utils/token-encryption');

const {
    SquareApiError,
    fetchWithTimeout,
    squareApiRequest,
    getSquareAccessToken,
    getSquareApi,
    generateIdempotencyKey,
    SQUARE_API_BASE,
    SQUARE_API_VERSION,
} = require('../../../services/loyalty-admin/shared-utils');

// ============================================================================
// SquareApiError
// ============================================================================

describe('SquareApiError', () => {
    test('creates error with correct properties', () => {
        const err = new SquareApiError('Rate limited', 429, '/customers', { retryAfter: 5 });

        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('SquareApiError');
        expect(err.message).toBe('Rate limited');
        expect(err.status).toBe(429);
        expect(err.endpoint).toBe('/customers');
        expect(err.details).toEqual({ retryAfter: 5 });
    });

    test('defaults details to empty object', () => {
        const err = new SquareApiError('fail', 500, '/test');
        expect(err.details).toEqual({});
    });
});

// ============================================================================
// fetchWithTimeout
// ============================================================================

describe('fetchWithTimeout', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('returns response on success', async () => {
        const mockResponse = { ok: true, json: () => ({ data: 1 }) };
        global.fetch = jest.fn().mockResolvedValue(mockResponse);

        const result = await fetchWithTimeout('https://example.com', {}, 5000);

        expect(result).toBe(mockResponse);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
    });

    test('throws timeout error on abort', async () => {
        global.fetch = jest.fn().mockImplementation(() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        });

        await expect(fetchWithTimeout('https://example.com', {}, 100))
            .rejects.toThrow('Request timeout after 100ms');
    });

    test('re-throws non-abort errors', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('Network down'));

        await expect(fetchWithTimeout('https://example.com', {}, 5000))
            .rejects.toThrow('Network down');
    });
});

// ============================================================================
// squareApiRequest
// ============================================================================

describe('squareApiRequest', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    function mockFetchResponse(status, body, headers = {}) {
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: {
                get: (key) => headers[key] || null,
            },
            json: jest.fn().mockResolvedValue(body),
            text: jest.fn().mockResolvedValue(JSON.stringify(body)),
        };
    }

    test('makes GET request with correct headers', async () => {
        const response = mockFetchResponse(200, { customer: { id: 'c1' } });
        global.fetch = jest.fn().mockResolvedValue(response);

        const result = await squareApiRequest('token123', 'GET', '/customers/c1');

        expect(result).toEqual({ customer: { id: 'c1' } });
        const fetchCall = global.fetch.mock.calls[0];
        expect(fetchCall[0]).toBe('https://connect.squareup.com/v2/customers/c1');
        expect(fetchCall[1].method).toBe('GET');
        expect(fetchCall[1].headers['Authorization']).toBe('Bearer token123');
        expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
        expect(fetchCall[1].headers['Square-Version']).toBe('2024-01-01');
    });

    test('includes body for POST requests', async () => {
        const response = mockFetchResponse(200, { group: { id: 'g1' } });
        global.fetch = jest.fn().mockResolvedValue(response);

        await squareApiRequest('token', 'POST', '/customers/groups', { name: 'VIP' });

        const fetchCall = global.fetch.mock.calls[0];
        const options = fetchCall[1];
        expect(JSON.parse(options.body)).toEqual({ name: 'VIP' });
    });

    test('does not include body for GET requests', async () => {
        const response = mockFetchResponse(200, { data: {} });
        global.fetch = jest.fn().mockResolvedValue(response);

        await squareApiRequest('token', 'GET', '/test', { ignored: true });

        const fetchCall = global.fetch.mock.calls[0];
        expect(fetchCall[1].body).toBeUndefined();
    });

    test('throws SquareApiError on non-OK response', async () => {
        const response = mockFetchResponse(404, { errors: [{ detail: 'Not found' }] });
        global.fetch = jest.fn().mockResolvedValue(response);

        await expect(squareApiRequest('token', 'GET', '/missing'))
            .rejects.toThrow(SquareApiError);

        try {
            await squareApiRequest('token', 'GET', '/missing');
        } catch (err) {
            expect(err.status).toBe(404);
            expect(err.endpoint).toBe('/missing');
        }
    });

    test('retries on 429 and succeeds', async () => {
        const rateLimited = mockFetchResponse(429, {}, { 'retry-after': '1' });
        const success = mockFetchResponse(200, { ok: true });
        global.fetch = jest.fn()
            .mockResolvedValueOnce(rateLimited)
            .mockResolvedValueOnce(success);

        const result = await squareApiRequest('token', 'GET', '/test', null, {
            maxRetries: 3,
        });

        expect(result).toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('throws after exhausting retries on 429', async () => {
        const rateLimited = mockFetchResponse(429, {}, { 'retry-after': '0' });
        global.fetch = jest.fn().mockResolvedValue(rateLimited);

        await expect(squareApiRequest('token', 'GET', '/test', null, { maxRetries: 2 }))
            .rejects.toThrow('Rate limited after 2 attempts');
    });

    test('wraps network errors in SquareApiError', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(squareApiRequest('token', 'GET', '/test'))
            .rejects.toThrow(SquareApiError);
    });
});

// ============================================================================
// getSquareAccessToken
// ============================================================================

describe('getSquareAccessToken', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns null when no merchant found', async () => {
        db.query.mockResolvedValue({ rows: [] });

        const token = await getSquareAccessToken(999);

        expect(token).toBeNull();
    });

    test('returns null when token is empty', async () => {
        db.query.mockResolvedValue({ rows: [{ square_access_token: null }] });

        const token = await getSquareAccessToken(1);

        expect(token).toBeNull();
    });

    test('decrypts encrypted token', async () => {
        db.query.mockResolvedValue({ rows: [{ square_access_token: 'enc:abc123' }] });

        const token = await getSquareAccessToken(1);

        expect(isEncryptedToken).toHaveBeenCalledWith('enc:abc123');
        expect(decryptToken).toHaveBeenCalledWith('enc:abc123');
        expect(token).toBe('decrypted_enc:abc123');
    });

    test('returns raw token when not encrypted', async () => {
        db.query.mockResolvedValue({ rows: [{ square_access_token: 'raw-token' }] });

        const token = await getSquareAccessToken(1);

        expect(isEncryptedToken).toHaveBeenCalledWith('raw-token');
        expect(decryptToken).not.toHaveBeenCalled();
        expect(token).toBe('raw-token');
    });

    test('queries with merchant_id and is_active filter', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await getSquareAccessToken(42);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE id = $1 AND is_active = TRUE'),
            [42]
        );
    });
});

// ============================================================================
// getSquareApi (lazy loader)
// ============================================================================

describe('getSquareApi', () => {
    test('is a callable function', () => {
        // getSquareApi lazy-loads services/square which requires node-fetch
        // We just verify the function exists and is exported
        expect(typeof getSquareApi).toBe('function');
    });
});

// ============================================================================
// Exports
// ============================================================================

describe('module exports', () => {
    test('exports SQUARE_API_BASE constant', () => {
        expect(SQUARE_API_BASE).toBe('https://connect.squareup.com/v2');
    });

    test('exports generateIdempotencyKey', () => {
        expect(typeof generateIdempotencyKey).toBe('function');
    });
});
