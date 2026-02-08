/**
 * Sync Routes
 *
 * Handles data synchronization with Square:
 * - Full sync (force sync all data)
 * - Sales velocity sync
 * - Smart sync (only sync stale data)
 * - Sync history and status
 *
 * Endpoints:
 * - POST /api/sync         - Full synchronization
 * - POST /api/sync-sales   - Sales velocity sync only
 * - POST /api/sync-smart   - Smart sync (interval-based)
 * - GET  /api/sync-history - Get sync history
 * - GET  /api/sync-intervals - Get configured intervals
 * - GET  /api/sync-status  - Get current sync status
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const squareApi = require('../utils/square-api');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/sync');
const asyncHandler = require('../middleware/async-handler');
const { reconcileBundleComponents } = require('../services/webhook-handlers/catalog-handler');

// ==================== SYNC HELPER FUNCTIONS ====================

/**
 * Logs sync operations with start/end times and status
 * @param {string} syncType - Type of sync being performed
 * @param {Function} syncFunction - Async function to execute
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object>} Result with success, recordsSynced, durationSeconds
 */
async function loggedSync(syncType, syncFunction, merchantId) {
    const startTime = Date.now();
    const startedAt = new Date();

    try {
        // Create or update sync history record (upsert for unique constraint)
        const insertResult = await db.query(`
            INSERT INTO sync_history (sync_type, started_at, status, merchant_id)
            VALUES ($1, $2, 'running', $3)
            ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                started_at = EXCLUDED.started_at,
                status = 'running',
                completed_at = NULL,
                records_synced = 0,
                error_message = NULL,
                duration_seconds = NULL
            RETURNING id
        `, [syncType, startedAt, merchantId]);

        const syncId = insertResult.rows[0].id;

        // Execute the sync function
        const recordsSynced = await syncFunction();

        // Calculate duration
        const durationSeconds = Math.floor((Date.now() - startTime) / 1000);

        // Update sync history with success
        await db.query(`
            UPDATE sync_history
            SET status = 'success',
                completed_at = CURRENT_TIMESTAMP,
                records_synced = $1,
                duration_seconds = $2
            WHERE id = $3
        `, [recordsSynced, durationSeconds, syncId]);

        return { success: true, recordsSynced, durationSeconds };
    } catch (error) {
        // Calculate duration even on failure
        const durationSeconds = Math.floor((Date.now() - startTime) / 1000);

        // Try to update sync history with failure
        try {
            await db.query(`
                UPDATE sync_history
                SET status = 'failed',
                    completed_at = CURRENT_TIMESTAMP,
                    error_message = $1,
                    duration_seconds = $2
                WHERE sync_type = $3 AND started_at = $4 AND merchant_id = $5
            `, [error.message, durationSeconds, syncType, startedAt, merchantId]);
        } catch (updateError) {
            logger.error('Failed to update sync history', { error: updateError.message });
        }

        throw error;
    }
}

/**
 * Check if a sync is needed based on interval
 * @param {string} syncType - Type of sync to check
 * @param {number} intervalHours - Required interval in hours
 * @param {number} merchantId - Merchant ID to check sync status for
 * @returns {Promise<Object>} {needed: boolean, lastSync: Date|null, nextDue: Date|null}
 */
async function isSyncNeeded(syncType, intervalHours, merchantId) {
    // GMC sync uses gmc_sync_history table
    const isGmcSync = syncType.startsWith('gmc_') || syncType === 'product_catalog';
    const tableName = isGmcSync ? 'gmc_sync_history' : 'sync_history';
    const timeColumn = isGmcSync ? 'created_at' : 'completed_at';

    const result = await db.query(`
        SELECT ${timeColumn} as completed_at, status
        FROM ${tableName}
        WHERE sync_type = $1 AND status = 'success' AND merchant_id = $2
        ORDER BY ${timeColumn} DESC
        LIMIT 1
    `, [isGmcSync ? syncType.replace('gmc_', '') : syncType, merchantId]);

    if (result.rows.length === 0) {
        // Never synced before, sync is needed
        return { needed: true, lastSync: null, nextDue: null };
    }

    const lastSync = new Date(result.rows[0].completed_at);
    const now = new Date();
    const hoursSinceLastSync = (now - lastSync) / (1000 * 60 * 60);
    const nextDue = new Date(lastSync.getTime() + intervalHours * 60 * 60 * 1000);

    return {
        needed: hoursSinceLastSync >= intervalHours,
        lastSync,
        nextDue,
        hoursSince: hoursSinceLastSync.toFixed(1)
    };
}

