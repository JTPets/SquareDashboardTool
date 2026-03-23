'use strict';

/**
 * Feature Registry — Phase 1 of Feature Module Architecture
 *
 * Defines every feature module in the platform. Each route prefix and
 * HTML page maps to exactly one module. Used by subscription enforcement,
 * billing, and access control layers (Phases 2+).
 */

const modules = {
    base: {
        key: 'base',
        name: 'Platform Base',
        routes: [
            '/api/auth',
            '/api/catalog',
            '/api/catalog-audit',
            '/api/sync',
            '/api/sync-sales',
            '/api/sync-smart',
            '/api/sync-history',
            '/api/sync-intervals',
            '/api/sync-status',
            '/api/settings',
            '/api/webhooks',
            '/api/merchants',
            '/api/config',
            '/api/health',
            '/api/admin',
            '/api/subscriptions',
            '/api/square',
            '/api/square-attributes',
            '/api/logs',
            '/api/locations',
            '/api/categories',
            '/api/items',
            '/api/variations',
            '/api/inventory',
            '/api/low-stock',
            '/api/bundles',
            '/api/merchant/features',
            '/api/staff',
            '/api/test-email',
            '/api/test-error',
            '/api/test-backup-email',
        ],
        pages: [
            'dashboard',
            'inventory',
            'settings',
            'login',
            'set-password',
            'merchants',
            'admin-subscriptions',
            'subscribe',
            'subscription-expired',
            'upgrade',
            'support',
            'logs',
            'index',
            'bundle-manager',
            'catalog-audit',
        ],
        price_cents: 0,
        free: true,
    },
    cycle_counts: {
        key: 'cycle_counts',
        name: 'Cycle Counts',
        routes: [
            '/api/cycle-counts',
        ],
        pages: [
            'cycle-count',
            'cycle-count-history',
        ],
        price_cents: 999,
        free: false,
    },
    reorder: {
        key: 'reorder',
        name: 'Reorder Intelligence',
        routes: [
            '/api/analytics',
            '/api/purchase-orders',
            '/api/vendor-catalog',
            '/api/vendor-dashboard',
            '/api/vendors',
            '/api/labels',
            '/api/sales-velocity',
            '/api/reorder-suggestions',
        ],
        pages: [
            'reorder',
            'purchase-orders',
            'vendor-dashboard',
            'vendor-catalog',
            'sales-velocity',
        ],
        price_cents: 1499,
        free: false,
    },
    expiry: {
        key: 'expiry',
        name: 'Expiry Automation',
        routes: [
            '/api/expiry-discounts',
            '/api/expirations',
        ],
        pages: [
            'expiry',
            'expiry-discounts',
            'expiry-audit',
        ],
        price_cents: 999,
        free: false,
    },
    delivery: {
        key: 'delivery',
        name: 'Delivery',
        routes: [
            '/api/delivery',
            '/api/driver',
        ],
        pages: [
            'delivery',
            'delivery-route',
            'delivery-history',
            'delivery-settings',
            'driver',
        ],
        price_cents: 1499,
        free: false,
    },
    loyalty: {
        key: 'loyalty',
        name: 'Loyalty Engine',
        routes: [
            '/api/loyalty',
            '/api/seniors',
            '/api/cart-activity',
            '/api/deleted-items',
        ],
        pages: [
            'loyalty',
            'cart-activity',
            'deleted-items',
        ],
        price_cents: 1999,
        free: false,
    },
    ai_tools: {
        key: 'ai_tools',
        name: 'AI Tools',
        routes: [
            '/api/ai-autofill',
        ],
        pages: [
            'catalog-workflow',
        ],
        price_cents: 999,
        free: false,
    },
    gmc: {
        key: 'gmc',
        name: 'Google Shopping',
        routes: [
            '/api/gmc',
            '/api/google',
        ],
        pages: [
            'gmc-feed',
        ],
        price_cents: 999,
        free: false,
    },
};

const bundles = {
    full_suite: {
        key: 'full_suite',
        name: 'Full Suite',
        includes: ['cycle_counts', 'reorder', 'expiry', 'delivery', 'loyalty', 'ai_tools', 'gmc'],
        price_cents: 5999,
    },
};

// --- Helper functions ---

/**
 * Returns the module key for a given route path prefix.
 * Matches the longest prefix first.
 */
function getModuleForRoute(routePath) {
    let bestMatch = null;
    let bestLength = 0;

    for (const mod of Object.values(modules)) {
        for (const prefix of mod.routes) {
            if (routePath === prefix || routePath.startsWith(prefix + '/')) {
                if (prefix.length > bestLength) {
                    bestMatch = mod.key;
                    bestLength = prefix.length;
                }
            }
        }
    }
    return bestMatch;
}

/**
 * Returns the module key for a given page name (without .html).
 */
function getModuleForPage(pageName) {
    for (const mod of Object.values(modules)) {
        if (mod.pages.includes(pageName)) {
            return mod.key;
        }
    }
    return null;
}

/**
 * Returns array of all module definitions.
 */
function getAllModules() {
    return Object.values(modules);
}

/**
 * Returns array of non-free module definitions.
 */
function getPaidModules() {
    return Object.values(modules).filter(m => !m.free);
}

/**
 * Returns bundle price in cents.
 */
function getBundlePrice(bundleKey) {
    const bundle = bundles[bundleKey];
    return bundle ? bundle.price_cents : null;
}

/**
 * Returns module price in cents.
 */
function getModulePrice(moduleKey) {
    const mod = modules[moduleKey];
    return mod ? mod.price_cents : null;
}

module.exports = {
    modules,
    bundles,
    getModuleForRoute,
    getModuleForPage,
    getAllModules,
    getPaidModules,
    getBundlePrice,
    getModulePrice,
};
