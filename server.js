/**
 * JTPets Inventory Management System - Main Server
 * Express API server with Square POS integration
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const db = require('./utils/database');
const squareApi = require('./utils/square-api');
const logger = require('./utils/logger');
const emailNotifier = require('./utils/email-notifier');

const app = express();
const PORT = process.env.PORT || 5001;

// AWS S3 Configuration for product images
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'items-images-production';
const AWS_S3_REGION = process.env.AWS_S3_REGION || 'us-west-2';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
// TODO: Migrate all console.log statements to logger module for consistent log aggregation
app.use((req, res, next) => {
    logger.info('API request', { method: req.method, path: req.path });
    next();
});

// ==================== HEALTH & STATUS ====================

/**
 * GET /api/health
 * Check system health and database connection
 */
app.get('/api/health', async (req, res) => {
    try {
        const dbConnected = await db.testConnection();
        res.json({
            status: 'ok',
            database: dbConnected ? 'connected' : 'disconnected',
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            database: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ==================== LOGGING ENDPOINTS ====================

/**
 * GET /api/logs
 * View recent logs
 */
app.get('/api/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logsDir = path.join(__dirname, 'logs');

        // Get today's log file
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `app-${today}.log`);

        const content = await fs.readFile(logFile, 'utf-8');
        const lines = content.trim().split('\n').slice(-limit);
        const logs = lines.map(line => JSON.parse(line));

        res.json({ logs, count: logs.length });

    } catch (error) {
        logger.error('Failed to read logs', { error: error.message });
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

/**
 * GET /api/logs/errors
 * View errors only
 */
app.get('/api/logs/errors', async (req, res) => {
    try {
        const logsDir = path.join(__dirname, 'logs');
        const today = new Date().toISOString().split('T')[0];
        const errorFile = path.join(logsDir, `error-${today}.log`);

        const content = await fs.readFile(errorFile, 'utf-8');
        const lines = content.trim().split('\n');
        const errors = lines.map(line => JSON.parse(line));

        res.json({ errors, count: errors.length });

    } catch (error) {
        res.json({ errors: [], count: 0 }); // No errors is good!
    }
});

/**
 * GET /api/logs/download
 * Download log file
 */
app.get('/api/logs/download', async (req, res) => {
    try {
        const logsDir = path.join(__dirname, 'logs');
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `app-${today}.log`);

        res.download(logFile, `jtpets-logs-${today}.log`);

    } catch (error) {
        res.status(404).json({ error: 'Log file not found' });
    }
});

/**
 * GET /api/logs/stats
 * Log statistics
 */
app.get('/api/logs/stats', async (req, res) => {
    try {
        const logsDir = path.join(__dirname, 'logs');
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `app-${today}.log`);
        const errorFile = path.join(logsDir, `error-${today}.log`);

        const logContent = await fs.readFile(logFile, 'utf-8').catch(() => '');
        const errorContent = await fs.readFile(errorFile, 'utf-8').catch(() => '');

        const logLines = logContent.trim().split('\n').filter(Boolean);
        const errorLines = errorContent.trim().split('\n').filter(Boolean);

        const logs = logLines.map(line => JSON.parse(line));
        const errors = errorLines.map(line => JSON.parse(line));

        const warnCount = logs.filter(l => l.level === 'warn').length;
        const infoCount = logs.filter(l => l.level === 'info').length;

        res.json({
            total: logs.length,
            errors: errors.length,
            warnings: warnCount,
            info: infoCount,
            today: today
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

/**
 * POST /api/test-email
 * Test email notifications
 */
app.post('/api/test-email', async (req, res) => {
    try {
        await emailNotifier.testEmail();
        res.json({ success: true, message: 'Test email sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/test-error
 * Test error logging and email
 */
app.post('/api/test-error', async (req, res) => {
    const testError = new Error('This is a test error');
    logger.error('Test error triggered', {
        error: testError.message,
        stack: testError.stack,
        endpoint: '/api/test-error'
    });

    await emailNotifier.sendCritical('Test Error', testError, {
        endpoint: '/api/test-error',
        details: 'This is a test to verify error logging and email notifications'
    });

    res.json({ message: 'Test error logged and email sent' });
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Resolve image IDs to URLs
 * @param {Array|null} imageIds - Array of image IDs from JSONB
 * @returns {Promise<Array>} Array of image URLs
 */
async function resolveImageUrls(imageIds) {
    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
        return [];
    }

    try {
        // Query the images table to get URLs
        const placeholders = imageIds.map((_, i) => `$${i + 1}`).join(',');
        const result = await db.query(
            `SELECT id, url FROM images WHERE id IN (${placeholders})`,
            imageIds
        );

        // Create a map of id -> url
        const urlMap = {};
        result.rows.forEach(row => {
            urlMap[row.id] = row.url;
        });

        // Return URLs in the same order as imageIds, with fallback format
        return imageIds.map(id => {
            if (urlMap[id]) {
                return urlMap[id];
            }
            // Fallback: construct S3 URL from environment variables
            return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/files/${id}/original.jpeg`;
        });
    } catch (error) {
        logger.error('Error resolving image URLs', { error: error.message });
        // Return fallback URLs from environment variables
        return imageIds.map(id =>
            `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/files/${id}/original.jpeg`
        );
    }
}

// ==================== SYNC HELPER FUNCTIONS ====================

/**
 * Log a sync operation to sync_history
 * @param {string} syncType - Type of sync operation
 * @param {Function} syncFunction - The sync function to execute
 * @returns {Promise<Object>} Result with records synced
 */
async function loggedSync(syncType, syncFunction) {
    const startTime = Date.now();
    const startedAt = new Date();

    try {
        // Create sync history record
        const insertResult = await db.query(`
            INSERT INTO sync_history (sync_type, started_at, status)
            VALUES ($1, $2, 'running')
            RETURNING id
        `, [syncType, startedAt]);

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
                WHERE sync_type = $3 AND started_at = $4
            `, [error.message, durationSeconds, syncType, startedAt]);
        } catch (updateError) {
            console.error('Failed to update sync history:', updateError);
        }

        throw error;
    }
}

/**
 * Check if a sync is needed based on interval
 * @param {string} syncType - Type of sync to check
 * @param {number} intervalHours - Required interval in hours
 * @returns {Promise<Object>} {needed: boolean, lastSync: Date|null, nextDue: Date|null}
 */
async function isSyncNeeded(syncType, intervalHours) {
    const result = await db.query(`
        SELECT completed_at, status
        FROM sync_history
        WHERE sync_type = $1 AND status = 'success'
        ORDER BY completed_at DESC
        LIMIT 1
    `, [syncType]);

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

// ==================== SYNC ENDPOINTS ====================

/**
 * POST /api/sync
 * Trigger full synchronization from Square (force sync, ignores intervals)
 */
app.post('/api/sync', async (req, res) => {
    try {
        console.log('Full sync requested');
        const summary = await squareApi.fullSync();

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
                sales_velocity_365d: summary.salesVelocity['365d'] || 0
            },
            errors: summary.errors
        });
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * POST /api/sync-sales
 * Sync only sales velocity data (faster, can run frequently)
 */
app.post('/api/sync-sales', async (req, res) => {
    try {
        console.log('Sales velocity sync requested');
        const results = {};

        for (const days of [91, 182, 365]) {
            results[`${days}d`] = await squareApi.syncSalesVelocity(days);
        }

        res.json({
            status: 'success',
            periods: [91, 182, 365],
            variations_updated: results
        });
    } catch (error) {
        console.error('Sales sync error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * POST /api/sync-smart
 * Smart sync that only syncs data types whose interval has elapsed
 * This is the recommended endpoint for scheduled/cron jobs
 */
app.post('/api/sync-smart', async (req, res) => {
    try {
        console.log('Smart sync requested');

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
        const locationCountResult = await db.query('SELECT COUNT(*) FROM locations WHERE active = TRUE');
        const locationCount = parseInt(locationCountResult.rows[0].count);
        const locationsCheck = await isSyncNeeded('locations', intervals.locations);

        if (locationCount === 0 || locationsCheck.needed) {
            try {
                if (locationCount === 0) {
                    console.log('No active locations found - forcing location sync...');
                } else {
                    console.log('Syncing locations...');
                }
                const result = await loggedSync('locations', () => squareApi.syncLocations());
                synced.push('locations');
                summary.locations = result;
            } catch (error) {
                errors.push({ type: 'locations', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.locations - parseFloat(locationsCheck.hoursSince));
            skipped.locations = `Last synced ${locationsCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        // Check and sync vendors
        const vendorsCheck = await isSyncNeeded('vendors', intervals.vendors);
        if (vendorsCheck.needed) {
            try {
                console.log('Syncing vendors...');
                const result = await loggedSync('vendors', () => squareApi.syncVendors());
                synced.push('vendors');
                summary.vendors = result;
            } catch (error) {
                errors.push({ type: 'vendors', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.vendors - parseFloat(vendorsCheck.hoursSince));
            skipped.vendors = `Last synced ${vendorsCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        // Check and sync catalog
        const catalogCheck = await isSyncNeeded('catalog', intervals.catalog);
        if (catalogCheck.needed) {
            try {
                console.log('Syncing catalog...');
                const result = await loggedSync('catalog', async () => {
                    const stats = await squareApi.syncCatalog();
                    return stats.items + stats.variations;
                });
                synced.push('catalog');
                summary.catalog = result;
            } catch (error) {
                errors.push({ type: 'catalog', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.catalog - parseFloat(catalogCheck.hoursSince));
            skipped.catalog = `Last synced ${catalogCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        // Check and sync inventory
        const inventoryCheck = await isSyncNeeded('inventory', intervals.inventory);
        if (inventoryCheck.needed) {
            try {
                console.log('Syncing inventory...');
                const result = await loggedSync('inventory', () => squareApi.syncInventory());
                synced.push('inventory');
                summary.inventory = result;
            } catch (error) {
                errors.push({ type: 'inventory', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.inventory - parseFloat(inventoryCheck.hoursSince));
            skipped.inventory = `Last synced ${inventoryCheck.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        // Check and sync sales_91d
        const sales91Check = await isSyncNeeded('sales_91d', intervals.sales_91d);
        if (sales91Check.needed) {
            try {
                console.log('Syncing 91-day sales velocity...');
                const result = await loggedSync('sales_91d', () => squareApi.syncSalesVelocity(91));
                synced.push('sales_91d');
                summary.sales_91d = result;
            } catch (error) {
                errors.push({ type: 'sales_91d', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.sales_91d - parseFloat(sales91Check.hoursSince));
            skipped.sales_91d = `Last synced ${sales91Check.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        // Check and sync sales_182d
        const sales182Check = await isSyncNeeded('sales_182d', intervals.sales_182d);
        if (sales182Check.needed) {
            try {
                console.log('Syncing 182-day sales velocity...');
                const result = await loggedSync('sales_182d', () => squareApi.syncSalesVelocity(182));
                synced.push('sales_182d');
                summary.sales_182d = result;
            } catch (error) {
                errors.push({ type: 'sales_182d', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.sales_182d - parseFloat(sales182Check.hoursSince));
            skipped.sales_182d = `Last synced ${sales182Check.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        // Check and sync sales_365d
        const sales365Check = await isSyncNeeded('sales_365d', intervals.sales_365d);
        if (sales365Check.needed) {
            try {
                console.log('Syncing 365-day sales velocity...');
                const result = await loggedSync('sales_365d', () => squareApi.syncSalesVelocity(365));
                synced.push('sales_365d');
                summary.sales_365d = result;
            } catch (error) {
                errors.push({ type: 'sales_365d', error: error.message });
            }
        } else {
            const hoursRemaining = Math.max(0, intervals.sales_365d - parseFloat(sales365Check.hoursSince));
            skipped.sales_365d = `Last synced ${sales365Check.hoursSince}h ago, next in ${hoursRemaining.toFixed(1)}h`;
        }

        res.json({
            status: errors.length === 0 ? 'success' : 'partial',
            synced,
            skipped,
            summary,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('Smart sync error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * GET /api/sync-history
 * Get recent sync history
 */
app.get('/api/sync-history', async (req, res) => {
    try {
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
            ORDER BY started_at DESC
            LIMIT $1
        `, [limit]);

        res.json({
            count: result.rows.length,
            history: result.rows
        });
    } catch (error) {
        console.error('Get sync history error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sync-status
 * Get current sync status for all sync types
 */
app.get('/api/sync-status', async (req, res) => {
    try {
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
            const check = await isSyncNeeded(syncType, intervalHours);

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
                    WHERE sync_type = $1 AND completed_at IS NOT NULL
                    ORDER BY completed_at DESC
                    LIMIT 1
                `, [syncType]);

                if (lastSyncResult.rows.length > 0) {
                    status[syncType].last_status = lastSyncResult.rows[0].status;
                    status[syncType].last_records_synced = lastSyncResult.rows[0].records_synced;
                    status[syncType].last_duration_seconds = lastSyncResult.rows[0].duration_seconds;
                }
            }
        }

        res.json(status);
    } catch (error) {
        console.error('Get sync status error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== CATALOG ENDPOINTS ====================

/**
 * GET /api/items
 * List all items with optional filtering
 */
app.get('/api/items', async (req, res) => {
    try {
        const { name, category } = req.query;
        let query = `
            SELECT i.*, c.name as category_name
            FROM items i
            LEFT JOIN categories c ON i.category_id = c.id
            WHERE 1=1
        `;
        const params = [];

        if (name) {
            params.push(`%${name}%`);
            query += ` AND i.name ILIKE $${params.length}`;
        }

        if (category) {
            params.push(`%${category}%`);
            query += ` AND c.name ILIKE $${params.length}`;
        }

        query += ' ORDER BY i.name';

        const result = await db.query(query, params);
        logger.info('API /api/items returning', { count: result.rows.length });
        res.json({
            count: result.rows.length,
            items: result.rows || []
        });
    } catch (error) {
        logger.error('Get items error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message, items: [] });
    }
});

/**
 * GET /api/variations
 * List all variations with optional filtering
 */
app.get('/api/variations', async (req, res) => {
    try {
        const { item_id, sku, has_cost } = req.query;
        let query = `
            SELECT v.*, i.name as item_name, i.category_name
            FROM variations v
            JOIN items i ON v.item_id = i.id
            WHERE 1=1
        `;
        const params = [];

        if (item_id) {
            params.push(item_id);
            query += ` AND v.item_id = $${params.length}`;
        }

        if (sku) {
            params.push(`%${sku}%`);
            query += ` AND v.sku ILIKE $${params.length}`;
        }

        if (has_cost === 'true') {
            query += ' AND EXISTS (SELECT 1 FROM variation_vendors vv WHERE vv.variation_id = v.id)';
        }

        query += ' ORDER BY i.name, v.name';

        const result = await db.query(query, params);

        // Resolve image URLs for each variation
        const variations = await Promise.all(result.rows.map(async (variation) => {
            const imageIds = variation.images;
            const imageUrls = await resolveImageUrls(imageIds);
            return {
                ...variation,
                image_urls: imageUrls
            };
        }));

        res.json({
            count: variations.length,
            variations
        });
    } catch (error) {
        console.error('Get variations error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/variations-with-costs
 * Get variations with cost and margin information
 */
app.get('/api/variations-with-costs', async (req, res) => {
    try {
        const query = `
            SELECT
                v.id,
                v.sku,
                v.images,
                i.name as item_name,
                v.name as variation_name,
                v.price_money as retail_price_cents,
                vv.unit_cost_money as cost_cents,
                ve.name as vendor_name,
                vv.vendor_code,
                CASE
                    WHEN v.price_money > 0 AND vv.unit_cost_money > 0
                    THEN ROUND(((v.price_money - vv.unit_cost_money)::DECIMAL / v.price_money * 100), 2)
                    ELSE NULL
                END as margin_percent,
                CASE
                    WHEN v.price_money > 0 AND vv.unit_cost_money > 0
                    THEN v.price_money - vv.unit_cost_money
                    ELSE NULL
                END as profit_cents
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id
            LEFT JOIN vendors ve ON vv.vendor_id = ve.id
            WHERE v.price_money IS NOT NULL
            ORDER BY i.name, v.name, ve.name
        `;

        const result = await db.query(query);

        // Resolve image URLs for each variation
        const variations = await Promise.all(result.rows.map(async (variation) => {
            const imageIds = variation.images;
            const imageUrls = await resolveImageUrls(imageIds);
            return {
                ...variation,
                image_urls: imageUrls
            };
        }));

        res.json({
            count: variations.length,
            variations
        });
    } catch (error) {
        console.error('Get variations with costs error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/variations/:id/extended
 * Update JTPets custom fields on a variation
 */
app.patch('/api/variations/:id/extended', async (req, res) => {
    try {
        const { id } = req.params;
        const allowedFields = [
            'case_pack_quantity', 'stock_alert_min', 'stock_alert_max',
            'preferred_stock_level', 'shelf_location', 'bin_location',
            'reorder_multiple', 'discontinued', 'discontinue_date',
            'replacement_variation_id', 'supplier_item_number',
            'last_cost_cents', 'last_cost_date', 'notes'
        ];

        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(req.body)) {
            if (allowedFields.includes(key)) {
                updates.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);

        const query = `
            UPDATE variations
            SET ${updates.join(', ')}
            WHERE id = $${paramCount}
            RETURNING *
        `;

        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        res.json({
            status: 'success',
            variation: result.rows[0]
        });
    } catch (error) {
        console.error('Update variation error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/variations/bulk-update-extended
 * Bulk update custom fields by SKU
 */
app.post('/api/variations/bulk-update-extended', async (req, res) => {
    try {
        const updates = req.body;
        if (!Array.isArray(updates)) {
            return res.status(400).json({ error: 'Request body must be an array' });
        }

        let updatedCount = 0;
        const errors = [];

        for (const update of updates) {
            if (!update.sku) {
                errors.push({ error: 'SKU required', data: update });
                continue;
            }

            try {
                const allowedFields = [
                    'case_pack_quantity', 'stock_alert_min', 'stock_alert_max',
                    'preferred_stock_level', 'shelf_location', 'bin_location',
                    'reorder_multiple', 'discontinued', 'notes'
                ];

                const sets = [];
                const values = [];
                let paramCount = 1;

                for (const [key, value] of Object.entries(update)) {
                    if (key !== 'sku' && allowedFields.includes(key)) {
                        sets.push(`${key} = $${paramCount}`);
                        values.push(value);
                        paramCount++;
                    }
                }

                if (sets.length > 0) {
                    sets.push('updated_at = CURRENT_TIMESTAMP');
                    values.push(update.sku);

                    await db.query(`
                        UPDATE variations
                        SET ${sets.join(', ')}
                        WHERE sku = $${paramCount}
                    `, values);
                    updatedCount++;
                }
            } catch (error) {
                errors.push({ sku: update.sku, error: error.message });
            }
        }

        res.json({
            status: 'success',
            updated_count: updatedCount,
            errors: errors
        });
    } catch (error) {
        console.error('Bulk update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== INVENTORY ENDPOINTS ====================

/**
 * GET /api/inventory
 * Get current inventory levels
 */
app.get('/api/inventory', async (req, res) => {
    try {
        const { location_id, low_stock } = req.query;
        let query = `
            SELECT
                ic.*,
                v.sku,
                v.name as variation_name,
                v.stock_alert_min,
                v.stock_alert_max,
                i.name as item_name,
                i.category_name,
                l.name as location_name
            FROM inventory_counts ic
            JOIN variations v ON ic.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            JOIN locations l ON ic.location_id = l.id
            WHERE ic.state = 'IN_STOCK'
        `;
        const params = [];

        if (location_id) {
            params.push(location_id);
            query += ` AND ic.location_id = $${params.length}`;
        }

        if (low_stock === 'true') {
            query += ` AND v.stock_alert_min IS NOT NULL AND ic.quantity < v.stock_alert_min`;
        }

        query += ' ORDER BY i.name, v.name, l.name';

        const result = await db.query(query, params);
        res.json({
            count: result.rows.length,
            inventory: result.rows
        });
    } catch (error) {
        console.error('Get inventory error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/low-stock
 * Get items below minimum stock alert threshold
 */
app.get('/api/low-stock', async (req, res) => {
    try {
        const query = `
            SELECT
                v.id,
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                ic.quantity as current_stock,
                v.stock_alert_min,
                v.stock_alert_max,
                v.preferred_stock_level,
                l.name as location_name,
                ic.location_id,
                (v.stock_alert_min - ic.quantity) as units_below_min
            FROM variations v
            JOIN items i ON v.item_id = i.id
            JOIN inventory_counts ic ON v.id = ic.catalog_object_id
            JOIN locations l ON ic.location_id = l.id
            WHERE v.stock_alert_min IS NOT NULL
              AND ic.quantity < v.stock_alert_min
              AND ic.state = 'IN_STOCK'
              AND v.discontinued = FALSE
            ORDER BY (v.stock_alert_min - ic.quantity) DESC, i.name
        `;

        const result = await db.query(query);
        res.json({
            count: result.rows.length,
            low_stock_items: result.rows
        });
    } catch (error) {
        console.error('Get low stock error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== VENDOR ENDPOINTS ====================

/**
 * GET /api/vendors
 * List all vendors
 */
app.get('/api/vendors', async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM vendors WHERE 1=1';
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }

        query += ' ORDER BY name';

        const result = await db.query(query, params);
        res.json({
            count: result.rows.length,
            vendors: result.rows
        });
    } catch (error) {
        console.error('Get vendors error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/locations
 * List all locations
 */
app.get('/api/locations', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT id, name, active, address, timezone
            FROM locations
            ORDER BY name
        `);

        res.json({
            count: result.rows.length,
            locations: result.rows
        });
    } catch (error) {
        console.error('Get locations error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== SALES VELOCITY ENDPOINTS ====================

/**
 * GET /api/sales-velocity
 * Get sales velocity data
 */
app.get('/api/sales-velocity', async (req, res) => {
    try {
        const { variation_id, location_id, period_days } = req.query;

        // Input validation for period_days
        if (period_days !== undefined) {
            const periodDaysNum = parseInt(period_days);
            const validPeriods = [91, 182, 365];
            if (isNaN(periodDaysNum) || !validPeriods.includes(periodDaysNum)) {
                return res.status(400).json({
                    error: 'Invalid period_days parameter',
                    message: 'period_days must be one of: 91, 182, or 365'
                });
            }
        }

        let query = `
            SELECT
                sv.*,
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                l.name as location_name
            FROM sales_velocity sv
            JOIN variations v ON sv.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            JOIN locations l ON sv.location_id = l.id
            WHERE 1=1
        `;
        const params = [];

        if (variation_id) {
            params.push(variation_id);
            query += ` AND sv.variation_id = $${params.length}`;
        }

        if (location_id) {
            params.push(location_id);
            query += ` AND sv.location_id = $${params.length}`;
        }

        if (period_days) {
            params.push(parseInt(period_days));
            query += ` AND sv.period_days = $${params.length}`;
        }

        query += ' ORDER BY sv.daily_avg_quantity DESC';

        const result = await db.query(query, params);
        res.json({
            count: result.rows.length,
            sales_velocity: result.rows
        });
    } catch (error) {
        console.error('Get sales velocity error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== REORDER SUGGESTIONS ====================

/**
 * GET /api/reorder-suggestions
 * Calculate reorder suggestions based on sales velocity
 */
app.get('/api/reorder-suggestions', async (req, res) => {
    try {
        const {
            vendor_id,
            supply_days = 45,
            location_id,
            min_cost
        } = req.query;

        // Input validation
        const supplyDaysNum = parseInt(supply_days);
        if (isNaN(supplyDaysNum) || supplyDaysNum < 1 || supplyDaysNum > 365) {
            return res.status(400).json({
                error: 'Invalid supply_days parameter',
                message: 'supply_days must be a number between 1 and 365'
            });
        }

        if (min_cost !== undefined) {
            const minCostNum = parseFloat(min_cost);
            if (isNaN(minCostNum) || minCostNum < 0) {
                return res.status(400).json({
                    error: 'Invalid min_cost parameter',
                    message: 'min_cost must be a positive number'
                });
            }
        }

        const safetyDays = parseInt(process.env.REORDER_SAFETY_DAYS || '7');

        let query = `
            SELECT
                v.id as variation_id,
                i.name as item_name,
                v.name as variation_name,
                v.sku,
                v.images,
                ic.location_id as location_id,
                l.name as location_name,
                COALESCE(ic.quantity, 0) as current_stock,
                sv91.daily_avg_quantity,
                sv91.weekly_avg_quantity,
                sv91.weekly_avg_quantity as weekly_avg_91d,
                sv182.weekly_avg_quantity as weekly_avg_182d,
                sv365.weekly_avg_quantity as weekly_avg_365d,
                ve.name as vendor_name,
                vv.vendor_code,
                vv.vendor_id as current_vendor_id,
                vv.unit_cost_money as unit_cost_cents,
                -- Get primary vendor (lowest cost, then earliest created)
                (SELECT vv2.vendor_id
                 FROM variation_vendors vv2
                 WHERE vv2.variation_id = v.id
                 ORDER BY vv2.unit_cost_money ASC, vv2.created_at ASC
                 LIMIT 1
                ) as primary_vendor_id,
                -- Get primary vendor name for comparison
                (SELECT ve2.name
                 FROM variation_vendors vv3
                 JOIN vendors ve2 ON vv3.vendor_id = ve2.id
                 WHERE vv3.variation_id = v.id
                 ORDER BY vv3.unit_cost_money ASC, vv3.created_at ASC
                 LIMIT 1
                ) as primary_vendor_name,
                v.case_pack_quantity,
                v.reorder_multiple,
                -- Prefer location-specific settings over global
                COALESCE(vls.stock_alert_min, v.stock_alert_min) as stock_alert_min,
                COALESCE(vls.stock_alert_max, v.stock_alert_max) as stock_alert_max,
                COALESCE(vls.preferred_stock_level, v.preferred_stock_level) as preferred_stock_level,
                ve.lead_time_days,
                -- Calculate days until stockout (fixed to handle zero/negative stock)
                CASE
                    WHEN sv91.daily_avg_quantity > 0 AND COALESCE(ic.quantity, 0) > 0
                    THEN ROUND(COALESCE(ic.quantity, 0) / sv91.daily_avg_quantity, 1)
                    WHEN COALESCE(ic.quantity, 0) <= 0
                    THEN 0
                    ELSE 999
                END as days_until_stockout,
                -- Base suggested quantity (supply_days worth of inventory)
                ROUND(COALESCE(sv91.daily_avg_quantity, 0) * $1, 2) as base_suggested_qty,
                -- Whether currently at or below minimum stock (prefer location-specific)
                CASE
                    WHEN COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                         AND COALESCE(ic.quantity, 0) <= COALESCE(vls.stock_alert_min, v.stock_alert_min)
                    THEN TRUE
                    ELSE FALSE
                END as below_minimum
            FROM variations v
            JOIN items i ON v.item_id = i.id
            JOIN variation_vendors vv ON v.id = vv.variation_id
            JOIN vendors ve ON vv.vendor_id = ve.id
            LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91
            LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182
            LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id
                AND ic.state = 'IN_STOCK'
            LEFT JOIN locations l ON ic.location_id = l.id
            LEFT JOIN variation_location_settings vls ON v.id = vls.variation_id
                AND ic.location_id = vls.location_id
            WHERE v.discontinued = FALSE
              AND (
                  -- ALWAYS SHOW: Out of stock items (regardless of supply_days or sales velocity)
                  COALESCE(ic.quantity, 0) <= 0

                  OR

                  -- ALWAYS SHOW: Items at or below alert threshold (regardless of supply_days)
                  (COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                      AND COALESCE(ic.quantity, 0) <= COALESCE(vls.stock_alert_min, v.stock_alert_min))

                  OR

                  -- APPLY SUPPLY_DAYS: Items with stock that will run out within supply_days period
                  -- Only applies to items with active sales velocity (sv91.daily_avg_quantity > 0)
                  (sv91.daily_avg_quantity > 0
                      AND COALESCE(ic.quantity, 0) / sv91.daily_avg_quantity < $1)
              )
        `;

        const params = [supplyDaysNum];

        if (vendor_id) {
            params.push(vendor_id);
            query += ` AND vv.vendor_id = $${params.length}`;
        }

        if (location_id) {
            params.push(location_id);
            query += ` AND (ic.location_id = $${params.length} OR ic.location_id IS NULL)`;
            query += ` AND (sv91.location_id = $${params.length} OR sv91.location_id IS NULL)`;
        }

        const result = await db.query(query, params);

        // Get priority thresholds from environment
        const urgentDays = parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0');
        const highDays = parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7');
        const mediumDays = parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14');
        const lowDays = parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30');

        // Process suggestions with case pack and reorder multiple logic
        const suggestions = result.rows
            .map(row => {
                const currentStock = parseFloat(row.current_stock) || 0;
                const dailyAvg = parseFloat(row.daily_avg_quantity) || 0;
                // Round up base suggested quantity to whole number
                const baseSuggestedQty = Math.ceil(parseFloat(row.base_suggested_qty) || 0);
                const casePack = parseInt(row.case_pack_quantity) || 1;
                const reorderMultiple = parseInt(row.reorder_multiple) || 1;
                const stockAlertMin = parseInt(row.stock_alert_min) || 0;  // Now includes location-specific via COALESCE
                const stockAlertMax = parseInt(row.stock_alert_max) || 999999;  // Now includes location-specific via COALESCE
                const locationId = row.location_id || null;
                const locationName = row.location_name || null;
                const leadTime = parseInt(row.lead_time_days) || 7;
                const daysUntilStockout = parseFloat(row.days_until_stockout) || 999;

                // Don't suggest if already above max
                if (currentStock >= stockAlertMax) {
                    return null;
                }

                // FILTERING LOGIC (must match SQL WHERE clause):
                // 1. ALWAYS include out-of-stock items (quantity <= 0), regardless of supply_days
                // 2. ALWAYS include items below alert threshold, regardless of supply_days
                // 3. Include items that will stockout within supply_days period (only if has velocity)
                const isOutOfStock = currentStock <= 0;
                const needsReorder = isOutOfStock || row.below_minimum || daysUntilStockout < supplyDaysNum;
                if (!needsReorder) {
                    return null;
                }

                // Calculate priority and reorder reason
                let priority;
                let reorder_reason;

                // Handle out-of-stock items specially
                if (currentStock <= urgentDays) {
                    if (dailyAvg > 0) {
                        priority = 'URGENT';
                        reorder_reason = 'Out of stock with active sales';
                    } else {
                        priority = 'MEDIUM';
                        reorder_reason = 'Out of stock - no recent sales';
                    }
                } else if (row.below_minimum && stockAlertMin > 0) {
                    priority = 'HIGH';
                    const locationInfo = locationName ? ` at ${locationName}` : '';
                    reorder_reason = `Below stock alert threshold (${stockAlertMin} units)${locationInfo}`;
                } else if (daysUntilStockout < highDays) {
                    priority = 'HIGH';
                    reorder_reason = `URGENT: Less than ${highDays} days of stock`;
                } else if (daysUntilStockout < mediumDays) {
                    priority = 'MEDIUM';
                    reorder_reason = `Less than ${mediumDays} days of stock remaining`;
                } else if (daysUntilStockout < lowDays) {
                    priority = 'LOW';
                    reorder_reason = `Less than ${lowDays} days of stock remaining`;
                } else {
                    priority = 'LOW';
                    reorder_reason = 'Below minimum stock level';
                }

                // Calculate quantity needed to reach supply_days worth of stock
                let targetQty;

                // For items with no sales velocity, use minimum reorder quantities
                if (dailyAvg <= 0 || baseSuggestedQty <= 0) {
                    // No sales data - suggest minimum reorder based on case pack or reorder multiple
                    if (casePack > 1) {
                        targetQty = casePack; // Order at least 1 case
                    } else if (reorderMultiple > 1) {
                        targetQty = reorderMultiple;
                    } else {
                        targetQty = 2; // Default minimum order of 2 units for safety stock
                    }
                } else {
                    // Use velocity-based calculation (already rounded up via baseSuggestedQty)
                    targetQty = baseSuggestedQty;
                }

                // When stock_alert_min > 0, ensure we order enough to exceed it
                if (stockAlertMin && stockAlertMin > 0) {
                    targetQty = Math.max(stockAlertMin + 1, targetQty);
                }

                // Calculate suggested quantity (round up to ensure minimum of 1)
                let suggestedQty = Math.ceil(Math.max(0, targetQty - currentStock));

                // Round up to case pack
                if (casePack > 1) {
                    suggestedQty = Math.ceil(suggestedQty / casePack) * casePack;
                }

                // Apply reorder multiple
                if (reorderMultiple > 1) {
                    suggestedQty = Math.ceil(suggestedQty / reorderMultiple) * reorderMultiple;
                }

                // Don't exceed max stock level (round up final quantity)
                const finalQty = Math.ceil(Math.min(suggestedQty, stockAlertMax - currentStock));

                if (finalQty <= 0) {
                    return null;
                }

                const unitCost = parseInt(row.unit_cost_cents) || 0;
                const orderCost = (finalQty * unitCost) / 100;

                return {
                    variation_id: row.variation_id,
                    item_name: row.item_name,
                    variation_name: row.variation_name,
                    sku: row.sku,
                    location_id: locationId,
                    location_name: locationName,
                    current_stock: currentStock,
                    daily_avg_quantity: dailyAvg,
                    weekly_avg_quantity: parseFloat(row.weekly_avg_quantity) || 0,
                    weekly_avg_91d: parseFloat(row.weekly_avg_91d) || 0,
                    weekly_avg_182d: parseFloat(row.weekly_avg_182d) || 0,
                    weekly_avg_365d: parseFloat(row.weekly_avg_365d) || 0,
                    days_until_stockout: daysUntilStockout,
                    below_minimum: row.below_minimum,
                    stock_alert_min: stockAlertMin,  // Includes location-specific via COALESCE
                    stock_alert_max: stockAlertMax,  // Includes location-specific via COALESCE
                    priority: priority,
                    reorder_reason: reorder_reason,
                    base_suggested_qty: baseSuggestedQty,
                    case_pack_quantity: casePack,
                    case_pack_adjusted_qty: suggestedQty,
                    final_suggested_qty: finalQty,
                    unit_cost_cents: unitCost,
                    order_cost: orderCost,
                    vendor_name: row.vendor_name,
                    vendor_code: row.vendor_code || 'N/A',
                    is_primary_vendor: row.current_vendor_id === row.primary_vendor_id,
                    primary_vendor_name: row.primary_vendor_name,
                    lead_time_days: leadTime,
                    has_velocity: dailyAvg > 0,
                    images: row.images  // Include images for URL resolution
                };
            })
            .filter(item => item !== null);

        // Apply minimum cost filter if specified
        let filteredSuggestions = suggestions;
        if (min_cost) {
            const minCostNum = parseFloat(min_cost);
            filteredSuggestions = suggestions.filter(s => s.order_cost >= minCostNum);
        }

        // Sort: by priority first (URGENT > HIGH > MEDIUM > LOW),
        // then by days until stockout,
        // then by daily_avg_quantity (items with sales first)
        const priorityOrder = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
        filteredSuggestions.sort((a, b) => {
            // First: Sort by priority
            if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
                return priorityOrder[b.priority] - priorityOrder[a.priority];
            }
            // Second: Sort by days until stockout
            if (a.days_until_stockout !== b.days_until_stockout) {
                return a.days_until_stockout - b.days_until_stockout;
            }
            // Third: Items with sales velocity come before items without sales
            return b.daily_avg_quantity - a.daily_avg_quantity;
        });

        // Resolve image URLs for each suggestion
        const suggestionsWithImages = await Promise.all(filteredSuggestions.map(async (suggestion) => {
            const imageIds = suggestion.images;
            const imageUrls = await resolveImageUrls(imageIds);
            return {
                ...suggestion,
                image_urls: imageUrls,
                images: undefined  // Remove raw image IDs from response
            };
        }));

        res.json({
            count: suggestionsWithImages.length,
            supply_days: supplyDaysNum,
            safety_days: safetyDays,
            suggestions: suggestionsWithImages
        });
    } catch (error) {
        console.error('Get reorder suggestions error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== PURCHASE ORDERS ====================

/**
 * POST /api/purchase-orders
 * Create a new purchase order
 */
app.post('/api/purchase-orders', async (req, res) => {
    try {
        const { vendor_id, location_id, supply_days_override, items, notes, created_by } = req.body;

        if (!vendor_id || !location_id || !items || items.length === 0) {
            return res.status(400).json({
                error: 'vendor_id, location_id, and items are required'
            });
        }

        // Generate PO number: PO-YYYYMMDD-XXX
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
        const countResult = await db.query(
            "SELECT COUNT(*) as count FROM purchase_orders WHERE po_number LIKE $1",
            [`PO-${dateStr}-%`]
        );
        const sequence = parseInt(countResult.rows[0].count) + 1;
        const poNumber = `PO-${dateStr}-${sequence.toString().padStart(3, '0')}`;

        // Calculate totals
        let subtotalCents = 0;
        for (const item of items) {
            subtotalCents += item.quantity_ordered * item.unit_cost_cents;
        }

        // Create PO
        const poResult = await db.query(`
            INSERT INTO purchase_orders (
                po_number, vendor_id, location_id, status, supply_days_override,
                subtotal_cents, total_cents, notes, created_by
            )
            VALUES ($1, $2, $3, 'DRAFT', $4, $5, $5, $6, $7)
            RETURNING *
        `, [poNumber, vendor_id, location_id, supply_days_override, subtotalCents, notes, created_by]);

        const po = poResult.rows[0];

        // Create PO items
        for (const item of items) {
            const totalCost = item.quantity_ordered * item.unit_cost_cents;
            await db.query(`
                INSERT INTO purchase_order_items (
                    purchase_order_id, variation_id, quantity_override,
                    quantity_ordered, unit_cost_cents, total_cost_cents, notes
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                po.id,
                item.variation_id,
                item.quantity_override || null,
                item.quantity_ordered,
                item.unit_cost_cents,
                totalCost,
                item.notes || null
            ]);
        }

        res.status(201).json({
            status: 'success',
            purchase_order: po
        });
    } catch (error) {
        console.error('Create PO error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/purchase-orders
 * List purchase orders with filtering
 */
app.get('/api/purchase-orders', async (req, res) => {
    try {
        const { status, vendor_id } = req.query;
        let query = `
            SELECT
                po.*,
                v.name as vendor_name,
                l.name as location_name,
                (SELECT COUNT(*) FROM purchase_order_items WHERE purchase_order_id = po.id) as item_count
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id
            JOIN locations l ON po.location_id = l.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND po.status = $${params.length}`;
        }

        if (vendor_id) {
            params.push(vendor_id);
            query += ` AND po.vendor_id = $${params.length}`;
        }

        query += ' ORDER BY po.created_at DESC';

        const result = await db.query(query, params);
        res.json({
            count: result.rows.length,
            purchase_orders: result.rows
        });
    } catch (error) {
        console.error('Get POs error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/purchase-orders/:id
 * Get single purchase order with all items
 */
app.get('/api/purchase-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Get PO header
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id
            JOIN locations l ON po.location_id = l.id
            WHERE po.id = $1
        `, [id]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];

        // Get PO items
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                i.name as item_name,
                v.name as variation_name
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            WHERE poi.purchase_order_id = $1
            ORDER BY i.name, v.name
        `, [id]);

        po.items = itemsResult.rows;

        res.json(po);
    } catch (error) {
        console.error('Get PO error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/purchase-orders/:id
 * Update a draft purchase order
 */
app.patch('/api/purchase-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { supply_days_override, items, notes } = req.body;

        // Check if PO is in DRAFT status
        const statusCheck = await db.query(
            'SELECT status FROM purchase_orders WHERE id = $1',
            [id]
        );

        if (statusCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        if (statusCheck.rows[0].status !== 'DRAFT') {
            return res.status(400).json({
                error: 'Only draft purchase orders can be updated'
            });
        }

        await db.transaction(async (client) => {
            // Update PO header
            const updates = [];
            const values = [];
            let paramCount = 1;

            if (supply_days_override !== undefined) {
                updates.push(`supply_days_override = $${paramCount}`);
                values.push(supply_days_override);
                paramCount++;
            }

            if (notes !== undefined) {
                updates.push(`notes = $${paramCount}`);
                values.push(notes);
                paramCount++;
            }

            if (updates.length > 0) {
                updates.push('updated_at = CURRENT_TIMESTAMP');
                values.push(id);
                await client.query(`
                    UPDATE purchase_orders
                    SET ${updates.join(', ')}
                    WHERE id = $${paramCount}
                `, values);
            }

            // Update items if provided
            if (items) {
                // Delete existing items
                await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [id]);

                // Insert new items and calculate totals
                let subtotalCents = 0;
                for (const item of items) {
                    const totalCost = item.quantity_ordered * item.unit_cost_cents;
                    subtotalCents += totalCost;

                    await client.query(`
                        INSERT INTO purchase_order_items (
                            purchase_order_id, variation_id, quantity_ordered,
                            unit_cost_cents, total_cost_cents, notes
                        )
                        VALUES ($1, $2, $3, $4, $5, $6)
                    `, [id, item.variation_id, item.quantity_ordered, item.unit_cost_cents, totalCost, item.notes]);
                }

                // Update totals
                await client.query(`
                    UPDATE purchase_orders
                    SET subtotal_cents = $1, total_cents = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                `, [subtotalCents, id]);
            }
        });

        // Return updated PO
        const result = await db.query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
        res.json({
            status: 'success',
            purchase_order: result.rows[0]
        });
    } catch (error) {
        console.error('Update PO error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/purchase-orders/:id/submit
 * Submit a purchase order (change from DRAFT to SUBMITTED)
 */
app.post('/api/purchase-orders/:id/submit', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(`
            UPDATE purchase_orders po
            SET
                status = 'SUBMITTED',
                order_date = COALESCE(order_date, CURRENT_DATE),
                expected_delivery_date = CURRENT_DATE + (
                    SELECT COALESCE(lead_time_days, 7) FROM vendors WHERE id = po.vendor_id
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'DRAFT'
            RETURNING *
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(400).json({
                error: 'Purchase order not found or not in DRAFT status'
            });
        }

        res.json({
            status: 'success',
            purchase_order: result.rows[0]
        });
    } catch (error) {
        console.error('Submit PO error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/purchase-orders/:id/receive
 * Record received quantities for PO items
 */
app.post('/api/purchase-orders/:id/receive', async (req, res) => {
    try {
        const { id } = req.params;
        const { items } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'items array is required' });
        }

        await db.transaction(async (client) => {
            // Update received quantities
            for (const item of items) {
                await client.query(`
                    UPDATE purchase_order_items
                    SET received_quantity = $1
                    WHERE id = $2 AND purchase_order_id = $3
                `, [item.received_quantity, item.id, id]);

                // TODO: Update inventory_counts when items are received
                // This would require Square API write access
            }

            // Check if all items fully received
            const checkResult = await client.query(`
                SELECT
                    COUNT(*) as total,
                    COUNT(CASE WHEN received_quantity >= quantity_ordered THEN 1 END) as received
                FROM purchase_order_items
                WHERE purchase_order_id = $1
            `, [id]);

            const { total, received } = checkResult.rows[0];

            // Update PO status if all items received
            if (parseInt(total) === parseInt(received)) {
                await client.query(`
                    UPDATE purchase_orders
                    SET status = 'RECEIVED', actual_delivery_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [id]);
            } else {
                await client.query(`
                    UPDATE purchase_orders
                    SET status = 'PARTIAL', updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [id]);
            }
        });

        // Return updated PO
        const result = await db.query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
        res.json({
            status: 'success',
            purchase_order: result.rows[0]
        });
    } catch (error) {
        console.error('Receive PO error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== CSV EXPORT HELPERS ====================

/**
 * Escape a CSV field according to RFC 4180
 * - Wrap in quotes if contains comma, quote, or newline
 * - Escape internal quotes by doubling them
 */
function escapeCSVField(value) {
    if (value === null || value === undefined) {
        return '';
    }

    const str = String(value);

    // Check if field needs escaping
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        // Escape quotes by doubling them, then wrap in quotes
        return '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
}

/**
 * Format date for Square CSV (MM/DD/YYYY)
 */
function formatDateForSquare(isoDateString) {
    if (!isoDateString) {
        return '';
    }

    const date = new Date(isoDateString);
    const month = date.getMonth() + 1; // 0-indexed
    const day = date.getDate();
    const year = date.getFullYear();

    return `${month}/${day}/${year}`;
}

/**
 * Format money for Square CSV (always 2 decimal places)
 */
function formatMoney(cents) {
    if (cents === null || cents === undefined) {
        return '0.00';
    }
    return (cents / 100).toFixed(2);
}

/**
 * GET /api/purchase-orders/:po_number/export-csv
 * Export a purchase order in Square's CSV import format
 *
 * Square CSV Format:
 * - UTF-8 with BOM
 * - Metadata rows with 6 trailing commas
 * - Empty line separator
 * - Header row
 * - Data rows (11 fields, no trailing comma)
 * - Line endings: \r\n
 */
app.get('/api/purchase-orders/:po_number/export-csv', async (req, res) => {
    try {
        const { po_number } = req.params;

        // Get PO header with vendor and location info
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name,
                l.address as location_address
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id
            JOIN locations l ON po.location_id = l.id
            WHERE po.po_number = $1
        `, [po_number]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];

        // Get PO items with SKU and item names
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                i.name as item_name,
                v.name as variation_name
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            WHERE poi.purchase_order_id = $1
            ORDER BY i.name, v.name
        `, [po.id]);

        // Build CSV content
        const lines = [];

        // UTF-8 BOM
        const BOM = '\uFEFF';

        // Metadata rows with 6 trailing commas
        lines.push(`Vendor,${escapeCSVField(po.vendor_name)},,,,,,`);
        lines.push(`Location,${escapeCSVField(po.location_name)},,,,,,`);
        lines.push(`Expected Delivery Date,${formatDateForSquare(po.expected_delivery_date)},,,,,,`);

        // Empty line
        lines.push('');

        // Header row (11 fields, no trailing comma)
        lines.push('SKU,Item Name,Quantity,Cost,Note,Expected Delivery Date,Vendor,Location,Ship To,Deliver To,Carrier');

        // Data rows (11 fields, no trailing comma)
        for (const item of itemsResult.rows) {
            const itemName = item.variation_name
                ? `${item.item_name} - ${item.variation_name}`
                : item.item_name;

            const row = [
                escapeCSVField(item.sku || ''),
                escapeCSVField(itemName),
                item.quantity_ordered || 0,
                formatMoney(item.unit_cost_money),
                escapeCSVField(item.notes || ''),
                formatDateForSquare(po.expected_delivery_date),
                escapeCSVField(po.vendor_name),
                escapeCSVField(po.location_name),
                escapeCSVField(po.location_address || ''),
                escapeCSVField(po.location_address || ''),
                escapeCSVField('') // Carrier - empty for now
            ];

            lines.push(row.join(','));
        }

        // Join with \r\n line endings
        const csvContent = BOM + lines.join('\r\n') + '\r\n';

        // Set response headers
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);

        // Send CSV
        res.send(csvContent);

        logger.info('CSV export generated', {
            po_number: po.po_number,
            vendor: po.vendor_name,
            items: itemsResult.rows.length
        });

    } catch (error) {
        logger.error('CSV export error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// ==================== SERVER STARTUP ====================

async function startServer() {
    try {
        // Log system initialization
        logger.info('Logging system initialized', {
            logsDir: path.join(__dirname, 'logs'),
            maxSize: '20m',
            retention: '14 days (regular), 30 days (errors)',
            compression: 'enabled',
            emailEnabled: process.env.EMAIL_ENABLED === 'true'
        });

        // Test database connection
        const dbConnected = await db.testConnection();
        if (!dbConnected) {
            const dbError = new Error('Failed to connect to database. Check your .env configuration.');
            logger.error('Database connection failed', {
                error: dbError.message,
                dbName: process.env.DB_NAME,
                dbHost: process.env.DB_HOST
            });
            await emailNotifier.sendCritical('Database Connection Failed', dbError, {
                details: {
                    dbName: process.env.DB_NAME,
                    dbHost: process.env.DB_HOST,
                    dbPort: process.env.DB_PORT
                }
            });
            process.exit(1);
        }

        logger.info('Database connection successful');

        // Start server
        app.listen(PORT, () => {
            console.log('='.repeat(60));
            console.log('JTPets Inventory Management System');
            console.log('='.repeat(60));
            console.log(`Server running on port ${PORT}`);
            console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`Database: ${process.env.DB_NAME || 'jtpets_beta'}`);
            console.log('='.repeat(60));
            console.log('API Endpoints:');
            console.log('  GET  /api/health');
            console.log('  GET  /api/logs              (view recent logs)');
            console.log('  GET  /api/logs/errors       (view error logs)');
            console.log('  GET  /api/logs/stats        (log statistics)');
            console.log('  GET  /api/logs/download     (download logs)');
            console.log('  POST /api/test-email        (test email)');
            console.log('  POST /api/test-error        (test error logging)');
            console.log('  POST /api/sync              (force full sync)');
            console.log('  POST /api/sync-smart        (smart interval-based sync)');
            console.log('  POST /api/sync-sales        (sync all sales periods)');
            console.log('  GET  /api/sync-status       (view sync schedule status)');
            console.log('  GET  /api/sync-history      (view sync history)');
            console.log('  GET  /api/items');
            console.log('  GET  /api/variations');
            console.log('  GET  /api/variations-with-costs');
            console.log('  GET  /api/inventory');
            console.log('  GET  /api/low-stock');
            console.log('  GET  /api/vendors');
            console.log('  GET  /api/sales-velocity');
            console.log('  GET  /api/reorder-suggestions');
            console.log('  POST /api/purchase-orders');
            console.log('  GET  /api/purchase-orders');
            console.log('  GET  /api/purchase-orders/:id');
            console.log('='.repeat(60));

            logger.info('Server started successfully', {
                port: PORT,
                environment: process.env.NODE_ENV || 'development',
                nodeVersion: process.version
            });
        });

        // Monitor database connection errors
        db.pool.on('error', (err) => {
            logger.error('Database connection error', {
                error: err.message,
                stack: err.stack
            });
            emailNotifier.sendCritical('Database Connection Lost', err);
        });

    } catch (error) {
        logger.error('Failed to start server', {
            error: error.message,
            stack: error.stack
        });
        await emailNotifier.sendCritical('Server Startup Failed', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing server...');
    await db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, closing server...');
    await db.close();
    process.exit(0);
});

// Start the server
startServer();

module.exports = app;
