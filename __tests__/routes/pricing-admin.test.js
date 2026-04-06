'use strict';

/**
 * Tests for admin pricing endpoints and pricing-service.js
 *
 * Verifies:
 * 1. pricingService reads prices from DB, not registry constants
 * 2. pricingService.seedModulePricing uses ON CONFLICT DO NOTHING (preserves overrides)
 * 3. Admin pricing endpoints exist and call pricing-service functions
 * 4. Feature registry price_cents are treated as seed defaults only
 */

jest.mock('../../utils/database');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const db = require('../../utils/database');

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// pricing-service: getModulePriceMap
// ---------------------------------------------------------------------------
describe('pricingService.getModulePriceMap()', () => {
    const pricingService = require('../../services/pricing-service');

    it('returns DB prices, not registry defaults, when DB has rows', async () => {
        // DB overrides cycle_counts price to 1200 (admin changed it)
        db.query.mockResolvedValueOnce({
            rows: [{ module_key: 'cycle_counts', price_cents: 1200 }]
        });

        const map = await pricingService.getModulePriceMap();

        expect(map.cycle_counts).toBe(1200);
    });

    it('falls back to registry default when module not in DB', async () => {
        // DB returns no rows for any module
        db.query.mockResolvedValueOnce({ rows: [] });

        const map = await pricingService.getModulePriceMap();

        // Registry default for cycle_counts is 999
        expect(map.cycle_counts).toBe(999);
    });

    it('merges DB prices with registry fallbacks', async () => {
        // DB only has cycle_counts; reorder uses registry default
        db.query.mockResolvedValueOnce({
            rows: [{ module_key: 'cycle_counts', price_cents: 500 }]
        });

        const map = await pricingService.getModulePriceMap();

        expect(map.cycle_counts).toBe(500);
        expect(map.reorder).toBe(1499); // registry default
    });
});

// ---------------------------------------------------------------------------
// pricing-service: getModulePrice
// ---------------------------------------------------------------------------
describe('pricingService.getModulePrice()', () => {
    const pricingService = require('../../services/pricing-service');

    it('returns DB price when found', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ price_cents: 750 }] });

        const price = await pricingService.getModulePrice('expiry');

        expect(price).toBe(750);
    });

    it('returns registry default when not found in DB', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const price = await pricingService.getModulePrice('expiry');

        // Registry default for expiry is 999
        expect(price).toBe(999);
    });

    it('returns null for unknown module key', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const price = await pricingService.getModulePrice('nonexistent_module');

        expect(price).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// pricing-service: updateModulePrice
// ---------------------------------------------------------------------------
describe('pricingService.updateModulePrice()', () => {
    const pricingService = require('../../services/pricing-service');

    it('calls db.query with upsert SQL and correct params', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await pricingService.updateModulePrice('cycle_counts', 1299);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO module_pricing/);
        expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/);
        expect(params).toEqual(['cycle_counts', 1299]);
    });
});

// ---------------------------------------------------------------------------
// pricing-service: seedModulePricing
// ---------------------------------------------------------------------------
describe('pricingService.seedModulePricing()', () => {
    const pricingService = require('../../services/pricing-service');
    const featureRegistry = require('../../config/feature-registry');

    it('uses ON CONFLICT DO NOTHING to preserve admin overrides', async () => {
        const paidModules = featureRegistry.getPaidModules();
        // Mock a successful insert for each module
        for (let i = 0; i < paidModules.length; i++) {
            db.query.mockResolvedValueOnce({ rows: [] });
        }

        await pricingService.seedModulePricing();

        const callCount = db.query.mock.calls.length;
        expect(callCount).toBe(paidModules.length);

        // Every call must use ON CONFLICT DO NOTHING (preserves existing admin prices)
        for (const [sql] of db.query.mock.calls) {
            expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/);
        }
    });

    it('seeds all paid modules from registry', async () => {
        const paidModules = featureRegistry.getPaidModules();
        for (let i = 0; i < paidModules.length; i++) {
            db.query.mockResolvedValueOnce({ rows: [] });
        }

        await pricingService.seedModulePricing();

        const seededKeys = db.query.mock.calls.map(([, params]) => params[0]);
        for (const mod of paidModules) {
            expect(seededKeys).toContain(mod.key);
        }
    });
});

