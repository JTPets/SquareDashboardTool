/**
 * Tests for subscription endpoint rate limiting
 * Verifies that unauthenticated subscription endpoints have rate limiters applied.
 *
 * Rate limiter middleware is identified by the presence of the `resetKey` property,
 * which is added by express-rate-limit to its middleware functions.
 */

describe('Subscription rate limiting', () => {
    let merchantRouter;
    let plansRouter;

    beforeAll(() => {
        merchantRouter = require('../../routes/subscriptions/merchant');
        plansRouter = require('../../routes/subscriptions/plans');
    });

    function getRoute(router, path, method) {
        return router.stack.find(layer =>
            layer.route && layer.route.path === path && layer.route.methods[method]
        );
    }

    function getRateLimiters(route) {
        return route.route.stack.filter(s => typeof s.handle.resetKey === 'function');
    }

    test('POST /subscriptions/promo/validate has a rate limiter', () => {
        const route = getRoute(merchantRouter, '/subscriptions/promo/validate', 'post');
        expect(route).toBeDefined();

        const limiters = getRateLimiters(route);
        expect(limiters.length).toBe(1);
    });

    test('rate limiter is the first middleware on POST /subscriptions/promo/validate', () => {
        const route = getRoute(merchantRouter, '/subscriptions/promo/validate', 'post');
        const firstHandler = route.route.stack[0].handle;
        expect(typeof firstHandler.resetKey).toBe('function');
    });

    test('POST /subscriptions/create has a rate limiter', () => {
        const route = getRoute(merchantRouter, '/subscriptions/create', 'post');
        expect(route).toBeDefined();

        const limiters = getRateLimiters(route);
        expect(limiters.length).toBe(1);
    });

    test('rate limiter is the first middleware on POST /subscriptions/create', () => {
        const route = getRoute(merchantRouter, '/subscriptions/create', 'post');
        const firstHandler = route.route.stack[0].handle;
        expect(typeof firstHandler.resetKey).toBe('function');
    });

    test('GET /subscriptions/status has a rate limiter (CRIT-1)', () => {
        const route = getRoute(merchantRouter, '/subscriptions/status', 'get');
        expect(route).toBeDefined();

        const limiters = getRateLimiters(route);
        expect(limiters.length).toBe(1);
    });

    test('rate limiter is the first middleware on GET /subscriptions/status (CRIT-1)', () => {
        const route = getRoute(merchantRouter, '/subscriptions/status', 'get');
        const firstHandler = route.route.stack[0].handle;
        expect(typeof firstHandler.resetKey).toBe('function');
    });

    test('GET /subscriptions/plans does NOT have a rate limiter', () => {
        const route = getRoute(plansRouter, '/subscriptions/plans', 'get');
        expect(route).toBeDefined();

        const limiters = getRateLimiters(route);
        expect(limiters.length).toBe(0);
    });
});
