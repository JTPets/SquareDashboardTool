/**
 * Authentication Middleware Test Suite
 *
 * Tests for session-based auth and role-based access control
 * These are CRITICAL security functions
 */

const {
    requireAuth,
    requireAuthApi,
    requireAdmin,
    requireRole,
    requireWriteAccess,
    optionalAuth,
    getCurrentUser,
    getClientIp
} = require('../../middleware/auth');

// Mock response object factory
function mockResponse() {
    const res = {
        statusCode: 200,
        jsonData: null,
        redirectUrl: null,
    };
    res.status = jest.fn((code) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((data) => {
        res.jsonData = data;
        return res;
    });
    res.redirect = jest.fn((url) => {
        res.redirectUrl = url;
        return res;
    });
    return res;
}

// Mock request object factory
function mockRequest(options = {}) {
    return {
        session: options.session || null,
        path: options.path || '/api/test',
        originalUrl: options.originalUrl || '/api/test',
        headers: options.headers || {},
        connection: options.connection || {},
        socket: options.socket || {},
        ...options
    };
}

describe('Authentication Middleware', () => {

    // ==================== requireAuth ====================
    describe('requireAuth', () => {

        test('calls next() when user is authenticated', () => {
            const req = mockRequest({
                session: { user: { id: 1, email: 'test@test.com', role: 'user' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
            expect(res.redirect).not.toHaveBeenCalled();
        });

        test('returns 401 JSON for unauthenticated API requests', () => {
            const req = mockRequest({
                session: null,
                path: '/api/items'
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.jsonData).toEqual({
                error: 'Authentication required',
                code: 'UNAUTHORIZED'
            });
        });

        test('redirects to login for unauthenticated page requests', () => {
            const req = mockRequest({
                session: null,
                path: '/dashboard.html',
                originalUrl: '/dashboard.html'
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith('/login.html?returnUrl=%2Fdashboard.html');
        });

        test('handles empty session object', () => {
            const req = mockRequest({
                session: {},
                path: '/api/items'
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('encodes special characters in return URL', () => {
            const req = mockRequest({
                session: null,
                path: '/inventory.html',
                originalUrl: '/inventory.html?filter=test&page=1'
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(res.redirect).toHaveBeenCalled();
            expect(res.redirectUrl).toContain('returnUrl=');
            expect(res.redirectUrl).toContain(encodeURIComponent('/inventory.html?filter=test&page=1'));
        });
    });

    // ==================== requireAuthApi ====================
    describe('requireAuthApi', () => {

        test('calls next() when user is authenticated', () => {
            const req = mockRequest({
                session: { user: { id: 1, email: 'test@test.com' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuthApi(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('returns 401 JSON when not authenticated', () => {
            const req = mockRequest({ session: null });
            const res = mockResponse();
            const next = jest.fn();

            requireAuthApi(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.jsonData.code).toBe('UNAUTHORIZED');
        });

        test('always returns JSON, never redirects', () => {
            const req = mockRequest({
                session: null,
                path: '/some-page.html' // Even for non-API paths
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuthApi(req, res, next);

            expect(res.redirect).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalled();
        });
    });

    // ==================== requireAdmin ====================
    describe('requireAdmin', () => {

        test('calls next() for admin users', () => {
            const req = mockRequest({
                session: { user: { id: 1, email: 'admin@test.com', role: 'admin' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('returns 401 when not authenticated', () => {
            const req = mockRequest({ session: null });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.jsonData.code).toBe('UNAUTHORIZED');
        });

        test('returns 403 for non-admin users', () => {
            const req = mockRequest({
                session: { user: { id: 1, email: 'user@test.com', role: 'user' } },
                path: '/api/admin/users'
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.code).toBe('FORBIDDEN');
            expect(res.jsonData.error).toContain('Admin');
        });

        test('returns 403 for readonly users', () => {
            const req = mockRequest({
                session: { user: { id: 1, email: 'readonly@test.com', role: 'readonly' } },
                path: '/api/admin'
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
        });
    });

    // ==================== requireRole ====================
    describe('requireRole', () => {

        test('allows user with matching role', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'user' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            const middleware = requireRole('user', 'admin');
            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('allows user with any of the specified roles', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'admin' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            const middleware = requireRole('user', 'admin');
            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('returns 401 when not authenticated', () => {
            const req = mockRequest({ session: null });
            const res = mockResponse();
            const next = jest.fn();

            const middleware = requireRole('admin');
            middleware(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('returns 403 when user role not in allowed list', () => {
            const req = mockRequest({
                session: { user: { id: 1, email: 'test@test.com', role: 'readonly' } },
                path: '/api/items'
            });
            const res = mockResponse();
            const next = jest.fn();

            const middleware = requireRole('admin', 'user');
            middleware(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.error).toContain('admin');
            expect(res.jsonData.error).toContain('user');
        });

        test('works with single role', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'admin' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            const middleware = requireRole('admin');
            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });

    // ==================== requireWriteAccess ====================
    describe('requireWriteAccess', () => {

        test('allows admin users', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'admin' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireWriteAccess(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('allows regular users', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'user' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireWriteAccess(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('returns 401 when not authenticated', () => {
            const req = mockRequest({ session: null });
            const res = mockResponse();
            const next = jest.fn();

            requireWriteAccess(req, res, next);

            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('returns 403 for readonly users', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'readonly' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireWriteAccess(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonData.error).toContain('read-only');
        });
    });

    // ==================== optionalAuth ====================
    describe('optionalAuth', () => {

        test('always calls next()', () => {
            const req = mockRequest({ session: null });
            const res = mockResponse();
            const next = jest.fn();

            optionalAuth(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('does not block authenticated users', () => {
            const req = mockRequest({
                session: { user: { id: 1 } }
            });
            const res = mockResponse();
            const next = jest.fn();

            optionalAuth(req, res, next);

            expect(next).toHaveBeenCalled();
        });
    });

    // ==================== getCurrentUser ====================
    describe('getCurrentUser', () => {

        test('returns user from session', () => {
            const user = { id: 1, email: 'test@test.com', role: 'user' };
            const req = mockRequest({
                session: { user }
            });

            const result = getCurrentUser(req);

            expect(result).toEqual(user);
        });

        test('returns null when no session', () => {
            const req = mockRequest({ session: null });

            const result = getCurrentUser(req);

            expect(result).toBeNull();
        });

        test('returns null when session has no user', () => {
            const req = mockRequest({ session: {} });

            const result = getCurrentUser(req);

            expect(result).toBeNull();
        });
    });

    // ==================== getClientIp ====================
    describe('getClientIp', () => {

        test('returns x-forwarded-for header (first IP)', () => {
            const req = mockRequest({
                headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' }
            });

            const result = getClientIp(req);

            expect(result).toBe('192.168.1.1');
        });

        test('returns x-real-ip header', () => {
            const req = mockRequest({
                headers: { 'x-real-ip': '192.168.1.2' }
            });

            const result = getClientIp(req);

            expect(result).toBe('192.168.1.2');
        });

        test('returns connection remoteAddress', () => {
            const req = mockRequest({
                headers: {},
                connection: { remoteAddress: '192.168.1.3' }
            });

            const result = getClientIp(req);

            expect(result).toBe('192.168.1.3');
        });

        test('returns socket remoteAddress', () => {
            const req = mockRequest({
                headers: {},
                connection: {},
                socket: { remoteAddress: '192.168.1.4' }
            });

            const result = getClientIp(req);

            expect(result).toBe('192.168.1.4');
        });

        test('returns "unknown" when no IP available', () => {
            const req = mockRequest({
                headers: {},
                connection: {},
                socket: {}
            });

            const result = getClientIp(req);

            expect(result).toBe('unknown');
        });

        test('prefers x-forwarded-for over other sources', () => {
            const req = mockRequest({
                headers: {
                    'x-forwarded-for': '192.168.1.1',
                    'x-real-ip': '192.168.1.2'
                },
                connection: { remoteAddress: '192.168.1.3' }
            });

            const result = getClientIp(req);

            expect(result).toBe('192.168.1.1');
        });

        test('trims whitespace from forwarded IP', () => {
            const req = mockRequest({
                headers: { 'x-forwarded-for': '  192.168.1.1  , 10.0.0.1' }
            });

            const result = getClientIp(req);

            expect(result).toBe('192.168.1.1');
        });
    });

    // ==================== Security Edge Cases ====================
    describe('Security Edge Cases', () => {

        test('session with undefined user is not authenticated', () => {
            const req = mockRequest({
                session: { user: undefined }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(next).not.toHaveBeenCalled();
        });

        test('session with null user is not authenticated', () => {
            const req = mockRequest({
                session: { user: null }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAuth(req, res, next);

            expect(next).not.toHaveBeenCalled();
        });

        test('missing role property blocks admin access', () => {
            const req = mockRequest({
                session: { user: { id: 1 } } // No role property
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('empty string role is not admin', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: '' } }
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('case sensitive role matching', () => {
            const req = mockRequest({
                session: { user: { id: 1, role: 'Admin' } } // Capital A
            });
            const res = mockResponse();
            const next = jest.fn();

            requireAdmin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403); // Should fail - role is 'Admin' not 'admin'
        });
    });
});
