/**
 * Sync Orchestrator — business logic extracted from routes/sync.js
 * Exports: loggedSync, isSyncNeeded, runSmartSync, getSyncHistory, getSyncStatus
 */

const db = require('../../utils/database');
const squareApi = require('../square');
const logger = require('../../utils/logger');
const { reconcileBundleComponents } = require('../webhook-handlers/catalog-handler');
const { getActiveLocationCount } = require('../catalog/location-service');

async function loggedSync(syncType, syncFn, merchantId) {
    const startTime = Date.now();
    const startedAt = new Date();

    const insertResult = await db.query(`
        INSERT INTO sync_history (sync_type, started_at, status, merchant_id)
        VALUES ($1, $2, 'running', $3)
        ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
            started_at = EXCLUDED.started_at, status = 'running',
            completed_at = NULL, records_synced = 0,
            error_message = NULL, duration_seconds = NULL
        RETURNING id
    `, [syncType, startedAt, merchantId]);

    const syncId = insertResult.rows[0].id;

    try {
        const recordsSynced = await syncFn();
        const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
        await db.query(`
            UPDATE sync_history SET status = 'success', completed_at = CURRENT_TIMESTAMP,
                records_synced = $1, duration_seconds = $2
            WHERE id = $3
        `, [recordsSynced, durationSeconds, syncId]);
        return { success: true, recordsSynced, durationSeconds };
    } catch (error) {
        const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
        try {
            await db.query(`
                UPDATE sync_history SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
                    error_message = $1, duration_seconds = $2
                WHERE sync_type = $3 AND started_at = $4 AND merchant_id = $5
            `, [error.message, durationSeconds, syncType, startedAt, merchantId]);
        } catch (updateError) {
            logger.error('Failed to update sync history', { error: updateError.message, merchantId });
        }
        throw error;
    }
}

async function isSyncNeeded(syncType, intervalHours, merchantId) {
    const isGmcSync = syncType.startsWith('gmc_') || syncType === 'product_catalog';
    const tableName = isGmcSync ? 'gmc_sync_history' : 'sync_history';
    const timeColumn = isGmcSync ? 'created_at' : 'completed_at';
    const lookupType = isGmcSync ? syncType.replace('gmc_', '') : syncType;

    const result = await db.query(`
        SELECT ${timeColumn} as completed_at FROM ${tableName}
        WHERE sync_type = $1 AND status = 'success' AND merchant_id = $2
        ORDER BY ${timeColumn} DESC LIMIT 1
    `, [lookupType, merchantId]);

    if (result.rows.length === 0) return { needed: true, lastSync: null, nextDue: null };

    const lastSync = new Date(result.rows[0].completed_at);
    const hoursSinceLastSync = (Date.now() - lastSync) / (1000 * 60 * 60);
    const nextDue = new Date(lastSync.getTime() + intervalHours * 60 * 60 * 1000);
    return { needed: hoursSinceLastSync >= intervalHours, lastSync, nextDue, hoursSince: hoursSinceLastSync.toFixed(1) };
}

// Helper: write success rows for multiple sales periods at once
async function _writeSalesHistoryRows(periods, result, merchantId) {
    for (const period of periods) {
        const days = period.replace('sales_', '').replace('d', '');
        await db.query(`
            INSERT INTO sync_history (sync_type, records_synced, merchant_id, started_at, synced_at, status, completed_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success', CURRENT_TIMESTAMP)
            ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                records_synced = EXCLUDED.records_synced, started_at = CURRENT_TIMESTAMP,
                synced_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, status = 'success'
        `, [period, result[`${days}d`] || 0, merchantId]);
    }
}

