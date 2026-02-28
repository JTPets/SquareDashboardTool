/**
 * Square Service Layer — Facade
 *
 * Public API for Square integration services. Re-exports all sub-modules
 * so consumers can continue importing from `require('./services/square')`.
 *
 * Sub-modules (Pkg 2b split — see docs/API-SPLIT-PLAN.md):
 *   square-client.js             — shared infrastructure (HTTP client, token resolution)
 *   square-locations.js          — location sync
 *   square-vendors.js            — vendor sync + reconciliation
 *   square-catalog-sync.js       — catalog sync (full + delta)
 *   square-inventory.js          — inventory counts, alerts, committed inventory
 *   square-velocity.js           — sales velocity sync + incremental updates
 *   square-custom-attributes.js  — custom attribute CRUD + push helpers
 *   square-pricing.js            — price, cost & catalog content updates
 *   square-diagnostics.js        — fix location mismatches, alerts, enable items
 *   square-sync-orchestrator.js  — fullSync orchestration
 *
 * Usage:
 *   const { syncCatalog, syncInventory, getSquareInventoryCount } = require('./services/square');
 */

const client = require('./square-client');
const locations = require('./square-locations');
const vendors = require('./square-vendors');
const catalogSync = require('./square-catalog-sync');
const inventory = require('./square-inventory');
const velocity = require('./square-velocity');
const customAttrs = require('./square-custom-attributes');
const pricing = require('./square-pricing');
const diagnostics = require('./square-diagnostics');
const orchestrator = require('./square-sync-orchestrator');

// Aggregate cleanup across all sub-modules with timers
function cleanup() {
    if (inventory.cleanupInventory) {
        inventory.cleanupInventory();
    }
}

module.exports = {
    ...client,
    ...locations,
    ...vendors,
    ...catalogSync,
    ...inventory,
    ...customAttrs,
    ...pricing,
    ...diagnostics,
    ...velocity,
    ...orchestrator,
    // Override cleanup to aggregate all sub-module cleanups
    cleanup
};
