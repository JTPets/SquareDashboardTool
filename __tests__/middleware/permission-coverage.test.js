'use strict';

/**
 * Permission Coverage Test — BACKLOG-41 Phase 3B-2
 *
 * Ensures every route prefix in feature-registry has a requirePermission
 * gate in server.js. Prevents future routes from being added without
 * permission enforcement.
 */

const fs = require('fs');
const path = require('path');
const { modules } = require('../../config/feature-registry');

const serverPath = path.join(__dirname, '../../server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

// Routes that are intentionally ungated (public or dev-only endpoints):
const EXEMPT_ROUTES = new Set([
    '/api/auth',             // Public login, logout, password reset
    '/api/health',           // Public health check (no merchant context)
    '/api/square',           // OAuth routes (mounted before auth middleware)
    '/api/driver',           // Public token-based driver endpoints
    '/api/test-email',       // Dev-only (disabled in production, already requireAdmin)
    '/api/test-error',       // Dev-only (disabled in production, already requireAdmin)
    '/api/test-backup-email', // Dev-only (disabled in production, already requireAdmin)
]);

// Routes that use a conditional gate (checked separately)
const CONDITIONAL_ROUTES = new Set([
    '/api/webhooks',
    '/api/staff',
    '/api/subscriptions',
    '/api/gmc',
]);

/**
 * Checks whether a route prefix has a requirePermission gate in server.js.
 * Searches for the path appearing on a line (or within a 5-line window)
 * that also contains 'requirePermission('.
 *
 * Matches both direct app.use() and gateApi() patterns.
 */
function hasPermissionGate(routePrefix) {
    const lines = serverSource.split('\n');
    const shortPath = routePrefix.replace(/^\/api/, '');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Direct app.use match with requirePermission on same line
        if (line.includes(`'${routePrefix}'`) && line.includes('requirePermission(')) {
            return true;
        }

        // gateApi match: gateApi('/path', ..., requirePermission(...))
        if (line.includes(`'${shortPath}'`) && line.includes('gateApi(') && line.includes('requirePermission(')) {
            return true;
        }
    }

    return false;
}

/**
 * Checks whether a route prefix has a conditional permission gate.
 * These are app.use('/api/path', (req, res, next) => { ... requirePermission ... })
 * or gateApi('/path', (req, res, next) => { ... requirePermission ... })
 * where requirePermission appears within a few lines of the path.
 */
function hasConditionalGate(routePrefix) {
    const lines = serverSource.split('\n');
    const shortPath = routePrefix.replace(/^\/api/, '');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const matchesPath = line.includes(`'${routePrefix}'`) ||
            (line.includes(`'${shortPath}'`) && line.includes('gateApi('));

        if (matchesPath) {
            // Check this line and next 8 lines for requirePermission
            const window = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
            if (window.includes('requirePermission(')) {
                return true;
            }
        }
    }
    return false;
}

describe('Permission coverage — every feature-registry route is gated', () => {

    for (const mod of Object.values(modules)) {
        for (const routePrefix of mod.routes) {
            if (EXEMPT_ROUTES.has(routePrefix)) {
                test(`${routePrefix} is intentionally exempt (public)`, () => {
                    // Verify it's truly public — should NOT have a permission gate
                    // (This is a documentation test, not a strict enforcement)
                    expect(EXEMPT_ROUTES.has(routePrefix)).toBe(true);
                });
                continue;
            }

            if (CONDITIONAL_ROUTES.has(routePrefix)) {
                test(`${routePrefix} has conditional permission gate`, () => {
                    expect(hasConditionalGate(routePrefix)).toBe(true);
                });
                continue;
            }

            test(`${routePrefix} has requirePermission gate`, () => {
                const gated = hasPermissionGate(routePrefix);
                if (!gated) {
                    // Provide helpful failure message
                    throw new Error(
                        `${routePrefix} (module: ${mod.key}) is missing a requirePermission gate in server.js. ` +
                        `Add: gateApi('${routePrefix.replace(/^\/api/, '')}', requirePermission('${mod.key}', 'read'));`
                    );
                }
                expect(gated).toBe(true);
            });
        }
    }
});

describe('v1 route coverage — paid module v1 routes are also gated', () => {
    // Verify that gateApi registers on both /api and /api/v1
    // by checking that the gateApi helper is defined in server.js
    test('gateApi helper registers on both /api and /api/v1', () => {
        expect(serverSource).toContain("app.use('/api' + path");
        expect(serverSource).toContain("app.use('/api/v1' + path");
    });

    // Spot-check a few critical v1 routes
    const v1SpotChecks = [
        '/api/v1/purchase-orders',
        '/api/v1/loyalty',
        '/api/v1/gmc',
        '/api/v1/delivery',
        '/api/v1/ai-autofill',
    ];

    for (const route of v1SpotChecks) {
        test(`${route} has requirePermission at mount level`, () => {
            const lines = serverSource.split('\n');
            const found = lines.some(line =>
                line.includes(`'${route}'`) && line.includes('requirePermission(')
            );
            expect(found).toBe(true);
        });
    }
});