async function runSmartSync({ merchantId } = {}) {
    logger.info('Smart sync initiated', { merchantId });

    // TODO(pre-franchise): make per-merchant (MT-6)
    const intervals = {
        catalog:    parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS    || '3'),
        locations:  parseInt(process.env.SYNC_LOCATIONS_INTERVAL_HOURS  || '3'),
        vendors:    parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS    || '24'),
        inventory:  parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS  || '3'),
        sales_91d:  parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS  || '3'),
        sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
        sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168')
    };

    const synced = [], errors = [], skipped = {}, summary = {};

    const skipMsg = (type, check) => {
        const rem = Math.max(0, intervals[type] - parseFloat(check.hoursSince));
        skipped[type] = `Last synced ${check.hoursSince}h ago, next in ${rem.toFixed(1)}h`;
    };

    // ── Locations (force if 0 active) ──
    const locationCount = await getActiveLocationCount(merchantId);
    const locCheck = await isSyncNeeded('locations', intervals.locations, merchantId);
    if (locationCount === 0 || locCheck.needed) {
        try {
            const r = await loggedSync('locations', () => squareApi.syncLocations(merchantId), merchantId);
            synced.push('locations'); summary.locations = r;
        } catch (e) { errors.push({ type: 'locations', error: e.message }); }
    } else { skipMsg('locations', locCheck); }

    // ── Vendors ──
    const vendCheck = await isSyncNeeded('vendors', intervals.vendors, merchantId);
    if (vendCheck.needed) {
        try {
            const r = await loggedSync('vendors', () => squareApi.syncVendors(merchantId), merchantId);
            synced.push('vendors'); summary.vendors = r;
        } catch (e) { errors.push({ type: 'vendors', error: e.message }); }
    } else { skipMsg('vendors', vendCheck); }

    // ── Catalog (force if 0 items) ──
    const itemCount = parseInt((await db.query('SELECT COUNT(*) FROM items WHERE merchant_id = $1', [merchantId])).rows[0].count);
    const catCheck = await isSyncNeeded('catalog', intervals.catalog, merchantId);
    if (itemCount === 0 || catCheck.needed) {
        try {
            const r = await loggedSync('catalog', async () => {
                const stats = await squareApi.syncCatalog(merchantId);
                logger.info('Catalog sync result', { merchantId, stats });
                return stats.items + stats.variations;
            }, merchantId);
            synced.push('catalog'); summary.catalog = r;
            await reconcileBundleComponents(merchantId);
        } catch (e) { errors.push({ type: 'catalog', error: e.message }); }
    } else { skipMsg('catalog', catCheck); }

    // ── Inventory (force if 0 counts) ──
    const invCount = parseInt((await db.query('SELECT COUNT(*) FROM inventory_counts WHERE merchant_id = $1', [merchantId])).rows[0].count);
    const invCheck = await isSyncNeeded('inventory', intervals.inventory, merchantId);
    if (invCount === 0 || invCheck.needed) {
        try {
            const r = await loggedSync('inventory', () => squareApi.syncInventory(merchantId), merchantId);
            synced.push('inventory'); summary.inventory = r;
        } catch (e) { errors.push({ type: 'inventory', error: e.message }); }
    } else { skipMsg('inventory', invCheck); }

    // ── Sales velocity (tiered: 365d → 182d → 91d only) ──
    const [s91, s182, s365] = await Promise.all([
        isSyncNeeded('sales_91d',  intervals.sales_91d,  merchantId),
        isSyncNeeded('sales_182d', intervals.sales_182d, merchantId),
        isSyncNeeded('sales_365d', intervals.sales_365d, merchantId)
    ]);

    // Catch-up: 365d synced with 0 records but 91d now has data
    let force365 = false;
    if (!s365.needed) {
        const last = (await db.query(`SELECT records_synced FROM sync_history WHERE sync_type = 'sales_365d' AND merchant_id = $1 AND status = 'success' ORDER BY completed_at DESC LIMIT 1`, [merchantId])).rows[0];
        if (last && last.records_synced === 0) {
            const v91 = (await db.query(`SELECT COUNT(*) as count FROM sales_velocity WHERE period_days = 91 AND merchant_id = $1 AND total_quantity_sold > 0`, [merchantId])).rows[0];
            if (parseInt(v91.count) > 0) { force365 = true; logger.info('Forcing 365d catch-up sync', { merchantId }); }
        }
    }

    if (s365.needed || force365) {
        try {
            const r = await squareApi.syncSalesVelocityAllPeriods(merchantId, 365);
            await _writeSalesHistoryRows(['sales_91d', 'sales_182d', 'sales_365d'], r, merchantId);
            synced.push('sales_91d', 'sales_182d', 'sales_365d');
            Object.assign(summary, { sales_91d: r['91d'], sales_182d: r['182d'], sales_365d: r['365d'], salesVelocityOptimization: 'tier1_365d_full_fetch' });
        } catch (e) { errors.push({ type: 'sales_velocity_365d', error: e.message }); }
    } else if (s182.needed) {
        try {
            const r = await squareApi.syncSalesVelocityAllPeriods(merchantId, 182);
            await _writeSalesHistoryRows(['sales_91d', 'sales_182d'], r, merchantId);
            synced.push('sales_91d', 'sales_182d');
            Object.assign(summary, { sales_91d: r['91d'], sales_182d: r['182d'], salesVelocityOptimization: 'tier2_182d_medium_fetch' });
            skipMsg('sales_365d', s365);
        } catch (e) { errors.push({ type: 'sales_velocity_182d', error: e.message }); }
    } else if (s91.needed) {
        try {
            const r = await loggedSync('sales_91d', () => squareApi.syncSalesVelocity(91, merchantId), merchantId);
            synced.push('sales_91d');
            Object.assign(summary, { sales_91d: r, salesVelocityOptimization: 'tier3_91d_minimal_fetch' });
        } catch (e) { errors.push({ type: 'sales_91d', error: e.message }); }
        skipMsg('sales_182d', s182); skipMsg('sales_365d', s365);
    } else {
        skipMsg('sales_91d', s91); skipMsg('sales_182d', s182); skipMsg('sales_365d', s365);
    }

    return { status: errors.length === 0 ? 'success' : 'partial', synced, skipped, summary, errors: errors.length > 0 ? errors : undefined };
}