/**
 * Run smart sync - intelligently syncs only data types whose interval has elapsed
 * This is the core function used by both the API endpoint and cron job
 * @param {Object} options - Options for smart sync
 * @param {number} options.merchantId - Merchant ID to sync for
 * @returns {Promise<Object>} Sync result with status, synced types, and summary
 */
async function runSmartSync({ merchantId } = {}) {
    logger.info('Smart sync initiated', { merchantId });

    // Get intervals from environment variables
    const intervals = {
        catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS || '3'),
        locations: parseInt(process.env.SYNC_LOCATIONS_INTERVAL_HOURS || '3'),
        vendors: parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS || '24'),
        inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS || '3'),
        sales_91d: parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS || '3'),
        sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
        sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168')
    };

    const synced = [];
    const skipped = {};
    const errors = [];
    const summary = {};

    // CRITICAL: Check and sync locations FIRST
    // Always sync if there are 0 active locations, regardless of interval
    // Locations are required for inventory and sales velocity syncs
    const locationCountResult = await db.query('SELECT COUNT(*) FROM locations WHERE active = TRUE AND merchant_id = $1', [merchantId]);
    const locationCount = parseInt(locationCountResult.rows[0].count);
    const locationsCheck = await isSyncNeeded('locations', intervals.locations, merchantId);

    if (locationCount === 0 || locationsCheck.needed) {
        try {
            if (locationCount === 0) {
                logger.info('No active locations found - forcing location sync');
            } else {
                logger.info('Syncing locations');
            }
            const result = await loggedSync('locations', () => squareApi.syncLocations(merchantId), merchantId);
            synced.push('locations');
            summary.locations = result;
        } catch (error) {
            logger.error('Location sync failed', { merchantId, error: error.message, stack: error.stack });
            errors.push({ type: 'locations', error: error.message });
        }
    } else {
        const hoursRemaining = Math.max(0, intervals.locations - parseFloat(locationsCheck.hoursSince));
        skipped.locations = `Last synced ${locationsCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
    }

    // Check and sync vendors
    const vendorsCheck = await isSyncNeeded('vendors', intervals.vendors, merchantId);
    if (vendorsCheck.needed) {
        try {
            logger.info('Syncing vendors');
            const result = await loggedSync('vendors', () => squareApi.syncVendors(merchantId), merchantId);
            synced.push('vendors');
            summary.vendors = result;
        } catch (error) {
            logger.error('Vendor sync failed', { merchantId, error: error.message, stack: error.stack });
            errors.push({ type: 'vendors', error: error.message });
        }
    } else {
        const hoursRemaining = Math.max(0, intervals.vendors - parseFloat(vendorsCheck.hoursSince));
        skipped.vendors = `Last synced ${vendorsCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
    }

    // Check and sync catalog
    // Force sync if merchant has 0 items (like we do for locations)
    const itemCountResult = await db.query('SELECT COUNT(*) FROM items WHERE merchant_id = $1', [merchantId]);
    const itemCount = parseInt(itemCountResult.rows[0].count);
    const catalogCheck = await isSyncNeeded('catalog', intervals.catalog, merchantId);

    if (itemCount === 0 || catalogCheck.needed) {
        try {
            if (itemCount === 0) {
                logger.info('No items found for merchant - forcing catalog sync', { merchantId });
            } else {
                logger.info('Syncing catalog', { merchantId });
            }
            const result = await loggedSync('catalog', async () => {
                const stats = await squareApi.syncCatalog(merchantId);
                logger.info('Catalog sync result', { merchantId, stats });
                return stats.items + stats.variations;
            }, merchantId);
            synced.push('catalog');
            summary.catalog = result;
            await reconcileBundleComponents(merchantId);
        } catch (error) {
            logger.error('Catalog sync error', { merchantId, error: error.message, stack: error.stack });
            errors.push({ type: 'catalog', error: error.message });
        }
    } else {
        const hoursRemaining = Math.max(0, intervals.catalog - parseFloat(catalogCheck.hoursSince));
        skipped.catalog = `Last synced ${catalogCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
    }

    // Check and sync inventory
    // Force sync if merchant has 0 inventory counts (like we do for locations/catalog)
    const invCountResult = await db.query('SELECT COUNT(*) FROM inventory_counts WHERE merchant_id = $1', [merchantId]);
    const invCount = parseInt(invCountResult.rows[0].count);
    const inventoryCheck = await isSyncNeeded('inventory', intervals.inventory, merchantId);

    if (invCount === 0 || inventoryCheck.needed) {
        try {
            if (invCount === 0) {
                logger.info('No inventory counts found for merchant - forcing inventory sync', { merchantId });
            } else {
                logger.info('Syncing inventory', { merchantId });
            }
            const result = await loggedSync('inventory', () => squareApi.syncInventory(merchantId), merchantId);
            synced.push('inventory');
            summary.inventory = result;
        } catch (error) {
            logger.error('Inventory sync error', { merchantId, error: error.message, stack: error.stack });
            errors.push({ type: 'inventory', error: error.message });
        }
    } else {
        const hoursRemaining = Math.max(0, intervals.inventory - parseFloat(inventoryCheck.hoursSince));
        skipped.inventory = `Last synced ${inventoryCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
    }

    // Check all sales velocity periods upfront to determine optimal sync strategy
    const sales91Check = await isSyncNeeded('sales_91d', intervals.sales_91d, merchantId);
    const sales182Check = await isSyncNeeded('sales_182d', intervals.sales_182d, merchantId);
    const sales365Check = await isSyncNeeded('sales_365d', intervals.sales_365d, merchantId);

    // Check if 365d needs a "catch-up" sync: 91d has data but 365d was synced with 0 records
    // This handles the case where a merchant's first sync had no orders, but orders came in later
    let force365dSync = false;
    if (!sales365Check.needed) {
        const lastSyncResult = await db.query(`
            SELECT records_synced FROM sync_history
            WHERE sync_type = 'sales_365d' AND merchant_id = $1 AND status = 'success'
            ORDER BY completed_at DESC LIMIT 1
        `, [merchantId]);

        if (lastSyncResult.rows.length > 0 && lastSyncResult.rows[0].records_synced === 0) {
            // 365d was synced with 0 records - check if 91d now has data
            const velocity91Check = await db.query(`
                SELECT COUNT(*) as count FROM sales_velocity
                WHERE period_days = 91 AND merchant_id = $1 AND total_quantity_sold > 0
            `, [merchantId]);

            if (parseInt(velocity91Check.rows[0].count) > 0) {
                force365dSync = true;
                logger.info('Forcing 365d sync: 91d has data but 365d was synced with 0 records', { merchantId });
            }
        }
    }

    // Tiered optimization strategy:
    // - If 365d is due → fetch 365d, calculate all three periods
    // - If 182d is due (but not 365d) → fetch 182d, calculate 91d + 182d
    // - If only 91d is due → fetch 91d only (smallest fetch, efficient for webhook-heavy setups)
    if (sales365Check.needed || force365dSync) {
        // Tier 1: 365d is due - fetch all 365 days, sync all periods
        try {
            logger.info('Syncing all sales velocity periods (365d due - full fetch)', { merchantId });

            const result = await squareApi.syncSalesVelocityAllPeriods(merchantId, 365);

            // Update sync_history for ALL periods since we synced them all
            for (const period of ['sales_91d', 'sales_182d', 'sales_365d']) {
                const days = period.replace('sales_', '').replace('d', '');
                await db.query(`
                    INSERT INTO sync_history (sync_type, records_synced, merchant_id, started_at, synced_at, status, completed_at)
                    VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success', CURRENT_TIMESTAMP)
                    ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                        records_synced = EXCLUDED.records_synced,
                        started_at = CURRENT_TIMESTAMP,
                        synced_at = CURRENT_TIMESTAMP,
                        completed_at = CURRENT_TIMESTAMP,
                        status = 'success'
                `, [period, result[`${days}d`] || 0, merchantId]);
            }

            synced.push('sales_91d', 'sales_182d', 'sales_365d');
            summary.sales_91d = result['91d'];
            summary.sales_182d = result['182d'];
            summary.sales_365d = result['365d'];
            summary.salesVelocityOptimization = 'tier1_365d_full_fetch';
        } catch (error) {
            logger.error('Sales velocity sync error (365d)', { error: error.message, stack: error.stack });
            errors.push({ type: 'sales_velocity_365d', error: error.message });
        }
    } else if (sales182Check.needed) {
        // Tier 2: 182d is due (but not 365d) - fetch 182 days, sync 91d + 182d only
        try {
            logger.info('Syncing 91d + 182d sales velocity (182d due - medium fetch)', { merchantId });

            const result = await squareApi.syncSalesVelocityAllPeriods(merchantId, 182);

            // Update sync_history for 91d and 182d only
            for (const period of ['sales_91d', 'sales_182d']) {
                const days = period.replace('sales_', '').replace('d', '');
                await db.query(`
                    INSERT INTO sync_history (sync_type, records_synced, merchant_id, started_at, synced_at, status, completed_at)
                    VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success', CURRENT_TIMESTAMP)
                    ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                        records_synced = EXCLUDED.records_synced,
                        started_at = CURRENT_TIMESTAMP,
                        synced_at = CURRENT_TIMESTAMP,
                        completed_at = CURRENT_TIMESTAMP,
                        status = 'success'
                `, [period, result[`${days}d`] || 0, merchantId]);
            }

            synced.push('sales_91d', 'sales_182d');
            summary.sales_91d = result['91d'];
            summary.sales_182d = result['182d'];
            summary.salesVelocityOptimization = 'tier2_182d_medium_fetch';

            // Report skipped status for 365d
            const hoursRemaining365 = Math.max(0, intervals.sales_365d - parseFloat(sales365Check.hoursSince));
            skipped.sales_365d = `Last synced ${sales365Check.hoursSince}h ago, next in ${hoursRemaining365.toFixed(1)}h`;
        } catch (error) {
            logger.error('Sales velocity sync error (182d)', { error: error.message, stack: error.stack });
            errors.push({ type: 'sales_velocity_182d', error: error.message });
        }
    } else if (sales91Check.needed) {
        // Tier 3: Only 91d is due - smallest fetch, ideal for webhook-heavy setups
        try {
            logger.info('Syncing 91-day sales velocity only (minimal fetch)', { merchantId });
            const result = await loggedSync('sales_91d', () => squareApi.syncSalesVelocity(91, merchantId), merchantId);
            synced.push('sales_91d');
            summary.sales_91d = result;
            summary.salesVelocityOptimization = 'tier3_91d_minimal_fetch';
        } catch (error) {
            errors.push({ type: 'sales_91d', error: error.message });
        }

        // Report skipped status for other periods
        const hoursRemaining182 = Math.max(0, intervals.sales_182d - parseFloat(sales182Check.hoursSince));
        skipped.sales_182d = `Last synced ${sales182Check.hoursSince}h ago, next in ${hoursRemaining182.toFixed(1)}h`;
        const hoursRemaining365 = Math.max(0, intervals.sales_365d - parseFloat(sales365Check.hoursSince));
        skipped.sales_365d = `Last synced ${sales365Check.hoursSince}h ago, next in ${hoursRemaining365.toFixed(1)}h`;
    } else {
        // No sales velocity periods need syncing - report all as skipped
        const hoursRemaining91 = Math.max(0, intervals.sales_91d - parseFloat(sales91Check.hoursSince));
        skipped.sales_91d = `Last synced ${sales91Check.hoursSince}h ago, next in ${hoursRemaining91.toFixed(1)}h`;
        const hoursRemaining182 = Math.max(0, intervals.sales_182d - parseFloat(sales182Check.hoursSince));
        skipped.sales_182d = `Last synced ${sales182Check.hoursSince}h ago, next in ${hoursRemaining182.toFixed(1)}h`;
        const hoursRemaining365 = Math.max(0, intervals.sales_365d - parseFloat(sales365Check.hoursSince));
        skipped.sales_365d = `Last synced ${sales365Check.hoursSince}h ago, next in ${hoursRemaining365.toFixed(1)}h`;
    }

    return {
        status: errors.length === 0 ? 'success' : 'partial',
        synced,
        skipped,
        summary,
        errors: errors.length > 0 ? errors : undefined
    };
}

// ==================== SYNC ENDPOINTS ====================

/**
 * POST /api/sync
 * Trigger full synchronization from Square (force sync, ignores intervals)
 */
router.post('/sync', requireAuth, requireMerchant, validators.sync, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Full sync requested', { merchantId });
    const summary = await squareApi.fullSync(merchantId);

    // Generate GMC feed after sync completes
    let gmcFeedResult = null;
    try {
        logger.info('Generating GMC feed after sync...');
        const gmcFeedModule = require('../utils/gmc-feed');
        gmcFeedResult = await gmcFeedModule.generateFeed();
        logger.info('GMC feed generated successfully', {
            products: gmcFeedResult.stats.total,
            feedUrl: gmcFeedResult.feedUrl
        });
    } catch (gmcError) {
        logger.error('GMC feed generation failed (non-blocking)', {
            error: gmcError.message
        });
        gmcFeedResult = { error: gmcError.message };
    }

    res.json({
        status: summary.success ? 'success' : 'partial',
        summary: {
            locations: summary.locations,
            vendors: summary.vendors,
            items: summary.catalog.items || 0,
            variations: summary.catalog.variations || 0,
            categories: summary.catalog.categories || 0,
            images: summary.catalog.images || 0,
            variation_vendors: summary.catalog.variationVendors || 0,
            inventory_records: summary.inventory,
            sales_velocity_91d: summary.salesVelocity['91d'] || 0,
            sales_velocity_182d: summary.salesVelocity['182d'] || 0,
            sales_velocity_365d: summary.salesVelocity['365d'] || 0,
            gmc_feed: gmcFeedResult ? {
                products: gmcFeedResult.stats?.total || 0,
                feedUrl: gmcFeedResult.feedUrl,
                error: gmcFeedResult.error
            } : null
        },
        errors: summary.errors
    });
}));

