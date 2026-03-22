'use strict';

const fs = require('fs');
const path = require('path');

const {
    modules,
    bundles,
    getModuleForRoute,
    getModuleForPage,
    getAllModules,
    getPaidModules,
    getBundlePrice,
    getModulePrice,
} = require('../../config/feature-registry');

// Parse server.js to extract all app.use('/api/...' route registrations
function extractRouteRegistrations() {
    const serverPath = path.join(__dirname, '..', '..', 'server.js');
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    // Match app.use('/api/...', ...) and app.get('/api/...', ...) etc.
    const pattern = /app\.(?:use|get|post|put|delete|patch)\(\s*['"]\/api(\/[^'"]*)?['"]/g;
    const prefixes = new Set();
    let match;
    while ((match = pattern.exec(serverSource)) !== null) {
        const full = '/api' + (match[1] || '');
        // Skip middleware-only registrations (no route handler, just middleware functions)
        // and /api/v1 duplicates (they mirror /api routes)
        if (full === '/api' || full.startsWith('/api/v1')) continue;
        prefixes.add(full);
    }
    return [...prefixes];
}

// List all HTML pages in public/
function extractHtmlPages() {
    const publicDir = path.join(__dirname, '..', '..', 'public');
    return fs.readdirSync(publicDir)
        .filter(f => f.endsWith('.html'))
        .map(f => f.replace('.html', ''));
}

// Collect all route prefixes from all modules
function allModuleRoutes() {
    const routes = [];
    for (const mod of Object.values(modules)) {
        for (const r of mod.routes) {
            routes.push({ route: r, module: mod.key });
        }
    }
    return routes;
}

// Collect all pages from all modules
function allModulePages() {
    const pages = [];
    for (const mod of Object.values(modules)) {
        for (const p of mod.pages) {
            pages.push({ page: p, module: mod.key });
        }
    }
    return pages;
}

describe('Feature Registry', () => {
    describe('Route coverage', () => {
        const registeredRoutes = extractRouteRegistrations();

        test('every route registered in server.js maps to a module', () => {
            const unmapped = [];
            for (const route of registeredRoutes) {
                const mod = getModuleForRoute(route);
                if (!mod) unmapped.push(route);
            }
            expect(unmapped).toEqual([]);
        });

        test('no route prefix appears in more than one module', () => {
            const seen = {};
            const duplicates = [];
            for (const { route, module: modKey } of allModuleRoutes()) {
                if (seen[route] && seen[route] !== modKey) {
                    duplicates.push(`${route} in both ${seen[route]} and ${modKey}`);
                }
                seen[route] = modKey;
            }
            expect(duplicates).toEqual([]);
        });
    });

    describe('Page coverage', () => {
        const htmlPages = extractHtmlPages();

        test('every HTML file in public/ maps to a module', () => {
            const unmapped = [];
            for (const page of htmlPages) {
                const mod = getModuleForPage(page);
                if (!mod) unmapped.push(page);
            }
            expect(unmapped).toEqual([]);
        });

        test('no page appears in more than one module', () => {
            const seen = {};
            const duplicates = [];
            for (const { page, module: modKey } of allModulePages()) {
                if (seen[page] && seen[page] !== modKey) {
                    duplicates.push(`${page} in both ${seen[page]} and ${modKey}`);
                }
                seen[page] = modKey;
            }
            expect(duplicates).toEqual([]);
        });
    });

    describe('Bundle definitions', () => {
        test('full_suite includes all paid modules', () => {
            const paidKeys = getPaidModules().map(m => m.key).sort();
            const bundleIncludes = [...bundles.full_suite.includes].sort();
            expect(bundleIncludes).toEqual(paidKeys);
        });

        test('full_suite price is 5999 cents', () => {
            expect(getBundlePrice('full_suite')).toBe(5999);
        });
    });

    describe('Helper functions', () => {
        test('getModuleForRoute returns correct module for known routes', () => {
            expect(getModuleForRoute('/api/auth')).toBe('base');
            expect(getModuleForRoute('/api/auth/login')).toBe('base');
            expect(getModuleForRoute('/api/cycle-counts')).toBe('cycle_counts');
            expect(getModuleForRoute('/api/cycle-counts/pending')).toBe('cycle_counts');
            expect(getModuleForRoute('/api/loyalty')).toBe('loyalty');
            expect(getModuleForRoute('/api/delivery')).toBe('delivery');
            expect(getModuleForRoute('/api/gmc')).toBe('gmc');
            expect(getModuleForRoute('/api/ai-autofill')).toBe('ai_tools');
            expect(getModuleForRoute('/api/expiry-discounts')).toBe('expiry');
            expect(getModuleForRoute('/api/purchase-orders')).toBe('reorder');
        });

        test('getModuleForRoute returns null for unknown routes', () => {
            expect(getModuleForRoute('/api/nonexistent')).toBeNull();
            expect(getModuleForRoute('/unknown')).toBeNull();
        });

        test('getModuleForRoute matches longest prefix', () => {
            // /api/admin/catalog-health should match /api/admin (base), not something shorter
            expect(getModuleForRoute('/api/admin/catalog-health')).toBe('base');
            expect(getModuleForRoute('/api/square/oauth/connect')).toBe('base');
        });

        test('getModuleForPage returns correct module for known pages', () => {
            expect(getModuleForPage('dashboard')).toBe('base');
            expect(getModuleForPage('login')).toBe('base');
            expect(getModuleForPage('cycle-count')).toBe('cycle_counts');
            expect(getModuleForPage('reorder')).toBe('reorder');
            expect(getModuleForPage('expiry')).toBe('expiry');
            expect(getModuleForPage('delivery')).toBe('delivery');
            expect(getModuleForPage('loyalty')).toBe('loyalty');
            expect(getModuleForPage('catalog-workflow')).toBe('ai_tools');
            expect(getModuleForPage('gmc-feed')).toBe('gmc');
        });

        test('getModuleForPage returns null for unknown pages', () => {
            expect(getModuleForPage('nonexistent')).toBeNull();
        });

        test('getAllModules returns all 8 modules', () => {
            const all = getAllModules();
            expect(all).toHaveLength(8);
            const keys = all.map(m => m.key).sort();
            expect(keys).toEqual([
                'ai_tools', 'base', 'cycle_counts', 'delivery',
                'expiry', 'gmc', 'loyalty', 'reorder',
            ]);
        });

        test('getPaidModules returns all non-free modules', () => {
            const paid = getPaidModules();
            expect(paid).toHaveLength(7);
            expect(paid.every(m => !m.free)).toBe(true);
            expect(paid.find(m => m.key === 'base')).toBeUndefined();
        });

        test('getBundlePrice returns correct price', () => {
            expect(getBundlePrice('full_suite')).toBe(5999);
            expect(getBundlePrice('nonexistent')).toBeNull();
        });

        test('getModulePrice returns correct prices', () => {
            expect(getModulePrice('base')).toBe(0);
            expect(getModulePrice('cycle_counts')).toBe(999);
            expect(getModulePrice('reorder')).toBe(1499);
            expect(getModulePrice('expiry')).toBe(999);
            expect(getModulePrice('delivery')).toBe(1499);
            expect(getModulePrice('loyalty')).toBe(1999);
            expect(getModulePrice('ai_tools')).toBe(999);
            expect(getModulePrice('gmc')).toBe(999);
            expect(getModulePrice('nonexistent')).toBeNull();
        });
    });

    describe('Module key validation', () => {
        test('all module keys are valid identifiers (lowercase, underscores only)', () => {
            const invalid = [];
            for (const key of Object.keys(modules)) {
                if (!/^[a-z][a-z0-9_]*$/.test(key)) {
                    invalid.push(key);
                }
            }
            expect(invalid).toEqual([]);
        });

        test('module key matches the key property inside the module', () => {
            for (const [key, mod] of Object.entries(modules)) {
                expect(mod.key).toBe(key);
            }
        });
    });
});