async function getSyncHistory(merchantId, { limit = 20 } = {}) {
    const result = await db.query(`
        SELECT id, sync_type, started_at, completed_at, status,
               records_synced, error_message, duration_seconds
        FROM sync_history
        WHERE merchant_id = $1
        ORDER BY started_at DESC LIMIT $2
    `, [merchantId, limit]);
    return { count: result.rows.length, history: result.rows };
}

async function getSyncStatus(merchantId) {
    const intervals = {
        catalog:    parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS    || '3'),
        vendors:    parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS    || '24'),
        inventory:  parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS  || '3'),
        sales_91d:  parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS  || '3'),
        sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
        sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168')
    };

    const status = {};
    for (const [syncType, intervalHours] of Object.entries(intervals)) {
        const check = await isSyncNeeded(syncType, intervalHours, merchantId);
        status[syncType] = { last_sync: check.lastSync, next_sync_due: check.nextDue, interval_hours: intervalHours, needs_sync: check.needed, hours_since_last_sync: check.hoursSince };

        if (check.lastSync) {
            const row = (await db.query(`
                SELECT status, records_synced, duration_seconds FROM sync_history
                WHERE sync_type = $1 AND completed_at IS NOT NULL AND merchant_id = $2
                ORDER BY completed_at DESC LIMIT 1
            `, [syncType, merchantId])).rows[0];
            if (row) { status[syncType].last_status = row.status; status[syncType].last_records_synced = row.records_synced; status[syncType].last_duration_seconds = row.duration_seconds; }
        }
    }
    return status;
}

module.exports = { loggedSync, isSyncNeeded, runSmartSync, getSyncHistory, getSyncStatus };