/**
 * POST /api/sync-sales
 * Sync only sales velocity data - optimized to fetch orders once for all periods
 */
router.post('/sync-sales', requireAuth, requireMerchant, validators.syncSales, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Sales velocity sync requested (optimized)', { merchantId });

    // Use optimized function that fetches orders once for all periods
    const results = await squareApi.syncSalesVelocityAllPeriods(merchantId);

    res.json({
        status: 'success',
        periods: [91, 182, 365],
        variations_updated: results,
        optimization: 'single_fetch'
    });
}));

/**
 * POST /api/sync-smart
 * Smart sync that only syncs data types whose interval has elapsed
 * This is the recommended endpoint for scheduled/cron jobs
 */
router.post('/sync-smart', requireAuth, requireMerchant, validators.syncSmart, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Smart sync requested', { merchantId });
    const result = await runSmartSync({ merchantId });
    res.json(result);
}));

/**
 * GET /api/sync-history
 * Get recent sync history
 */
router.get('/sync-history', requireAuth, requireMerchant, validators.syncHistory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const limit = parseInt(req.query.limit) || 20;

    const result = await db.query(`
        SELECT
            id,
            sync_type,
            started_at,
            completed_at,
            status,
            records_synced,
            error_message,
            duration_seconds
        FROM sync_history
        WHERE merchant_id = $1
        ORDER BY started_at DESC
        LIMIT $2
    `, [merchantId, limit]);

    res.json({
        count: result.rows.length,
        history: result.rows
    });
}));

