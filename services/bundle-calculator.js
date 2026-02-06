/**
 * Bundle Calculator Service
 *
 * Calculates optimal bundle vs individual ordering mix.
 * Given a bundle's children and their individual needs, finds the
 * cheapest ordering strategy (all bundles, all individual, or optimized mix).
 */

/**
 * Calculate a specific bundle quantity option
 * @param {Object} bundle - { cost_cents }
 * @param {Array} children - [{ variation_id, child_item_name, quantity_in_bundle, individual_cost_cents, individual_need }]
 * @param {number} bundleQty - Number of bundles to order
 * @returns {Object} Cost breakdown for this bundle quantity
 */
function calculateBundleOption(bundle, children, bundleQty) {
    const bundleCost = bundleQty * bundle.cost_cents;
    const topups = [];
    const surplus = {};

    for (const child of children) {
        const unitsFromBundles = bundleQty * child.quantity_in_bundle;
        const remainingNeed = Math.max(0, child.individual_need - unitsFromBundles);

        if (remainingNeed > 0) {
            topups.push({
                variation_id: child.variation_id,
                name: child.child_item_name,
                qty: Math.ceil(remainingNeed),
                cost_cents: Math.ceil(remainingNeed) * (child.individual_cost_cents || 0)
            });
        }

        if (unitsFromBundles > child.individual_need) {
            surplus[child.child_item_name] = unitsFromBundles - child.individual_need;
        }
    }

    const topupCost = topups.reduce((sum, t) => sum + t.cost_cents, 0);

    return {
        bundle_qty: bundleQty,
        bundle_cost_cents: bundleCost,
        individual_topups: topups,
        topup_cost_cents: topupCost,
        total_cost_cents: bundleCost + topupCost,
        surplus
    };
}

/**
 * Calculate optimal bundle vs individual ordering mix
 *
 * @param {Object} bundle - { cost_cents, variation_id }
 * @param {Array} children - [{
 *   variation_id, child_item_name, quantity_in_bundle, individual_cost_cents,
 *   individual_need (units needed for supply_days target)
 * }]
 * @returns {Object} { all_bundles, all_individual, optimized }
 */
function calculateOrderOptions(bundle, children) {
    // Option A: All individual (0 bundles)
    const allIndividual = {
        bundle_qty: 0,
        bundle_cost_cents: 0,
        individual_topups: children.map(c => ({
            variation_id: c.variation_id,
            name: c.child_item_name,
            qty: c.individual_need,
            cost_cents: c.individual_need * (c.individual_cost_cents || 0)
        })),
        topup_cost_cents: children.reduce((sum, c) =>
            sum + (c.individual_need * (c.individual_cost_cents || 0)), 0),
        total_cost_cents: children.reduce((sum, c) =>
            sum + (c.individual_need * (c.individual_cost_cents || 0)), 0),
        surplus: {}
    };

    // If no children have needs, return early
    const anyNeed = children.some(c => c.individual_need > 0);
    if (!anyNeed) {
        return {
            all_bundles: { ...allIndividual },
            all_individual: allIndividual,
            optimized: {
                ...allIndividual,
                savings_vs_individual_cents: 0,
                savings_pct: '0.0'
            }
        };
    }

    // Option B: All bundles (enough to cover highest-need child)
    const maxBundles = Math.max(...children.map(c =>
        c.quantity_in_bundle > 0
            ? Math.ceil(c.individual_need / c.quantity_in_bundle)
            : 0
    ));
    const allBundles = calculateBundleOption(bundle, children, maxBundles);

    // Option C: Optimized - try every bundle qty from 0 to max, find cheapest
    let bestOption = { total_cost_cents: Infinity };
    for (let b = 0; b <= maxBundles; b++) {
        const option = calculateBundleOption(bundle, children, b);
        if (option.total_cost_cents < bestOption.total_cost_cents) {
            bestOption = option;
        }
    }

    bestOption.savings_vs_individual_cents = allIndividual.total_cost_cents - bestOption.total_cost_cents;
    bestOption.savings_pct = allIndividual.total_cost_cents > 0
        ? ((bestOption.savings_vs_individual_cents / allIndividual.total_cost_cents) * 100).toFixed(1)
        : '0.0';

    return {
        all_bundles: allBundles,
        all_individual: allIndividual,
        optimized: bestOption
    };
}

module.exports = { calculateOrderOptions, calculateBundleOption };
