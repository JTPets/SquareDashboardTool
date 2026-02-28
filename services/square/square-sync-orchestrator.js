/**
 * Square Sync Orchestrator
 *
 * Orchestrates a full data sync from Square — locations, vendors, catalog,
 * inventory, committed inventory, and sales velocity — in the correct order.
 *
 * Exports:
 *   fullSync(merchantId) — run all sync operations in sequence
 *
 * Usage:
 *   const { fullSync } = require('./square-sync-orchestrator');
 */

const logger = require('../../utils/logger');
const { syncLocations } = require('./square-locations');
const { syncVendors } = require('./square-vendors');
const { syncCatalog } = require('./square-catalog-sync');
const { syncInventory, syncCommittedInventory } = require('./square-inventory');
const { syncSalesVelocityAllPeriods } = require('./square-velocity');

/**
 * Run full sync of all data from Square
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} Sync summary
 */
async function fullSync(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for fullSync');
    }
    logger.info('Starting full Square sync', { merchantId });
    const startTime = Date.now();

    const summary = {
        success: true,
        errors: [],
        locations: 0,
        vendors: 0,
        catalog: {},
        inventory: 0,
        committedInventory: 0,
        salesVelocity: {}
    };

    try {
        // Step 1: Sync locations
        try {
            summary.locations = await syncLocations(merchantId);
        } catch (error) {
            summary.errors.push(`Locations: ${error.message}`);
        }

        // Step 2: Sync vendors
        try {
            summary.vendors = await syncVendors(merchantId);
        } catch (error) {
            summary.errors.push(`Vendors: ${error.message}`);
        }

        // Step 3: Sync catalog
        try {
            summary.catalog = await syncCatalog(merchantId);
        } catch (error) {
            summary.errors.push(`Catalog: ${error.message}`);
        }

        // Step 4: Sync inventory
        try {
            summary.inventory = await syncInventory(merchantId);
        } catch (error) {
            summary.errors.push(`Inventory: ${error.message}`);
        }

        // Step 5: Sync committed inventory from open invoices
        try {
            summary.committedInventory = await syncCommittedInventory(merchantId);
        } catch (error) {
            summary.errors.push(`Committed inventory: ${error.message}`);
        }

        // Step 6: Sync sales velocity for all periods (optimized - single API fetch)
        try {
            summary.salesVelocity = await syncSalesVelocityAllPeriods(merchantId);
        } catch (error) {
            summary.errors.push(`Sales velocity: ${error.message}`);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info('Full Square sync complete', { duration_seconds: duration });

        if (summary.errors.length > 0) {
            logger.warn('Errors encountered during full sync', { errors: summary.errors });
            summary.success = false;
        }

        return summary;
    } catch (error) {
        logger.error('Full sync failed', { error: error.message, stack: error.stack });
        summary.success = false;
        summary.errors.push(error.message);
        return summary;
    }
}

module.exports = {
    fullSync
};
