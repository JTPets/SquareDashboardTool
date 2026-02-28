/**
 * Square API Integration Service — Backward Compatibility Shim
 *
 * This file previously contained ~4,900 lines of Square API logic.
 * All functions have been extracted into focused sub-modules (Pkg 2b split).
 * This shim re-exports everything so consumers importing from api.js directly
 * continue to work without changes.
 *
 * Sub-modules:
 *   square-client.js           — shared infrastructure (HTTP client, token resolution)
 *   square-locations.js        — location sync
 *   square-vendors.js          — vendor sync + reconciliation
 *   square-catalog-sync.js     — catalog sync (full + delta)
 *   square-inventory.js        — inventory counts, alerts, committed inventory
 *   square-velocity.js         — sales velocity sync + incremental updates
 *   square-custom-attributes.js — custom attribute CRUD + push helpers
 *   square-pricing.js          — price, cost & catalog content updates
 *   square-diagnostics.js      — fix location mismatches, alerts, enable items
 *   square-sync-orchestrator.js — fullSync orchestration
 *
 * See docs/API-SPLIT-PLAN.md for the full splitting plan.
 *
 * Usage:
 *   const { syncCatalog, syncInventory } = require('./services/square/api');
 *   // Prefer: const { syncCatalog, syncInventory } = require('./services/square');
 */

// Shared infrastructure
const { getMerchantToken, makeSquareRequest, generateIdempotencyKey } = require('./square-client');

// Domain modules
const { syncLocations } = require('./square-locations');
const { syncVendors, ensureVendorsExist } = require('./square-vendors');
const { syncCatalog, deltaSyncCatalog } = require('./square-catalog-sync');
const { syncInventory, getSquareInventoryCount, setSquareInventoryCount, setSquareInventoryAlertThreshold, syncCommittedInventory, cleanupInventory } = require('./square-inventory');
const { syncSalesVelocity, syncSalesVelocityAllPeriods, updateSalesVelocityFromOrder } = require('./square-velocity');
const { fullSync } = require('./square-sync-orchestrator');

// Previously extracted modules (Phase 3)
const { fixLocationMismatches, fixInventoryAlerts, enableItemAtAllLocations } = require('./square-diagnostics');
const {
    listCustomAttributeDefinitions,
    upsertCustomAttributeDefinition,
    updateCustomAttributeValues,
    batchUpdateCustomAttributeValues,
    initializeCustomAttributes,
    pushCasePackToSquare,
    pushBrandsToSquare,
    pushExpiryDatesToSquare,
    deleteCustomAttributeDefinition
} = require('./square-custom-attributes');
const { batchUpdateVariationPrices, updateVariationCost, batchUpdateCatalogContent } = require('./square-pricing');

/**
 * Cleanup function for graceful shutdown — delegates to sub-modules with timers.
 * Called from server.js gracefulShutdown().
 */
function cleanup() {
    cleanupInventory();
}

module.exports = {
    // Shared infrastructure
    getMerchantToken,
    makeSquareRequest,
    generateIdempotencyKey,
    // Locations
    syncLocations,
    // Vendors
    syncVendors,
    ensureVendorsExist,
    // Catalog sync
    syncCatalog,
    deltaSyncCatalog,
    // Inventory
    syncInventory,
    getSquareInventoryCount,
    setSquareInventoryCount,
    setSquareInventoryAlertThreshold,
    syncCommittedInventory,
    // Sales velocity
    syncSalesVelocity,
    syncSalesVelocityAllPeriods,
    updateSalesVelocityFromOrder,
    // Orchestration
    fullSync,
    // Diagnostics
    fixLocationMismatches,
    fixInventoryAlerts,
    enableItemAtAllLocations,
    // Custom attributes
    listCustomAttributeDefinitions,
    upsertCustomAttributeDefinition,
    updateCustomAttributeValues,
    batchUpdateCustomAttributeValues,
    initializeCustomAttributes,
    pushCasePackToSquare,
    pushBrandsToSquare,
    pushExpiryDatesToSquare,
    deleteCustomAttributeDefinition,
    // Pricing
    batchUpdateVariationPrices,
    updateVariationCost,
    batchUpdateCatalogContent,
    // Lifecycle
    cleanup
};
