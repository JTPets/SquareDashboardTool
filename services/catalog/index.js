/**
 * Catalog Service Module
 *
 * Business logic for catalog data management including:
 * - Locations, items, variations, categories
 * - Inventory and stock levels
 * - Expiration tracking
 * - Catalog auditing
 *
 * Extracted from routes/catalog.js as part of P1-2 (fat routes service extraction).
 */

const itemService = require('./item-service');
const variationService = require('./variation-service');
const inventoryService = require('./inventory-service');
const auditService = require('./audit-service');
const reorderMath = require('./reorder-math');

module.exports = {
    // Item Service
    getLocations: itemService.getLocations,
    getCategories: itemService.getCategories,
    getItems: itemService.getItems,

    // Variation Service
    getVariations: variationService.getVariations,
    getVariationsWithCosts: variationService.getVariationsWithCosts,
    updateExtendedFields: variationService.updateExtendedFields,
    updateMinStock: variationService.updateMinStock,
    updateCost: variationService.updateCost,
    bulkUpdateExtendedFields: variationService.bulkUpdateExtendedFields,

    // Inventory Service
    getInventory: inventoryService.getInventory,
    getLowStock: inventoryService.getLowStock,
    getDeletedItems: inventoryService.getDeletedItems,
    getExpirations: inventoryService.getExpirations,
    saveExpirations: inventoryService.saveExpirations,
    markExpirationsReviewed: inventoryService.markExpirationsReviewed,

    // Audit Service
    getCatalogAudit: auditService.getCatalogAudit,
    fixLocationMismatches: auditService.fixLocationMismatches,
    enableItemAtAllLocations: auditService.enableItemAtAllLocations,

    // Reorder Math
    calculateReorderQuantity: reorderMath.calculateReorderQuantity,
    calculateDaysOfStock: reorderMath.calculateDaysOfStock
};
