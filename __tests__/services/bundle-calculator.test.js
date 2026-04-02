/**
 * Bundle Calculator Tests
 *
 * Tests for pure bundle ordering optimization calculations.
 */

const { calculateOrderOptions, calculateBundleOption } = require('../../services/bundles/bundle-calculator');

describe('Bundle Calculator', () => {
    const bundle = { cost_cents: 5000 }; // $50 bundle

    const children = [
        { variation_id: 'v1', child_item_name: 'Chicken', quantity_in_bundle: 2, individual_cost_cents: 1500, individual_need: 6 },
        { variation_id: 'v2', child_item_name: 'Beef', quantity_in_bundle: 1, individual_cost_cents: 2000, individual_need: 3 },
    ];

    // ==================== calculateBundleOption ====================
    describe('calculateBundleOption', () => {
        test('calculates cost for 0 bundles (all individual)', () => {
            const result = calculateBundleOption(bundle, children, 0);
            expect(result.bundle_qty).toBe(0);
            expect(result.bundle_cost_cents).toBe(0);
            expect(result.individual_topups).toHaveLength(2);
            expect(result.topup_cost_cents).toBe(6 * 1500 + 3 * 2000); // 9000 + 6000
            expect(result.total_cost_cents).toBe(15000);
            expect(result.surplus).toEqual({});
        });

        test('calculates cost for exact bundle coverage', () => {
            const result = calculateBundleOption(bundle, children, 3);
            // 3 bundles: Chicken = 6 (need 6), Beef = 3 (need 3)
            expect(result.bundle_qty).toBe(3);
            expect(result.bundle_cost_cents).toBe(15000);
            expect(result.individual_topups).toHaveLength(0);
            expect(result.topup_cost_cents).toBe(0);
            expect(result.total_cost_cents).toBe(15000);
        });

        test('calculates surplus when bundles exceed need', () => {
            const result = calculateBundleOption(bundle, children, 5);
            // 5 bundles: Chicken = 10 (need 6, surplus 4), Beef = 5 (need 3, surplus 2)
            expect(result.surplus.Chicken).toBe(4);
            expect(result.surplus.Beef).toBe(2);
        });

        test('calculates topups when bundles partially cover need', () => {
            const result = calculateBundleOption(bundle, children, 1);
            // 1 bundle: Chicken = 2 (need 6, topup 4), Beef = 1 (need 3, topup 2)
            expect(result.individual_topups).toHaveLength(2);
            const chickenTopup = result.individual_topups.find(t => t.name === 'Chicken');
            expect(chickenTopup.qty).toBe(4);
            expect(chickenTopup.cost_cents).toBe(6000);
        });

        test('handles children with zero individual_cost_cents', () => {
            const freeChildren = [
                { variation_id: 'v1', child_item_name: 'Free Item', quantity_in_bundle: 1, individual_cost_cents: 0, individual_need: 5 },
            ];
            const result = calculateBundleOption(bundle, freeChildren, 2);
            expect(result.individual_topups).toHaveLength(1);
            expect(result.individual_topups[0].cost_cents).toBe(0);
        });

        test('handles children with zero quantity_in_bundle', () => {
            const zeroQtyChildren = [
                { variation_id: 'v1', child_item_name: 'Item', quantity_in_bundle: 0, individual_cost_cents: 1000, individual_need: 5 },
            ];
            const result = calculateBundleOption(bundle, zeroQtyChildren, 3);
            // 0 units from bundles, so all need is individual
            expect(result.individual_topups[0].qty).toBe(5);
        });
    });

    // ==================== calculateOrderOptions ====================
    describe('calculateOrderOptions', () => {
        test('returns all three options', () => {
            const result = calculateOrderOptions(bundle, children);
            expect(result).toHaveProperty('all_bundles');
            expect(result).toHaveProperty('all_individual');
            expect(result).toHaveProperty('optimized');
        });

        test('all_individual has 0 bundles', () => {
            const result = calculateOrderOptions(bundle, children);
            expect(result.all_individual.bundle_qty).toBe(0);
            expect(result.all_individual.bundle_cost_cents).toBe(0);
        });

        test('all_bundles covers highest-need child', () => {
            const result = calculateOrderOptions(bundle, children);
            // Chicken: ceil(6/2) = 3, Beef: ceil(3/1) = 3 → max = 3
            expect(result.all_bundles.bundle_qty).toBe(3);
        });

        test('optimized picks cheapest option', () => {
            const result = calculateOrderOptions(bundle, children);
            expect(result.optimized.total_cost_cents).toBeLessThanOrEqual(result.all_individual.total_cost_cents);
            expect(result.optimized.total_cost_cents).toBeLessThanOrEqual(result.all_bundles.total_cost_cents);
        });

        test('optimized includes savings calculations', () => {
            const result = calculateOrderOptions(bundle, children);
            expect(result.optimized).toHaveProperty('savings_vs_individual_cents');
            expect(result.optimized).toHaveProperty('savings_pct');
        });

        test('returns early when no children have needs', () => {
            const noNeedChildren = [
                { variation_id: 'v1', child_item_name: 'Item', quantity_in_bundle: 2, individual_cost_cents: 1000, individual_need: 0 },
            ];
            const result = calculateOrderOptions(bundle, noNeedChildren);
            expect(result.all_bundles.bundle_qty).toBe(0);
            expect(result.optimized.savings_vs_individual_cents).toBe(0);
            expect(result.optimized.savings_pct).toBe('0.0');
        });

        test('handles bundles cheaper than individual', () => {
            const cheapBundle = { cost_cents: 2000 };
            const expensiveItems = [
                { variation_id: 'v1', child_item_name: 'Item A', quantity_in_bundle: 5, individual_cost_cents: 1000, individual_need: 10 },
            ];
            const result = calculateOrderOptions(cheapBundle, expensiveItems);
            // All individual = 10 * 1000 = 10000
            // 2 bundles = 4000, covers all 10
            expect(result.optimized.total_cost_cents).toBeLessThan(result.all_individual.total_cost_cents);
        });

        test('handles single child', () => {
            const singleChild = [
                { variation_id: 'v1', child_item_name: 'Solo', quantity_in_bundle: 3, individual_cost_cents: 2000, individual_need: 9 },
            ];
            const result = calculateOrderOptions(bundle, singleChild);
            expect(result.all_bundles.bundle_qty).toBe(3);
        });

        test('savings_pct is 0.0 when all individual costs are 0', () => {
            const freeChildren = [
                { variation_id: 'v1', child_item_name: 'Free', quantity_in_bundle: 1, individual_cost_cents: 0, individual_need: 5 },
            ];
            const result = calculateOrderOptions(bundle, freeChildren);
            expect(result.optimized.savings_pct).toBe('0.0');
        });
    });
});
