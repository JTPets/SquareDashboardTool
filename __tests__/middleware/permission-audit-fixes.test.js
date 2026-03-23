/**
 * Permission Audit Fixes Tests
 *
 * Validates fixes from the permission wiring audit:
 * - FIX 1: GMC feed.tsv / local-inventory-feed.tsv bypass requireFeature
 * - FIX 2: Subscription admin routes use requirePermission('subscription', 'admin')
 * - FIX 3: Feature registry maps /api/square/custom-attributes (not /api/square-attributes)
 * - FIX 4: Vendor bulk create stores vendor_code even without cost_cents
 */

'use strict';

// ============================================================================
// FIX 1: GMC feed paths bypass requireFeature at mount level
// ============================================================================

describe('FIX 1 — GMC feed public path exemption', () => {
    // Verify that server.js mounts /api/gmc with feed path exemptions
    const fs = require('fs');
    const path = require('path');
    const serverSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'server.js'), 'utf8'
    );

    test('server.js GMC mount exempts /feed.tsv from requireFeature', () => {
        // The mount should contain a conditional check for /feed.tsv
        const gmcSection = serverSource.substring(
            serverSource.indexOf('// ==================== GMC ROUTES'),
            serverSource.indexOf('// ==================== DELIVERY ROUTES')
        );
        expect(gmcSection).toContain("req.path === '/feed.tsv'");
        expect(gmcSection).toContain('return next()');
        expect(gmcSection).toContain('requireFeature');
    });

    test('server.js GMC mount exempts /local-inventory-feed.tsv from requireFeature', () => {
        const gmcSection = serverSource.substring(
            serverSource.indexOf('// ==================== GMC ROUTES'),
            serverSource.indexOf('// ==================== DELIVERY ROUTES')
        );
        expect(gmcSection).toContain("req.path === '/local-inventory-feed.tsv'");
    });

    test('server.js GMC mount exempts feed paths from requirePermission', () => {
        const gmcSection = serverSource.substring(
            serverSource.indexOf('// ==================== GMC ROUTES'),
            serverSource.indexOf('// ==================== DELIVERY ROUTES')
        );
        expect(gmcSection).toContain('requirePermission');
        // Both feed.tsv checks should appear twice (once for feature, once for permission)
        const feedTsvCount = (gmcSection.match(/feed\.tsv/g) || []).length;
        expect(feedTsvCount).toBeGreaterThanOrEqual(2);
    });

    test('apiAuthMiddleware still lists GMC feed paths as public', () => {
        expect(serverSource).toContain("'/gmc/feed.tsv'");
        expect(serverSource).toContain("'/gmc/local-inventory-feed.tsv'");
    });
});

// ============================================================================
// FIX 2: Subscription admin routes use requirePermission
// ============================================================================

