/**
 * Request Correlation ID Middleware Test Suite (Audit 8.x)
 *
 * Tests:
 * - Generates UUID when no X-Request-ID header present
 * - Reuses client-supplied X-Request-ID header
 * - Truncates long X-Request-ID headers to 36 chars
 * - Sets X-Request-ID response header
 * - Attaches requestId to req
 * - Attaches child logger to req.log
 * - sendError includes requestId in response body
 */

jest.mock('../../utils/logger', () => {
    const child = jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }));
    return {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child,
    };
});

const logger = require('../../utils/logger');

describe('Request ID Middleware', () => {
    let requestId;

    beforeEach(() => {
        jest.clearAllMocks();
        // Re-require to get fresh module with mocked logger
        jest.isolateModules(() => {
            requestId = require('../../middleware/request-id');
        });
    });

    function mockReq(headers = {}) {
        return { headers };
    }

    function mockRes() {
        const res = {};
        res.setHeader = jest.fn();
        return res;
    }

    test('generates a UUID when no X-Request-ID header is present', () => {
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        requestId(req, res, next);

        expect(req.requestId).toBeDefined();
        // UUID v4 format: 8-4-4-4-12 hex chars
        expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('reuses client-supplied X-Request-ID header', () => {
        const clientId = 'abc-123-client-supplied';
        const req = mockReq({ 'x-request-id': clientId });
        const res = mockRes();
        const next = jest.fn();

        requestId(req, res, next);

        expect(req.requestId).toBe(clientId);
    });

    test('truncates long X-Request-ID to 36 characters', () => {
        const longId = 'a'.repeat(100);
        const req = mockReq({ 'x-request-id': longId });
        const res = mockRes();
        const next = jest.fn();

        requestId(req, res, next);

        expect(req.requestId).toBe('a'.repeat(36));
    });

    test('sets X-Request-ID response header', () => {
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        requestId(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId);
    });

    test('attaches child logger to req.log with requestId', () => {
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        requestId(req, res, next);

        expect(logger.child).toHaveBeenCalledWith({ requestId: req.requestId });
        expect(req.log).toBeDefined();
    });

    test('generates unique IDs for different requests', () => {
        const req1 = mockReq();
        const req2 = mockReq();
        const res = mockRes();
        const next = jest.fn();

        requestId(req1, res, next);
        requestId(req2, res, next);

        expect(req1.requestId).not.toBe(req2.requestId);
    });
});

describe('sendError includes requestId', () => {
    const { sendError } = require('../../utils/response-helper');

    test('includes requestId in error response when req.requestId is set', () => {
        const jsonFn = jest.fn();
        const req = { requestId: 'test-request-id-123' };
        const res = {
            req,
            status: jest.fn().mockReturnThis(),
            json: jsonFn,
        };

        sendError(res, 'Something went wrong', 400, 'TEST_ERROR');

        expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            error: 'Something went wrong',
            code: 'TEST_ERROR',
            requestId: 'test-request-id-123',
        }));
    });

    test('omits requestId when req.requestId is not set', () => {
        const jsonFn = jest.fn();
        const res = {
            req: {},
            status: jest.fn().mockReturnThis(),
            json: jsonFn,
        };

        sendError(res, 'Something went wrong', 400);

        const body = jsonFn.mock.calls[0][0];
        expect(body.requestId).toBeUndefined();
    });
});
