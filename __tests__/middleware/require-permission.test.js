'use strict';

/**
 * Permission Enforcement Middleware Test Suite — BACKLOG-41
 *
 * Tests for role-based permission enforcement on feature routes.
 */

const { requirePermission } = require('../../middleware/require-permission');

// Mock logger to prevent console output and verify warn calls
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));
const logger = require('../../utils/logger');

// Mock response factory (matches feature-gate pattern)
function mockResponse() {
    const res = {
        statusCode: 200,
        jsonData: null,
    };
    res.status = jest.fn((code) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((data) => {
        res.jsonData = data;
        return res;
    });
    // sendError reads res.req?.requestId
    res.req = { requestId: undefined };
    return res;
}

// Mock request factory
function mockRequest(options = {}) {
    return {
        merchantContext: options.merchantContext || null,
        originalUrl: options.originalUrl || '/api/test',
        method: options.method || 'GET',
    };
}

describe('Permission Enforcement Middleware', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('requirePermission()', () => {

        test('owner passes loyalty read', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: {
                    id: 1,
                    userRole: 'owner',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('owner passes loyalty write', () => {
            const middleware = requirePermission('loyalty', 'write');
            const req = mockRequest({
                merchantContext: {
                    id: 1,
                    userRole: 'owner',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('clerk blocked from loyalty read', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    userRole: 'clerk',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.success).toBe(false);
            expect(res.jsonData.code).toBe('PERMISSION_DENIED');
        });

        test('clerk passes cycle_counts write', () => {
            const middleware = requirePermission('cycle_counts', 'write');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    userRole: 'clerk',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('clerk passes delivery write', () => {
            const middleware = requirePermission('delivery', 'write');
            const req = mockRequest({
                merchantContext: {
                    id: 2,
                    userRole: 'clerk',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('readonly blocked from write', () => {
            const middleware = requirePermission('cycle_counts', 'write');
            const req = mockRequest({
                merchantContext: {
                    id: 3,
                    userRole: 'readonly',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('PERMISSION_DENIED');
        });

        test('readonly blocked from loyalty read', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: {
                    id: 3,
                    userRole: 'readonly',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('PERMISSION_DENIED');
        });

        test('unknown role blocked', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: {
                    id: 4,
                    userRole: 'intern',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('PERMISSION_DENIED');
        });

        test('platform_owner bypasses all permission checks', () => {
            const middleware = requirePermission('loyalty', 'admin');
            const req = mockRequest({
                merchantContext: {
                    id: 1,
                    userRole: 'owner',
                    subscriptionStatus: 'platform_owner',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('missing merchant context returns 403', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({ merchantContext: null });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('NO_MERCHANT');
        });

        test('logs denied access at warn level', () => {
            const middleware = requirePermission('loyalty', 'write');
            const req = mockRequest({
                merchantContext: {
                    id: 5,
                    userRole: 'clerk',
                    subscriptionStatus: 'active',
                },
                originalUrl: '/api/loyalty/programs',
                method: 'POST',
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(logger.warn).toHaveBeenCalledWith('Permission denied', {
                role: 'clerk',
                feature: 'loyalty',
                level: 'write',
                path: '/api/loyalty/programs',
                method: 'POST',
                merchantId: 5,
            });
        });

        test('manager passes loyalty read', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: {
                    id: 6,
                    userRole: 'manager',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('legacy "user" role treated as clerk', () => {
            const middleware = requirePermission('cycle_counts', 'write');
            const req = mockRequest({
                merchantContext: {
                    id: 7,
                    userRole: 'user',
                    subscriptionStatus: 'active',
                }
            });
            const res = mockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            // 'user' maps to 'clerk' which has write on cycle_counts
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });
    });
});