/**
 * GET /api/sync-intervals
 * Get configured sync intervals (read-only, from env vars)
 */
router.get('/sync-intervals', requireAuth, validators.syncIntervals, asyncHandler(async (req, res) => {
    res.json({
        intervals: {
            catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS || '3'),
            locations: parseInt(process.env.SYNC_LOCATIONS_INTERVAL_HOURS || '3'),
            vendors: parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS || '24'),
            inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS || '3'),
            sales_91d: parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS || '3'),
            sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
            sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168'),
            gmc: process.env.GMC_SYNC_CRON_SCHEDULE || null
        },
        cronSchedule: process.env.SYNC_CRON_SCHEDULE || '0 * * * *'
    });
}));

/**
 * GET /api/sync-status
 * Get current sync status for all sync types
 */
router.get('/sync-status', requireAuth, requireMerchant, validators.syncStatus, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const intervals = {
        catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS || '3'),
        vendors: parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS || '24'),
        inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS || '3'),
        sales_91d: parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS || '3'),
        sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
        sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168')
    };

    const status = {};

    for (const [syncType, intervalHours] of Object.entries(intervals)) {
        const check = await isSyncNeeded(syncType, intervalHours, merchantId);

        status[syncType] = {
            last_sync: check.lastSync,
            next_sync_due: check.nextDue,
            interval_hours: intervalHours,
            needs_sync: check.needed,
            hours_since_last_sync: check.hoursSince
        };

        // Get the last sync status
        if (check.lastSync) {
            const lastSyncResult = await db.query(`
                SELECT status, records_synced, duration_seconds
                FROM sync_history
                WHERE sync_type = $1 AND completed_at IS NOT NULL AND merchant_id = $2
                ORDER BY completed_at DESC
                LIMIT 1
            `, [syncType, merchantId]);

            if (lastSyncResult.rows.length > 0) {
                status[syncType].last_status = lastSyncResult.rows[0].status;
                status[syncType].last_records_synced = lastSyncResult.rows[0].records_synced;
                status[syncType].last_duration_seconds = lastSyncResult.rows[0].duration_seconds;
            }
        }
    }

    res.json(status);
}));

module.exports = router;

// Export for use by cron jobs in server.js
module.exports.runSmartSync = runSmartSync;
module.exports.isSyncNeeded = isSyncNeeded;
module.exports.loggedSync = loggedSync;