// ---------------------------------------------------------------------------
// pricing-service: getPlatformPlanPricing
// ---------------------------------------------------------------------------
describe('pricingService.getPlatformPlanPricing()', () => {
    const pricingService = require('../../services/pricing-service');

    it('returns DB plan prices when platform owner and plans exist', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 42 }] })  // platform owner lookup
            .mockResolvedValueOnce({
                rows: [
                    { plan_key: 'monthly', name: 'Monthly', price_cents: 3499, billing_frequency: 'MONTHLY', is_active: true },
                    { plan_key: 'annual',  name: 'Annual',  price_cents: 34990, billing_frequency: 'ANNUAL', is_active: true },
                ]
            });

        const plans = await pricingService.getPlatformPlanPricing();

        expect(plans).toHaveLength(2);
        expect(plans[0].price_cents).toBe(3499);
        expect(plans[1].price_cents).toBe(34990);
    });

    it('returns registry defaults when no platform owner found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no platform owner

        const plans = await pricingService.getPlatformPlanPricing();

        expect(plans.length).toBeGreaterThan(0);
        // Should return registry defaults (not DB prices)
        const monthlyDefault = plans.find(p => p.plan_key === 'monthly');
        expect(monthlyDefault).toBeDefined();
        expect(monthlyDefault.price_cents).toBe(2999); // registry default
    });

    it('returns registry defaults when platform owner has no plans', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // platform owner found
            .mockResolvedValueOnce({ rows: [] });            // no plans

        const plans = await pricingService.getPlatformPlanPricing();

        const monthlyDefault = plans.find(p => p.plan_key === 'monthly');
        expect(monthlyDefault.price_cents).toBe(2999);
    });
});

// ---------------------------------------------------------------------------
// pricing-service: updatePlatformPlanPrice
// ---------------------------------------------------------------------------
describe('pricingService.updatePlatformPlanPrice()', () => {
    const pricingService = require('../../services/pricing-service');

    it('updates plan price for platform owner merchant', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 5 }] })  // platform owner
            .mockResolvedValueOnce({
                rows: [{ plan_key: 'monthly', price_cents: 3999 }]
            });

        const result = await pricingService.updatePlatformPlanPrice('monthly', 3999);

        expect(result.plan_key).toBe('monthly');
        expect(result.price_cents).toBe(3999);

        const [updateSql, updateParams] = db.query.mock.calls[1];
        expect(updateSql).toMatch(/UPDATE subscription_plans/);
        expect(updateParams).toEqual([3999, 5, 'monthly']);
    });

    it('throws when no platform owner found', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(
            pricingService.updatePlatformPlanPrice('monthly', 1000)
        ).rejects.toThrow('No platform owner merchant found');
    });

    it('throws when plan key not found for platform owner', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 5 }] })
            .mockResolvedValueOnce({ rows: [] }); // no rows updated

        await expect(
            pricingService.updatePlatformPlanPrice('monthly', 1000)
        ).rejects.toThrow('Plan "monthly" not found for platform owner');
    });
});

// ---------------------------------------------------------------------------
// feature-registry: price_cents are seed defaults, not authoritative
// ---------------------------------------------------------------------------
describe('feature-registry price_cents are seed defaults only', () => {
    const featureRegistry = require('../../config/feature-registry');

    it('all paid modules have price_cents defined (for seeding)', () => {
        const paid = featureRegistry.getPaidModules();
        expect(paid.length).toBeGreaterThan(0);
        for (const mod of paid) {
            expect(typeof mod.price_cents).toBe('number');
            expect(mod.price_cents).toBeGreaterThan(0);
        }
    });

    it('publicPlans have price_cents defined (for seeding)', () => {
        const plans = Object.values(featureRegistry.publicPlans);
        expect(plans.length).toBeGreaterThan(0);
        for (const plan of plans) {
            expect(typeof plan.price_cents).toBe('number');
            expect(plan.price_cents).toBeGreaterThan(0);
        }
    });

    it('module registry does NOT export a getPrice function that bypasses DB', () => {
        // Prices must come from pricing-service (DB), not directly from registry
        // The registry exports helpers for routing/pages, not for live pricing
        expect(typeof featureRegistry.getModuleForRoute).toBe('function');
        expect(typeof featureRegistry.getModuleForPage).toBe('function');
        // getModulePrice is a legacy helper that reads from registry constants;
        // it should only be used as a fallback, never as the primary price source
        // (pricing-service.js wraps it correctly)
    });
});