describe('FIX 2 — Subscription admin routes use requirePermission', () => {
    const fs = require('fs');
    const path = require('path');
    const subscriptionsSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'routes', 'subscriptions.js'), 'utf8'
    );

    test('admin/list uses requirePermission(subscription, admin)', () => {
        // Find the admin/list route definition line
        const listLine = subscriptionsSource.match(
            /router\.get\(['"]\/subscriptions\/admin\/list['"].+/
        );
        expect(listLine).not.toBeNull();
        expect(listLine[0]).toContain("requirePermission('subscription', 'admin')");
    });

    test('admin/plans uses requirePermission(subscription, admin)', () => {
        const plansLine = subscriptionsSource.match(
            /router\.get\(['"]\/subscriptions\/admin\/plans['"].+/
        );
        expect(plansLine).not.toBeNull();
        expect(plansLine[0]).toContain("requirePermission('subscription', 'admin')");
    });

    test('admin/setup-plans uses requirePermission(subscription, admin)', () => {
        const setupLine = subscriptionsSource.match(
            /router\.post\(['"]\/subscriptions\/admin\/setup-plans['"].+/
        );
        expect(setupLine).not.toBeNull();
        expect(setupLine[0]).toContain("requirePermission('subscription', 'admin')");
    });

    test('admin routes do NOT use requireAdmin directly', () => {
        // Extract just the admin route definitions
        const adminSection = subscriptionsSource.substring(
            subscriptionsSource.indexOf("'/subscriptions/admin/list'"),
            subscriptionsSource.indexOf("'/webhooks/events'")
        );
        // requireAdmin should not appear in the admin route middleware chains
        expect(adminSection).not.toMatch(/,\s*requireAdmin\s*,/);
    });

    test('requirePermission is imported from require-permission middleware', () => {
        expect(subscriptionsSource).toContain("require('../middleware/require-permission')");
    });

    test('subscription permission matrix: owner gets admin, manager does not', () => {
        const { hasPermission } = require('../../config/permissions');
        expect(hasPermission('owner', 'subscription', 'admin')).toBe(true);
        expect(hasPermission('manager', 'subscription', 'admin')).toBe(false);
        expect(hasPermission('manager', 'subscription', 'read')).toBe(true);
        expect(hasPermission('clerk', 'subscription', 'admin')).toBe(false);
        expect(hasPermission('clerk', 'subscription', 'read')).toBe(false);
    });
});

// ============================================================================
// FIX 3: Feature registry path matches actual route
// ============================================================================

describe('FIX 3 — Feature registry path for square attributes', () => {
    const { modules, getModuleForRoute } = require('../../config/feature-registry');

    test('/api/square/custom-attributes is in the base module routes', () => {
        expect(modules.base.routes).toContain('/api/square/custom-attributes');
    });

    test('/api/square-attributes is NOT in any module routes', () => {
        for (const mod of Object.values(modules)) {
            expect(mod.routes).not.toContain('/api/square-attributes');
        }
    });

    test('getModuleForRoute resolves /api/square/custom-attributes to base', () => {
        const mod = getModuleForRoute('/api/square/custom-attributes');
        expect(mod).toBe('base');
    });
});

// ============================================================================
// FIX 4: Vendor bulk create stores vendor_code without cost_cents
// ============================================================================

describe('FIX 4 — variation_vendors insert when vendor_id present but no cost_cents', () => {
    // Reset modules for clean mock state
    beforeEach(() => {
        jest.resetModules();
        jest.resetAllMocks();
    });

    test('createSquareBatch inserts variation_vendors when vendor_id present but cost_cents is null', async () => {
        // Mock dependencies
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        }));
        const mockDbQuery = jest.fn();
        const mockDbTransaction = jest.fn();
        jest.mock('../../utils/database', () => ({
            query: mockDbQuery,
            transaction: mockDbTransaction,
        }));
        jest.mock('../../services/square/square-client', () => ({
            getMerchantToken: jest.fn().mockResolvedValue('test-token'),
            makeSquareRequest: jest.fn(),
            sleep: jest.fn().mockResolvedValue(),
            generateIdempotencyKey: jest.fn().mockReturnValue('test-key'),
        }));

        const { createSquareBatch } = require('../../services/vendor/catalog-create-service');
        const { makeSquareRequest } = require('../../services/square/square-client');

        const entry = {
            id: 1,
            vendor_id: 'VENDOR_ABC',
            vendor_name: 'Test Vendor',
            product_name: 'Test Product',
            upc: null,
            cost_cents: null, // No cost
            price_cents: 999,
            matched_variation_id: null,
            vendor_item_number: 'VIN-100',
        };

        makeSquareRequest.mockResolvedValueOnce({
            objects: [],
            id_mappings: [
                { client_object_id: '#item_1', object_id: 'REAL_ITEM' },
                { client_object_id: '#var_1', object_id: 'REAL_VAR' },
            ]
        });

        const txQueries = [];
        const mockClient = { query: jest.fn(async (...args) => { txQueries.push(args); return { rows: [] }; }) };
        mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

        const result = await createSquareBatch([entry], 42, 'test-token');

        expect(result.created).toBe(1);

        // Verify variation_vendors INSERT was called
        const vendorInsert = txQueries.find(q => q[0].includes('INSERT INTO variation_vendors'));
        expect(vendorInsert).toBeDefined();
        expect(vendorInsert[1]).toContain('VENDOR_ABC');
        expect(vendorInsert[1]).toContain('VIN-100');
        expect(vendorInsert[1]).toContain(null); // cost_cents is null
        expect(vendorInsert[1]).toContain(42); // merchant_id
    });

    test('createSquareBatch skips variation_vendors when no vendor_id', async () => {
        jest.mock('../../utils/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        }));
        const mockDbQuery = jest.fn();
        const mockDbTransaction = jest.fn();
        jest.mock('../../utils/database', () => ({
            query: mockDbQuery,
            transaction: mockDbTransaction,
        }));
        jest.mock('../../services/square/square-client', () => ({
            getMerchantToken: jest.fn().mockResolvedValue('test-token'),
            makeSquareRequest: jest.fn(),
            sleep: jest.fn().mockResolvedValue(),
            generateIdempotencyKey: jest.fn().mockReturnValue('test-key'),
        }));

        const { createSquareBatch } = require('../../services/vendor/catalog-create-service');
        const { makeSquareRequest } = require('../../services/square/square-client');

        const entry = {
            id: 1,
            vendor_id: null, // No vendor
            vendor_name: null,
            product_name: 'Test Product',
            upc: null,
            cost_cents: null,
            price_cents: 999,
            matched_variation_id: null,
            vendor_item_number: null,
        };

        makeSquareRequest.mockResolvedValueOnce({
            objects: [],
            id_mappings: [
                { client_object_id: '#item_1', object_id: 'REAL_ITEM' },
                { client_object_id: '#var_1', object_id: 'REAL_VAR' },
            ]
        });

        const txQueries = [];
        const mockClient = { query: jest.fn(async (...args) => { txQueries.push(args); return { rows: [] }; }) };
        mockDbTransaction.mockImplementation(async (fn) => fn(mockClient));

        await createSquareBatch([entry], 42, 'test-token');

        // Verify variation_vendors INSERT was NOT called
        const vendorInsert = txQueries.find(q => q[0].includes('INSERT INTO variation_vendors'));
        expect(vendorInsert).toBeUndefined();
    });
});
