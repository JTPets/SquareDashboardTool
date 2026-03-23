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

    // ========================================================
    // Route-level permission scenarios (BACKLOG-41 Phase 3B-2)
    // Verifies that the permission matrix correctly blocks/allows
    // access for specific role+route combinations.
    // ========================================================
    describe('clerk role route access', () => {

        test('clerk blocked from /api/settings (base:admin)', () => {
            const middleware = requirePermission('base', 'admin');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/settings/merchant',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
            expect(res.jsonData.code).toBe('PERMISSION_DENIED');
        });

        test('clerk blocked from /api/admin (staff:admin)', () => {
            const middleware = requirePermission('staff', 'admin');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/admin/merchants',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('clerk blocked from /api/loyalty (loyalty:read)', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/loyalty/programs',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('clerk blocked from /api/ai-autofill (ai_tools:read)', () => {
            const middleware = requirePermission('ai_tools', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/ai-autofill',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('clerk CAN reach /api/cycle-counts (cycle_counts:read)', () => {
            const middleware = requirePermission('cycle_counts', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/cycle-counts/pending',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('clerk CAN reach /api/delivery (delivery:read)', () => {
            const middleware = requirePermission('delivery', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/delivery',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('clerk CAN reach /api/expiry-discounts (expiry:read)', () => {
            const middleware = requirePermission('expiry', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/expiry-discounts/status',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('clerk CAN read base module routes (base:read)', () => {
            const middleware = requirePermission('base', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/inventory',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('clerk blocked from /api/gmc (gmc:read)', () => {
            const middleware = requirePermission('gmc', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/gmc/feed',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });
    });

    describe('readonly role route access', () => {

        test('readonly blocked from /api/cycle-counts (cycle_counts:read)', () => {
            const middleware = requirePermission('cycle_counts', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'readonly', subscriptionStatus: 'active' },
                originalUrl: '/api/cycle-counts/pending',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('readonly blocked from /api/delivery (delivery:read)', () => {
            const middleware = requirePermission('delivery', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'readonly', subscriptionStatus: 'active' },
                originalUrl: '/api/delivery',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('readonly CAN read base module routes (base:read)', () => {
            const middleware = requirePermission('base', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'readonly', subscriptionStatus: 'active' },
                originalUrl: '/api/inventory',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        test('readonly blocked from /api/settings (base:admin)', () => {
            const middleware = requirePermission('base', 'admin');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'readonly', subscriptionStatus: 'active' },
                originalUrl: '/api/settings/merchant',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('readonly blocked from /api/reorder (reorder:read)', () => {
            const middleware = requirePermission('reorder', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'readonly', subscriptionStatus: 'active' },
                originalUrl: '/api/vendors',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });
    });

    describe('manager role route access', () => {

        test('manager CAN reach /api/loyalty (loyalty:read)', () => {
            const middleware = requirePermission('loyalty', 'read');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'manager', subscriptionStatus: 'active' },
                originalUrl: '/api/loyalty/programs',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        test('manager CAN reach /api/settings (base:admin)', () => {
            const middleware = requirePermission('base', 'admin');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'manager', subscriptionStatus: 'active' },
                originalUrl: '/api/settings/merchant',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        test('manager blocked from /api/admin (staff:admin)', () => {
            const middleware = requirePermission('staff', 'admin');
            const req = mockRequest({
                merchantContext: { id: 1, userRole: 'manager', subscriptionStatus: 'active' },
                originalUrl: '/api/admin/merchants',
            });
            const res = mockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });
    });

    describe('staff/accept public endpoint', () => {

        test('staff permission gate skips /accept (public)', () => {
            // Simulates the conditional middleware in server.js
            const conditionalGate = (req, res, next) => {
                if (req.path === '/accept' || req.path === '/validate-token') return next();
                return requirePermission('staff', 'read')(req, res, next);
            };

            const req = { path: '/accept', merchantContext: null };
            const res = mockResponse();
            const next = jest.fn();
            conditionalGate(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        test('staff permission gate enforces on non-public paths', () => {
            const conditionalGate = (req, res, next) => {
                if (req.path === '/accept' || req.path === '/validate-token') return next();
                return requirePermission('staff', 'read')(req, res, next);
            };

            const req = {
                path: '/invite',
                merchantContext: { id: 1, userRole: 'clerk', subscriptionStatus: 'active' },
                originalUrl: '/api/staff/invite',
                method: 'POST',
            };
            const res = mockResponse();
            const next = jest.fn();
            conditionalGate(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });
    });
});
