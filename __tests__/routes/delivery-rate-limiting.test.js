/**
 * Delivery & Driver API Rate Limiting Test Suite (SEC-14)
 *
 * Verifies that all delivery/driver endpoints have per-endpoint rate limiting
 * middleware wired in. Does NOT test rate limit behavior (that's express-rate-limit's
 * responsibility) — only that the middleware is present in the route stack.
 */

const deliveryRouter = require('../../routes/delivery');
const driverApiRouter = require('../../routes/driver-api');

/**
 * Extract route definitions from an Express router.
 * Returns array of { method, path, middlewareCount }
 */
function getRoutes(router) {
    const routes = [];
    router.stack.forEach(layer => {
        if (layer.route) {
            const route = layer.route;
            Object.keys(route.methods).forEach(method => {
                routes.push({
                    method: method.toUpperCase(),
                    path: route.path,
                    handlers: route.stack.length
                });
            });
        }
    });
    return routes;
}

/**
 * Check if a route has a rate limiter middleware.
 * express-rate-limit v7 wraps the handler in an anonymous async function.
 * We detect it by matching the wrapper's toString() pattern.
 */
function hasRateLimiter(router, method, path) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
            return layer.route.stack.some(s => {
                if (s.name === 'rateLimit') return true;
                // express-rate-limit v7 wraps in anonymous async (request, response, next) => ...
                const src = s.handle.toString();
                return src.includes('await Promise.resolve(fn(request, response, next))');
            });
        }
    }
    return false;
}

describe('SEC-14: Delivery endpoint rate limiting', () => {
    describe('delivery.js — authenticated endpoints', () => {
        const rateLimitedWriteEndpoints = [
            ['POST', '/orders'],
            ['PATCH', '/orders/:id'],
            ['DELETE', '/orders/:id'],
            ['POST', '/orders/:id/skip'],
            ['POST', '/orders/:id/complete'],
            ['PATCH', '/orders/:id/customer-note'],
            ['PATCH', '/orders/:id/notes'],
            ['POST', '/orders/:id/pod'],
            ['POST', '/route/finish'],
            ['PUT', '/settings'],
        ];

        test.each(rateLimitedWriteEndpoints)(
            '%s %s has deliveryRateLimit middleware',
            (method, path) => {
                expect(hasRateLimiter(deliveryRouter, method, path)).toBe(true);
            }
        );

        const strictRateLimitedEndpoints = [
            ['POST', '/route/generate'],
            ['POST', '/geocode'],
            ['POST', '/sync'],
            ['POST', '/backfill-customers'],
        ];

        test.each(strictRateLimitedEndpoints)(
            '%s %s has deliveryStrictRateLimit middleware',
            (method, path) => {
                expect(hasRateLimiter(deliveryRouter, method, path)).toBe(true);
            }
        );

        const readOnlyEndpoints = [
            ['GET', '/orders'],
            ['GET', '/orders/:id'],
            ['GET', '/orders/:id/customer'],
            ['GET', '/orders/:id/customer-stats'],
            ['GET', '/pod/:id'],
            ['GET', '/route/active'],
            ['GET', '/route/:id'],
            ['GET', '/settings'],
            ['GET', '/audit'],
            ['GET', '/stats'],
        ];

        test.each(readOnlyEndpoints)(
            '%s %s is a read-only endpoint (no per-route rate limit required)',
            (method, path) => {
                // Read-only endpoints rely on global rate limit — just verify they exist
                const routes = getRoutes(deliveryRouter);
                const found = routes.find(r => r.method === method && r.path === path);
                expect(found).toBeDefined();
            }
        );
    });

    describe('driver-api.js — public endpoints', () => {
        const driverRateLimitedEndpoints = [
            ['GET', '/driver/:token'],
            ['POST', '/driver/:token/orders/:orderId/complete'],
            ['POST', '/driver/:token/orders/:orderId/skip'],
            ['POST', '/driver/:token/finish'],
        ];

        test.each(driverRateLimitedEndpoints)(
            '%s %s has deliveryRateLimit middleware',
            (method, path) => {
                expect(hasRateLimiter(driverApiRouter, method, path)).toBe(true);
            }
        );

        test('POST /driver/:token/orders/:orderId/pod has deliveryStrictRateLimit (10MB upload)', () => {
            expect(hasRateLimiter(driverApiRouter, 'POST', '/driver/:token/orders/:orderId/pod')).toBe(true);
        });
    });

    describe('driver-api.js — authenticated endpoints', () => {
        const authenticatedEndpoints = [
            ['POST', '/delivery/route/:id/share'],
            ['DELETE', '/delivery/route/:id/token'],
        ];

        test.each(authenticatedEndpoints)(
            '%s %s has deliveryRateLimit middleware',
            (method, path) => {
                expect(hasRateLimiter(driverApiRouter, method, path)).toBe(true);
            }
        );
    });
});
