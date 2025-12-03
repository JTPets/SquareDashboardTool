/**
 * JTPets Inventory Management System - Main Server
 * Express API server with Square POS integration
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const cron = require('node-cron');
const db = require('./utils/database');
const squareApi = require('./utils/square-api');
const logger = require('./utils/logger');
const emailNotifier = require('./utils/email-notifier');
const { escapeCSVField, formatDateForSquare, formatMoney, formatGTIN, UTF8_BOM } = require('./utils/csv-helpers');

const app = express();
const PORT = process.env.PORT || 5001;

// AWS S3 Configuration for product images
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'items-images-production';
const AWS_S3_REGION = process.env.AWS_S3_REGION || 'us-west-2';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for database imports
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
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

/**
 * GET /api/config
 * Get frontend configuration from environment variables
 */
app.get('/api/config', (req, res) => {
    try {
        res.json({
            defaultSupplyDays: parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45'),
            reorderSafetyDays: parseInt(process.env.REORDER_SAFETY_DAYS || '7'),
            reorderPriorityThresholds: {
                urgent: parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0'),
                high: parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7'),
                medium: parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14'),
                low: parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30')
            }
        });
    } catch (error) {
        logger.error('Failed to get config', { error: error.message });
        res.status(500).json({ error: 'Failed to get configuration' });
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

/**
 * POST /api/test-backup-email
 * Test backup email functionality
 */
app.post('/api/test-backup-email', async (req, res) => {
    try {
        logger.info('Testing backup email');
        await runAutomatedBackup();
        res.json({ success: true, message: 'Test backup email sent successfully' });
    } catch (error) {
        logger.error('Test backup email failed', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Resolve image IDs to URLs with fallback support
 * @param {Array|null} variationImages - Array of image IDs from variation
 * @param {Array|null} itemImages - Array of image IDs from parent item (fallback)
 * @returns {Promise<Array>} Array of image URLs
 */
async function resolveImageUrls(variationImages, itemImages = null) {
    // Try variation images first, then fall back to item images
    let imageIds = variationImages;

    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
        imageIds = itemImages;
    }

    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
        return [];
    }

    try {
        // Query the images table to get URLs
        const placeholders = imageIds.map((_, i) => `$${i + 1}`).join(',');
        const result = await db.query(
            `SELECT id, url FROM images WHERE id IN (${placeholders}) AND url IS NOT NULL`,
            imageIds
        );

        // Create a map of id -> url
        const urlMap = {};
        result.rows.forEach(row => {
            if (row.url) {
                urlMap[row.id] = row.url;
            }
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
            logger.error('Failed to update sync history', { error: updateError.message });
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

/**
 * Run automated database backup and email it
 * This is used by the weekly backup cron job
 * @returns {Promise<void>}
 */
async function runAutomatedBackup() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    logger.info('Starting automated database backup');

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'jtpets_beta';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || '';

    // Find pg_dump command (handles Windows paths)
    const pgDumpCmd = process.platform === 'win32' ? findPgDumpOnWindows() : 'pg_dump';

    // Set PGPASSWORD environment variable for pg_dump
    const env = { ...process.env, PGPASSWORD: dbPassword };

    // Use pg_dump to create backup
    const command = `${pgDumpCmd} -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} --clean --if-exists --no-owner --no-privileges`;

    const { stdout, stderr } = await execAsync(command, {
        env,
        maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });

    if (stderr && !stderr.includes('NOTICE')) {
        logger.warn('Database backup warnings', { warnings: stderr });
    }

    // Get database info for the email
    const sizeResult = await db.query(`
        SELECT
            pg_database.datname as name,
            pg_size_pretty(pg_database_size(pg_database.datname)) as size
        FROM pg_database
        WHERE datname = $1
    `, [dbName]);

    const tablesResult = await db.query(`
        SELECT
            relname as tablename,
            n_live_tup as row_count
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC
    `);

    const dbInfo = {
        database: sizeResult.rows[0]?.name || dbName,
        size: sizeResult.rows[0]?.size || 'Unknown',
        tables: tablesResult.rows
    };

    // Email the backup
    await emailNotifier.sendBackup(stdout, dbInfo);

    logger.info('Automated database backup completed and emailed', {
        size_bytes: stdout.length,
        database: dbName
    });
}

/**
 * Run smart sync - intelligently syncs only data types whose interval has elapsed
 * This is the core function used by both the API endpoint and cron job
 * @returns {Promise<Object>} Sync result with status, synced types, and summary
 */
async function runSmartSync() {
    logger.info('Smart sync initiated');

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
                logger.info('No active locations found - forcing location sync');
            } else {
                logger.info('Syncing locations');
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
            logger.info('Syncing vendors');
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
            logger.info('Syncing catalog');
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
            logger.info('Syncing inventory');
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
            logger.info('Syncing 91-day sales velocity');
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
            logger.info('Syncing 182-day sales velocity');
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
            logger.info('Syncing 365-day sales velocity');
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
app.post('/api/sync', async (req, res) => {
    try {
        logger.info('Full sync requested');
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
        logger.error('Sync error', { error: error.message, stack: error.stack });
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
        logger.info('Sales velocity sync requested');
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
        logger.error('Sales sync error', { error: error.message, stack: error.stack });
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
        logger.info('Smart sync requested');
        const result = await runSmartSync();
        res.json(result);
    } catch (error) {
        logger.error('Smart sync error', { error: error.message, stack: error.stack });
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
        logger.error('Get sync history error', { error: error.message, stack: error.stack });
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
        logger.error('Get sync status error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== CATALOG ENDPOINTS ====================

/**
 * GET /api/categories
 * Get list of all distinct categories from items
 */
app.get('/api/categories', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT DISTINCT i.category_name
            FROM items i
            WHERE i.category_name IS NOT NULL
              AND i.category_name != ''
              AND COALESCE(i.is_deleted, FALSE) = FALSE
            ORDER BY i.category_name
        `);
        logger.info('API /api/categories returning', { count: result.rows.length });
        res.json(result.rows.map(row => row.category_name));
    } catch (error) {
        logger.error('Get categories error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

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
            SELECT v.*, i.name as item_name, i.category_name, i.images as item_images
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

        // Resolve image URLs for each variation (with item fallback)
        const variations = await Promise.all(result.rows.map(async (variation) => {
            const imageUrls = await resolveImageUrls(variation.images, variation.item_images);
            return {
                ...variation,
                item_images: undefined,  // Remove from response
                image_urls: imageUrls
            };
        }));

        res.json({
            count: variations.length,
            variations
        });
    } catch (error) {
        logger.error('Get variations error', { error: error.message, stack: error.stack });
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
                i.images as item_images,
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

        // Resolve image URLs for each variation (with item fallback)
        const variations = await Promise.all(result.rows.map(async (variation) => {
            const imageUrls = await resolveImageUrls(variation.images, variation.item_images);
            return {
                ...variation,
                item_images: undefined,  // Remove from response
                image_urls: imageUrls
            };
        }));

        res.json({
            count: variations.length,
            variations
        });
    } catch (error) {
        logger.error('Get variations with costs error', { error: error.message, stack: error.stack });
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
        logger.error('Update variation error', { error: error.message, stack: error.stack });
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
        logger.error('Bulk update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== EXPIRATION TRACKING ENDPOINTS ====================

/**
 * GET /api/expirations
 * Get variations with expiration data for expiration tracker
 */
app.get('/api/expirations', async (req, res) => {
    try {
        const { expiry, category } = req.query;

        let query = `
            SELECT
                v.id as identifier,
                i.name as name,
                v.name as variation,
                v.upc as gtin,
                v.price_money,
                v.currency,
                i.category_name,
                ve.expiration_date,
                ve.does_not_expire,
                COALESCE(SUM(ic.quantity), 0) as quantity,
                v.images,
                i.images as item_images
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK'
            WHERE COALESCE(v.is_deleted, FALSE) = FALSE
        `;
        const params = [];

        // Filter by category
        if (category) {
            params.push(`%${category}%`);
            query += ` AND i.category_name ILIKE $${params.length}`;
        }

        // Group by to aggregate inventory across locations
        query += `
            GROUP BY v.id, i.name, v.name, v.upc, v.price_money, v.currency,
                     i.category_name, ve.expiration_date, ve.does_not_expire, v.images, i.images
        `;

        // Filter by expiry timeframe (applied after grouping)
        if (expiry) {
            if (expiry === 'no-expiry') {
                query += ` HAVING ve.expiration_date IS NULL AND (ve.does_not_expire IS NULL OR ve.does_not_expire = FALSE)`;
            } else if (expiry === 'never-expires') {
                query += ` HAVING ve.does_not_expire = TRUE`;
            } else {
                const days = parseInt(expiry);
                if (!isNaN(days)) {
                    query += ` HAVING ve.expiration_date IS NOT NULL
                              AND ve.does_not_expire = FALSE
                              AND ve.expiration_date <= NOW() + INTERVAL '${days} days'
                              AND ve.expiration_date >= NOW()`;
                }
            }
        }

        query += ' ORDER BY ve.expiration_date ASC NULLS LAST, i.name, v.name';

        const result = await db.query(query, params);

        // Resolve image URLs (with item fallback)
        const items = await Promise.all(result.rows.map(async (row) => {
            const imageUrls = await resolveImageUrls(row.images, row.item_images);
            return {
                ...row,
                image_urls: imageUrls,
                images: undefined,  // Remove raw image IDs from response
                item_images: undefined  // Remove from response
            };
        }));

        logger.info('API /api/expirations returning', { count: items.length });

        res.json({
            count: items.length,
            items: items
        });

    } catch (error) {
        logger.error('Get expirations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message, items: [] });
    }
});

/**
 * POST /api/expirations
 * Save/update expiration data for variations
 */
app.post('/api/expirations', async (req, res) => {
    try {
        const changes = req.body;

        if (!Array.isArray(changes)) {
            return res.status(400).json({ error: 'Expected array of changes' });
        }

        let updatedCount = 0;

        for (const change of changes) {
            const { variation_id, expiration_date, does_not_expire } = change;

            if (!variation_id) {
                logger.warn('Skipping change - no variation_id', change);
                continue;
            }

            await db.query(`
                INSERT INTO variation_expiration (variation_id, expiration_date, does_not_expire, updated_at)
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                ON CONFLICT (variation_id)
                DO UPDATE SET
                    expiration_date = EXCLUDED.expiration_date,
                    does_not_expire = EXCLUDED.does_not_expire,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                variation_id,
                expiration_date || null,
                does_not_expire || false
            ]);

            updatedCount++;
        }

        logger.info('Updated expirations', { count: updatedCount });

        res.json({
            success: true,
            message: `Updated ${updatedCount} expiration record(s)`
        });

    } catch (error) {
        logger.error('Save expirations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to save expiration data', details: error.message });
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
                ic.catalog_object_id as variation_id,
                ic.quantity,
                ic.location_id,
                ic.updated_at,
                v.sku,
                v.name as variation_name,
                v.price_money,
                v.currency,
                v.stock_alert_min,
                v.stock_alert_max,
                v.case_pack_quantity,
                v.discontinued,
                v.images,
                i.id as item_id,
                i.name as item_name,
                i.category_name,
                i.images as item_images,
                l.name as location_name,
                -- Sales velocity data
                sv91.daily_avg_quantity,
                sv91.weekly_avg_quantity as weekly_avg_91d,
                sv182.weekly_avg_quantity as weekly_avg_182d,
                sv365.weekly_avg_quantity as weekly_avg_365d,
                -- Days until stockout calculation
                CASE
                    WHEN sv91.daily_avg_quantity > 0 AND COALESCE(ic.quantity, 0) > 0
                    THEN ROUND(COALESCE(ic.quantity, 0) / sv91.daily_avg_quantity, 1)
                    WHEN COALESCE(ic.quantity, 0) <= 0
                    THEN 0
                    ELSE 999
                END as days_until_stockout,
                -- Get primary vendor info
                (SELECT ve.name
                 FROM variation_vendors vv
                 JOIN vendors ve ON vv.vendor_id = ve.id
                 WHERE vv.variation_id = v.id
                 ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                 LIMIT 1
                ) as vendor_name,
                (SELECT vv.vendor_code
                 FROM variation_vendors vv
                 WHERE vv.variation_id = v.id
                 ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                 LIMIT 1
                ) as vendor_code,
                (SELECT vv.unit_cost_money
                 FROM variation_vendors vv
                 WHERE vv.variation_id = v.id
                 ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                 LIMIT 1
                ) as unit_cost_cents
            FROM inventory_counts ic
            JOIN variations v ON ic.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            JOIN locations l ON ic.location_id = l.id
            LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91
            LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182
            LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365
            WHERE ic.state = 'IN_STOCK'
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
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

        // Resolve image URLs using the same helper as reorder suggestions
        const inventoryWithImages = await Promise.all(result.rows.map(async (row) => {
            const imageUrls = await resolveImageUrls(row.images, row.item_images);
            return {
                ...row,
                image_urls: imageUrls,
                images: undefined,  // Remove raw image IDs from response
                item_images: undefined  // Remove from response
            };
        }));

        res.json({
            count: inventoryWithImages.length,
            inventory: inventoryWithImages
        });
    } catch (error) {
        logger.error('Get inventory error', { error: error.message, stack: error.stack });
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
                (v.stock_alert_min - ic.quantity) as units_below_min,
                v.images,
                i.images as item_images
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

        // Resolve image URLs (with item fallback)
        const items = await Promise.all(result.rows.map(async (row) => {
            const imageUrls = await resolveImageUrls(row.images, row.item_images);
            return {
                ...row,
                image_urls: imageUrls,
                images: undefined,  // Remove raw image IDs from response
                item_images: undefined  // Remove from response
            };
        }));

        res.json({
            count: items.length,
            low_stock_items: items
        });
    } catch (error) {
        logger.error('Get low stock error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/deleted-items
 * Get soft-deleted items for cleanup management
 */
app.get('/api/deleted-items', async (req, res) => {
    try {
        const { age_months } = req.query;

        let query = `
            SELECT
                v.id,
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                v.price_money,
                v.currency,
                i.category_name,
                v.deleted_at,
                v.is_deleted,
                COALESCE(SUM(ic.quantity), 0) as current_stock,
                DATE_PART('day', NOW() - v.deleted_at) as days_deleted,
                v.images,
                i.images as item_images
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK'
            WHERE v.is_deleted = TRUE
        `;
        const params = [];

        // Filter by age if specified
        if (age_months) {
            const months = parseInt(age_months);
            if (!isNaN(months) && months > 0) {
                query += ` AND v.deleted_at <= NOW() - INTERVAL '${months} months'`;
            }
        }

        query += `
            GROUP BY v.id, i.name, v.name, v.sku, v.price_money, v.currency,
                     i.category_name, v.deleted_at, v.is_deleted, v.images, i.images
            ORDER BY v.deleted_at DESC NULLS LAST, i.name, v.name
        `;

        const result = await db.query(query, params);

        // Resolve image URLs (with item fallback)
        const items = await Promise.all(result.rows.map(async (row) => {
            const imageUrls = await resolveImageUrls(row.images, row.item_images);
            return {
                ...row,
                image_urls: imageUrls,
                images: undefined,  // Remove raw image IDs from response
                item_images: undefined  // Remove from response
            };
        }));

        res.json({
            count: items.length,
            deleted_items: items
        });
    } catch (error) {
        logger.error('Get deleted items error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== CATALOG AUDIT ENDPOINTS ====================

/**
 * GET /api/catalog-audit
 * Get comprehensive catalog audit data - identifies items with missing/incomplete data
 */
app.get('/api/catalog-audit', async (req, res) => {
    try {
        const { location_id, issue_type } = req.query;

        // Build comprehensive audit query
        const query = `
            WITH variation_data AS (
                SELECT
                    v.id as variation_id,
                    v.sku,
                    v.upc,
                    v.name as variation_name,
                    v.price_money,
                    v.currency,
                    v.track_inventory,
                    v.inventory_alert_type,
                    v.inventory_alert_threshold,
                    v.stock_alert_min,
                    v.images as variation_images,
                    i.id as item_id,
                    i.name as item_name,
                    i.description,
                    i.category_id,
                    i.category_name,
                    i.taxable,
                    i.tax_ids,
                    i.visibility,
                    i.available_online,
                    i.available_for_pickup,
                    i.seo_title,
                    i.seo_description,
                    i.images as item_images,
                    -- Check for vendor assignment
                    (SELECT COUNT(*) FROM variation_vendors vv WHERE vv.variation_id = v.id) as vendor_count,
                    -- Get primary vendor info
                    (SELECT ve.name
                     FROM variation_vendors vv
                     JOIN vendors ve ON vv.vendor_id = ve.id
                     WHERE vv.variation_id = v.id
                     ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                     LIMIT 1
                    ) as vendor_name,
                    -- Get unit cost
                    (SELECT vv.unit_cost_money
                     FROM variation_vendors vv
                     WHERE vv.variation_id = v.id
                     ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                     LIMIT 1
                    ) as unit_cost_cents,
                    -- Get current stock (sum across all locations or specific location)
                    (SELECT COALESCE(SUM(ic.quantity), 0)
                     FROM inventory_counts ic
                     WHERE ic.catalog_object_id = v.id
                       AND ic.state = 'IN_STOCK'
                       ${location_id ? "AND ic.location_id = $1" : ""}
                    ) as current_stock,
                    -- Check if ANY location has a stock_alert_min set (for reorder threshold check)
                    (SELECT MAX(vls.stock_alert_min)
                     FROM variation_location_settings vls
                     WHERE vls.variation_id = v.id
                       AND vls.stock_alert_min IS NOT NULL
                       AND vls.stock_alert_min > 0
                    ) as location_stock_alert_min,
                    -- Sales velocity (all periods like reorder.html)
                    COALESCE(sv91.daily_avg_quantity, 0) as daily_velocity,
                    COALESCE(sv91.weekly_avg_quantity, 0) as weekly_avg_91d,
                    COALESCE(sv182.weekly_avg_quantity, 0) as weekly_avg_182d,
                    COALESCE(sv365.weekly_avg_quantity, 0) as weekly_avg_365d,
                    COALESCE(sv91.total_quantity_sold, 0) as total_sold_91d
                FROM variations v
                JOIN items i ON v.item_id = i.id
                LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91
                LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182
                LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365
                WHERE COALESCE(v.is_deleted, FALSE) = FALSE
                  AND COALESCE(i.is_deleted, FALSE) = FALSE
            )
            SELECT
                *,
                -- Calculate days of stock remaining
                CASE
                    WHEN daily_velocity > 0 AND current_stock > 0
                    THEN ROUND(current_stock / daily_velocity, 1)
                    ELSE NULL
                END as days_of_stock,
                -- Calculate audit flags (focused on actual data quality issues)
                (category_id IS NULL OR category_name IS NULL OR category_name = '') as missing_category,
                (taxable = FALSE OR taxable IS NULL) as not_taxable,
                (price_money IS NULL OR price_money = 0) as missing_price,
                (description IS NULL OR description = '') as missing_description,
                (item_images IS NULL OR item_images::text = '[]' OR item_images::text = 'null') as missing_item_image,
                (variation_images IS NULL OR variation_images::text = '[]' OR variation_images::text = 'null') as missing_variation_image,
                (sku IS NULL OR sku = '') as missing_sku,
                (upc IS NULL OR upc = '') as missing_upc,
                (track_inventory = FALSE OR track_inventory IS NULL) as stock_tracking_off,
                -- No reorder threshold: Out of stock AND no minimum threshold set anywhere
                -- Check: Square's inventory_alert, global stock_alert_min, OR location-specific stock_alert_min
                (
                    current_stock <= 0
                    AND (inventory_alert_type IS NULL OR inventory_alert_type != 'LOW_QUANTITY' OR inventory_alert_threshold IS NULL OR inventory_alert_threshold = 0)
                    AND (stock_alert_min IS NULL OR stock_alert_min = 0)
                    AND (location_stock_alert_min IS NULL)
                ) as no_reorder_threshold,
                (vendor_count = 0) as missing_vendor,
                (unit_cost_cents IS NULL AND UPPER(variation_name) NOT LIKE '%SAMPLE%') as missing_cost,  -- Excludes SAMPLE variations (samples are free)
                -- E-commerce settings (requires catalog re-sync for correct data)
                (visibility IS NULL OR visibility NOT IN ('PUBLIC', 'VISIBLE')) as not_visible_online,
                -- SEO fields
                (seo_title IS NULL OR seo_title = '') as missing_seo_title,
                (seo_description IS NULL OR seo_description = '') as missing_seo_description,
                -- Tax configuration
                (tax_ids IS NULL OR tax_ids::text = '[]' OR tax_ids::text = 'null') as no_tax_ids
            FROM variation_data
            ORDER BY item_name, variation_name
        `;

        const params = location_id ? [location_id] : [];
        const result = await db.query(query, params);

        // Calculate aggregate statistics
        const stats = {
            total_items: result.rows.length,
            missing_category: result.rows.filter(r => r.missing_category).length,
            not_taxable: result.rows.filter(r => r.not_taxable).length,
            missing_price: result.rows.filter(r => r.missing_price).length,
            missing_description: result.rows.filter(r => r.missing_description).length,
            missing_item_image: result.rows.filter(r => r.missing_item_image).length,
            missing_variation_image: result.rows.filter(r => r.missing_variation_image).length,
            missing_sku: result.rows.filter(r => r.missing_sku).length,
            missing_upc: result.rows.filter(r => r.missing_upc).length,
            stock_tracking_off: result.rows.filter(r => r.stock_tracking_off).length,
            no_reorder_threshold: result.rows.filter(r => r.no_reorder_threshold).length,
            missing_vendor: result.rows.filter(r => r.missing_vendor).length,
            missing_cost: result.rows.filter(r => r.missing_cost).length,
            not_visible_online: result.rows.filter(r => r.not_visible_online).length,
            missing_seo_title: result.rows.filter(r => r.missing_seo_title).length,
            missing_seo_description: result.rows.filter(r => r.missing_seo_description).length,
            no_tax_ids: result.rows.filter(r => r.no_tax_ids).length
        };

        // Count items with at least one issue (excluding e-commerce settings from "issues" count)
        stats.items_with_issues = result.rows.filter(r =>
            r.missing_category || r.not_taxable || r.missing_price ||
            r.missing_description || r.missing_item_image || r.missing_sku ||
            r.missing_upc || r.stock_tracking_off || r.no_reorder_threshold ||
            r.missing_vendor || r.missing_cost
        ).length;

        // Filter by specific issue type if requested
        let filteredData = result.rows;
        if (issue_type) {
            filteredData = result.rows.filter(r => r[issue_type] === true);
        }

        // Calculate issue count per item and resolve image URLs
        const itemsWithIssueCounts = await Promise.all(filteredData.map(async (row) => {
            let issueCount = 0;
            const issues = [];

            if (row.missing_category) { issueCount++; issues.push('No Category'); }
            if (row.not_taxable) { issueCount++; issues.push('Not Taxable'); }
            if (row.missing_price) { issueCount++; issues.push('No Price'); }
            if (row.missing_description) { issueCount++; issues.push('No Description'); }
            if (row.missing_item_image) { issueCount++; issues.push('No Image'); }
            if (row.missing_sku) { issueCount++; issues.push('No SKU'); }
            if (row.missing_upc) { issueCount++; issues.push('No UPC'); }
            if (row.stock_tracking_off) { issueCount++; issues.push('Low Stock Alerts Off'); }
            if (row.no_reorder_threshold) { issueCount++; issues.push('OOS, No Min'); }
            if (row.missing_vendor) { issueCount++; issues.push('No Vendor'); }
            if (row.missing_cost) { issueCount++; issues.push('No Cost'); }
            // E-commerce settings (informational, tracked separately)
            if (row.not_visible_online) { issues.push('Not Visible Online'); }
            // SEO fields
            if (row.missing_seo_title) { issues.push('No SEO Title'); }
            if (row.missing_seo_description) { issues.push('No SEO Description'); }
            // Tax configuration
            if (row.no_tax_ids) { issues.push('No Tax IDs'); }

            // Resolve image URLs BEFORE cleaning up the fields
            // Note: JSONB columns are already parsed by pg driver, no JSON.parse needed
            const imageUrls = await resolveImageUrls(
                row.variation_images,
                row.item_images
            );

            return {
                ...row,
                issue_count: issueCount,
                issues: issues,
                image_urls: imageUrls,
                // Clean up internal fields AFTER using them
                variation_images: undefined,
                item_images: undefined
            };
        }));

        res.json({
            stats: stats,
            count: itemsWithIssueCounts.length,
            items: itemsWithIssueCounts
        });

    } catch (error) {
        logger.error('Catalog audit error', { error: error.message, stack: error.stack });
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
        logger.error('Get vendors error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== VENDOR CATALOG IMPORT ====================

const vendorCatalog = require('./utils/vendor-catalog');

/**
 * POST /api/vendor-catalog/import
 * Import vendor catalog from CSV or XLSX file
 * Expects multipart form data with 'file' field or JSON body with 'data' and 'fileType'
 */
app.post('/api/vendor-catalog/import', async (req, res) => {
    try {
        const { data, fileType, fileName, defaultVendorName } = req.body;

        if (!data) {
            return res.status(400).json({
                error: 'Missing file data',
                message: 'Please provide file data in the request body'
            });
        }

        // Determine file type from fileName if not explicitly provided
        let type = fileType;
        if (!type && fileName) {
            type = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
        }
        if (!type) {
            type = 'csv'; // Default to CSV
        }

        // Convert base64 to buffer for XLSX, or use string directly for CSV
        let fileData;
        if (type === 'xlsx') {
            fileData = Buffer.from(data, 'base64');
        } else {
            // For CSV, data might be base64 or plain text
            try {
                fileData = Buffer.from(data, 'base64').toString('utf-8');
            } catch {
                fileData = data;
            }
        }

        const result = await vendorCatalog.importVendorCatalog(fileData, type, {
            defaultVendorName: defaultVendorName || null
        });

        if (result.success) {
            res.json({
                success: true,
                message: `Imported ${result.stats.imported} items from vendor catalog`,
                batchId: result.batchId,
                stats: result.stats,
                validationErrors: result.validationErrors,
                fieldMap: result.fieldMap,
                duration: result.duration
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error,
                batchId: result.batchId,
                validationErrors: result.validationErrors
            });
        }
    } catch (error) {
        logger.error('Vendor catalog import error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/preview
 * Preview file contents and get auto-detected column mappings
 */
app.post('/api/vendor-catalog/preview', async (req, res) => {
    try {
        const { data, fileType, fileName } = req.body;

        if (!data) {
            return res.status(400).json({
                error: 'Missing file data',
                message: 'Please provide file data in the request body'
            });
        }

        // Determine file type
        let type = fileType;
        if (!type && fileName) {
            type = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
        }
        if (!type) {
            type = 'csv';
        }

        // Convert base64 to buffer for XLSX, or use string for CSV
        let fileData;
        if (type === 'xlsx') {
            fileData = Buffer.from(data, 'base64');
        } else {
            try {
                fileData = Buffer.from(data, 'base64').toString('utf-8');
            } catch {
                fileData = data;
            }
        }

        const preview = await vendorCatalog.previewFile(fileData, type);

        // Transform response for frontend compatibility
        const columns = preview.columns.map(c => c.originalHeader);
        const autoMappings = {};
        const sampleValues = {};

        preview.columns.forEach(c => {
            autoMappings[c.originalHeader] = c.suggestedMapping;
            sampleValues[c.originalHeader] = c.sampleValues;
        });

        res.json({
            success: true,
            totalRows: preview.totalRows,
            columns,
            autoMappings,
            sampleValues,
            fieldTypes: preview.fieldTypes
        });

    } catch (error) {
        logger.error('Vendor catalog preview error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/import-mapped
 * Import vendor catalog with explicit column mappings
 * Requires: vendorId (selected vendor), columnMappings
 * Optional: importName (catalog name like "ABC Corp 2025 Price List")
 */
app.post('/api/vendor-catalog/import-mapped', async (req, res) => {
    try {
        const { data, fileType, fileName, columnMappings, vendorId, vendorName, importName } = req.body;

        if (!data) {
            return res.status(400).json({
                error: 'Missing file data',
                message: 'Please provide file data in the request body'
            });
        }

        if (!vendorId) {
            return res.status(400).json({
                error: 'Missing vendor',
                message: 'Please select a vendor for this import'
            });
        }

        // Determine file type
        let type = fileType;
        if (!type && fileName) {
            type = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
        }
        if (!type) {
            type = 'csv';
        }

        // Convert base64 to buffer for XLSX, or use string for CSV
        let fileData;
        if (type === 'xlsx') {
            fileData = Buffer.from(data, 'base64');
        } else {
            try {
                fileData = Buffer.from(data, 'base64').toString('utf-8');
            } catch {
                fileData = data;
            }
        }

        const result = await vendorCatalog.importWithMappings(fileData, type, {
            columnMappings: columnMappings || {},
            vendorId,
            vendorName: vendorName || 'Unknown Vendor',
            importName: importName || null
        });

        if (result.success) {
            res.json({
                success: true,
                message: `Imported ${result.stats.imported} items from vendor catalog`,
                batchId: result.batchId,
                stats: result.stats,
                validationErrors: result.validationErrors,
                fieldMap: result.fieldMap,
                duration: result.duration,
                importName: result.importName,
                vendorName: result.vendorName
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error,
                batchId: result.batchId,
                validationErrors: result.validationErrors,
                fieldMap: result.fieldMap
            });
        }
    } catch (error) {
        logger.error('Vendor catalog import-mapped error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/field-types
 * Get supported field types for column mapping
 */
app.get('/api/vendor-catalog/field-types', (req, res) => {
    res.json({ fieldTypes: vendorCatalog.FIELD_TYPES });
});

/**
 * GET /api/vendor-catalog
 * Search and list vendor catalog items
 */
app.get('/api/vendor-catalog', async (req, res) => {
    try {
        const { vendor_id, vendor_name, upc, search, matched_only, limit, offset } = req.query;

        const items = await vendorCatalog.searchVendorCatalog({
            vendorId: vendor_id,
            vendorName: vendor_name,
            upc,
            search,
            matchedOnly: matched_only === 'true',
            limit: parseInt(limit) || 100,
            offset: parseInt(offset) || 0
        });

        res.json({
            count: items.length,
            items
        });
    } catch (error) {
        logger.error('Vendor catalog search error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/lookup/:upc
 * Quick lookup by UPC - returns all vendor items matching UPC
 */
app.get('/api/vendor-catalog/lookup/:upc', async (req, res) => {
    try {
        const { upc } = req.params;

        if (!upc) {
            return res.status(400).json({ error: 'UPC is required' });
        }

        const items = await vendorCatalog.lookupByUPC(upc);

        // Also look up our catalog item by UPC
        const ourItem = await db.query(`
            SELECT
                v.id, v.sku, v.name as variation_name, v.upc, v.price_money,
                i.name as item_name, i.category_name,
                vv.unit_cost_money as current_cost_cents,
                vv.vendor_id as current_vendor_id
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id
            WHERE v.upc = $1
              AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
            LIMIT 1
        `, [upc]);

        res.json({
            upc,
            vendorItems: items,
            ourCatalogItem: ourItem.rows[0] || null
        });
    } catch (error) {
        logger.error('Vendor catalog lookup error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/batches
 * List import batches with summary stats
 * Query params: include_archived=true to include archived imports
 */
app.get('/api/vendor-catalog/batches', async (req, res) => {
    try {
        const { include_archived } = req.query;
        const batches = await vendorCatalog.getImportBatches({
            includeArchived: include_archived === 'true'
        });
        res.json({
            count: batches.length,
            batches
        });
    } catch (error) {
        logger.error('Get vendor catalog batches error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/batches/:batchId/archive
 * Archive an import batch (soft delete - keeps for searches)
 */
app.post('/api/vendor-catalog/batches/:batchId/archive', async (req, res) => {
    try {
        const { batchId } = req.params;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const archivedCount = await vendorCatalog.archiveImportBatch(batchId);
        res.json({
            success: true,
            message: `Archived ${archivedCount} items from batch ${batchId}`,
            archivedCount
        });
    } catch (error) {
        logger.error('Archive vendor catalog batch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/batches/:batchId/unarchive
 * Unarchive an import batch
 */
app.post('/api/vendor-catalog/batches/:batchId/unarchive', async (req, res) => {
    try {
        const { batchId } = req.params;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const unarchivedCount = await vendorCatalog.unarchiveImportBatch(batchId);
        res.json({
            success: true,
            message: `Unarchived ${unarchivedCount} items from batch ${batchId}`,
            unarchivedCount
        });
    } catch (error) {
        logger.error('Unarchive vendor catalog batch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/vendor-catalog/batches/:batchId
 * Permanently delete an import batch
 */
app.delete('/api/vendor-catalog/batches/:batchId', async (req, res) => {
    try {
        const { batchId } = req.params;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const deletedCount = await vendorCatalog.deleteImportBatch(batchId);
        res.json({
            success: true,
            message: `Permanently deleted ${deletedCount} items from batch ${batchId}`,
            deletedCount
        });
    } catch (error) {
        logger.error('Delete vendor catalog batch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/stats
 * Get vendor catalog statistics
 */
app.get('/api/vendor-catalog/stats', async (req, res) => {
    try {
        const stats = await vendorCatalog.getStats();
        res.json(stats);
    } catch (error) {
        logger.error('Get vendor catalog stats error', { error: error.message, stack: error.stack });
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
        logger.error('Get locations error', { error: error.message, stack: error.stack });
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
                i.category_name,
                l.name as location_name
            FROM sales_velocity sv
            JOIN variations v ON sv.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            JOIN locations l ON sv.location_id = l.id
            WHERE COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
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
        logger.error('Get sales velocity error', { error: error.message, stack: error.stack });
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
                i.images as item_images,
                i.category_name,
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
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
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
                const stockAlertMax = row.stock_alert_max ? parseInt(row.stock_alert_max) : null;  // Keep null as null for infinity
                const locationId = row.location_id || null;
                const locationName = row.location_name || null;
                const leadTime = parseInt(row.lead_time_days) || 7;
                const daysUntilStockout = parseFloat(row.days_until_stockout) || 999;

                // Don't suggest if already above max (null = unlimited, so skip this check)
                if (stockAlertMax !== null && currentStock >= stockAlertMax) {
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
                        targetQty = 1; // Default minimum order of 1 unit
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
                // If stockAlertMax is null (unlimited), don't cap the quantity
                const finalQty = stockAlertMax !== null
                    ? Math.ceil(Math.min(suggestedQty, stockAlertMax - currentStock))
                    : Math.ceil(suggestedQty);

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
                    images: row.images,  // Include images for URL resolution
                    item_images: row.item_images  // Include item images for fallback
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

        // Resolve image URLs for each suggestion (with item fallback)
        const suggestionsWithImages = await Promise.all(filteredSuggestions.map(async (suggestion) => {
            const imageUrls = await resolveImageUrls(suggestion.images, suggestion.item_images);
            return {
                ...suggestion,
                image_urls: imageUrls,
                images: undefined,  // Remove raw image IDs from response
                item_images: undefined  // Remove from response
            };
        }));

        res.json({
            count: suggestionsWithImages.length,
            supply_days: supplyDaysNum,
            safety_days: safetyDays,
            suggestions: suggestionsWithImages
        });
    } catch (error) {
        logger.error('Get reorder suggestions error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== CYCLE COUNT BATCH GENERATION ====================

/**
 * Generate daily cycle count batch
 * This function:
 * 1. Adds 30 NEW items every day (or DAILY_COUNT_TARGET)
 * 2. Uncompleted items from previous batches remain in queue
 * 3. Ensures backlog grows if days are skipped to stay on 30/day target
 */
async function generateDailyBatch() {
    try {
        logger.info('Starting daily cycle count batch generation');
        const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');

        // Create today's session
        await db.query(
            `INSERT INTO count_sessions (session_date, items_expected)
             VALUES (CURRENT_DATE, $1)
             ON CONFLICT (session_date) DO NOTHING`,
            [dailyTarget]
        );

        // STEP 1: Auto-add recent inaccurate counts to priority queue for verification
        // This helps identify if discrepancies were one-off miscounts or real inventory issues
        // Looks back 7 days to catch items missed due to skipped cron jobs
        const recentInaccurateQuery = `
            SELECT DISTINCT ch.catalog_object_id, v.sku, i.name as item_name,
                   DATE(ch.last_counted_date) as count_date
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN count_queue_priority cqp ON ch.catalog_object_id = cqp.catalog_object_id AND cqp.completed = FALSE
            WHERE ch.is_accurate = FALSE
              AND ch.last_counted_date >= CURRENT_DATE - INTERVAL '7 days'
              AND ch.last_counted_date < CURRENT_DATE
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqp.id IS NULL
              AND NOT EXISTS (
                -- Only add if there's no more recent count after the inaccurate one
                SELECT 1 FROM count_history ch2
                WHERE ch2.catalog_object_id = ch.catalog_object_id
                  AND ch2.last_counted_date > ch.last_counted_date
              )
        `;

        const recentInaccurate = await db.query(recentInaccurateQuery);
        const recentInaccurateCount = recentInaccurate.rows.length;

        if (recentInaccurateCount > 0) {
            logger.info(`Found ${recentInaccurateCount} inaccurate counts from the past 7 days to recount`);

            // Add to priority queue for today (only if not already in queue)
            const priorityInserts = recentInaccurate.rows.map(item => {
                const daysAgo = item.count_date ? Math.floor((Date.now() - new Date(item.count_date)) / (1000 * 60 * 60 * 24)) : 1;
                const timeRef = daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
                return db.query(
                    `INSERT INTO count_queue_priority (catalog_object_id, notes, added_by, added_date)
                     SELECT $1, $2, 'System', CURRENT_TIMESTAMP
                     WHERE NOT EXISTS (
                         SELECT 1 FROM count_queue_priority
                         WHERE catalog_object_id = $1 AND completed = FALSE
                     )`,
                    [item.catalog_object_id, `Recount - Inaccurate ${timeRef} (${item.sku})`]
                );
            });

            await Promise.all(priorityInserts);
            logger.info(`Added ${recentInaccurateCount} items from recent inaccurate counts to priority queue`);
        } else {
            logger.info('No recent inaccurate counts to recount');
        }

        // Count uncompleted items from previous batches (for reporting)
        const uncompletedResult = await db.query(`
            SELECT COUNT(DISTINCT catalog_object_id) as count
            FROM count_queue_daily
            WHERE completed = FALSE
        `);
        const uncompletedCount = parseInt(uncompletedResult.rows[0]?.count || 0);

        logger.info(`Found ${uncompletedCount} uncompleted items from previous batches`);

        // ALWAYS add the full daily target (30 items) regardless of backlog
        // This ensures we add 30 new items every day, and backlog accumulates
        const itemsToAdd = dailyTarget;

        // Get items to add (oldest count dates first, excluding already queued items)
        // Priority: Never counted > Oldest counted > Alphabetically
        const newItemsQuery = `
            SELECT v.id
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id
            LEFT JOIN count_queue_daily cqd ON v.id = cqd.catalog_object_id AND cqd.completed = FALSE
            LEFT JOIN count_queue_priority cqp ON v.id = cqp.catalog_object_id AND cqp.completed = FALSE
            WHERE COALESCE(v.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqd.id IS NULL
              AND cqp.id IS NULL
            ORDER BY ch.last_counted_date ASC NULLS FIRST, i.name, v.name
            LIMIT $1
        `;

        const newItems = await db.query(newItemsQuery, [itemsToAdd]);

        if (newItems.rows.length === 0) {
            logger.info('No new items available to add to batch');
            return {
                success: true,
                uncompleted: uncompletedCount,
                new_items_added: 0,
                yesterday_inaccurate_added: recentInaccurateCount,
                total_in_batch: uncompletedCount
            };
        }

        // Insert new items into daily batch queue
        const insertPromises = newItems.rows.map(item =>
            db.query(
                `INSERT INTO count_queue_daily (catalog_object_id, batch_date, notes)
                 VALUES ($1, CURRENT_DATE, 'Auto-generated daily batch')
                 ON CONFLICT (catalog_object_id, batch_date) DO NOTHING`,
                [item.id]
            )
        );

        await Promise.all(insertPromises);

        logger.info(`Successfully added ${newItems.rows.length} new items to daily batch`);

        return {
            success: true,
            uncompleted: uncompletedCount,
            new_items_added: newItems.rows.length,
            yesterday_inaccurate_added: recentInaccurateCount,
            total_in_batch: uncompletedCount + newItems.rows.length
        };

    } catch (error) {
        logger.error('Daily batch generation failed', { error: error.message });
        throw error;
    }
}

// ==================== CYCLE COUNT HELPERS ====================

/**
 * Send cycle count completion report email
 * Includes accuracy tracking and variance data
 */
async function sendCycleCountReport() {
    try {
        const emailEnabled = process.env.EMAIL_ENABLED === 'true';
        const reportEnabled = process.env.CYCLE_COUNT_REPORT_EMAIL === 'true';

        if (!emailEnabled || !reportEnabled) {
            logger.info('Email reporting disabled in configuration');
            return { sent: false, reason: 'Email reporting disabled' };
        }

        // Get today's session data
        const sessionQuery = `
            SELECT
                session_date,
                items_expected,
                items_completed,
                completion_rate
            FROM count_sessions
            WHERE session_date = CURRENT_DATE
        `;

        const session = await db.query(sessionQuery);

        if (session.rows.length === 0) {
            logger.warn('No session data for today - cannot send report');
            return { sent: false, reason: 'No session data' };
        }

        const sessionData = session.rows[0];

        // Get items counted today with accuracy data
        const itemsQuery = `
            SELECT
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                ch.last_counted_date,
                ch.counted_by,
                ch.is_accurate,
                ch.actual_quantity,
                ch.expected_quantity,
                ch.variance,
                ch.notes
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            WHERE DATE(ch.last_counted_date) = CURRENT_DATE
            ORDER BY ch.is_accurate ASC NULLS LAST, ABS(COALESCE(ch.variance, 0)) DESC, ch.last_counted_date DESC
        `;

        const items = await db.query(itemsQuery);

        // Calculate accuracy statistics
        const accurateCount = items.rows.filter(item => item.is_accurate === true).length;
        const inaccurateCount = items.rows.filter(item => item.is_accurate === false).length;
        const totalWithData = accurateCount + inaccurateCount;
        const accuracyRate = totalWithData > 0 ? ((accurateCount / totalWithData) * 100).toFixed(1) : 'N/A';

        // Calculate total variance
        const totalVariance = items.rows.reduce((sum, item) => sum + Math.abs(item.variance || 0), 0);

        // Build email content with accuracy data
        const emailSubject = `Cycle Count Report - ${sessionData.session_date} ${sessionData.completion_rate >= 100 ? '✅ COMPLETE' : ''}`;
        const emailBody = `
            <h2>Daily Cycle Count Report</h2>
            <p><strong>Date:</strong> ${sessionData.session_date}</p>
            <p><strong>Status:</strong> ${sessionData.completion_rate >= 100 ? '✅ 100% COMPLETE' : '⏳ In Progress'}</p>

            <h3>Summary</h3>
            <table border="1" cellpadding="8" style="border-collapse: collapse; margin-bottom: 20px;">
                <tr>
                    <td><strong>Items Expected:</strong></td>
                    <td>${sessionData.items_expected}</td>
                </tr>
                <tr>
                    <td><strong>Items Completed:</strong></td>
                    <td>${sessionData.items_completed}</td>
                </tr>
                <tr>
                    <td><strong>Completion Rate:</strong></td>
                    <td>${sessionData.completion_rate}%</td>
                </tr>
                <tr>
                    <td><strong>Accuracy Rate:</strong></td>
                    <td>${accuracyRate}% (${accurateCount}/${totalWithData} accurate)</td>
                </tr>
                <tr style="background-color: ${inaccurateCount > 0 ? '#fff3cd' : '#d4edda'};">
                    <td><strong>Discrepancies Found:</strong></td>
                    <td>${inaccurateCount} items</td>
                </tr>
                <tr>
                    <td><strong>Total Variance:</strong></td>
                    <td>${totalVariance} units</td>
                </tr>
            </table>

            ${inaccurateCount > 0 ? `
                <h3>⚠️ Discrepancies (${inaccurateCount} items)</h3>
                <table border="1" cellpadding="5" style="border-collapse: collapse; margin-bottom: 20px; background-color: #fff3cd;">
                    <thead>
                        <tr style="background-color: #ffc107; color: #000;">
                            <th>SKU</th>
                            <th>Product</th>
                            <th>Expected</th>
                            <th>Actual</th>
                            <th>Variance</th>
                            <th>Notes</th>
                            <th>Counted By</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.rows.filter(item => item.is_accurate === false).map(item => `
                            <tr>
                                <td>${item.sku || 'N/A'}</td>
                                <td>${item.item_name}${item.variation_name ? ' - ' + item.variation_name : ''}</td>
                                <td>${item.expected_quantity !== null ? item.expected_quantity : 'N/A'}</td>
                                <td><strong>${item.actual_quantity !== null ? item.actual_quantity : 'N/A'}</strong></td>
                                <td style="color: ${item.variance > 0 ? '#28a745' : '#dc3545'}; font-weight: bold;">
                                    ${item.variance !== null ? (item.variance > 0 ? '+' : '') + item.variance : 'N/A'}
                                </td>
                                <td>${item.notes || '-'}</td>
                                <td>${item.counted_by || 'System'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : ''}

            <h3>All Items Counted Today (${items.rows.length})</h3>
            <table border="1" cellpadding="5" style="border-collapse: collapse;">
                <thead>
                    <tr>
                        <th>SKU</th>
                        <th>Product</th>
                        <th>Status</th>
                        <th>Expected</th>
                        <th>Actual</th>
                        <th>Variance</th>
                        <th>Counted By</th>
                        <th>Time</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.rows.map(item => {
                        const rowColor = item.is_accurate === false ? '#fff3cd' :
                                       item.is_accurate === true ? '#d4edda' : '#ffffff';
                        return `
                        <tr style="background-color: ${rowColor};">
                            <td>${item.sku || 'N/A'}</td>
                            <td>${item.item_name}${item.variation_name ? ' - ' + item.variation_name : ''}</td>
                            <td>${item.is_accurate === true ? '✅ Accurate' :
                                  item.is_accurate === false ? '⚠️ Discrepancy' : '-'}</td>
                            <td>${item.expected_quantity !== null ? item.expected_quantity : '-'}</td>
                            <td>${item.actual_quantity !== null ? item.actual_quantity : '-'}</td>
                            <td style="color: ${item.variance > 0 ? '#28a745' : item.variance < 0 ? '#dc3545' : '#000'};">
                                ${item.variance !== null ? (item.variance > 0 ? '+' : '') + item.variance : '-'}
                            </td>
                            <td>${item.counted_by || 'System'}</td>
                            <td>${new Date(item.last_counted_date).toLocaleTimeString()}</td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>

            <p style="margin-top: 20px; font-size: 12px; color: #666;">
                <em>This report was generated automatically by the JTPets Inventory Management System.</em>
            </p>
        `;

        // Send email using existing email notifier
        await emailNotifier.sendAlert(emailSubject, emailBody);
        logger.info('Cycle count report email sent successfully');

        // Send to additional email if configured
        const additionalEmail = process.env.ADDITIONAL_CYCLE_COUNT_REPORT_EMAIL;
        if (additionalEmail && additionalEmail.trim()) {
            try {
                // Temporarily override EMAIL_TO for the additional recipient
                const originalEmailTo = process.env.EMAIL_TO;
                process.env.EMAIL_TO = additionalEmail.trim();

                await emailNotifier.sendAlert(emailSubject, emailBody);
                logger.info('Cycle count report sent to additional email', { email: additionalEmail });

                // Restore original EMAIL_TO
                process.env.EMAIL_TO = originalEmailTo;
            } catch (error) {
                logger.error('Failed to send cycle count report to additional email', {
                    email: additionalEmail,
                    error: error.message
                });
                // Don't throw - main email was sent successfully
            }
        }

        return { sent: true, items_count: items.rows.length, accuracy_rate: accuracyRate };

    } catch (error) {
        logger.error('Send cycle count report failed', { error: error.message });
        throw error;
    }
}

// ==================== CYCLE COUNT ENDPOINTS ====================

/**
 * GET /api/cycle-counts/pending
 * Get pending items for cycle counting from daily batch queue
 * Returns accumulated uncounted items (priority + daily batch)
 */
app.get('/api/cycle-counts/pending', async (req, res) => {
    try {
        const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');

        // Get today's session or create it
        await db.query(
            `INSERT INTO count_sessions (session_date, items_expected)
             VALUES (CURRENT_DATE, $1)
             ON CONFLICT (session_date) DO NOTHING`,
            [dailyTarget]
        );

        // First, get priority queue items (Send Now items)
        const priorityQuery = `
            SELECT DISTINCT
                v.*,
                i.name as item_name,
                i.category_name,
                i.images as item_images,
                COALESCE(SUM(ic.quantity), 0) as current_inventory,
                TRUE as is_priority,
                ch.last_counted_date,
                ch.counted_by,
                cqp.added_date as priority_added_date,
                cqp.notes as priority_notes
            FROM count_queue_priority cqp
            JOIN variations v ON cqp.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK'
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id
            WHERE cqp.completed = FALSE
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
            GROUP BY v.id, i.name, i.category_name, i.images, ch.last_counted_date, ch.counted_by,
                     cqp.added_date, cqp.notes
            ORDER BY cqp.added_date ASC
        `;

        const priorityItems = await db.query(priorityQuery);
        const priorityCount = priorityItems.rows.length;

        // Get items from daily batch queue that haven't been completed
        const dailyBatchQuery = `
            SELECT DISTINCT
                v.*,
                i.name as item_name,
                i.category_name,
                i.images as item_images,
                COALESCE(SUM(ic.quantity), 0) as current_inventory,
                FALSE as is_priority,
                ch.last_counted_date,
                ch.counted_by,
                cqd.batch_date,
                cqd.added_date as batch_added_date
            FROM count_queue_daily cqd
            JOIN variations v ON cqd.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK'
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id
            LEFT JOIN count_queue_priority cqp ON v.id = cqp.catalog_object_id AND cqp.completed = FALSE
            WHERE cqd.completed = FALSE
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqp.id IS NULL
            GROUP BY v.id, i.name, i.category_name, i.images, ch.last_counted_date, ch.counted_by,
                     cqd.batch_date, cqd.added_date
            ORDER BY cqd.batch_date ASC, cqd.added_date ASC
        `;

        const dailyBatchItems = await db.query(dailyBatchQuery);

        // Combine priority and daily batch items
        const allItems = [...priorityItems.rows, ...dailyBatchItems.rows];

        // Resolve image URLs for all items and ensure proper field mapping
        const itemsWithImages = await Promise.all(allItems.map(async (item) => {
            const imageUrls = await resolveImageUrls(item.images, item.item_images);

            return {
                ...item,
                variation_name: item.name, // Explicitly map variation name (v.name -> variation_name)
                image_urls: imageUrls,
                images: undefined,
                item_images: undefined,
                name: undefined // Remove to avoid confusion with item_name
            };
        }));

        // Filter out items without valid IDs and log them
        const validItems = itemsWithImages.filter(item => {
            if (!item.id) {
                logger.warn('Excluding item without valid ID from cycle count', {
                    item_name: item.item_name,
                    sku: item.sku,
                    variation_name: item.variation_name,
                    is_priority: item.is_priority
                });
                return false;
            }
            return true;
        });

        if (validItems.length < itemsWithImages.length) {
            logger.error(`Filtered out ${itemsWithImages.length - validItems.length} items without IDs from cycle count queue`);
        }

        res.json({
            count: validItems.length,
            target: dailyTarget,
            priority_count: priorityCount,
            daily_batch_count: dailyBatchItems.rows.length,
            items: validItems
        });

    } catch (error) {
        logger.error('Get pending cycle counts error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/:id/complete
 * Mark an item as counted with accuracy tracking
 */
app.post('/api/cycle-counts/:id/complete', async (req, res) => {
    try {
        const { id } = req.params;
        const { counted_by, is_accurate, actual_quantity, expected_quantity, notes } = req.body;

        // Validate catalog_object_id
        if (!id || id === 'null' || id === 'undefined') {
            logger.error('Invalid catalog_object_id received', { id, body: req.body });
            return res.status(400).json({
                error: 'Invalid item ID. Please refresh the page and try again.'
            });
        }

        // Calculate variance if quantities provided
        let variance = null;
        if (actual_quantity !== null && actual_quantity !== undefined &&
            expected_quantity !== null && expected_quantity !== undefined) {
            variance = actual_quantity - expected_quantity;
        }

        // Insert or update count history with accuracy data
        await db.query(
            `INSERT INTO count_history (
                catalog_object_id, last_counted_date, counted_by,
                is_accurate, actual_quantity, expected_quantity, variance, notes
             )
             VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (catalog_object_id)
             DO UPDATE SET
                last_counted_date = CURRENT_TIMESTAMP,
                counted_by = EXCLUDED.counted_by,
                is_accurate = EXCLUDED.is_accurate,
                actual_quantity = EXCLUDED.actual_quantity,
                expected_quantity = EXCLUDED.expected_quantity,
                variance = EXCLUDED.variance,
                notes = EXCLUDED.notes`,
            [id, counted_by || 'System', is_accurate, actual_quantity, expected_quantity, variance, notes]
        );

        // Mark priority item as completed if it exists
        await db.query(
            `UPDATE count_queue_priority
             SET completed = TRUE, completed_date = CURRENT_TIMESTAMP
             WHERE catalog_object_id = $1 AND completed = FALSE`,
            [id]
        );

        // Mark daily batch item as completed if it exists
        await db.query(
            `UPDATE count_queue_daily
             SET completed = TRUE, completed_date = CURRENT_TIMESTAMP
             WHERE catalog_object_id = $1 AND completed = FALSE`,
            [id]
        );

        // Update session completed count
        await db.query(
            `UPDATE count_sessions
             SET items_completed = items_completed + 1,
                 completion_rate = (items_completed + 1)::DECIMAL / items_expected * 100
             WHERE session_date = CURRENT_DATE`
        );

        // Check if we've reached 100% completion for today
        const completionCheck = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE completed = FALSE) as pending_count,
                COUNT(*) as total_count
            FROM (
                SELECT catalog_object_id, completed FROM count_queue_daily WHERE batch_date <= CURRENT_DATE
                UNION
                SELECT catalog_object_id, completed FROM count_queue_priority
            ) combined
        `);

        const pendingCount = parseInt(completionCheck.rows[0]?.pending_count || 0);
        const isFullyComplete = pendingCount === 0 && completionCheck.rows[0]?.total_count > 0;

        // If 100% complete, automatically send the report email
        if (isFullyComplete) {
            logger.info('Cycle count 100% complete - triggering automatic email report');

            // Trigger email report asynchronously (don't wait for it)
            sendCycleCountReport().catch(error => {
                logger.error('Auto email report failed', { error: error.message });
            });
        }

        res.json({
            success: true,
            catalog_object_id: id,
            is_complete: isFullyComplete,
            pending_count: pendingCount
        });

    } catch (error) {
        logger.error('Complete cycle count error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/send-now
 * Add item(s) to priority queue
 */
app.post('/api/cycle-counts/send-now', async (req, res) => {
    try {
        const { skus, added_by, notes } = req.body;

        if (!skus || !Array.isArray(skus) || skus.length === 0) {
            return res.status(400).json({ error: 'SKUs array is required' });
        }

        // Find variation IDs for given SKUs
        const variations = await db.query(
            `SELECT id, sku FROM variations
             WHERE sku = ANY($1::text[])
             AND COALESCE(is_deleted, FALSE) = FALSE`,
            [skus]
        );

        if (variations.rows.length === 0) {
            return res.status(404).json({ error: 'No valid SKUs found' });
        }

        // Insert into priority queue (only if not already in queue)
        const insertPromises = variations.rows.map(row =>
            db.query(
                `INSERT INTO count_queue_priority (catalog_object_id, added_by, notes)
                 SELECT $1, $2, $3
                 WHERE NOT EXISTS (
                     SELECT 1 FROM count_queue_priority
                     WHERE catalog_object_id = $1 AND completed = FALSE
                 )`,
                [row.id, added_by || 'System', notes || null]
            )
        );

        await Promise.all(insertPromises);

        res.json({
            success: true,
            items_added: variations.rows.length,
            skus: variations.rows.map(r => r.sku)
        });

    } catch (error) {
        logger.error('Add to priority queue error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cycle-counts/stats
 * Get cycle count statistics and history
 */
app.get('/api/cycle-counts/stats', async (req, res) => {
    try {
        const { days } = req.query;
        const lookbackDays = parseInt(days || '30');

        // Get session stats for the last N days
        const sessionsQuery = `
            SELECT
                session_date,
                items_expected,
                items_completed,
                completion_rate,
                started_at,
                completed_at
            FROM count_sessions
            WHERE session_date >= CURRENT_DATE - INTERVAL '${lookbackDays} days'
            ORDER BY session_date DESC
        `;

        const sessions = await db.query(sessionsQuery);

        // Get overall stats
        const overallQuery = `
            SELECT
                COUNT(DISTINCT catalog_object_id) as total_items_counted,
                MAX(last_counted_date) as most_recent_count,
                MIN(last_counted_date) as oldest_count,
                COUNT(DISTINCT catalog_object_id) FILTER (
                    WHERE last_counted_date >= CURRENT_DATE - INTERVAL '30 days'
                ) as counted_last_30_days
            FROM count_history
        `;

        const overall = await db.query(overallQuery);

        // Get total variations that need counting
        const totalQuery = `
            SELECT COUNT(*) as total_variations
            FROM variations
            WHERE COALESCE(is_deleted, FALSE) = FALSE
              AND track_inventory = TRUE
        `;

        const total = await db.query(totalQuery);

        // Calculate coverage percentage
        const totalVariations = parseInt(total.rows[0].total_variations);
        const itemsCounted = parseInt(overall.rows[0].total_items_counted);
        const coveragePercent = totalVariations > 0
            ? ((itemsCounted / totalVariations) * 100).toFixed(2)
            : 0;

        res.json({
            sessions: sessions.rows,
            overall: {
                ...overall.rows[0],
                total_variations: totalVariations,
                coverage_percent: coveragePercent
            }
        });

    } catch (error) {
        logger.error('Get cycle count stats error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cycle-counts/history
 * Get historical cycle count data with variance details
 * Query params: date (YYYY-MM-DD) or start_date + end_date
 */
app.get('/api/cycle-counts/history', async (req, res) => {
    try {
        const { date, start_date, end_date } = req.query;

        let dateFilter = '';
        const params = [];

        if (date) {
            // Single date query
            params.push(date);
            dateFilter = `AND DATE(ch.last_counted_date) = $${params.length}`;
        } else if (start_date && end_date) {
            // Date range query
            params.push(start_date, end_date);
            dateFilter = `AND DATE(ch.last_counted_date) BETWEEN $${params.length - 1} AND $${params.length}`;
        } else if (start_date) {
            // From start date to now
            params.push(start_date);
            dateFilter = `AND DATE(ch.last_counted_date) >= $${params.length}`;
        } else {
            // Default to last 30 days
            dateFilter = `AND ch.last_counted_date >= CURRENT_DATE - INTERVAL '30 days'`;
        }

        const query = `
            SELECT
                ch.id,
                ch.catalog_object_id,
                v.name as variation_name,
                v.sku,
                i.name as item_name,
                i.category_name,
                ch.last_counted_date,
                ch.counted_by,
                ch.is_accurate,
                ch.actual_quantity,
                ch.expected_quantity,
                ch.variance,
                ch.notes,
                v.price_money,
                v.currency,
                -- Calculate variance value in dollars
                CASE
                    WHEN ch.variance IS NOT NULL AND v.price_money IS NOT NULL
                    THEN (ch.variance * v.price_money / 100.0)
                    ELSE 0
                END as variance_value
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            WHERE 1=1
                ${dateFilter}
            ORDER BY ch.last_counted_date DESC, ABS(COALESCE(ch.variance, 0)) DESC
        `;

        const result = await db.query(query, params);

        // Calculate summary stats
        const totalCounts = result.rows.length;
        const accurateCounts = result.rows.filter(r => r.is_accurate).length;
        const inaccurateCounts = result.rows.filter(r => r.is_accurate === false).length;
        const totalVariance = result.rows.reduce((sum, r) => sum + Math.abs(r.variance || 0), 0);
        const totalVarianceValue = result.rows.reduce((sum, r) => sum + Math.abs(r.variance_value || 0), 0);

        const accuracyRate = totalCounts > 0
            ? ((accurateCounts / totalCounts) * 100).toFixed(2)
            : 0;

        res.json({
            summary: {
                total_counts: totalCounts,
                accurate_counts: accurateCounts,
                inaccurate_counts: inaccurateCounts,
                accuracy_rate: parseFloat(accuracyRate),
                total_variance_units: totalVariance,
                total_variance_value: totalVarianceValue
            },
            items: result.rows.map(row => ({
                ...row,
                variance_value: parseFloat((Number(row.variance_value) || 0).toFixed(2))
            }))
        });

    } catch (error) {
        logger.error('Get cycle count history error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/email-report
 * Send completion report email (uses shared sendCycleCountReport function)
 */
app.post('/api/cycle-counts/email-report', async (req, res) => {
    try {
        const result = await sendCycleCountReport();

        if (!result.sent) {
            return res.status(400).json({
                error: result.reason || 'Email reporting is disabled in configuration'
            });
        }

        res.json({
            success: true,
            message: 'Report sent successfully',
            ...result
        });

    } catch (error) {
        logger.error('Send cycle count report error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/generate-batch
 * Manually trigger daily batch generation
 */
app.post('/api/cycle-counts/generate-batch', async (req, res) => {
    try {
        logger.info('Manual batch generation requested');
        const result = await generateDailyBatch();

        res.json({
            success: true,
            message: 'Batch generated successfully',
            ...result
        });

    } catch (error) {
        logger.error('Manual batch generation failed', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cycle-counts/reset
 * Admin function to rebuild count history from current catalog
 */
app.post('/api/cycle-counts/reset', async (req, res) => {
    try {
        const { preserve_history } = req.body;

        if (preserve_history !== false) {
            // Add all variations that don't have count history yet
            await db.query(`
                INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by)
                SELECT v.id, '1970-01-01'::timestamp, 'System Reset'
                FROM variations v
                WHERE COALESCE(v.is_deleted, FALSE) = FALSE
                  AND v.track_inventory = TRUE
                  AND NOT EXISTS (
                    SELECT 1 FROM count_history ch
                    WHERE ch.catalog_object_id = v.id
                  )
            `);
        } else {
            // Complete reset - clear all history
            await db.query('DELETE FROM count_history');
            await db.query('DELETE FROM count_queue_priority');
            await db.query('DELETE FROM count_sessions');

            // Re-initialize with all current variations
            await db.query(`
                INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by)
                SELECT id, '1970-01-01'::timestamp, 'System Reset'
                FROM variations
                WHERE COALESCE(is_deleted, FALSE) = FALSE
                  AND track_inventory = TRUE
            `);
        }

        const countResult = await db.query('SELECT COUNT(*) as count FROM count_history');

        res.json({
            success: true,
            message: preserve_history ? 'Added new items to count history' : 'Count history reset complete',
            total_items: parseInt(countResult.rows[0].count)
        });

    } catch (error) {
        logger.error('Reset count history error', { error: error.message, stack: error.stack });
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
        logger.error('Create PO error', { error: error.message, stack: error.stack });
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
        logger.error('Get POs error', { error: error.message, stack: error.stack });
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
        logger.error('Get PO error', { error: error.message, stack: error.stack });
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
        logger.error('Update PO error', { error: error.message, stack: error.stack });
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
        logger.error('Submit PO error', { error: error.message, stack: error.stack });
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
        logger.error('Receive PO error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/purchase-orders/:id
 * Delete a purchase order (only DRAFT orders can be deleted)
 */
app.delete('/api/purchase-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Check if PO exists and is in DRAFT status
        const poCheck = await db.query(
            'SELECT id, po_number, status FROM purchase_orders WHERE id = $1',
            [id]
        );

        if (poCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poCheck.rows[0];

        if (po.status !== 'DRAFT') {
            return res.status(400).json({
                error: 'Only draft purchase orders can be deleted',
                message: `Cannot delete ${po.status} purchase order. Only DRAFT orders can be deleted.`
            });
        }

        // Delete PO (items will be cascade deleted)
        await db.query('DELETE FROM purchase_orders WHERE id = $1', [id]);

        res.json({
            status: 'success',
            message: `Purchase order ${po.po_number} deleted successfully`
        });
    } catch (error) {
        logger.error('Delete PO error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/purchase-orders/:po_number/export-csv
 * Export a purchase order in Square's CSV format (matches their export/import format)
 *
 * CSV FORMAT (based on actual Square PO exports):
 * Row 1 (header): Item Name,Variation Name,SKU,GTIN,Vendor Code,Notes,Qty,Unit Price,Fee,Price w/ Fee,Amount,Status
 * Rows 2-N: [item data rows - 12 columns]
 * [blank rows]
 * Metadata section at BOTTOM:
 *   Vendor,[name]
 *   Account Number,
 *   Address,
 *   Contact,
 *   Phone Number,
 *   Email,
 *   [blank]
 *   Ship To,[location]
 *   Expected On,[M/D/YYYY]
 *   Ordered By,
 *   Notes,[notes]
 *
 * CRITICAL FORMAT REQUIREMENTS:
 * - Exactly 12 columns in item rows (Item Name through Status)
 * - SKU and GTIN: Tab-prefixed (\t851655000000) to prevent Excel scientific notation
 * - Currency WITH $ symbol: $105.00, $13.29 (not 105.00)
 * - Qty must be integer (e.g., 3)
 * - Fee typically blank (or $0.00)
 * - Price w/ Fee = Unit Price + Fee
 * - Amount = Qty * Price w/ Fee
 * - Status typically "Open"
 * - Metadata at BOTTOM, not top
 * - Line endings: \r\n (CRLF)
 * - UTF-8 encoding with BOM
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

        // Get PO items with SKU, UPC (GTIN), and item names
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                v.upc as gtin,
                i.name as item_name,
                v.name as variation_name,
                vv.vendor_code
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2
            WHERE poi.purchase_order_id = $1
            ORDER BY i.name, v.name
        `, [po.id, po.vendor_id]);

        // Build CSV content
        const lines = [];

        // Header row - EXACT Square format (12 columns in exact order)
        lines.push('Item Name,Variation Name,SKU,GTIN,Vendor Code,Notes,Qty,Unit Price,Fee,Price w/ Fee,Amount,Status');

        // Data rows (12 fields matching header order)
        for (const item of itemsResult.rows) {
            const qty = Math.round(item.quantity_ordered || 0); // Integer
            const unitPrice = formatMoney(item.unit_cost_cents); // $105.00 format
            const fee = ''; // Blank (no fee)
            const priceWithFee = unitPrice; // Same as unit price when no fee

            // Calculate Amount = Qty * Price w/ Fee
            const unitPriceCents = item.unit_cost_cents || 0;
            const amountCents = qty * unitPriceCents;
            const amount = formatMoney(amountCents);

            const status = 'Open'; // Default status for new PO items

            const row = [
                escapeCSVField(item.item_name || ''),
                escapeCSVField(item.variation_name || ''),
                formatGTIN(item.sku), // Tab-prefixed to prevent scientific notation
                formatGTIN(item.gtin), // Tab-prefixed to prevent scientific notation
                escapeCSVField(item.vendor_code || ''),
                escapeCSVField(item.notes || ''), // Notes column (item-specific)
                qty, // Integer
                unitPrice, // $105.00
                fee, // Blank
                priceWithFee, // $105.00
                amount, // $315.00
                status // Open
            ];

            lines.push(row.join(','));
        }

        // Calculate expected delivery date (use existing or default to today + lead time)
        let expectedDeliveryDate = po.expected_delivery_date;
        if (!expectedDeliveryDate) {
            // Default: today + vendor lead time (or 7 days if no lead time set)
            const leadTimeDays = po.lead_time_days || 7;
            const deliveryDate = new Date();
            deliveryDate.setDate(deliveryDate.getDate() + leadTimeDays);
            expectedDeliveryDate = deliveryDate.toISOString();
        }

        // Add blank rows before metadata (matches Square's format)
        lines.push('');
        lines.push('');

        // Metadata rows at BOTTOM (Square's actual format)
        lines.push(`Vendor,${escapeCSVField(po.vendor_name)}`);
        lines.push('Account Number,');
        lines.push('Address,');
        lines.push('Contact,');
        lines.push('Phone Number,');
        lines.push('Email,');
        lines.push('');
        lines.push(`Ship To,${escapeCSVField(po.location_name)}`);
        lines.push(`Expected On,${formatDateForSquare(expectedDeliveryDate)}`);
        lines.push('Ordered By,');
        lines.push(`Notes,${escapeCSVField(po.notes || '')}`);


        // Join with \r\n (CRLF) line endings for maximum compatibility
        const csvLines = lines.join('\r\n') + '\r\n';

        // Add UTF-8 BOM (Byte Order Mark) for proper encoding recognition
        const csvContent = UTF8_BOM + csvLines;

        // Set response headers with cache-busting to prevent stale file issues
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        // Send CSV
        res.send(csvContent);

        logger.info('Square CSV export generated', {
            po_number: po.po_number,
            vendor: po.vendor_name,
            items: itemsResult.rows.length
        });

    } catch (error) {
        logger.error('CSV export error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/purchase-orders/:po_number/export-xlsx
 * Export a purchase order as Square-compatible XLSX file
 *
 * Square XLSX Import Format (EXACT template structure):
 *
 * Row 1: Instructions text
 * Rows 2-3: Blank
 * Row 4: Vendor,[vendor name]
 * Row 5: Ship to,[location name]
 * Row 6: Expected On,[date]
 * Row 7: Notes,[notes]
 * Row 8: Blank
 * Row 9: Column headers (Item Name, Variation Name, SKU, GTIN, Vendor Code, Notes, Qty, Unit Cost)
 * Row 10+: Line items
 *
 * CRITICAL REQUIREMENTS:
 * - Sheet name MUST be "Sheet0"
 * - Only one sheet
 * - No merged cells
 * - Headers in row 9 exactly as specified
 * - Data starts row 10
 * - Columns A-H only
 */
app.get('/api/purchase-orders/:po_number/export-xlsx', async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const { po_number } = req.params;

        // Get PO header with vendor and location info
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id
            JOIN locations l ON po.location_id = l.id
            WHERE po.po_number = $1
        `, [po_number]);

        if (poResult.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        const po = poResult.rows[0];

        // Get PO items
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                v.upc as gtin,
                i.name as item_name,
                v.name as variation_name,
                vv.vendor_code
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2
            WHERE poi.purchase_order_id = $1
            ORDER BY i.name, v.name
        `, [po.id, po.vendor_id]);

        // Calculate expected delivery date
        let expectedDeliveryDate = po.expected_delivery_date;
        if (!expectedDeliveryDate) {
            const leadTimeDays = po.lead_time_days || 7;
            const deliveryDate = new Date();
            deliveryDate.setDate(deliveryDate.getDate() + leadTimeDays);
            expectedDeliveryDate = deliveryDate;
        } else {
            expectedDeliveryDate = new Date(expectedDeliveryDate);
        }

        // Create workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Sheet0');

        // Row 1: Instructions (exact text from Square template)
        worksheet.getCell('A1').value = 'Fill out the purchase order starting with the line items - then add in the vendor and destination name below. Each line item requires at least one of the following: item name, SKU, or GTIN. Quantity is also required for each item.';

        // Rows 2-3: Blank (skip)

        // Row 4: Vendor
        worksheet.getCell('A4').value = 'Vendor';
        worksheet.getCell('B4').value = po.vendor_name;

        // Row 5: Ship to
        worksheet.getCell('A5').value = 'Ship to';
        worksheet.getCell('B5').value = po.location_name;

        // Row 6: Expected On (must be Excel date)
        worksheet.getCell('A6').value = 'Expected On';
        worksheet.getCell('B6').value = expectedDeliveryDate;
        worksheet.getCell('B6').numFmt = 'm/d/yyyy'; // Format as date

        // Row 7: Notes
        worksheet.getCell('A7').value = 'Notes';
        worksheet.getCell('B7').value = po.notes || '';

        // Row 8: Blank (skip)

        // Row 9: Column Headers (EXACT order required by Square)
        const headers = ['Item Name', 'Variation Name', 'SKU', 'GTIN', 'Vendor Code', 'Notes', 'Qty', 'Unit Cost'];
        worksheet.getRow(9).values = headers;

        // Make header row bold
        worksheet.getRow(9).font = { bold: true };

        // Row 10+: Line items
        let currentRow = 10;
        for (const item of itemsResult.rows) {
            const row = worksheet.getRow(currentRow);
            row.values = [
                item.item_name || '',
                item.variation_name || '',
                item.sku || '',
                item.gtin || '',
                item.vendor_code || '',
                item.notes || '',
                Math.round(item.quantity_ordered || 0), // Integer
                (item.unit_cost_cents || 0) / 100 // Decimal (no $ symbol in Excel)
            ];

            // Format Unit Cost as currency with 2 decimals
            row.getCell(8).numFmt = '0.00';

            currentRow++;
        }

        // Auto-fit columns for readability
        worksheet.columns = [
            { key: 'itemName', width: 25 },
            { key: 'variationName', width: 20 },
            { key: 'sku', width: 15 },
            { key: 'gtin', width: 15 },
            { key: 'vendorCode', width: 15 },
            { key: 'notes', width: 20 },
            { key: 'qty', width: 8 },
            { key: 'unitCost', width: 12 }
        ];

        // Generate Excel file buffer
        const buffer = await workbook.xlsx.writeBuffer();

        // Set response headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="PO_${po.po_number}_${po.vendor_name.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        // Send Excel file
        res.send(buffer);

        logger.info('Square XLSX export generated', {
            po_number: po.po_number,
            vendor: po.vendor_name,
            items: itemsResult.rows.length
        });

    } catch (error) {
        logger.error('XLSX export error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== DATABASE BACKUP & RESTORE ====================

/**
 * Find pg_dump command on Windows in common installation paths
 */
function findPgDumpOnWindows() {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    // Try direct command first
    try {
        execSync('pg_dump --version', { stdio: 'ignore' });
        return 'pg_dump';
    } catch (e) {
        // Not in PATH, search common locations
    }

    // Common PostgreSQL installation paths on Windows
    const basePaths = [
        'C:\\Program Files\\PostgreSQL',
        'C:\\Program Files (x86)\\PostgreSQL'
    ];

    // Check versions 20 down to 10 (future-proof for newer releases)
    for (const basePath of basePaths) {
        for (let version = 20; version >= 10; version--) {
            const pgDumpPath = path.join(basePath, `${version}`, 'bin', 'pg_dump.exe');
            if (fs.existsSync(pgDumpPath)) {
                logger.info('Found pg_dump at', { path: pgDumpPath });
                return `"${pgDumpPath}"`;
            }
        }
    }

    throw new Error('pg_dump not found. Please add PostgreSQL bin directory to PATH or install PostgreSQL client tools.');
}

/**
 * GET /api/database/export
 * Export database as SQL dump
 */
app.get('/api/database/export', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        const dbHost = process.env.DB_HOST || 'localhost';
        const dbPort = process.env.DB_PORT || '5432';
        const dbName = process.env.DB_NAME || 'jtpets_beta';
        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || '';

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `jtpets_backup_${timestamp}.sql`;

        logger.info('Starting database export', { database: dbName });

        // Find pg_dump command (handles Windows paths)
        const pgDumpCmd = process.platform === 'win32' ? findPgDumpOnWindows() : 'pg_dump';

        // Set PGPASSWORD environment variable for pg_dump
        const env = { ...process.env, PGPASSWORD: dbPassword };

        // Use pg_dump to create backup
        const command = `${pgDumpCmd} -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} --clean --if-exists --no-owner --no-privileges`;

        const { stdout, stderr } = await execAsync(command, {
            env,
            maxBuffer: 50 * 1024 * 1024 // 50MB buffer
        });

        if (stderr && !stderr.includes('NOTICE')) {
            logger.warn('Database export warnings', { warnings: stderr });
        }

        // Send SQL dump as downloadable file
        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(stdout);

        logger.info('Database export completed', {
            filename,
            size_bytes: stdout.length
        });

    } catch (error) {
        logger.error('Database export failed', {
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({
            error: 'Database export failed',
            message: error.message
        });
    }
});

/**
 * Find psql command on Windows in common installation paths
 */
function findPsqlOnWindows() {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    // Try direct command first
    try {
        execSync('psql --version', { stdio: 'ignore' });
        return 'psql';
    } catch (e) {
        // Not in PATH, search common locations
    }

    // Common PostgreSQL installation paths on Windows
    const basePaths = [
        'C:\\Program Files\\PostgreSQL',
        'C:\\Program Files (x86)\\PostgreSQL'
    ];

    // Check versions 20 down to 10 (future-proof for newer releases)
    for (const basePath of basePaths) {
        for (let version = 20; version >= 10; version--) {
            const psqlPath = path.join(basePath, `${version}`, 'bin', 'psql.exe');
            if (fs.existsSync(psqlPath)) {
                logger.info('Found psql at', { path: psqlPath });
                return `"${psqlPath}"`;
            }
        }
    }

    throw new Error('psql not found. Please add PostgreSQL bin directory to PATH or install PostgreSQL client tools.');
}

/**
 * POST /api/database/import
 * Import database from SQL dump
 * Body: { sql: "SQL dump content" }
 */
app.post('/api/database/import', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        const tmpFs = require('fs').promises;
        const tmpPath = require('path');

        const { sql } = req.body;

        if (!sql || typeof sql !== 'string') {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'SQL content is required'
            });
        }

        const dbHost = process.env.DB_HOST || 'localhost';
        const dbPort = process.env.DB_PORT || '5432';
        const dbName = process.env.DB_NAME || 'jtpets_beta';
        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || '';

        logger.info('Starting database import', {
            database: dbName,
            sql_size_bytes: sql.length
        });

        // Write SQL to temporary file
        const tmpDir = tmpPath.join(__dirname, 'temp');
        await tmpFs.mkdir(tmpDir, { recursive: true });

        const tmpFile = tmpPath.join(tmpDir, `import_${Date.now()}.sql`);
        await tmpFs.writeFile(tmpFile, sql, 'utf-8');

        try {
            // Find psql command (handles Windows paths)
            const psqlCmd = process.platform === 'win32' ? findPsqlOnWindows() : 'psql';

            // Set PGPASSWORD environment variable for psql
            const env = { ...process.env, PGPASSWORD: dbPassword };

            // Use psql to restore backup
            const command = `${psqlCmd} -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -f "${tmpFile}" -v ON_ERROR_STOP=1`;

            logger.info('Executing psql command', { command: command.replace(dbPassword, '***') });

            const { stdout, stderr } = await execAsync(command, {
                env,
                maxBuffer: 50 * 1024 * 1024 // 50MB buffer
            });

            // Clean up temp file
            await tmpFs.unlink(tmpFile);

            if (stderr && !stderr.includes('NOTICE') && !stderr.includes('WARNING')) {
                logger.warn('Database import warnings', { warnings: stderr });
            }

            logger.info('Database import completed successfully');

            res.json({
                success: true,
                message: 'Database imported successfully',
                output: stdout
            });

        } catch (execError) {
            // Clean up temp file on error
            try {
                await tmpFs.unlink(tmpFile);
            } catch (unlinkError) {
                // Ignore unlink errors
            }
            throw execError;
        }

    } catch (error) {
        logger.error('Database import failed', {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({
            error: 'Database import failed',
            message: error.message,
            details: error.stderr || error.message
        });
    }
});

/**
 * GET /api/database/info
 * Get database information
 */
app.get('/api/database/info', async (req, res) => {
    try {
        // Get database size
        const sizeResult = await db.query(`
            SELECT
                pg_database.datname as name,
                pg_size_pretty(pg_database_size(pg_database.datname)) as size,
                pg_database_size(pg_database.datname) as size_bytes
            FROM pg_database
            WHERE datname = $1
        `, [process.env.DB_NAME || 'jtpets_beta']);

        // Get table counts
        const tablesResult = await db.query(`
            SELECT
                schemaname,
                relname as tablename,
                n_live_tup as row_count
            FROM pg_stat_user_tables
            ORDER BY n_live_tup DESC
        `);

        // Get database version
        const versionResult = await db.query('SELECT version()');

        res.json({
            database: sizeResult.rows[0] || {},
            tables: tablesResult.rows,
            version: versionResult.rows[0].version,
            connection: {
                host: process.env.DB_HOST || 'localhost',
                port: process.env.DB_PORT || '5432',
                database: process.env.DB_NAME || 'jtpets_beta',
                user: process.env.DB_USER || 'postgres'
            }
        });

    } catch (error) {
        logger.error('Failed to get database info', {
            error: error.message
        });
        res.status(500).json({
            error: 'Failed to get database info',
            message: error.message
        });
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
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
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

        // Ensure database schema is up to date
        await db.ensureSchema();

        // Start server
        app.listen(PORT, () => {
            const banner = [
                '='.repeat(60),
                'JTPets Inventory Management System',
                '='.repeat(60),
                `Server running on port ${PORT}`,
                `Environment: ${process.env.NODE_ENV || 'development'}`,
                `Database: ${process.env.DB_NAME || 'jtpets_beta'}`,
                '='.repeat(60),
                'API Endpoints (40 total):',
                '  GET    /api/health',
                '  GET    /api/logs                                  (view recent logs)',
                '  GET    /api/logs/errors                           (view error logs)',
                '  GET    /api/logs/stats                            (log statistics)',
                '  GET    /api/logs/download                         (download logs)',
                '  POST   /api/test-email                            (test email)',
                '  POST   /api/test-error                            (test error logging)',
                '  POST   /api/sync                                  (force full sync)',
                '  POST   /api/sync-smart                            (smart interval-based sync)',
                '  POST   /api/sync-sales                            (sync all sales periods)',
                '  GET    /api/sync-status                           (view sync schedule status)',
                '  GET    /api/sync-history                          (view sync history)',
                '  GET    /api/items',
                '  GET    /api/variations',
                '  GET    /api/variations-with-costs',
                '  PATCH  /api/variations/:id/extended               (update extended fields)',
                '  POST   /api/variations/bulk-update-extended       (bulk update extended fields)',
                '  GET    /api/expirations                           (get expiration tracking)',
                '  GET    /api/inventory',
                '  GET    /api/low-stock',
                '  GET    /api/deleted-items                         (view deleted items)',
                '  GET    /api/vendors',
                '  GET    /api/locations',
                '  GET    /api/sales-velocity',
                '  GET    /api/reorder-suggestions',
                '  GET    /api/cycle-counts/pending                  (pending cycle counts)',
                '  POST   /api/cycle-counts/:id/complete             (complete cycle count)',
                '  POST   /api/cycle-counts/send-now                 (send to priority queue)',
                '  GET    /api/cycle-counts/stats                    (cycle count statistics)',
                '  POST   /api/cycle-counts/email-report             (email cycle count report)',
                '  POST   /api/cycle-counts/generate-batch           (generate daily batch)',
                '  POST   /api/cycle-counts/reset                    (reset count history)',
                '  POST   /api/purchase-orders                       (create PO)',
                '  GET    /api/purchase-orders                       (list POs)',
                '  GET    /api/purchase-orders/:id                   (get PO details)',
                '  PATCH  /api/purchase-orders/:id                   (update PO)',
                '  POST   /api/purchase-orders/:id/submit            (submit PO)',
                '  POST   /api/purchase-orders/:id/receive           (receive PO)',
                '  DELETE /api/purchase-orders/:id                   (delete PO)',
                '  GET    /api/purchase-orders/:po_number/export-csv (export PO to CSV)',
                '='.repeat(60)
            ];

            logger.info('Server started successfully', {
                port: PORT,
                environment: process.env.NODE_ENV || 'development',
                nodeVersion: process.version,
                startup_banner: banner.join('\n')
            });
        });

        // Initialize cycle count daily batch generation cron job
        // Runs every day at 1:00 AM
        const cronSchedule = process.env.CYCLE_COUNT_CRON || '0 1 * * *';
        cron.schedule(cronSchedule, async () => {
            logger.info('Running scheduled daily batch generation');
            try {
                const result = await generateDailyBatch();
                logger.info('Scheduled batch generation completed', result);
            } catch (error) {
                logger.error('Scheduled batch generation failed', { error: error.message });
                await emailNotifier.sendAlert(
                    'Cycle Count Batch Generation Failed',
                    `Failed to generate daily cycle count batch:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        });

        logger.info('Cycle count cron job scheduled', { schedule: cronSchedule });

        // Initialize automated database sync cron job
        // Runs hourly by default (configurable via SYNC_CRON_SCHEDULE)
        const syncCronSchedule = process.env.SYNC_CRON_SCHEDULE || '0 * * * *';
        cron.schedule(syncCronSchedule, async () => {
            logger.info('Running scheduled smart sync');
            try {
                const result = await runSmartSync();
                logger.info('Scheduled smart sync completed', {
                    synced: result.synced,
                    skipped: Object.keys(result.skipped).length,
                    errors: result.errors?.length || 0
                });

                // Send alert if there were errors
                if (result.errors && result.errors.length > 0) {
                    await emailNotifier.sendAlert(
                        'Database Sync Partial Failure',
                        `Some sync operations failed:\n\n${result.errors.map(e => `- ${e.type}: ${e.error}`).join('\n')}`
                    );
                }
            } catch (error) {
                logger.error('Scheduled smart sync failed', { error: error.message });
                await emailNotifier.sendAlert(
                    'Database Sync Failed',
                    `Failed to run scheduled database sync:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        });

        logger.info('Database sync cron job scheduled', { schedule: syncCronSchedule });

        // Initialize automated weekly database backup cron job
        // Runs every Sunday at 2:00 AM by default (configurable via BACKUP_CRON_SCHEDULE)
        const backupCronSchedule = process.env.BACKUP_CRON_SCHEDULE || '0 2 * * 0';
        cron.schedule(backupCronSchedule, async () => {
            logger.info('Running scheduled database backup');
            try {
                await runAutomatedBackup();
                logger.info('Scheduled database backup completed successfully');
            } catch (error) {
                logger.error('Scheduled database backup failed', { error: error.message });
                await emailNotifier.sendAlert(
                    'Automated Database Backup Failed',
                    `Failed to run scheduled database backup:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        });

        logger.info('Database backup cron job scheduled', { schedule: backupCronSchedule });

        // Startup check: Generate today's batch if it doesn't exist yet
        // This handles cases where server was offline during scheduled cron time
        (async () => {
            try {
                // Check if any items have been added to today's batch
                const batchCheck = await db.query(`
                    SELECT COUNT(*) as count
                    FROM count_queue_daily
                    WHERE batch_date = CURRENT_DATE
                `);

                const todaysBatchCount = parseInt(batchCheck.rows[0]?.count || 0);

                if (todaysBatchCount === 0) {
                    logger.info('No batch found for today - generating startup batch');
                    const result = await generateDailyBatch();
                    logger.info('Startup batch generation completed', result);
                } else {
                    logger.info('Today\'s batch already exists', { items_count: todaysBatchCount });
                }
            } catch (error) {
                logger.error('Startup batch check failed', { error: error.message });
            }
        })();

        // Startup check: Run smart sync if data is stale
        // This handles cases where server was offline during scheduled sync time
        (async () => {
            try {
                logger.info('Checking for stale data on startup');

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

                // Check if any sync type is stale
                let needsSync = false;
                const staleTypes = [];

                for (const [syncType, intervalHours] of Object.entries(intervals)) {
                    const check = await isSyncNeeded(syncType, intervalHours);
                    if (check.needed) {
                        needsSync = true;
                        staleTypes.push(syncType);
                    }
                }

                if (needsSync) {
                    logger.info('Stale data detected on startup - running smart sync', {
                        stale_types: staleTypes
                    });
                    const result = await runSmartSync();
                    logger.info('Startup smart sync completed', {
                        synced: result.synced,
                        skipped: Object.keys(result.skipped).length,
                        errors: result.errors?.length || 0
                    });

                    // Send alert if there were errors
                    if (result.errors && result.errors.length > 0) {
                        await emailNotifier.sendAlert(
                            'Startup Database Sync Partial Failure',
                            `Some sync operations failed during startup:\n\n${result.errors.map(e => `- ${e.type}: ${e.error}`).join('\n')}`
                        );
                    }
                } else {
                    logger.info('All data is current - no sync needed on startup');
                }
            } catch (error) {
                logger.error('Startup sync check failed', { error: error.message });
                // Don't send alert for startup check failures - not critical
            }
        })();

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
    logger.info('SIGTERM received, closing server');
    await db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, closing server');
    await db.close();
    process.exit(0);
});

// Start the server
startServer();

module.exports = app;
