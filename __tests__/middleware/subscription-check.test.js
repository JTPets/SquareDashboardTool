/**
 * Subscription Check Middleware Test Suite
 *
 * SECURITY TESTS — validates that subscription status cannot be spoofed
 * via client-supplied headers, query parameters, or cookies.
 */

// Mock dependencies
jest.mock('../../utils/subscription-handler', () => ({
    checkSubscriptionStatus: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const {
    getSubscriberEmail,
    isPublicRoute,
    subscriptionCheck
} = require('../../middleware/subscription-check');
const { checkSubscriptionStatus } = require('../../utils/subscription-handler');

// Mock request factory
function mockRequest(options = {}) {
    return {
        session: options.session || null,
        headers: options.headers || {},
        query: options.query || {},
        cookies: options.cookies || {},
        path: options.path || '/api/test',
        ...options
    };
}

// Mock response factory
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

describe('Subscription Check Middleware', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getSubscriberEmail — auth bypass prevention', () => {

        test('returns email from session.email', () => {
            const req = mockRequest({
                session: { email: 'valid@example.com' }
            });

            expect(getSubscriberEmail(req)).toBe('valid@example.com');
        });

        test('returns email from session.user.email', () => {
            const req = mockRequest({
                session: { user: { email: 'user@example.com' } }
            });

            expect(getSubscriberEmail(req)).toBe('user@example.com');
        });

        test('prefers session.email over session.user.email', () => {
            const req = mockRequest({
                session: {
                    email: 'session@example.com',
                    user: { email: 'user@example.com' }
                }
            });

            expect(getSubscriberEmail(req)).toBe('session@example.com');
        });

        test('SECURITY: spoofed X-Subscriber-Email header does NOT grant access', () => {
            const req = mockRequest({
                session: null,
                headers: { 'x-subscriber-email': 'attacker@evil.com' }
            });

            expect(getSubscriberEmail(req)).toBeNull();
        });

        test('SECURITY: spoofed query parameter email does NOT grant access', () => {
            const req = mockRequest({
                session: null,
                query: { email: 'attacker@evil.com' }
            });

            expect(getSubscriberEmail(req)).toBeNull();
        });

        test('SECURITY: spoofed cookie subscriber_email does NOT grant access', () => {
            const req = mockRequest({
                session: null,
                cookies: { subscriber_email: 'attacker@evil.com' }
            });

            expect(getSubscriberEmail(req)).toBeNull();
        });

        test('SECURITY: spoofed header ignored even with valid session', () => {
            const req = mockRequest({
                session: { email: 'real@example.com' },
                headers: { 'x-subscriber-email': 'attacker@evil.com' }
            });

            // Should return session email, not header
            expect(getSubscriberEmail(req)).toBe('real@example.com');
        });

        test('returns null when no session exists', () => {
            const req = mockRequest({ session: null });

            expect(getSubscriberEmail(req)).toBeNull();
        });

        test('returns null when session has no email', () => {
            const req = mockRequest({ session: {} });

            expect(getSubscriberEmail(req)).toBeNull();
        });
    });

    describe('subscriptionCheck middleware', () => {

        test('skips check for public routes', async () => {
            const req = mockRequest({ path: '/api/health' });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('returns 401 for API request without session', async () => {
            const req = mockRequest({
                session: null,
                path: '/api/items'
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('SECURITY: spoofed X-Subscriber-Email header does NOT bypass subscription check', async () => {
            const req = mockRequest({
                session: null,
                path: '/api/items',
                headers: { 'x-subscriber-email': 'attacker@evil.com' }
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            // Attacker email in header should be ignored — no session means 401
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('SECURITY: spoofed query email does NOT bypass subscription check', async () => {
            const req = mockRequest({
                session: null,
                path: '/api/items',
                query: { email: 'attacker@evil.com' }
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('SECURITY: spoofed cookie does NOT bypass subscription check', async () => {
            const req = mockRequest({
                session: null,
                path: '/api/items',
                cookies: { subscriber_email: 'attacker@evil.com' }
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('allows request when checkSubscriptionStatus returns valid', async () => {
            checkSubscriptionStatus.mockResolvedValue({
                isValid: true,
                status: 'active'
            });

            const req = mockRequest({
                session: { email: 'subscriber@example.com' },
                path: '/api/items'
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('rejects request when checkSubscriptionStatus returns invalid', async () => {
            checkSubscriptionStatus.mockResolvedValue({
                isValid: false,
                status: 'expired',
                message: 'Subscription expired'
            });

            const req = mockRequest({
                session: { email: 'expired@example.com' },
                path: '/api/items'
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('redirects non-API requests to subscribe page when no session', async () => {
            const req = mockRequest({
                session: null,
                path: '/dashboard.html'
            });
            const res = mockResponse();
            const next = jest.fn();

            await subscriptionCheck(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith('/subscribe.html');
        });
    });

    describe('isPublicRoute', () => {

        test('identifies health endpoint as public', () => {
            expect(isPublicRoute('/api/health')).toBe(true);
        });

        test('identifies subscription routes as public', () => {
            expect(isPublicRoute('/api/subscriptions/plans')).toBe(true);
            expect(isPublicRoute('/api/subscriptions/status')).toBe(true);
        });

        test('identifies static assets as public', () => {
            expect(isPublicRoute('/style.css')).toBe(true);
            expect(isPublicRoute('/app.js')).toBe(true);
            expect(isPublicRoute('/logo.png')).toBe(true);
        });

        test('identifies protected routes as non-public', () => {
            expect(isPublicRoute('/api/items')).toBe(false);
            expect(isPublicRoute('/api/orders')).toBe(false);
        });
    });
});
