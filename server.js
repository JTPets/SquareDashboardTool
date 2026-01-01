/**
 * Square Dashboard Addon Tool - Main Server
 * Express API server with Square POS integration
 */

console.log('Starting Square Dashboard Addon Tool...');
console.log('Loading configuration...');

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs').promises;
const cron = require('node-cron');
const db = require('./utils/database');
const squareApi = require('./utils/square-api');
const logger = require('./utils/logger');
const emailNotifier = require('./utils/email-notifier');
const subscriptionHandler = require('./utils/subscription-handler');
const { subscriptionCheck } = require('./middleware/subscription-check');
const { escapeCSVField, formatDateForSquare, formatMoney, formatGTIN, UTF8_BOM } = require('./utils/csv-helpers');
const expiryDiscount = require('./utils/expiry-discount');

// Security middleware
const { configureHelmet, configureRateLimit, configureCors, corsErrorHandler } = require('./middleware/security');
const { requireAuth, requireAuthApi, requireAdmin, requireWriteAccess } = require('./middleware/auth');
const authRoutes = require('./routes/auth');

// Multi-tenant middleware and routes
const { loadMerchantContext, requireMerchant, requireValidSubscription, getSquareClientForMerchant } = require('./middleware/merchant');
const squareOAuthRoutes = require('./routes/square-oauth');
const MerchantDB = require('./utils/merchant-db');

const app = express();
const PORT = process.env.PORT || 5001;

/**
 * Get the public-facing app URL for browser redirects.
 *
 * IMPORTANT: This is separate from GOOGLE_REDIRECT_URI!
 * - GOOGLE_REDIRECT_URI: Used for OAuth callback (registered with Google, can be localhost)
 * - PUBLIC_APP_URL: Where browsers should be redirected after OAuth (must be reachable by user)
 *
 * For LAN access on Raspberry Pi:
 *   GOOGLE_REDIRECT_URI=http://localhost:5001/api/google/callback  (Google accepts localhost)
 *   PUBLIC_APP_URL=http://192.168.0.64:5001  (LAN IP so other devices can reach it)
 *
 * For production:
 *   GOOGLE_REDIRECT_URI=https://yourdomain.com/api/google/callback
 *   PUBLIC_APP_URL=https://yourdomain.com
 *
 * @param {Object} req - Express request object (used for fallback)
 * @returns {string} The public app URL
 */
function getPublicAppUrl(req) {
    // Prefer explicit PUBLIC_APP_URL if set
    if (process.env.PUBLIC_APP_URL) {
        return process.env.PUBLIC_APP_URL.replace(/\/$/, ''); // Remove trailing slash
    }
    // Fallback: derive from request (works when accessed directly)
    return `${req.protocol}://${req.get('host')}`;
}

// AWS S3 Configuration for product images
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'items-images-production';
const AWS_S3_REGION = process.env.AWS_S3_REGION || 'us-west-2';

// ==================== SECURITY MIDDLEWARE ====================

// Trust proxy (required when behind Cloudflare, nginx, etc.)
// This ensures rate limiting and session cookies work correctly with X-Forwarded-For headers
app.set('trust proxy', 1);

// Security headers (helmet) - skip in development if causing issues
if (process.env.DISABLE_SECURITY_HEADERS !== 'true') {
    app.use(configureHelmet());
}

// Rate limiting
app.use(configureRateLimit());

// CORS configuration
app.use(configureCors());
app.use(corsErrorHandler);

// Body parsing - capture raw body for webhook signature verification
app.use(express.json({
    limit: '50mb',
    verify: (req, res, buf) => {
        // Store raw body for webhook signature verification
        if (req.originalUrl === '/api/webhooks/square') {
            req.rawBody = buf.toString('utf8');
        }
    }
}));

// Session configuration
const sessionDurationHours = parseInt(process.env.SESSION_DURATION_HOURS) || 24;
const pgSessionStore = new PgSession({
    pool: db.pool,
    tableName: 'sessions',
    createTableIfMissing: true,
    errorLog: (err) => {
        logger.error('Session store error', { error: err.message });
    }
});

// Handle session store errors
pgSessionStore.on('error', (err) => {
    logger.error('Session store connection error', { error: err.message });
});

console.log('Initializing session middleware...');

app.use(session({
    store: pgSessionStore,
    secret: process.env.SESSION_SECRET || 'change-this-secret-in-production-' + Math.random().toString(36),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: 'auto',                                   // Auto-detect based on X-Forwarded-Proto (works with Cloudflare)
        httpOnly: true,                                   // No JavaScript access
        maxAge: sessionDurationHours * 60 * 60 * 1000,   // Configurable duration
        sameSite: 'lax'                                   // CSRF protection
    },
    name: 'sid',  // Change from default 'connect.sid' for security
    proxy: true   // Trust the reverse proxy (Cloudflare)
}));

console.log('Session middleware initialized');

// Warn if using default session secret
if (!process.env.SESSION_SECRET) {
    logger.warn('SESSION_SECRET not set! Using random secret. Sessions will be lost on restart.');
}

// ==================== PAGE AUTHENTICATION ====================
// Redirect unauthenticated users to login page for protected HTML pages
const authEnabled = process.env.AUTH_DISABLED !== 'true';

// Public pages that don't require authentication
const publicPages = ['/', '/index.html', '/login.html', '/subscribe.html', '/support.html'];

if (authEnabled) {
    app.use((req, res, next) => {
        // Only check HTML page requests (not API, not static assets)
        if (req.method === 'GET' && (req.path.match(/\.(html)$/) || req.path === '/')) {
            // Allow public pages without auth
            if (publicPages.includes(req.path)) {
                return next();
            }
            // Check if user is authenticated
            if (!req.session || !req.session.user) {
                // Redirect to login with return URL
                const returnUrl = encodeURIComponent(req.originalUrl);
                return res.redirect(`/login.html?returnUrl=${returnUrl}`);
            }
        }
        next();
    });
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output'))); // Serve generated files

// Request logging
app.use((req, res, next) => {
    // Skip logging for static assets
    if (!req.path.match(/\.(js|css|png|jpg|ico|svg|woff|woff2)$/)) {
        logger.info('API request', { method: req.method, path: req.path, user: req.session?.user?.email });
    }
    next();
});

// ==================== AUTHENTICATION ROUTES ====================
// These routes are public (login, logout, etc.)
app.use('/api/auth', authRoutes);

// ==================== SQUARE OAUTH ROUTES ====================
// OAuth connect/callback routes (partial auth - callback needs special handling)
app.use('/api/square/oauth', squareOAuthRoutes);

// ==================== MERCHANT CONTEXT MIDDLEWARE ====================
// Load merchant context for all authenticated requests
// Must be AFTER auth middleware so req.session.user is available
app.use(loadMerchantContext);

// ==================== API AUTHENTICATION MIDDLEWARE ====================
// Protect all API routes (authEnabled already set above)
if (authEnabled) {
    app.use('/api', (req, res, next) => {
        // Allow health check without auth
        if (req.path === '/health') {
            return next();
        }
        // Allow webhook endpoint without auth (Square needs to POST to it)
        if (req.path === '/webhooks/square') {
            return next();
        }
        // Require authentication for all other API routes
        return requireAuthApi(req, res, next);
    });
    logger.info('Authentication middleware enabled');
} else {
    logger.warn('⚠️  Authentication is DISABLED! Set AUTH_DISABLED=false for production.');
}

// Subscription check middleware (optional, in addition to auth)
if (process.env.SUBSCRIPTION_CHECK_ENABLED === 'true') {
    logger.info('Subscription check middleware enabled');
    app.use(subscriptionCheck);
}

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

// ==================== MERCHANT MANAGEMENT API ====================

/**
 * GET /api/merchants
 * List all merchants the current user has access to
 */
app.get('/api/merchants', requireAuth, async (req, res) => {
    try {
        const { getUserMerchants } = require('./middleware/merchant');
        const merchants = await getUserMerchants(req.session.user.id);

        res.json({
            success: true,
            merchants,
            activeMerchantId: req.session.activeMerchantId || null,
            activeMerchant: req.merchantContext || null
        });
    } catch (error) {
        logger.error('Error listing merchants:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list merchants'
        });
    }
});

/**
 * POST /api/merchants/switch
 * Switch the active merchant for the current session
 */
app.post('/api/merchants/switch', requireAuth, async (req, res) => {
    const { merchantId } = req.body;

    if (!merchantId) {
        return res.status(400).json({
            success: false,
            error: 'merchantId is required'
        });
    }

    try {
        const { switchActiveMerchant } = require('./middleware/merchant');
        const switched = await switchActiveMerchant(
            req.session,
            req.session.user.id,
            parseInt(merchantId)
        );

        if (!switched) {
            return res.status(403).json({
                success: false,
                error: 'You do not have access to this merchant'
            });
        }

        res.json({
            success: true,
            activeMerchantId: req.session.activeMerchantId,
            message: 'Merchant switched successfully'
        });
    } catch (error) {
        logger.error('Error switching merchant:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to switch merchant'
        });
    }
});

/**
 * GET /api/merchants/context
 * Get current merchant context for the session
 */
app.get('/api/merchants/context', requireAuth, async (req, res) => {
    res.json({
        success: true,
        hasMerchant: !!req.merchantContext,
        merchant: req.merchantContext || null,
        connectUrl: '/api/square/oauth/connect'
    });
});

/**
 * GET /api/config
 * Get frontend configuration from environment variables
 */
app.get('/api/config', async (req, res) => {
    try {
        // Check Square connection
        let squareConnected = false;
        try {
            const locations = await squareApi.getLocations();
            squareConnected = locations && locations.length > 0;
        } catch (e) {
            squareConnected = false;
        }

        res.json({
            defaultSupplyDays: parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45'),
            reorderSafetyDays: parseInt(process.env.REORDER_SAFETY_DAYS || '7'),
            reorderPriorityThresholds: {
                urgent: parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0'),
                high: parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7'),
                medium: parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14'),
                low: parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30')
            },
            square_connected: squareConnected,
            square_environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
            email_configured: !!(process.env.SMTP_HOST || process.env.EMAIL_HOST),
            sync_intervals: {
                catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL || '60'),
                inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL || '15'),
                sales: parseInt(process.env.SYNC_SALES_INTERVAL || '60')
            }
        });
    } catch (error) {
        logger.error('Failed to get config', { error: error.message });
        res.status(500).json({ error: 'Failed to get configuration' });
    }
});

// ==================== SETTINGS ENDPOINTS ====================

const fsPromises = require('fs').promises;

/**
 * GET /api/settings/env
 * Read environment variables (masked for sensitive values)
 * Requires admin role
 */
app.get('/api/settings/env', requireAdmin, async (req, res) => {
    try {
        const envPath = path.join(__dirname, '.env');

        // Read .env file
        let envContent = '';
        try {
            envContent = await fsPromises.readFile(envPath, 'utf8');
        } catch (e) {
            // .env might not exist
            logger.warn('.env file not found');
        }

        // Parse .env content
        const variables = {};
        const lines = envContent.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;

            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();

            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            variables[key] = value;
        }

        // Define expected variables with defaults
        const expectedVars = [
            'PORT', 'NODE_ENV', 'PUBLIC_APP_URL',
            'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
            'SQUARE_ACCESS_TOKEN', 'SQUARE_ENVIRONMENT',
            'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
            'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
            'EMAIL_FROM', 'EMAIL_TO'
        ];

        // Add any missing expected variables
        for (const key of expectedVars) {
            if (!(key in variables)) {
                variables[key] = '';
            }
        }

        res.json({ success: true, variables });

    } catch (error) {
        logger.error('Failed to read env settings', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/settings/env
 * Update environment variables (writes to .env file)
 * Requires admin role
 */
app.put('/api/settings/env', requireAdmin, async (req, res) => {
    try {
        const { variables } = req.body;

        if (!variables || typeof variables !== 'object') {
            return res.status(400).json({ success: false, error: 'Variables object required' });
        }

        const envPath = path.join(__dirname, '.env');

        // Build .env content
        let content = '# Square Dashboard Addon Tool - Environment Configuration\n';
        content += '# Updated: ' + new Date().toISOString() + '\n\n';

        // Group variables
        const groups = {
            'Server': ['PORT', 'NODE_ENV', 'PUBLIC_APP_URL'],
            'Database': ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
            'Square API': ['SQUARE_ACCESS_TOKEN', 'SQUARE_ENVIRONMENT'],
            'Google OAuth': ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
            'Email/SMTP': ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_TO']
        };

        const writtenKeys = new Set();

        for (const [groupName, keys] of Object.entries(groups)) {
            content += `# ${groupName}\n`;
            for (const key of keys) {
                if (key in variables) {
                    const value = variables[key] || '';
                    // Quote values with spaces or special chars
                    const needsQuotes = value.includes(' ') || value.includes('#') || value.includes('=');
                    content += `${key}=${needsQuotes ? '"' + value + '"' : value}\n`;
                    writtenKeys.add(key);
                }
            }
            content += '\n';
        }

        // Write any remaining variables
        const remaining = Object.keys(variables).filter(k => !writtenKeys.has(k));
        if (remaining.length > 0) {
            content += '# Other\n';
            for (const key of remaining) {
                const value = variables[key] || '';
                const needsQuotes = value.includes(' ') || value.includes('#') || value.includes('=');
                content += `${key}=${needsQuotes ? '"' + value + '"' : value}\n`;
            }
        }

        // Write to file
        await fsPromises.writeFile(envPath, content, 'utf8');
        logger.info('Environment variables updated', { keys: Object.keys(variables).length });

        res.json({ success: true, message: 'Settings saved. Restart server to apply changes.' });

    } catch (error) {
        logger.error('Failed to save env settings', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== LOGGING ENDPOINTS ====================

/**
 * GET /api/logs
 * View recent logs
 * Requires admin role
 */
app.get('/api/logs', requireAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logsDir = path.join(__dirname, 'output', 'logs');

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
        const logsDir = path.join(__dirname, 'output', 'logs');
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
        const logsDir = path.join(__dirname, 'output', 'logs');
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `app-${today}.log`);

        res.download(logFile, `square-dashboard-addon-logs-${today}.log`);

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
        const logsDir = path.join(__dirname, 'output', 'logs');
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

/**
 * Batch resolve image URLs for multiple items in a SINGLE query
 * This is much more efficient than calling resolveImageUrls for each item
 * @param {Array} items - Array of objects with 'images' and optional 'item_images' fields
 * @returns {Promise<Map>} Map of item index -> image URLs array
 */
async function batchResolveImageUrls(items) {
    // Collect all unique image IDs
    const allImageIds = new Set();
    const itemImageMapping = []; // Track which images belong to which item

    items.forEach((item, index) => {
        let imageIds = item.images;
        if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
            imageIds = item.item_images;
        }
        if (imageIds && Array.isArray(imageIds)) {
            imageIds.forEach(id => allImageIds.add(id));
        }
        itemImageMapping.push({
            index,
            imageIds: imageIds && Array.isArray(imageIds) ? imageIds : []
        });
    });

    // If no images to resolve, return empty results
    if (allImageIds.size === 0) {
        return new Map(items.map((_, i) => [i, []]));
    }

    // Single batch query for ALL images
    const imageIdArray = Array.from(allImageIds);
    let urlMap = {};

    try {
        const placeholders = imageIdArray.map((_, i) => `$${i + 1}`).join(',');
        const result = await db.query(
            `SELECT id, url FROM images WHERE id IN (${placeholders}) AND url IS NOT NULL`,
            imageIdArray
        );

        result.rows.forEach(row => {
            if (row.url) {
                urlMap[row.id] = row.url;
            }
        });
    } catch (error) {
        logger.error('Error in batch image URL resolution', { error: error.message });
    }

    // Build result map for each item
    const resultMap = new Map();
    itemImageMapping.forEach(({ index, imageIds }) => {
        const urls = imageIds.map(id => {
            if (urlMap[id]) {
                return urlMap[id];
            }
            return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/files/${id}/original.jpeg`;
        });
        resultMap.set(index, urls);
    });

    return resultMap;
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
    const dbName = process.env.DB_NAME || 'square_dashboard_addon';
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

        // Generate GMC feed after sync completes
        let gmcFeedResult = null;
        let googleSheetResult = null;
        try {
            logger.info('Generating GMC feed after sync...');
            const gmcFeedModule = require('./utils/gmc-feed');
            gmcFeedResult = await gmcFeedModule.generateFeed();
            logger.info('GMC feed generated successfully', {
                products: gmcFeedResult.stats.total,
                feedUrl: gmcFeedResult.feedUrl
            });

            // Try to sync to Google Sheets if configured and authenticated
            try {
                const googleSheetsModule = require('./utils/google-sheets');
                const isAuthenticated = await googleSheetsModule.isAuthenticated();

                if (isAuthenticated) {
                    // Get configured spreadsheet ID from settings
                    const sheetIdResult = await db.query(
                        "SELECT setting_value FROM gmc_settings WHERE setting_key = 'google_sheet_id'"
                    );

                    if (sheetIdResult.rows.length > 0 && sheetIdResult.rows[0].setting_value) {
                        const spreadsheetId = sheetIdResult.rows[0].setting_value;
                        const { products } = await gmcFeedModule.generateFeedData();

                        googleSheetResult = await googleSheetsModule.writeFeedToSheet(spreadsheetId, products, {
                            sheetName: 'GMC Feed',
                            clearFirst: true
                        });

                        logger.info('GMC feed synced to Google Sheets', {
                            spreadsheetUrl: googleSheetResult.spreadsheetUrl,
                            updatedRows: googleSheetResult.updatedRows
                        });
                    } else {
                        logger.info('Google Sheets sync skipped: no spreadsheet ID configured');
                    }
                } else {
                    logger.info('Google Sheets sync skipped: not authenticated');
                }
            } catch (sheetError) {
                logger.error('Google Sheets sync failed (non-blocking)', {
                    error: sheetError.message
                });
                googleSheetResult = { error: sheetError.message };
            }
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
                } : null,
                google_sheet: googleSheetResult ? {
                    spreadsheetUrl: googleSheetResult.spreadsheetUrl,
                    updatedRows: googleSheetResult.updatedRows,
                    error: googleSheetResult.error
                } : null
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
app.get('/api/sync-history', requireMerchant, async (req, res) => {
    try {
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
app.get('/api/categories', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT DISTINCT i.category_name
            FROM items i
            WHERE i.category_name IS NOT NULL
              AND i.category_name != ''
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND i.merchant_id = $1
            ORDER BY i.category_name
        `, [merchantId]);
        logger.info('API /api/categories returning', { count: result.rows.length, merchantId });
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
app.get('/api/items', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { name, category } = req.query;
        let query = `
            SELECT i.*, c.name as category_name
            FROM items i
            LEFT JOIN categories c ON i.category_id = c.id AND c.merchant_id = $1
            WHERE i.merchant_id = $1
        `;
        const params = [merchantId];

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
        logger.info('API /api/items returning', { count: result.rows.length, merchantId });
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
app.get('/api/variations', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { item_id, sku, has_cost } = req.query;
        let query = `
            SELECT v.*, i.name as item_name, i.category_name, i.images as item_images
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE v.merchant_id = $1
        `;
        const params = [merchantId];

        if (item_id) {
            params.push(item_id);
            query += ` AND v.item_id = $${params.length}`;
        }

        if (sku) {
            params.push(`%${sku}%`);
            query += ` AND v.sku ILIKE $${params.length}`;
        }

        if (has_cost === 'true') {
            query += ` AND EXISTS (SELECT 1 FROM variation_vendors vv WHERE vv.variation_id = v.id AND vv.merchant_id = $1)`;
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
 * Update custom fields on a variation
 * Automatically syncs case_pack_quantity to Square if changed
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

        // Track if case_pack_quantity is being updated
        const casePackUpdate = req.body.case_pack_quantity !== undefined;
        const newCasePackValue = req.body.case_pack_quantity;

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

        // Auto-sync case_pack_quantity to Square if updated with a valid value (must be > 0)
        let squareSyncResult = null;
        if (casePackUpdate && newCasePackValue !== null && newCasePackValue > 0) {
            try {
                squareSyncResult = await squareApi.updateCustomAttributeValues(id, {
                    case_pack_quantity: {
                        number_value: newCasePackValue.toString()
                    }
                });
                logger.info('Case pack synced to Square', { variation_id: id, case_pack: newCasePackValue });
            } catch (syncError) {
                logger.error('Failed to sync case pack to Square', { variation_id: id, error: syncError.message });
                // Don't fail the request - local update succeeded
                squareSyncResult = { success: false, error: syncError.message };
            }
        }

        res.json({
            status: 'success',
            variation: result.rows[0],
            square_sync: squareSyncResult
        });
    } catch (error) {
        logger.error('Update variation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/variations/:id/min-stock
 * Update min stock (inventory alert threshold) and sync to Square
 * Uses location-specific overrides in Square
 */
app.patch('/api/variations/:id/min-stock', async (req, res) => {
    try {
        const { id } = req.params;
        const { min_stock, location_id } = req.body;

        // Validate input
        if (min_stock !== null && (typeof min_stock !== 'number' || min_stock < 0)) {
            return res.status(400).json({
                error: 'min_stock must be a non-negative number or null'
            });
        }

        // Get variation details
        const variationResult = await db.query(
            `SELECT v.id, v.sku, v.name, v.item_id, v.track_inventory,
                    v.inventory_alert_threshold, i.name as item_name
             FROM variations v
             JOIN items i ON v.item_id = i.id
             WHERE v.id = $1`,
            [id]
        );

        if (variationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const variation = variationResult.rows[0];
        const previousValue = variation.inventory_alert_threshold;

        // Determine which location to use
        let targetLocationId = location_id;

        if (!targetLocationId) {
            // First try to get the location where this item has inventory
            const inventoryLocationResult = await db.query(
                `SELECT ic.location_id
                 FROM inventory_counts ic
                 JOIN locations l ON ic.location_id = l.id
                 WHERE ic.catalog_object_id = $1 AND l.active = TRUE AND ic.state = 'IN_STOCK'
                 ORDER BY ic.quantity DESC NULLS LAST
                 LIMIT 1`,
                [id]
            );

            if (inventoryLocationResult.rows.length > 0) {
                targetLocationId = inventoryLocationResult.rows[0].location_id;
            } else {
                // Fall back to the primary/first active location
                const locationResult = await db.query(
                    'SELECT id FROM locations WHERE active = TRUE ORDER BY name LIMIT 1'
                );

                if (locationResult.rows.length === 0) {
                    return res.status(400).json({
                        error: 'No active locations found. Please sync locations first.'
                    });
                }

                targetLocationId = locationResult.rows[0].id;
            }
        }

        // Push update to Square (location-specific)
        logger.info('Updating min stock in Square', {
            variationId: id,
            sku: variation.sku,
            locationId: targetLocationId,
            previousValue,
            newValue: min_stock
        });

        try {
            await squareApi.setSquareInventoryAlertThreshold(id, targetLocationId, min_stock);
        } catch (squareError) {
            logger.error('Failed to update Square inventory alert threshold', {
                variationId: id,
                locationId: targetLocationId,
                error: squareError.message
            });
            return res.status(500).json({
                error: 'Failed to update Square: ' + squareError.message,
                square_error: true
            });
        }

        // Update local database (variation-level)
        await db.query(
            `UPDATE variations
             SET inventory_alert_threshold = $1,
                 inventory_alert_type = $2,
                 stock_alert_min = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [
                min_stock,
                min_stock !== null && min_stock > 0 ? 'LOW_QUANTITY' : 'NONE',
                id
            ]
        );

        // Also update location-specific settings if table exists
        await db.query(
            `INSERT INTO variation_location_settings (variation_id, location_id, stock_alert_min, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (variation_id, location_id)
             DO UPDATE SET stock_alert_min = EXCLUDED.stock_alert_min, updated_at = CURRENT_TIMESTAMP`,
            [id, targetLocationId, min_stock]
        );

        logger.info('Min stock updated successfully', {
            variationId: id,
            sku: variation.sku,
            itemName: variation.item_name,
            locationId: targetLocationId,
            previousValue,
            newValue: min_stock
        });

        res.json({
            success: true,
            variation_id: id,
            sku: variation.sku,
            location_id: targetLocationId,
            previous_value: previousValue,
            new_value: min_stock,
            synced_to_square: true
        });

    } catch (error) {
        logger.error('Update min stock error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/variations/:id/cost
 * Update unit cost (vendor cost) and sync to Square
 */
app.patch('/api/variations/:id/cost', async (req, res) => {
    try {
        const { id } = req.params;
        const { cost_cents, vendor_id } = req.body;

        // Validate input
        if (cost_cents === undefined || cost_cents === null) {
            return res.status(400).json({ error: 'cost_cents is required' });
        }

        if (typeof cost_cents !== 'number' || cost_cents < 0) {
            return res.status(400).json({ error: 'cost_cents must be a non-negative number' });
        }

        // Get variation details
        const variationResult = await db.query(`
            SELECT v.id, v.sku, v.name, i.name as item_name,
                   vv.vendor_id, vv.unit_cost_money as current_cost,
                   ven.name as vendor_name
            FROM variations v
            JOIN items i ON v.item_id = i.id
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id
            LEFT JOIN vendors ven ON vv.vendor_id = ven.id
            WHERE v.id = $1
            ORDER BY vv.unit_cost_money ASC NULLS LAST
            LIMIT 1
        `, [id]);

        if (variationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const variation = variationResult.rows[0];
        const targetVendorId = vendor_id || variation.vendor_id;
        const previousCost = variation.current_cost;

        // If we have a vendor, update Square and local DB
        if (targetVendorId) {
            try {
                const squareResult = await squareApi.updateVariationCost(
                    id,
                    targetVendorId,
                    Math.round(cost_cents),
                    'CAD'
                );

                logger.info('Cost updated in Square', {
                    variationId: id,
                    sku: variation.sku,
                    vendorId: targetVendorId,
                    oldCost: previousCost,
                    newCost: cost_cents
                });

                res.json({
                    success: true,
                    variation_id: id,
                    sku: variation.sku,
                    item_name: variation.item_name,
                    vendor_id: targetVendorId,
                    vendor_name: variation.vendor_name,
                    previous_cost_cents: previousCost,
                    new_cost_cents: cost_cents,
                    synced_to_square: true
                });

            } catch (squareError) {
                logger.error('Square cost update failed', {
                    variationId: id,
                    error: squareError.message
                });
                return res.status(500).json({
                    error: 'Failed to update cost in Square: ' + squareError.message,
                    square_error: true
                });
            }
        } else {
            // No vendor - save locally only (can't push to Square without vendor)
            // Update local variation_vendors with a null vendor or just log the cost
            logger.warn('Cost update without vendor - saving locally only', {
                variationId: id,
                sku: variation.sku,
                cost_cents
            });

            // Store in variations table as a fallback cost field (if you have one)
            // For now, just acknowledge the limitation
            res.json({
                success: true,
                variation_id: id,
                sku: variation.sku,
                item_name: variation.item_name,
                vendor_id: null,
                vendor_name: null,
                previous_cost_cents: previousCost,
                new_cost_cents: cost_cents,
                synced_to_square: false,
                warning: 'No vendor associated - cost saved locally only. Assign a vendor to sync cost to Square.'
            });
        }

    } catch (error) {
        logger.error('Update cost error', { error: error.message, stack: error.stack });
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
        const squarePushResults = { success: 0, failed: 0, errors: [] };

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

                // Track if case_pack_quantity is being updated
                const casePackUpdate = update.case_pack_quantity !== undefined;
                const newCasePackValue = update.case_pack_quantity;

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

                    // Get variation ID before updating (needed for Square sync)
                    const variationResult = await db.query(
                        'SELECT id FROM variations WHERE sku = $1',
                        [update.sku]
                    );

                    await db.query(`
                        UPDATE variations
                        SET ${sets.join(', ')}
                        WHERE sku = $${paramCount}
                    `, values);
                    updatedCount++;

                    // Auto-sync case_pack_quantity to Square if updated with valid value (must be > 0)
                    if (casePackUpdate && newCasePackValue !== null && newCasePackValue > 0 && variationResult.rows.length > 0) {
                        const variationId = variationResult.rows[0].id;
                        try {
                            await squareApi.updateCustomAttributeValues(variationId, {
                                case_pack_quantity: {
                                    number_value: newCasePackValue.toString()
                                }
                            });
                            squarePushResults.success++;
                            logger.info('Case pack synced to Square (bulk)', { variation_id: variationId, sku: update.sku, case_pack: newCasePackValue });
                        } catch (syncError) {
                            squarePushResults.failed++;
                            squarePushResults.errors.push({ sku: update.sku, error: syncError.message });
                            logger.error('Failed to sync case pack to Square (bulk)', { sku: update.sku, error: syncError.message });
                        }
                    }
                }
            } catch (error) {
                errors.push({ sku: update.sku, error: error.message });
            }
        }

        res.json({
            status: 'success',
            updated_count: updatedCount,
            errors: errors,
            squarePush: squarePushResults
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

        // Check if reviewed_at column exists (for backwards compatibility)
        let hasReviewedColumn = false;
        try {
            const colCheck = await db.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'variation_expiration' AND column_name = 'reviewed_at'
            `);
            hasReviewedColumn = colCheck.rows.length > 0;
        } catch (e) {
            // Column check failed, assume it doesn't exist
        }

        let query = `
            SELECT
                v.id as identifier,
                i.name as name,
                v.name as variation,
                v.sku,
                v.upc as gtin,
                v.price_money,
                v.currency,
                i.category_name,
                ve.expiration_date,
                ve.does_not_expire,
                ${hasReviewedColumn ? 've.reviewed_at,' : ''}
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
            GROUP BY v.id, i.name, v.name, v.sku, v.upc, v.price_money, v.currency,
                     i.category_name, ve.expiration_date, ve.does_not_expire, ${hasReviewedColumn ? 've.reviewed_at,' : ''} v.images, i.images
        `;

        // Filter by expiry timeframe (applied after grouping)
        if (expiry) {
            if (expiry === 'no-expiry') {
                query += ` HAVING ve.expiration_date IS NULL AND (ve.does_not_expire IS NULL OR ve.does_not_expire = FALSE)`;
            } else if (expiry === 'never-expires') {
                query += ` HAVING ve.does_not_expire = TRUE`;
            } else if (expiry === 'review') {
                // Review items: 90-120 days out, NOT already reviewed in last 30 days
                query += ` HAVING ve.expiration_date IS NOT NULL
                          AND ve.does_not_expire = FALSE
                          AND ve.expiration_date >= NOW() + INTERVAL '90 days'
                          AND ve.expiration_date <= NOW() + INTERVAL '120 days'`;
                if (hasReviewedColumn) {
                    query += ` AND (ve.reviewed_at IS NULL OR ve.reviewed_at < NOW() - INTERVAL '30 days')`;
                }
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

        // Resolve image URLs in a SINGLE batch query
        const imageUrlMap = await batchResolveImageUrls(result.rows);
        const items = result.rows.map((row, index) => ({
            ...row,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,  // Remove raw image IDs from response
            item_images: undefined  // Remove from response
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
        let squarePushResults = { success: 0, failed: 0, errors: [] };

        for (const change of changes) {
            const { variation_id, expiration_date, does_not_expire } = change;

            if (!variation_id) {
                logger.warn('Skipping change - no variation_id', change);
                continue;
            }

            // Determine effective expiration date
            // If no date and not "does not expire", use 2020-01-01 to trigger review
            let effectiveExpirationDate = expiration_date || null;
            if (!expiration_date && does_not_expire !== true) {
                effectiveExpirationDate = '2020-01-01';
            }

            // Save to local database
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
                effectiveExpirationDate,
                does_not_expire === true
            ]);

            updatedCount++;

            // Push to Square
            try {
                const customAttributeValues = {};

                // Handle expiration_date
                if (expiration_date) {
                    customAttributeValues.expiration_date = { string_value: expiration_date };
                } else if (does_not_expire !== true) {
                    // No date and doesn't have "does not expire" flag - set to 2020-01-01 to trigger review
                    customAttributeValues.expiration_date = { string_value: '2020-01-01' };
                }

                // Always push does_not_expire toggle (it's a real setting)
                customAttributeValues.does_not_expire = { boolean_value: does_not_expire === true };

                await squareApi.updateCustomAttributeValues(variation_id, customAttributeValues);
                squarePushResults.success++;
                logger.info('Pushed expiry to Square', { variation_id, expiration_date, does_not_expire });
            } catch (squareError) {
                squarePushResults.failed++;
                squarePushResults.errors.push({ variation_id, error: squareError.message });
                logger.error('Failed to push expiry to Square', {
                    variation_id,
                    error: squareError.message
                });
            }
        }

        logger.info('Updated expirations', {
            count: updatedCount,
            squarePush: squarePushResults
        });

        res.json({
            success: true,
            message: `Updated ${updatedCount} expiration record(s)`,
            squarePush: squarePushResults
        });

    } catch (error) {
        logger.error('Save expirations error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to save expiration data', details: error.message });
    }
});

/**
 * POST /api/expirations/review
 * Mark items as reviewed (so they don't reappear in review filter)
 * Also syncs reviewed_at timestamp to Square for cross-platform consistency
 */
app.post('/api/expirations/review', async (req, res) => {
    try {
        const { variation_ids, reviewed_by } = req.body;

        if (!Array.isArray(variation_ids) || variation_ids.length === 0) {
            return res.status(400).json({ error: 'Expected array of variation_ids' });
        }

        // Check if reviewed_at column exists
        let hasReviewedColumn = false;
        try {
            const colCheck = await db.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'variation_expiration' AND column_name = 'reviewed_at'
            `);
            hasReviewedColumn = colCheck.rows.length > 0;
        } catch (e) {
            // Column check failed
        }

        if (!hasReviewedColumn) {
            return res.status(503).json({
                error: 'Review feature not available',
                details: 'Please restart the server to apply database migrations.'
            });
        }

        let reviewedCount = 0;
        const reviewedAt = new Date().toISOString();
        let squarePushResults = { success: 0, failed: 0, errors: [] };

        for (const variation_id of variation_ids) {
            // Save to local database
            await db.query(`
                INSERT INTO variation_expiration (variation_id, reviewed_at, reviewed_by, updated_at)
                VALUES ($1, NOW(), $2, NOW())
                ON CONFLICT (variation_id)
                DO UPDATE SET
                    reviewed_at = NOW(),
                    reviewed_by = COALESCE($2, variation_expiration.reviewed_by),
                    updated_at = NOW()
            `, [variation_id, reviewed_by || 'User']);

            reviewedCount++;

            // Push to Square for cross-platform consistency (both timestamp and user)
            try {
                const customAttributeValues = {
                    expiry_reviewed_at: { string_value: reviewedAt }
                };
                // Also push reviewed_by if provided
                if (reviewed_by) {
                    customAttributeValues.expiry_reviewed_by = { string_value: reviewed_by };
                }
                await squareApi.updateCustomAttributeValues(variation_id, customAttributeValues);
                squarePushResults.success++;
            } catch (squareError) {
                squarePushResults.failed++;
                squarePushResults.errors.push({ variation_id, error: squareError.message });
                logger.warn('Failed to push review data to Square', {
                    variation_id,
                    error: squareError.message
                });
            }
        }

        logger.info('Marked items as reviewed', { count: reviewedCount, reviewed_by, squarePush: squarePushResults });

        res.json({
            success: true,
            message: `Marked ${reviewedCount} item(s) as reviewed`,
            reviewed_count: reviewedCount,
            squarePush: squarePushResults
        });

    } catch (error) {
        logger.error('Mark as reviewed error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to mark items as reviewed', details: error.message });
    }
});

// ==================== EXPIRY DISCOUNT ENDPOINTS ====================

/**
 * GET /api/expiry-discounts/status
 * Get summary of current expiry discount status
 */
app.get('/api/expiry-discounts/status', async (req, res) => {
    try {
        const summary = await expiryDiscount.getDiscountStatusSummary();
        res.json(summary);
    } catch (error) {
        logger.error('Get expiry discount status error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/tiers
 * Get all discount tier configurations
 */
app.get('/api/expiry-discounts/tiers', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM expiry_discount_tiers
            ORDER BY priority DESC
        `);
        res.json({ tiers: result.rows });
    } catch (error) {
        logger.error('Get expiry discount tiers error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/expiry-discounts/tiers/:id
 * Update a discount tier configuration
 */
app.patch('/api/expiry-discounts/tiers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Build dynamic update query
        const allowedFields = [
            'tier_name', 'min_days_to_expiry', 'max_days_to_expiry',
            'discount_percent', 'is_auto_apply', 'requires_review',
            'color_code', 'priority', 'is_active'
        ];

        const setClauses = [];
        const params = [id];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                params.push(value);
                setClauses.push(`${key} = $${params.length}`);
            }
        }

        if (setClauses.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        setClauses.push('updated_at = NOW()');

        const result = await db.query(`
            UPDATE expiry_discount_tiers
            SET ${setClauses.join(', ')}
            WHERE id = $1
            RETURNING *
        `, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tier not found' });
        }

        logger.info('Updated expiry discount tier', { id, updates });
        res.json({ tier: result.rows[0] });

    } catch (error) {
        logger.error('Update expiry discount tier error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/variations
 * Get variations with their discount status
 */
app.get('/api/expiry-discounts/variations', async (req, res) => {
    try {
        const { tier_code, needs_pull, limit = 100, offset = 0 } = req.query;

        let query = `
            SELECT
                vds.variation_id,
                vds.days_until_expiry,
                vds.original_price_cents,
                vds.discounted_price_cents,
                vds.discount_applied_at,
                vds.needs_pull,
                vds.last_evaluated_at,
                v.sku,
                v.name as variation_name,
                v.price_money as current_price_cents,
                v.images,
                i.name as item_name,
                i.id as item_id,
                i.category_name,
                i.images as item_images,
                ve.expiration_date,
                ve.does_not_expire,
                ve.reviewed_at,
                edt.id as tier_id,
                edt.tier_code,
                edt.tier_name,
                edt.discount_percent,
                edt.color_code,
                edt.is_auto_apply,
                edt.requires_review,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0) as current_stock,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0)
                    - COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as available_to_sell
            FROM variation_discount_status vds
            JOIN variations v ON vds.variation_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE')
            WHERE v.is_deleted = FALSE
        `;

        const params = [];

        if (tier_code) {
            params.push(tier_code);
            query += ` AND edt.tier_code = $${params.length}`;
        }

        if (needs_pull === 'true') {
            query += ` AND vds.needs_pull = TRUE`;
        }

        query += `
            GROUP BY vds.variation_id, vds.days_until_expiry, vds.original_price_cents,
                     vds.discounted_price_cents, vds.discount_applied_at, vds.needs_pull,
                     vds.last_evaluated_at, v.sku, v.name, v.price_money, v.images, i.name, i.id,
                     i.category_name, i.images, ve.expiration_date, ve.does_not_expire, ve.reviewed_at,
                     edt.id, edt.tier_code, edt.tier_name, edt.discount_percent, edt.color_code,
                     edt.is_auto_apply, edt.requires_review
            ORDER BY vds.days_until_expiry ASC NULLS LAST
        `;

        params.push(parseInt(limit));
        query += ` LIMIT $${params.length}`;

        params.push(parseInt(offset));
        query += ` OFFSET $${params.length}`;

        const result = await db.query(query, params);

        // Get total count for pagination
        let countQuery = `
            SELECT COUNT(DISTINCT vds.variation_id) as total
            FROM variation_discount_status vds
            JOIN variations v ON vds.variation_id = v.id
            LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id
            WHERE v.is_deleted = FALSE
        `;

        if (tier_code) {
            countQuery += ` AND edt.tier_code = '${tier_code}'`;
        }
        if (needs_pull === 'true') {
            countQuery += ` AND vds.needs_pull = TRUE`;
        }

        const countResult = await db.query(countQuery);

        // Resolve image URLs
        const imageUrlMap = await batchResolveImageUrls(result.rows);
        const variations = result.rows.map((row, index) => ({
            ...row,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,
            item_images: undefined
        }));

        res.json({
            variations,
            total: parseInt(countResult.rows[0]?.total || 0),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

    } catch (error) {
        logger.error('Get expiry discount variations error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/evaluate
 * Run expiry tier evaluation for all variations
 */
app.post('/api/expiry-discounts/evaluate', async (req, res) => {
    try {
        const { dry_run = false } = req.body;

        logger.info('Manual expiry evaluation requested', { dry_run });

        const result = await expiryDiscount.evaluateAllVariations({
            dryRun: dry_run,
            triggeredBy: 'MANUAL'
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('Expiry evaluation error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/apply
 * Apply discounts based on current tier assignments
 */
app.post('/api/expiry-discounts/apply', async (req, res) => {
    try {
        const { dry_run = false } = req.body;

        logger.info('Manual discount application requested', { dry_run });

        const result = await expiryDiscount.applyDiscounts({ dryRun: dry_run });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('Discount application error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/run
 * Run full expiry discount automation (evaluate + apply)
 */
app.post('/api/expiry-discounts/run', async (req, res) => {
    try {
        const { dry_run = false } = req.body;

        logger.info('Full expiry discount automation requested', { dry_run });

        const result = await expiryDiscount.runExpiryDiscountAutomation({ dryRun: dry_run });

        // Send email notification if enabled and not dry run
        if (!dry_run && result.evaluation) {
            const tierChanges = result.evaluation.tierChanges?.length || 0;
            const newAssignments = result.evaluation.newAssignments?.length || 0;

            if (tierChanges > 0 || newAssignments > 0) {
                const emailEnabled = await expiryDiscount.getSetting('email_notifications');
                if (emailEnabled === 'true') {
                    try {
                        await emailNotifier.sendAlert(
                            'Expiry Discount Automation Report',
                            `Expiry discount automation completed.\n\n` +
                            `Summary:\n` +
                            `- Total evaluated: ${result.evaluation.totalEvaluated}\n` +
                            `- Tier changes: ${tierChanges}\n` +
                            `- New assignments: ${newAssignments}\n` +
                            `- Discounts applied: ${result.discountApplication?.applied?.length || 0}\n` +
                            `- Discounts removed: ${result.discountApplication?.removed?.length || 0}\n` +
                            `- Errors: ${result.errors?.length || 0}\n\n` +
                            `Duration: ${result.duration}ms`
                        );
                    } catch (emailError) {
                        logger.error('Failed to send automation email', { error: emailError.message });
                    }
                }
            }
        }

        res.json(result);

    } catch (error) {
        logger.error('Expiry discount automation error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/init-square
 * Initialize Square discount objects for all tiers
 */
app.post('/api/expiry-discounts/init-square', async (req, res) => {
    try {
        logger.info('Square discount initialization requested');

        const result = await expiryDiscount.initializeSquareDiscounts();

        res.json({
            success: result.errors.length === 0,
            ...result
        });

    } catch (error) {
        logger.error('Square discount init error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/audit-log
 * Get audit log of discount changes
 */
app.get('/api/expiry-discounts/audit-log', async (req, res) => {
    try {
        const { variation_id, limit = 100 } = req.query;

        const logs = await expiryDiscount.getAuditLog({
            variationId: variation_id,
            limit: parseInt(limit)
        });

        res.json({ logs });

    } catch (error) {
        logger.error('Get audit log error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/settings
 * Get expiry discount system settings
 */
app.get('/api/expiry-discounts/settings', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT setting_key, setting_value, description
            FROM expiry_discount_settings
            ORDER BY setting_key
        `);

        const settings = {};
        for (const row of result.rows) {
            settings[row.setting_key] = {
                value: row.setting_value,
                description: row.description
            };
        }

        res.json({ settings });

    } catch (error) {
        logger.error('Get expiry discount settings error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/expiry-discounts/settings
 * Update expiry discount system settings
 */
app.patch('/api/expiry-discounts/settings', async (req, res) => {
    try {
        const updates = req.body;

        for (const [key, value] of Object.entries(updates)) {
            await expiryDiscount.updateSetting(key, value);
        }

        logger.info('Updated expiry discount settings', { updates });

        res.json({ success: true, message: 'Settings updated' });

    } catch (error) {
        logger.error('Update expiry discount settings error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== INVENTORY ENDPOINTS ====================

/**
 * GET /api/inventory
 * Get current inventory levels
 */
app.get('/api/inventory', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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
                 JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $1
                 WHERE vv.variation_id = v.id AND vv.merchant_id = $1
                 ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                 LIMIT 1
                ) as vendor_name,
                (SELECT vv.vendor_code
                 FROM variation_vendors vv
                 WHERE vv.variation_id = v.id AND vv.merchant_id = $1
                 ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                 LIMIT 1
                ) as vendor_code,
                (SELECT vv.unit_cost_money
                 FROM variation_vendors vv
                 WHERE vv.variation_id = v.id AND vv.merchant_id = $1
                 ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                 LIMIT 1
                ) as unit_cost_cents
            FROM inventory_counts ic
            JOIN variations v ON ic.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $1
            LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91 AND sv91.merchant_id = $1
            LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $1
            LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $1
            WHERE ic.state = 'IN_STOCK'
              AND ic.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
        `;
        const params = [merchantId];

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
app.get('/api/low-stock', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $1
            JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $1
            WHERE v.merchant_id = $1
              AND v.stock_alert_min IS NOT NULL
              AND ic.quantity < v.stock_alert_min
              AND ic.state = 'IN_STOCK'
              AND v.discontinued = FALSE
            ORDER BY (v.stock_alert_min - ic.quantity) DESC, i.name
        `;

        const result = await db.query(query, [merchantId]);

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
                    i.present_at_all_locations as item_present_at_all,
                    v.present_at_all_locations as variation_present_at_all,
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
                -- Inventory alerts not enabled - check both variation-level AND location-level settings
                (
                    (inventory_alert_type IS NULL OR inventory_alert_type != 'LOW_QUANTITY')
                    AND (location_stock_alert_min IS NULL OR location_stock_alert_min = 0)
                ) as inventory_alerts_off,
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
                -- SEO fields
                (seo_title IS NULL OR seo_title = '') as missing_seo_title,
                (seo_description IS NULL OR seo_description = '') as missing_seo_description,
                -- Tax configuration
                (tax_ids IS NULL OR tax_ids::text = '[]' OR tax_ids::text = 'null') as no_tax_ids,
                -- Location mismatch: variation enabled at all locations but parent item is not
                (variation_present_at_all = TRUE AND item_present_at_all = FALSE) as location_mismatch,
                -- Sales channel flags
                (
                    (item_present_at_all = FALSE OR item_present_at_all IS NULL)
                    OR (available_online = FALSE OR available_online IS NULL)
                ) as any_channel_off,
                (item_present_at_all = FALSE OR item_present_at_all IS NULL) as pos_disabled,
                (available_online = FALSE OR available_online IS NULL) as online_disabled
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
            inventory_alerts_off: result.rows.filter(r => r.inventory_alerts_off).length,
            no_reorder_threshold: result.rows.filter(r => r.no_reorder_threshold).length,
            missing_vendor: result.rows.filter(r => r.missing_vendor).length,
            missing_cost: result.rows.filter(r => r.missing_cost).length,
            missing_seo_title: result.rows.filter(r => r.missing_seo_title).length,
            missing_seo_description: result.rows.filter(r => r.missing_seo_description).length,
            no_tax_ids: result.rows.filter(r => r.no_tax_ids).length,
            location_mismatch: result.rows.filter(r => r.location_mismatch).length,
            any_channel_off: result.rows.filter(r => r.any_channel_off).length,
            pos_disabled: result.rows.filter(r => r.pos_disabled).length,
            online_disabled: result.rows.filter(r => r.online_disabled).length
        };

        // Count items with at least one issue
        stats.items_with_issues = result.rows.filter(r =>
            r.missing_category || r.not_taxable || r.missing_price ||
            r.missing_description || r.missing_item_image || r.missing_sku ||
            r.missing_upc || r.stock_tracking_off || r.inventory_alerts_off || r.no_reorder_threshold ||
            r.missing_vendor || r.missing_cost || r.location_mismatch || r.any_channel_off
        ).length;

        // Filter by specific issue type if requested
        let filteredData = result.rows;
        if (issue_type) {
            filteredData = result.rows.filter(r => r[issue_type] === true);
        }

        // Batch resolve ALL image URLs in a SINGLE query (much faster than per-item)
        const imageUrlMap = await batchResolveImageUrls(filteredData.map(row => ({
            images: row.variation_images,
            item_images: row.item_images
        })));

        // Calculate issue count per item (synchronous - no DB calls)
        const itemsWithIssueCounts = filteredData.map((row, index) => {
            let issueCount = 0;
            const issues = [];

            if (row.missing_category) { issueCount++; issues.push('No Category'); }
            if (row.not_taxable) { issueCount++; issues.push('Not Taxable'); }
            if (row.missing_price) { issueCount++; issues.push('No Price'); }
            if (row.missing_description) { issueCount++; issues.push('No Description'); }
            if (row.missing_item_image) { issueCount++; issues.push('No Image'); }
            if (row.missing_sku) { issueCount++; issues.push('No SKU'); }
            if (row.missing_upc) { issueCount++; issues.push('No UPC'); }
            if (row.stock_tracking_off) { issueCount++; issues.push('Stock Tracking Off'); }
            if (row.inventory_alerts_off) { issueCount++; issues.push('Inv Alerts Off'); }
            if (row.no_reorder_threshold) { issueCount++; issues.push('OOS, No Min'); }
            if (row.missing_vendor) { issueCount++; issues.push('No Vendor'); }
            if (row.missing_cost) { issueCount++; issues.push('No Cost'); }
            if (row.location_mismatch) { issueCount++; issues.push('Location Mismatch'); }
            // Sales channels
            if (row.any_channel_off) { issueCount++; issues.push('Channel Disabled'); }
            if (row.pos_disabled) { issues.push('POS Disabled'); }
            if (row.online_disabled) { issues.push('Online Disabled'); }
            // SEO fields
            if (row.missing_seo_title) { issues.push('No SEO Title'); }
            if (row.missing_seo_description) { issues.push('No SEO Description'); }
            // Tax configuration
            if (row.no_tax_ids) { issues.push('No Tax IDs'); }

            return {
                ...row,
                issue_count: issueCount,
                issues: issues,
                image_urls: imageUrlMap.get(index) || [],
                // Clean up internal fields
                variation_images: undefined,
                item_images: undefined
            };
        });

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

/**
 * POST /api/catalog-audit/fix-locations
 * Fix all location mismatches by setting items/variations to present_at_all_locations = true
 */
app.post('/api/catalog-audit/fix-locations', async (req, res) => {
    try {
        logger.info('Starting location mismatch fix from API');

        const result = await squareApi.fixLocationMismatches();

        if (result.success) {
            res.json({
                success: true,
                message: `Fixed ${result.itemsFixed} items and ${result.variationsFixed} variations`,
                itemsFixed: result.itemsFixed,
                variationsFixed: result.variationsFixed,
                details: result.details
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Some items could not be fixed',
                itemsFixed: result.itemsFixed,
                variationsFixed: result.variationsFixed,
                errors: result.errors,
                details: result.details
            });
        }
    } catch (error) {
        logger.error('Fix location mismatches error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== SQUARE CUSTOM ATTRIBUTES ====================

/**
 * GET /api/square/custom-attributes
 * List all custom attribute definitions from Square
 */
app.get('/api/square/custom-attributes', async (req, res) => {
    try {
        const definitions = await squareApi.listCustomAttributeDefinitions();
        res.json({
            success: true,
            count: definitions.length,
            definitions
        });
    } catch (error) {
        logger.error('List custom attributes error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/debug/expiry-status
 * Debug endpoint to check expiration sync status
 */
app.get('/api/debug/expiry-status', async (req, res) => {
    try {
        const { sku, variation_id } = req.query;

        let query = `
            SELECT ve.variation_id, ve.expiration_date, ve.does_not_expire,
                   ve.reviewed_at, ve.reviewed_by, ve.updated_at,
                   v.sku, v.name as variation_name, v.custom_attributes,
                   i.name as item_name
            FROM variation_expiration ve
            JOIN variations v ON ve.variation_id = v.id
            JOIN items i ON v.item_id = i.id
        `;
        const params = [];

        if (sku) {
            params.push(sku);
            query += ` WHERE v.sku = $1`;
        } else if (variation_id) {
            params.push(variation_id);
            query += ` WHERE ve.variation_id = $1`;
        } else {
            // Show recently reviewed items
            query += ` WHERE ve.reviewed_at IS NOT NULL ORDER BY ve.reviewed_at DESC LIMIT 10`;
        }

        const result = await db.query(query, params);
        res.json({
            count: result.rows.length,
            data: result.rows,
            query_params: { sku, variation_id }
        });
    } catch (error) {
        logger.error('Debug expiry status error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/init
 * Initialize custom attribute definitions in Square
 * Creates: case_pack_quantity (NUMBER), brand (STRING)
 */
app.post('/api/square/custom-attributes/init', async (req, res) => {
    try {
        logger.info('Initializing custom attribute definitions');
        const result = await squareApi.initializeCustomAttributes();
        res.json(result);
    } catch (error) {
        logger.error('Init custom attributes error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/definition
 * Create or update a single custom attribute definition
 */
app.post('/api/square/custom-attributes/definition', async (req, res) => {
    try {
        const definition = req.body;

        if (!definition.key || !definition.name) {
            return res.status(400).json({ error: 'key and name are required' });
        }

        const result = await squareApi.upsertCustomAttributeDefinition(definition);
        res.json(result);
    } catch (error) {
        logger.error('Create custom attribute definition error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/square/custom-attributes/definition/:key
 * Delete a custom attribute definition by key or ID
 * WARNING: This also deletes all values using this definition
 */
app.delete('/api/square/custom-attributes/definition/:key', async (req, res) => {
    try {
        const { key } = req.params;
        logger.info('Deleting custom attribute definition', { key });
        const result = await squareApi.deleteCustomAttributeDefinition(key);
        res.json(result);
    } catch (error) {
        logger.error('Delete custom attribute definition error', { error: error.message, key: req.params.key });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/square/custom-attributes/:objectId
 * Update custom attribute values on a single catalog object (item or variation)
 */
app.put('/api/square/custom-attributes/:objectId', async (req, res) => {
    try {
        const { objectId } = req.params;
        const customAttributeValues = req.body;

        if (!customAttributeValues || Object.keys(customAttributeValues).length === 0) {
            return res.status(400).json({ error: 'customAttributeValues object is required' });
        }

        const result = await squareApi.updateCustomAttributeValues(objectId, customAttributeValues);
        res.json(result);
    } catch (error) {
        logger.error('Update custom attribute values error', { error: error.message, objectId: req.params.objectId });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/case-pack
 * Push all local case_pack_quantity values to Square
 */
app.post('/api/square/custom-attributes/push/case-pack', async (req, res) => {
    try {
        logger.info('Pushing case pack quantities to Square');
        const result = await squareApi.pushCasePackToSquare();
        res.json(result);
    } catch (error) {
        logger.error('Push case pack error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/brand
 * Push all local brand assignments to Square
 */
app.post('/api/square/custom-attributes/push/brand', async (req, res) => {
    try {
        logger.info('Pushing brand assignments to Square');
        const result = await squareApi.pushBrandsToSquare();
        res.json(result);
    } catch (error) {
        logger.error('Push brands error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/expiry
 * Push all local expiration dates to Square
 */
app.post('/api/square/custom-attributes/push/expiry', async (req, res) => {
    try {
        logger.info('Pushing expiry dates to Square');
        const result = await squareApi.pushExpiryDatesToSquare();
        res.json(result);
    } catch (error) {
        logger.error('Push expiry dates error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/all
 * Push all local custom attribute data to Square (case pack, brand, expiry)
 */
app.post('/api/square/custom-attributes/push/all', async (req, res) => {
    try {
        logger.info('Pushing all custom attributes to Square');

        const results = {
            success: true,
            casePack: null,
            brand: null,
            expiry: null,
            errors: []
        };

        // Push case pack quantities
        try {
            results.casePack = await squareApi.pushCasePackToSquare();
        } catch (error) {
            results.errors.push({ type: 'casePack', error: error.message });
            results.success = false;
        }

        // Push brand assignments
        try {
            results.brand = await squareApi.pushBrandsToSquare();
        } catch (error) {
            results.errors.push({ type: 'brand', error: error.message });
            results.success = false;
        }

        // Push expiry dates
        try {
            results.expiry = await squareApi.pushExpiryDatesToSquare();
        } catch (error) {
            results.errors.push({ type: 'expiry', error: error.message });
            results.success = false;
        }

        res.json(results);
    } catch (error) {
        logger.error('Push all custom attributes error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== GOOGLE OAUTH & SHEETS ENDPOINTS ====================

const googleSheets = require('./utils/google-sheets');

/**
 * GET /api/google/status
 * Check Google OAuth authentication status
 */
app.get('/api/google/status', async (req, res) => {
    try {
        const status = await googleSheets.getAuthStatus();
        res.json(status);
    } catch (error) {
        logger.error('Google status error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/google/auth
 * Start Google OAuth flow - redirects to Google consent screen
 * Uses GOOGLE_REDIRECT_URI from environment (not request hostname) to prevent private IP issues
 */
app.get('/api/google/auth', async (req, res) => {
    try {
        const authUrl = googleSheets.getAuthUrl();
        logger.info('Redirecting to Google OAuth', { redirectUri: process.env.GOOGLE_REDIRECT_URI });
        res.redirect(authUrl);
    } catch (error) {
        logger.error('Google auth error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/google/callback
 * Google OAuth callback - exchanges code for tokens
 *
 * IMPORTANT: After OAuth, we redirect to PUBLIC_APP_URL (not relative path).
 * This ensures the browser goes to the correct host (e.g., LAN IP) instead of
 * staying on localhost (which Google redirected to for the OAuth callback).
 */
app.get('/api/google/callback', async (req, res) => {
    // Get the public URL for post-OAuth redirects
    // This may differ from the OAuth callback URL (e.g., LAN IP vs localhost)
    const publicUrl = getPublicAppUrl(req);

    try {
        const { code, error: oauthError } = req.query;

        if (oauthError) {
            logger.error('Google OAuth error', { error: oauthError });
            return res.redirect(`${publicUrl}/settings.html?google_error=${encodeURIComponent(oauthError)}`);
        }

        if (!code) {
            return res.redirect(`${publicUrl}/settings.html?google_error=no_code`);
        }

        await googleSheets.exchangeCodeForTokens(code);
        logger.info('Google OAuth successful, redirecting to public URL', { publicUrl });
        res.redirect(`${publicUrl}/settings.html?google_connected=true`);
    } catch (error) {
        logger.error('Google callback error', { error: error.message });
        res.redirect(`${publicUrl}/settings.html?google_error=${encodeURIComponent(error.message)}`);
    }
});

/**
 * POST /api/google/disconnect
 * Disconnect Google OAuth (remove tokens)
 */
app.post('/api/google/disconnect', async (req, res) => {
    try {
        await googleSheets.disconnect();
        res.json({ success: true, message: 'Google account disconnected' });
    } catch (error) {
        logger.error('Google disconnect error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/sync-sheet
 * Write GMC feed to Google Sheets
 */
app.post('/api/gmc/sync-sheet', async (req, res) => {
    try {
        const { spreadsheet_id, sheet_name } = req.body;

        if (!spreadsheet_id) {
            return res.status(400).json({ error: 'spreadsheet_id is required' });
        }

        // Check if authenticated
        const authenticated = await googleSheets.isAuthenticated();
        if (!authenticated) {
            return res.status(401).json({
                error: 'Not authenticated with Google',
                authRequired: true
            });
        }

        // Generate feed data
        const { products, stats } = await gmcFeed.generateFeedData();

        // Write to Google Sheet
        const result = await googleSheets.writeFeedToSheet(spreadsheet_id, products, {
            sheetName: sheet_name || 'GMC Feed',
            clearFirst: true
        });

        // Update gmc_settings with spreadsheet ID
        await db.query(`
            INSERT INTO gmc_settings (setting_key, setting_value, description)
            VALUES ('google_sheet_id', $1, 'Google Sheets spreadsheet ID for GMC feed')
            ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP
        `, [spreadsheet_id]);

        res.json({
            success: true,
            stats,
            spreadsheetUrl: result.spreadsheetUrl,
            updatedRows: result.updatedRows
        });
    } catch (error) {
        logger.error('GMC sheet sync error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/google/spreadsheet/:id
 * Get spreadsheet info
 */
app.get('/api/google/spreadsheet/:id', async (req, res) => {
    try {
        const info = await googleSheets.getSpreadsheetInfo(req.params.id);
        res.json(info);
    } catch (error) {
        logger.error('Get spreadsheet error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== GOOGLE MERCHANT CENTER FEED ENDPOINTS ====================

const gmcFeed = require('./utils/gmc-feed');

/**
 * GET /api/gmc/feed
 * Generate and return GMC feed data as JSON
 */
app.get('/api/gmc/feed', async (req, res) => {
    try {
        const { location_id, include_products } = req.query;
        const { products, stats, settings } = await gmcFeed.generateFeedData({
            locationId: location_id,
            includeProducts: include_products === 'true'
        });

        res.json({
            success: true,
            stats,
            settings,
            products
        });
    } catch (error) {
        logger.error('GMC feed generation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/generate
 * Generate GMC feed and save to TSV file
 */
app.post('/api/gmc/generate', async (req, res) => {
    try {
        const { location_id, filename } = req.body;
        const result = await gmcFeed.generateFeed({
            locationId: location_id,
            filename: filename || 'gmc-feed.tsv'
        });

        res.json(result);
    } catch (error) {
        logger.error('GMC feed generation error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/feed.tsv
 * Download the current GMC feed as TSV
 */
app.get('/api/gmc/feed.tsv', async (req, res) => {
    try {
        const { location_id } = req.query;
        const { products } = await gmcFeed.generateFeedData({ locationId: location_id });
        const tsvContent = gmcFeed.generateTsvContent(products);

        res.setHeader('Content-Type', 'text/tab-separated-values');
        res.setHeader('Content-Disposition', 'attachment; filename="gmc-feed.tsv"');
        res.send(tsvContent);
    } catch (error) {
        logger.error('GMC feed download error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/settings
 * Get GMC feed settings
 */
app.get('/api/gmc/settings', async (req, res) => {
    try {
        const settings = await gmcFeed.getSettings();
        res.json({ settings });
    } catch (error) {
        logger.error('GMC settings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/settings
 * Update GMC feed settings
 */
app.put('/api/gmc/settings', async (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Settings object required' });
        }

        for (const [key, value] of Object.entries(settings)) {
            await db.query(`
                INSERT INTO gmc_settings (setting_key, setting_value, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (setting_key) DO UPDATE SET
                    setting_value = EXCLUDED.setting_value,
                    updated_at = CURRENT_TIMESTAMP
            `, [key, value]);
        }

        const updatedSettings = await gmcFeed.getSettings();
        res.json({ success: true, settings: updatedSettings });
    } catch (error) {
        logger.error('GMC settings update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/brands
 * List all brands
 */
app.get('/api/gmc/brands', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM brands ORDER BY name');
        res.json({ count: result.rows.length, brands: result.rows });
    } catch (error) {
        logger.error('GMC brands error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands/import
 * Import brands from array
 */
app.post('/api/gmc/brands/import', async (req, res) => {
    try {
        const { brands } = req.body;
        if (!Array.isArray(brands)) {
            return res.status(400).json({ error: 'Brands array required' });
        }

        const imported = await gmcFeed.importBrands(brands);
        res.json({ success: true, imported });
    } catch (error) {
        logger.error('GMC brands import error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands
 * Create a new brand
 */
app.post('/api/gmc/brands', async (req, res) => {
    try {
        const { name, logo_url, website } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Brand name required' });
        }

        const result = await db.query(
            'INSERT INTO brands (name, logo_url, website) VALUES ($1, $2, $3) RETURNING *',
            [name, logo_url, website]
        );
        res.json({ success: true, brand: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Brand already exists' });
        }
        logger.error('GMC brand create error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/items/:itemId/brand
 * Assign a brand to an item
 * Automatically syncs brand to Square custom attribute
 */
app.put('/api/gmc/items/:itemId/brand', async (req, res) => {
    try {
        const { itemId } = req.params;
        const { brand_id } = req.body;

        let squareSyncResult = null;
        let brandName = null;

        if (!brand_id) {
            // Remove brand assignment
            await db.query('DELETE FROM item_brands WHERE item_id = $1', [itemId]);

            // Also remove from Square (set to empty string)
            try {
                squareSyncResult = await squareApi.updateCustomAttributeValues(itemId, {
                    brand: { string_value: '' }
                });
                logger.info('Brand removed from Square', { item_id: itemId });
            } catch (syncError) {
                logger.error('Failed to remove brand from Square', { item_id: itemId, error: syncError.message });
                squareSyncResult = { success: false, error: syncError.message };
            }

            return res.json({ success: true, message: 'Brand removed from item', square_sync: squareSyncResult });
        }

        // Get brand name for Square sync
        const brandResult = await db.query('SELECT name FROM brands WHERE id = $1', [brand_id]);
        if (brandResult.rows.length === 0) {
            return res.status(404).json({ error: 'Brand not found' });
        }
        brandName = brandResult.rows[0].name;

        // Save to local database
        await db.query(`
            INSERT INTO item_brands (item_id, brand_id)
            VALUES ($1, $2)
            ON CONFLICT (item_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
        `, [itemId, brand_id]);

        // Auto-sync brand to Square
        try {
            squareSyncResult = await squareApi.updateCustomAttributeValues(itemId, {
                brand: { string_value: brandName }
            });
            logger.info('Brand synced to Square', { item_id: itemId, brand: brandName });
        } catch (syncError) {
            logger.error('Failed to sync brand to Square', { item_id: itemId, error: syncError.message });
            squareSyncResult = { success: false, error: syncError.message };
        }

        res.json({ success: true, brand_name: brandName, square_sync: squareSyncResult });
    } catch (error) {
        logger.error('GMC item brand assign error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands/auto-detect
 * Auto-detect brands from item names for items missing brand assignments
 * Matches item names against the provided master brand list only
 * Handles multi-word brands (e.g., "Blue Buffalo", "Taste of the Wild")
 */
app.post('/api/gmc/brands/auto-detect', async (req, res) => {
    try {
        const { brands: brandList } = req.body;

        if (!brandList || !Array.isArray(brandList) || brandList.length === 0) {
            return res.status(400).json({ error: 'brands array required (list of brand names)' });
        }

        // Clean and normalize the master brand list
        const cleanedBrands = brandList
            .filter(b => b && typeof b === 'string' && b.trim())
            .map(b => b.trim());

        if (cleanedBrands.length === 0) {
            return res.status(400).json({ error: 'No valid brand names provided' });
        }

        // Ensure all brands exist in our brands table
        for (const brandName of cleanedBrands) {
            await db.query(
                'INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
                [brandName]
            );
        }

        // Get the brands from the master list with their DB IDs
        // Sort by length DESC so longer brand names match first (e.g., "Blue Buffalo" before "Blue")
        const brandsResult = await db.query(
            `SELECT id, name FROM brands WHERE name = ANY($1) ORDER BY LENGTH(name) DESC`,
            [cleanedBrands]
        );

        // Build matching structures - use lowercase for case-insensitive matching
        const masterBrands = brandsResult.rows.map(b => ({
            id: b.id,
            name: b.name,
            nameLower: b.name.toLowerCase()
        }));

        // Get items without brand assignments
        const itemsResult = await db.query(`
            SELECT i.id, i.name, i.category_name
            FROM items i
            LEFT JOIN item_brands ib ON i.id = ib.item_id
            WHERE ib.item_id IS NULL
              AND i.is_deleted = FALSE
            ORDER BY i.name
        `);

        const detectedMatches = [];
        const noMatch = [];

        for (const item of itemsResult.rows) {
            const itemNameLower = item.name.toLowerCase();
            let matchedBrand = null;

            // Try to match brand from the provided master list
            // Check if item name STARTS WITH the brand name (handles multi-word brands)
            for (const brand of masterBrands) {
                // Check various separators after brand name, or exact match
                if (itemNameLower.startsWith(brand.nameLower + ' ') ||
                    itemNameLower.startsWith(brand.nameLower + '-') ||
                    itemNameLower.startsWith(brand.nameLower + '_') ||
                    itemNameLower.startsWith(brand.nameLower + ':') ||
                    itemNameLower.startsWith(brand.nameLower + ',') ||
                    itemNameLower === brand.nameLower) {
                    matchedBrand = brand;
                    break;  // Stop at first match (longest brands checked first)
                }
            }

            if (matchedBrand) {
                detectedMatches.push({
                    item_id: item.id,
                    item_name: item.name,
                    category: item.category_name,
                    detected_brand_id: matchedBrand.id,
                    detected_brand_name: matchedBrand.name,
                    selected: true  // Default to selected for bulk update
                });
            } else {
                noMatch.push({
                    item_id: item.id,
                    item_name: item.name,
                    category: item.category_name
                });
            }
        }

        res.json({
            success: true,
            master_brands_provided: cleanedBrands.length,
            total_items_without_brand: itemsResult.rows.length,
            detected_count: detectedMatches.length,
            no_match_count: noMatch.length,
            detected: detectedMatches,
            no_match: noMatch
        });
    } catch (error) {
        logger.error('Brand auto-detect error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/brands/bulk-assign
 * Bulk assign brands to items and sync to Square
 * Expects array of {item_id, brand_id} objects
 */
app.post('/api/gmc/brands/bulk-assign', async (req, res) => {
    try {
        const { assignments } = req.body;

        if (!assignments || !Array.isArray(assignments) || assignments.length === 0) {
            return res.status(400).json({ error: 'assignments array required (array of {item_id, brand_id})' });
        }

        const results = {
            success: true,
            assigned: 0,
            synced_to_square: 0,
            failed: 0,
            errors: []
        };

        // Get brand names for Square sync
        const brandIds = [...new Set(assignments.map(a => a.brand_id))];
        const brandsResult = await db.query(
            `SELECT id, name FROM brands WHERE id = ANY($1)`,
            [brandIds]
        );
        const brandNamesMap = new Map(brandsResult.rows.map(b => [b.id, b.name]));

        // Prepare Square batch updates
        const squareUpdates = [];

        for (const assignment of assignments) {
            const { item_id, brand_id } = assignment;

            if (!item_id || !brand_id) {
                results.failed++;
                results.errors.push({ item_id, error: 'Missing item_id or brand_id' });
                continue;
            }

            try {
                // Save to local database
                await db.query(`
                    INSERT INTO item_brands (item_id, brand_id)
                    VALUES ($1, $2)
                    ON CONFLICT (item_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
                `, [item_id, brand_id]);

                results.assigned++;

                // Prepare Square update
                const brandName = brandNamesMap.get(brand_id);
                if (brandName) {
                    squareUpdates.push({
                        catalogObjectId: item_id,
                        customAttributeValues: {
                            brand: { string_value: brandName }
                        }
                    });
                }
            } catch (error) {
                results.failed++;
                results.errors.push({ item_id, error: error.message });
            }
        }

        // Batch sync to Square
        if (squareUpdates.length > 0) {
            try {
                const squareResult = await squareApi.batchUpdateCustomAttributeValues(squareUpdates);
                results.synced_to_square = squareResult.updated || 0;
                results.square_sync = squareResult;

                if (squareResult.errors && squareResult.errors.length > 0) {
                    results.errors.push(...squareResult.errors.map(e => ({ type: 'square_sync', ...e })));
                }
            } catch (syncError) {
                logger.error('Square batch sync failed', { error: syncError.message });
                results.errors.push({ type: 'square_batch_sync', error: syncError.message });
            }
        }

        results.success = results.failed === 0;

        logger.info('Bulk brand assignment complete', {
            assigned: results.assigned,
            synced: results.synced_to_square,
            failed: results.failed
        });

        res.json(results);
    } catch (error) {
        logger.error('Bulk brand assign error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/taxonomy
 * List Google taxonomy categories
 */
app.get('/api/gmc/taxonomy', async (req, res) => {
    try {
        const { search, limit } = req.query;
        let query = 'SELECT * FROM google_taxonomy';
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            query += ` WHERE name ILIKE $${params.length}`;
        }

        query += ' ORDER BY name';

        if (limit) {
            params.push(parseInt(limit));
            query += ` LIMIT $${params.length}`;
        }

        const result = await db.query(query, params);
        res.json({ count: result.rows.length, taxonomy: result.rows });
    } catch (error) {
        logger.error('GMC taxonomy error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/taxonomy/import
 * Import Google taxonomy from array
 */
app.post('/api/gmc/taxonomy/import', async (req, res) => {
    try {
        const { taxonomy } = req.body;
        if (!Array.isArray(taxonomy)) {
            return res.status(400).json({ error: 'Taxonomy array required (array of {id, name})' });
        }

        const imported = await gmcFeed.importGoogleTaxonomy(taxonomy);
        res.json({ success: true, imported });
    } catch (error) {
        logger.error('GMC taxonomy import error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/categories/:categoryId/taxonomy
 * Map a Square category to a Google taxonomy
 */
app.put('/api/gmc/categories/:categoryId/taxonomy', async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { google_taxonomy_id } = req.body;

        if (!google_taxonomy_id) {
            // Remove mapping
            await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1', [categoryId]);
            return res.json({ success: true, message: 'Taxonomy mapping removed' });
        }

        await db.query(`
            INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id)
            VALUES ($1, $2)
            ON CONFLICT (category_id) DO UPDATE SET
                google_taxonomy_id = EXCLUDED.google_taxonomy_id,
                updated_at = CURRENT_TIMESTAMP
        `, [categoryId, google_taxonomy_id]);

        res.json({ success: true });
    } catch (error) {
        logger.error('GMC category taxonomy mapping error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/gmc/categories/:categoryId/taxonomy
 * Remove a category's Google taxonomy mapping
 */
app.delete('/api/gmc/categories/:categoryId/taxonomy', async (req, res) => {
    try {
        const { categoryId } = req.params;
        await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1', [categoryId]);
        res.json({ success: true, message: 'Taxonomy mapping removed' });
    } catch (error) {
        logger.error('GMC category taxonomy delete error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/category-mappings
 * Get all category to taxonomy mappings
 */
app.get('/api/gmc/category-mappings', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                c.id as category_id,
                c.name as category_name,
                gt.id as google_taxonomy_id,
                gt.name as google_taxonomy_name
            FROM categories c
            LEFT JOIN category_taxonomy_mapping ctm ON c.id = ctm.category_id
            LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
            ORDER BY c.name
        `);
        res.json({ count: result.rows.length, mappings: result.rows });
    } catch (error) {
        logger.error('GMC category mappings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/category-taxonomy
 * Map a category (by name) to a Google taxonomy
 * Creates the category in the categories table if it doesn't exist
 */
app.put('/api/gmc/category-taxonomy', async (req, res) => {
    try {
        const { category_name, google_taxonomy_id } = req.body;

        if (!category_name) {
            return res.status(400).json({ error: 'category_name is required' });
        }
        if (!google_taxonomy_id) {
            return res.status(400).json({ error: 'google_taxonomy_id is required' });
        }

        // Find or create the category by name
        let categoryResult = await db.query(
            'SELECT id FROM categories WHERE name = $1',
            [category_name]
        );

        let categoryId;
        if (categoryResult.rows.length === 0) {
            // Create the category (use name as ID since Square categories use UUIDs)
            const insertResult = await db.query(
                'INSERT INTO categories (id, name) VALUES ($1, $2) RETURNING id',
                [category_name, category_name]
            );
            categoryId = insertResult.rows[0].id;
        } else {
            categoryId = categoryResult.rows[0].id;
        }

        // Create or update the mapping
        await db.query(`
            INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id)
            VALUES ($1, $2)
            ON CONFLICT (category_id) DO UPDATE SET
                google_taxonomy_id = EXCLUDED.google_taxonomy_id,
                updated_at = CURRENT_TIMESTAMP
        `, [categoryId, google_taxonomy_id]);

        res.json({ success: true, category_id: categoryId });
    } catch (error) {
        logger.error('GMC category taxonomy mapping error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/gmc/category-taxonomy
 * Remove a category's Google taxonomy mapping (by name)
 */
app.delete('/api/gmc/category-taxonomy', async (req, res) => {
    try {
        const { category_name } = req.body;

        if (!category_name) {
            return res.status(400).json({ error: 'category_name is required' });
        }

        // Find the category by name
        const categoryResult = await db.query(
            'SELECT id FROM categories WHERE name = $1',
            [category_name]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const categoryId = categoryResult.rows[0].id;
        await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1', [categoryId]);

        res.json({ success: true, message: 'Taxonomy mapping removed' });
    } catch (error) {
        logger.error('GMC category taxonomy delete error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/taxonomy/fetch-google
 * Fetch and import Google's official taxonomy file
 */
app.get('/api/gmc/taxonomy/fetch-google', async (req, res) => {
    try {
        const taxonomyUrl = 'https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt';

        logger.info('Fetching Google taxonomy from official URL');

        const response = await fetch(taxonomyUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch taxonomy: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();
        const lines = text.split('\n');

        // Skip header line, parse remaining lines
        let imported = 0;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Format: "1 - Animals & Pet Supplies"
            const match = line.match(/^(\d+)\s*-\s*(.+)$/);
            if (match) {
                const id = parseInt(match[1]);
                const name = match[2].trim();

                // Upsert into google_taxonomy table
                await db.query(`
                    INSERT INTO google_taxonomy (id, name)
                    VALUES ($1, $2)
                    ON CONFLICT (id) DO UPDATE SET name = $2
                `, [id, name]);
                imported++;
            }
        }

        logger.info(`Imported ${imported} Google taxonomy entries`);
        res.json({ success: true, imported, message: `Imported ${imported} taxonomy entries` });

    } catch (error) {
        logger.error('Google taxonomy fetch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/history
 * Get feed generation history
 */
app.get('/api/gmc/history', async (req, res) => {
    try {
        const { limit } = req.query;
        let query = 'SELECT * FROM gmc_feed_history ORDER BY generated_at DESC';
        const params = [];

        if (limit) {
            params.push(parseInt(limit));
            query += ` LIMIT $${params.length}`;
        }

        const result = await db.query(query, params);
        res.json({ count: result.rows.length, history: result.rows });
    } catch (error) {
        logger.error('GMC history error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== VENDOR ENDPOINTS ====================

/**
 * GET /api/vendors
 * List all vendors
 */
app.get('/api/vendors', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { status } = req.query;
        let query = 'SELECT * FROM vendors WHERE merchant_id = $1';
        const params = [merchantId];

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
        // Accept both 'mappings' (frontend) and 'columnMappings' (API) for compatibility
        const { data, fileType, fileName, columnMappings, mappings, vendorId, vendorName, importName } = req.body;
        const resolvedMappings = columnMappings || mappings;

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
            columnMappings: resolvedMappings || {},
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
 * POST /api/vendor-catalog/push-price-changes
 * Push selected price changes to Square
 * Body: { priceChanges: [{variationId, newPriceCents, currency?}] }
 */
app.post('/api/vendor-catalog/push-price-changes', async (req, res) => {
    try {
        const { priceChanges } = req.body;

        if (!priceChanges || !Array.isArray(priceChanges) || priceChanges.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'priceChanges array is required and must not be empty'
            });
        }

        // Validate each price change
        for (const change of priceChanges) {
            if (!change.variationId) {
                return res.status(400).json({
                    success: false,
                    error: 'Each price change must have a variationId'
                });
            }
            if (typeof change.newPriceCents !== 'number' || change.newPriceCents < 0) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid newPriceCents for variation ${change.variationId}`
                });
            }
        }

        logger.info('Pushing price changes to Square', { count: priceChanges.length });

        const squareApi = require('./utils/square-api');
        const result = await squareApi.batchUpdateVariationPrices(priceChanges);

        res.json({
            success: result.success,
            updated: result.updated,
            failed: result.failed,
            errors: result.errors,
            details: result.details
        });
    } catch (error) {
        logger.error('Push price changes error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/locations
 * List all locations
 */
app.get('/api/locations', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT id, name, active, address, timezone
            FROM locations
            WHERE merchant_id = $1
            ORDER BY name
        `, [merchantId]);

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
app.get('/api/sales-velocity', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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
            JOIN variations v ON sv.variation_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            JOIN locations l ON sv.location_id = l.id AND l.merchant_id = $1
            WHERE sv.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
        `;
        const params = [merchantId];

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
app.get('/api/reorder-suggestions', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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
                COALESCE(ic_committed.quantity, 0) as committed_quantity,
                COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0) as available_quantity,
                sv91.daily_avg_quantity,
                sv91.weekly_avg_quantity,
                sv91.weekly_avg_quantity as weekly_avg_91d,
                sv182.weekly_avg_quantity as weekly_avg_182d,
                sv365.weekly_avg_quantity as weekly_avg_365d,
                -- Expiration data
                vexp.expiration_date,
                vexp.does_not_expire,
                CASE
                    WHEN vexp.does_not_expire = TRUE THEN NULL
                    WHEN vexp.expiration_date IS NOT NULL THEN
                        EXTRACT(DAY FROM (vexp.expiration_date - CURRENT_DATE))::INTEGER
                    ELSE NULL
                END as days_until_expiry,
                ve.name as vendor_name,
                vv.vendor_code,
                vv.vendor_id as current_vendor_id,
                vv.unit_cost_money as unit_cost_cents,
                -- Get primary vendor (lowest cost, then earliest created)
                (SELECT vv2.vendor_id
                 FROM variation_vendors vv2
                 WHERE vv2.variation_id = v.id AND vv2.merchant_id = $2
                 ORDER BY vv2.unit_cost_money ASC, vv2.created_at ASC
                 LIMIT 1
                ) as primary_vendor_id,
                -- Get primary vendor name for comparison
                (SELECT ve2.name
                 FROM variation_vendors vv3
                 JOIN vendors ve2 ON vv3.vendor_id = ve2.id AND ve2.merchant_id = $2
                 WHERE vv3.variation_id = v.id AND vv3.merchant_id = $2
                 ORDER BY vv3.unit_cost_money ASC, vv3.created_at ASC
                 LIMIT 1
                ) as primary_vendor_name,
                -- Get primary vendor cost for comparison
                (SELECT vv4.unit_cost_money
                 FROM variation_vendors vv4
                 WHERE vv4.variation_id = v.id AND vv4.merchant_id = $2
                 ORDER BY vv4.unit_cost_money ASC, vv4.created_at ASC
                 LIMIT 1
                ) as primary_vendor_cost,
                -- Get pending quantity from unreceived purchase orders
                COALESCE((
                    SELECT SUM(poi.quantity_ordered - COALESCE(poi.received_quantity, 0))
                    FROM purchase_order_items poi
                    JOIN purchase_orders po ON poi.purchase_order_id = po.id AND po.merchant_id = $2
                    WHERE poi.variation_id = v.id AND poi.merchant_id = $2
                      AND po.status NOT IN ('RECEIVED', 'CANCELLED')
                      AND (poi.quantity_ordered - COALESCE(poi.received_quantity, 0)) > 0
                ), 0) as pending_po_quantity,
                v.case_pack_quantity,
                v.reorder_multiple,
                -- Prefer location-specific settings over global
                COALESCE(vls.stock_alert_min, v.stock_alert_min) as stock_alert_min,
                COALESCE(vls.stock_alert_max, v.stock_alert_max) as stock_alert_max,
                COALESCE(vls.preferred_stock_level, v.preferred_stock_level) as preferred_stock_level,
                ve.lead_time_days,
                -- Calculate days until stockout based on AVAILABLE quantity (not total on-hand)
                CASE
                    WHEN sv91.daily_avg_quantity > 0 AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) > 0
                    THEN ROUND((COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv91.daily_avg_quantity, 1)
                    WHEN (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0
                    THEN 0
                    ELSE 999
                END as days_until_stockout,
                -- Base suggested quantity (supply_days worth of inventory)
                ROUND(COALESCE(sv91.daily_avg_quantity, 0) * $1, 2) as base_suggested_qty,
                -- Whether currently at or below minimum stock based on AVAILABLE quantity
                CASE
                    WHEN COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                         AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= COALESCE(vls.stock_alert_min, v.stock_alert_min)
                    THEN TRUE
                    ELSE FALSE
                END as below_minimum
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
            JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $2
            LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91 AND sv91.merchant_id = $2
            LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $2
            LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $2
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.merchant_id = $2
                AND ic.state = 'IN_STOCK'
            LEFT JOIN inventory_counts ic_committed ON v.id = ic_committed.catalog_object_id AND ic_committed.merchant_id = $2
                AND ic_committed.state = 'RESERVED_FOR_SALE'
                AND ic_committed.location_id = ic.location_id
            LEFT JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $2
            LEFT JOIN variation_location_settings vls ON v.id = vls.variation_id AND vls.merchant_id = $2
                AND ic.location_id = vls.location_id
            LEFT JOIN variation_expiration vexp ON v.id = vexp.variation_id AND vexp.merchant_id = $2
            WHERE v.merchant_id = $2
              AND v.discontinued = FALSE
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND (
                  -- ALWAYS SHOW: Out of available stock (available = on_hand - committed)
                  (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= 0

                  OR

                  -- ALWAYS SHOW: Items at or below alert threshold based on AVAILABLE quantity
                  (COALESCE(vls.stock_alert_min, v.stock_alert_min) IS NOT NULL
                      AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) <= COALESCE(vls.stock_alert_min, v.stock_alert_min))

                  OR

                  -- APPLY SUPPLY_DAYS: Items with available stock that will run out within supply_days period
                  -- Only applies to items with active sales velocity (sv91.daily_avg_quantity > 0)
                  (sv91.daily_avg_quantity > 0
                      AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv91.daily_avg_quantity < $1)
              )
        `;

        const params = [supplyDaysNum, merchantId];

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
                const committedQty = parseInt(row.committed_quantity) || 0;
                const availableQty = currentStock - committedQty;  // Use available for calculations
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

                // Don't suggest if AVAILABLE already above max (null = unlimited, so skip this check)
                if (stockAlertMax !== null && availableQty >= stockAlertMax) {
                    return null;
                }

                // FILTERING LOGIC (must match SQL WHERE clause):
                // 1. ALWAYS include out-of-available-stock items (available <= 0), regardless of supply_days
                // 2. ALWAYS include items below alert threshold based on available, regardless of supply_days
                // 3. Include items that will stockout within supply_days period (only if has velocity)
                const isOutOfStock = availableQty <= 0;
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

                // Calculate suggested quantity based on AVAILABLE stock (round up to ensure minimum of 1)
                let suggestedQty = Math.ceil(Math.max(0, targetQty - availableQty));

                // Round up to case pack
                if (casePack > 1) {
                    suggestedQty = Math.ceil(suggestedQty / casePack) * casePack;
                }

                // Apply reorder multiple
                if (reorderMultiple > 1) {
                    suggestedQty = Math.ceil(suggestedQty / reorderMultiple) * reorderMultiple;
                }

                // Don't exceed max stock level based on AVAILABLE (round up final quantity)
                // If stockAlertMax is null (unlimited), don't cap the quantity
                const finalQty = stockAlertMax !== null
                    ? Math.ceil(Math.min(suggestedQty, stockAlertMax - availableQty))
                    : Math.ceil(suggestedQty);

                if (finalQty <= 0) {
                    return null;
                }

                const unitCost = parseInt(row.unit_cost_cents) || 0;
                const pendingPoQty = parseInt(row.pending_po_quantity) || 0;

                // Subtract pending PO quantity from suggested order
                const adjustedQty = Math.max(0, finalQty - pendingPoQty);
                const orderCost = (adjustedQty * unitCost) / 100;

                // Skip if nothing to order after accounting for pending POs
                if (adjustedQty <= 0) {
                    return null;
                }

                return {
                    variation_id: row.variation_id,
                    item_name: row.item_name,
                    variation_name: row.variation_name,
                    sku: row.sku,
                    location_id: locationId,
                    location_name: locationName,
                    current_stock: currentStock,
                    committed_quantity: committedQty,
                    available_quantity: availableQty,
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
                    pending_po_quantity: pendingPoQty,
                    final_suggested_qty: adjustedQty,
                    unit_cost_cents: unitCost,
                    order_cost: orderCost,
                    vendor_name: row.vendor_name,
                    vendor_code: row.vendor_code || 'N/A',
                    is_primary_vendor: row.current_vendor_id === row.primary_vendor_id,
                    primary_vendor_name: row.primary_vendor_name,
                    primary_vendor_cost: parseInt(row.primary_vendor_cost) || 0,
                    lead_time_days: leadTime,
                    has_velocity: dailyAvg > 0,
                    images: row.images,  // Include images for URL resolution
                    item_images: row.item_images,  // Include item images for fallback
                    // Expiration data
                    expiration_date: row.expiration_date,
                    does_not_expire: row.does_not_expire || false,
                    days_until_expiry: row.days_until_expiry
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

        // Resolve image URLs in a SINGLE batch query (much faster than N individual queries)
        const imageUrlMap = await batchResolveImageUrls(filteredSuggestions);
        const suggestionsWithImages = filteredSuggestions.map((suggestion, index) => ({
            ...suggestion,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,  // Remove raw image IDs from response
            item_images: undefined  // Remove from response
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
                <em>This report was generated automatically by Square Dashboard Addon Tool.</em>
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
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0) as current_inventory,
                COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as committed_quantity,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0)
                    - COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as available_quantity,
                TRUE as is_priority,
                ch.last_counted_date,
                ch.counted_by,
                cqp.added_date as priority_added_date,
                cqp.notes as priority_notes
            FROM count_queue_priority cqp
            JOIN variations v ON cqp.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE')
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
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0) as current_inventory,
                COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as committed_quantity,
                COALESCE(SUM(CASE WHEN ic.state = 'IN_STOCK' THEN ic.quantity ELSE 0 END), 0)
                    - COALESCE(SUM(CASE WHEN ic.state = 'RESERVED_FOR_SALE' THEN ic.quantity ELSE 0 END), 0) as available_quantity,
                FALSE as is_priority,
                ch.last_counted_date,
                ch.counted_by,
                cqd.batch_date,
                cqd.added_date as batch_added_date
            FROM count_queue_daily cqd
            JOIN variations v ON cqd.catalog_object_id = v.id
            JOIN items i ON v.item_id = i.id
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE')
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
 * POST /api/cycle-counts/:id/sync-to-square
 * Push the cycle count adjustment to Square
 * Verifies Square's current inventory matches our DB before updating
 */
app.post('/api/cycle-counts/:id/sync-to-square', async (req, res) => {
    try {
        const { id } = req.params;
        const { actual_quantity, location_id } = req.body;

        // Validate catalog_object_id
        if (!id || id === 'null' || id === 'undefined') {
            logger.error('Invalid catalog_object_id for Square sync', { id, body: req.body });
            return res.status(400).json({
                error: 'Invalid item ID. Please refresh the page and try again.'
            });
        }

        // Validate actual_quantity
        if (actual_quantity === null || actual_quantity === undefined || isNaN(parseInt(actual_quantity))) {
            return res.status(400).json({
                error: 'Actual quantity is required for Square sync.'
            });
        }

        const actualQty = parseInt(actual_quantity);

        // Get the variation details
        const variationResult = await db.query(
            `SELECT v.id, v.sku, v.name, v.item_id, i.name as item_name, v.track_inventory
             FROM variations v
             JOIN items i ON v.item_id = i.id
             WHERE v.id = $1`,
            [id]
        );

        if (variationResult.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

        const variation = variationResult.rows[0];

        // Check if inventory tracking is enabled
        if (!variation.track_inventory) {
            return res.status(400).json({
                error: 'Inventory tracking is not enabled for this item in Square.'
            });
        }

        // Determine which location to use
        let targetLocationId = location_id;

        if (!targetLocationId) {
            // Get the primary/first active location
            const locationResult = await db.query(
                'SELECT id FROM locations WHERE active = TRUE ORDER BY name LIMIT 1'
            );

            if (locationResult.rows.length === 0) {
                return res.status(400).json({
                    error: 'No active locations found. Please sync locations first.'
                });
            }

            targetLocationId = locationResult.rows[0].id;
        }

        // Get our stored inventory count from the database
        const dbInventoryResult = await db.query(
            `SELECT quantity, updated_at
             FROM inventory_counts
             WHERE catalog_object_id = $1
               AND location_id = $2
               AND state = 'IN_STOCK'`,
            [id, targetLocationId]
        );

        const dbQuantity = dbInventoryResult.rows.length > 0
            ? parseInt(dbInventoryResult.rows[0].quantity) || 0
            : 0;

        const dbUpdatedAt = dbInventoryResult.rows.length > 0
            ? dbInventoryResult.rows[0].updated_at
            : null;

        // Fetch current inventory from Square to verify it matches our DB
        logger.info('Verifying Square inventory before sync', {
            catalogObjectId: id,
            locationId: targetLocationId,
            dbQuantity
        });

        const squareQuantity = await squareApi.getSquareInventoryCount(id, targetLocationId);

        // Compare Square's current inventory with our database
        if (squareQuantity !== dbQuantity) {
            logger.warn('Square inventory mismatch detected', {
                catalogObjectId: id,
                locationId: targetLocationId,
                squareQuantity,
                dbQuantity,
                dbUpdatedAt
            });

            return res.status(409).json({
                error: 'Inventory has changed in Square since last sync. Please sync inventory first before updating counts.',
                details: {
                    square_quantity: squareQuantity,
                    database_quantity: dbQuantity,
                    last_synced: dbUpdatedAt
                },
                action_required: 'sync_inventory'
            });
        }

        // Inventory matches - proceed with the update to Square
        logger.info('Square inventory verified, proceeding with update', {
            catalogObjectId: id,
            locationId: targetLocationId,
            currentQuantity: squareQuantity,
            newQuantity: actualQty
        });

        // Update Square inventory
        const updateResult = await squareApi.setSquareInventoryCount(
            id,
            targetLocationId,
            actualQty,
            `Cycle count adjustment - SKU: ${variation.sku || 'N/A'}`
        );

        // Update our local database with the new quantity
        await db.query(
            `INSERT INTO inventory_counts (catalog_object_id, location_id, state, quantity, updated_at)
             VALUES ($1, $2, 'IN_STOCK', $3, CURRENT_TIMESTAMP)
             ON CONFLICT (catalog_object_id, location_id, state)
             DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
            [id, targetLocationId, actualQty]
        );

        // Update the count_history to mark it as synced
        await db.query(
            `UPDATE count_history
             SET notes = COALESCE(notes, '') || ' [Synced to Square at ' || TO_CHAR(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') || ']'
             WHERE catalog_object_id = $1`,
            [id]
        );

        logger.info('Square inventory sync complete', {
            catalogObjectId: id,
            sku: variation.sku,
            itemName: variation.item_name,
            locationId: targetLocationId,
            previousQuantity: squareQuantity,
            newQuantity: actualQty,
            variance: actualQty - squareQuantity
        });

        res.json({
            success: true,
            catalog_object_id: id,
            sku: variation.sku,
            item_name: variation.item_name,
            location_id: targetLocationId,
            previous_quantity: squareQuantity,
            new_quantity: actualQty,
            variance: actualQty - squareQuantity
        });

    } catch (error) {
        logger.error('Sync to Square error', { error: error.message, stack: error.stack });
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
app.post('/api/purchase-orders', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { vendor_id, location_id, supply_days_override, items, notes, created_by } = req.body;

        if (!vendor_id || !location_id || !items || items.length === 0) {
            return res.status(400).json({
                error: 'vendor_id, location_id, and items are required'
            });
        }

        // Filter out any items with zero or negative quantity
        const validItems = items.filter(item => item.quantity_ordered > 0);
        if (validItems.length === 0) {
            return res.status(400).json({
                error: 'No items with valid quantities. All items have zero or negative quantity.'
            });
        }

        // Generate PO number: PO-YYYYMMDD-XXX
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
        const countResult = await db.query(
            "SELECT COUNT(*) as count FROM purchase_orders WHERE po_number LIKE $1 AND merchant_id = $2",
            [`PO-${dateStr}-%`, merchantId]
        );
        const sequence = parseInt(countResult.rows[0].count) + 1;
        const poNumber = `PO-${dateStr}-${sequence.toString().padStart(3, '0')}`;

        // Calculate totals
        let subtotalCents = 0;
        for (const item of validItems) {
            subtotalCents += item.quantity_ordered * item.unit_cost_cents;
        }

        // Create PO
        const poResult = await db.query(`
            INSERT INTO purchase_orders (
                po_number, vendor_id, location_id, status, supply_days_override,
                subtotal_cents, total_cents, notes, created_by, merchant_id
            )
            VALUES ($1, $2, $3, 'DRAFT', $4, $5, $5, $6, $7, $8)
            RETURNING *
        `, [poNumber, vendor_id, location_id, supply_days_override, subtotalCents, notes, created_by, merchantId]);

        const po = poResult.rows[0];

        // Create PO items
        for (const item of validItems) {
            const totalCost = item.quantity_ordered * item.unit_cost_cents;
            await db.query(`
                INSERT INTO purchase_order_items (
                    purchase_order_id, variation_id, quantity_override,
                    quantity_ordered, unit_cost_cents, total_cost_cents, notes, merchant_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                po.id,
                item.variation_id,
                item.quantity_override || null,
                item.quantity_ordered,
                item.unit_cost_cents,
                totalCost,
                item.notes || null,
                merchantId
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
app.get('/api/purchase-orders', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { status, vendor_id } = req.query;
        let query = `
            SELECT
                po.*,
                v.name as vendor_name,
                l.name as location_name,
                (SELECT COUNT(*) FROM purchase_order_items WHERE purchase_order_id = po.id AND merchant_id = $1) as item_count
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $1
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $1
            WHERE po.merchant_id = $1
        `;
        const params = [merchantId];

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
app.get('/api/purchase-orders/:id', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { id } = req.params;

        // Get PO header
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
            WHERE po.id = $1 AND po.merchant_id = $2
        `, [id, merchantId]);

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
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $2
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $2
            ORDER BY i.name, v.name
        `, [id, merchantId]);

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
app.patch('/api/purchase-orders/:id', requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { id } = req.params;
        const { supply_days_override, items, notes } = req.body;

        // Check if PO is in DRAFT status and belongs to this merchant
        const statusCheck = await db.query(
            'SELECT status FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
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
                values.push(merchantId);
                await client.query(`
                    UPDATE purchase_orders
                    SET ${updates.join(', ')}
                    WHERE id = $${paramCount} AND merchant_id = $${paramCount + 1}
                `, values);
            }

            // Update items if provided
            if (items) {
                // Delete existing items
                await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1 AND merchant_id = $2', [id, merchantId]);

                // Insert new items and calculate totals
                let subtotalCents = 0;
                for (const item of items) {
                    const totalCost = item.quantity_ordered * item.unit_cost_cents;
                    subtotalCents += totalCost;

                    await client.query(`
                        INSERT INTO purchase_order_items (
                            purchase_order_id, variation_id, quantity_ordered,
                            unit_cost_cents, total_cost_cents, notes, merchant_id
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [id, item.variation_id, item.quantity_ordered, item.unit_cost_cents, totalCost, item.notes, merchantId]);
                }

                // Update totals
                await client.query(`
                    UPDATE purchase_orders
                    SET subtotal_cents = $1, total_cents = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2 AND merchant_id = $3
                `, [subtotalCents, id, merchantId]);
            }
        });

        // Return updated PO
        const result = await db.query('SELECT * FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
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
        const dbName = process.env.DB_NAME || 'square_dashboard_addon';
        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || '';

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `square_dashboard_addon_backup_${timestamp}.sql`;

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
        const dbName = process.env.DB_NAME || 'square_dashboard_addon';
        const dbUser = process.env.DB_USER || 'postgres';
        const dbPassword = process.env.DB_PASSWORD || '';

        logger.info('Starting database import', {
            database: dbName,
            sql_size_bytes: sql.length
        });

        // Write SQL to temporary file
        const tmpDir = tmpPath.join(__dirname, 'output', 'temp');
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
        `, [process.env.DB_NAME || 'square_dashboard_addon']);

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
                database: process.env.DB_NAME || 'square_dashboard_addon',
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

// ==================== SUBSCRIPTIONS & PAYMENTS ====================

/**
 * GET /api/square/payment-config
 * Get Square application ID for Web Payments SDK
 */
app.get('/api/square/payment-config', (req, res) => {
    res.json({
        applicationId: process.env.SQUARE_APPLICATION_ID || null,
        locationId: process.env.SQUARE_LOCATION_ID || null,
        environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
    });
});

/**
 * GET /api/subscriptions/plans
 * Get available subscription plans
 */
app.get('/api/subscriptions/plans', async (req, res) => {
    try {
        const plans = await subscriptionHandler.getPlans();
        res.json({
            success: true,
            plans,
            trialDays: subscriptionHandler.TRIAL_DAYS
        });
    } catch (error) {
        logger.error('Get plans error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/create
 * Create a new subscription with payment
 */
app.post('/api/subscriptions/create', async (req, res) => {
    try {
        const { email, businessName, plan, sourceId } = req.body;

        if (!email || !plan || !sourceId) {
            return res.status(400).json({ error: 'Email, plan, and payment source are required' });
        }

        // Check if subscriber already exists
        const existing = await subscriptionHandler.getSubscriberByEmail(email);
        if (existing) {
            return res.status(400).json({ error: 'An account with this email already exists' });
        }

        // Get plan pricing
        const plans = await subscriptionHandler.getPlans();
        const selectedPlan = plans.find(p => p.plan_key === plan);
        if (!selectedPlan) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Create customer in Square
        let squareCustomerId = null;
        let cardId = null;
        let cardBrand = null;
        let cardLastFour = null;

        try {
            // Create Square customer
            const customerResponse = await squareApi.makeSquareRequest('/v2/customers', {
                method: 'POST',
                body: JSON.stringify({
                    email_address: email,
                    company_name: businessName || undefined,
                    idempotency_key: `customer-${email}-${Date.now()}`
                })
            });

            if (customerResponse.customer) {
                squareCustomerId = customerResponse.customer.id;

                // Create card on file
                const cardResponse = await squareApi.makeSquareRequest(`/v2/cards`, {
                    method: 'POST',
                    body: JSON.stringify({
                        source_id: sourceId,
                        idempotency_key: `card-${email}-${Date.now()}`,
                        card: {
                            customer_id: squareCustomerId
                        }
                    })
                });

                if (cardResponse.card) {
                    cardId = cardResponse.card.id;
                    cardBrand = cardResponse.card.card_brand;
                    cardLastFour = cardResponse.card.last_4;
                }
            }
        } catch (squareError) {
            logger.error('Square customer/card creation failed', { error: squareError.message });
            // Continue anyway - we can create customer later
        }

        // Create subscriber in database
        const subscriber = await subscriptionHandler.createSubscriber({
            email: email.toLowerCase(),
            businessName,
            plan,
            squareCustomerId,
            cardBrand,
            cardLastFour,
            cardId
        });

        // Process initial payment
        let paymentResult = null;
        if (squareCustomerId && cardId) {
            try {
                const paymentResponse = await squareApi.makeSquareRequest('/v2/payments', {
                    method: 'POST',
                    body: JSON.stringify({
                        source_id: cardId,
                        idempotency_key: `payment-${subscriber.id}-${Date.now()}`,
                        amount_money: {
                            amount: selectedPlan.price_cents,
                            currency: 'CAD'
                        },
                        customer_id: squareCustomerId,
                        note: `Square Dashboard Addon - ${selectedPlan.name} (30-day trial, fully refundable)`
                    })
                });

                if (paymentResponse.payment) {
                    paymentResult = paymentResponse.payment;

                    // Record payment
                    await subscriptionHandler.recordPayment({
                        subscriberId: subscriber.id,
                        squarePaymentId: paymentResult.id,
                        amountCents: selectedPlan.price_cents,
                        currency: 'CAD',
                        status: paymentResult.status === 'COMPLETED' ? 'completed' : 'pending',
                        paymentType: 'subscription',
                        receiptUrl: paymentResult.receipt_url
                    });

                    // Log event
                    await subscriptionHandler.logEvent({
                        subscriberId: subscriber.id,
                        eventType: 'subscription.created',
                        eventData: { plan, amount: selectedPlan.price_cents, payment_id: paymentResult.id }
                    });
                }
            } catch (paymentError) {
                logger.error('Payment processing failed', { error: paymentError.message });
                // Don't fail the subscription - it's in trial anyway
            }
        }

        logger.info('Subscription created', {
            subscriberId: subscriber.id,
            email: subscriber.email,
            plan,
            paymentStatus: paymentResult?.status || 'no_payment'
        });

        res.json({
            success: true,
            subscriber: {
                id: subscriber.id,
                email: subscriber.email,
                plan: subscriber.subscription_plan,
                status: subscriber.subscription_status,
                trialEndDate: subscriber.trial_end_date
            },
            payment: paymentResult ? {
                status: paymentResult.status,
                receiptUrl: paymentResult.receipt_url
            } : null
        });

    } catch (error) {
        logger.error('Create subscription error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/subscriptions/status
 * Check subscription status for an email
 */
app.get('/api/subscriptions/status', async (req, res) => {
    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const status = await subscriptionHandler.checkSubscriptionStatus(email);
        res.json(status);

    } catch (error) {
        logger.error('Check subscription status error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/cancel
 * Cancel a subscription
 */
app.post('/api/subscriptions/cancel', async (req, res) => {
    try {
        const { email, reason } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
        if (!subscriber) {
            return res.status(404).json({ error: 'Subscriber not found' });
        }

        const updated = await subscriptionHandler.cancelSubscription(subscriber.id, reason);

        // Log event
        await subscriptionHandler.logEvent({
            subscriberId: subscriber.id,
            eventType: 'subscription.canceled',
            eventData: { reason }
        });

        res.json({
            success: true,
            subscriber: updated
        });

    } catch (error) {
        logger.error('Cancel subscription error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/refund
 * Process a refund for a subscription payment
 */
app.post('/api/subscriptions/refund', async (req, res) => {
    try {
        const { email, reason } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
        if (!subscriber) {
            return res.status(404).json({ error: 'Subscriber not found' });
        }

        // Get the most recent payment
        const payments = await subscriptionHandler.getPaymentHistory(subscriber.id);
        const lastPayment = payments.find(p => p.status === 'completed' && !p.refunded_at);

        if (!lastPayment) {
            return res.status(400).json({ error: 'No refundable payment found' });
        }

        // Process refund in Square
        let squareRefund = null;
        if (lastPayment.square_payment_id) {
            try {
                const refundResponse = await squareApi.makeSquareRequest('/v2/refunds', {
                    method: 'POST',
                    body: JSON.stringify({
                        idempotency_key: `refund-${lastPayment.id}-${Date.now()}`,
                        payment_id: lastPayment.square_payment_id,
                        amount_money: {
                            amount: lastPayment.amount_cents,
                            currency: lastPayment.currency
                        },
                        reason: reason || '30-day trial refund'
                    })
                });

                squareRefund = refundResponse.refund;
            } catch (refundError) {
                logger.error('Square refund failed', { error: refundError.message });
                return res.status(500).json({ error: 'Refund processing failed: ' + refundError.message });
            }
        }

        // Update payment record
        await subscriptionHandler.processRefund(lastPayment.id, lastPayment.amount_cents, reason || '30-day trial refund');

        // Cancel subscription
        await subscriptionHandler.cancelSubscription(subscriber.id, 'Refunded');

        // Log event
        await subscriptionHandler.logEvent({
            subscriberId: subscriber.id,
            eventType: 'payment.refunded',
            eventData: { payment_id: lastPayment.id, amount: lastPayment.amount_cents, reason }
        });

        res.json({
            success: true,
            refund: squareRefund,
            message: 'Refund processed successfully'
        });

    } catch (error) {
        logger.error('Process refund error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/subscriptions/admin/list
 * Get all subscribers (admin endpoint)
 */
app.get('/api/subscriptions/admin/list', async (req, res) => {
    try {
        const { status } = req.query;
        const subscribers = await subscriptionHandler.getAllSubscribers({ status });
        const stats = await subscriptionHandler.getSubscriptionStats();

        res.json({
            success: true,
            count: subscribers.length,
            subscribers,
            stats
        });

    } catch (error) {
        logger.error('List subscribers error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/webhooks/events
 * View recent webhook events (admin only)
 */
app.get('/api/webhooks/events', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 50, status, event_type } = req.query;

        let query = `
            SELECT id, square_event_id, event_type, merchant_id, status,
                   received_at, processed_at, processing_time_ms, error_message,
                   sync_results
            FROM webhook_events
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }

        if (event_type) {
            params.push(event_type);
            query += ` AND event_type = $${params.length}`;
        }

        params.push(parseInt(limit));
        query += ` ORDER BY received_at DESC LIMIT $${params.length}`;

        const result = await db.query(query, params);

        // Get summary stats
        const stats = await db.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE status = 'failed') as failed,
                COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
                AVG(processing_time_ms) FILTER (WHERE processing_time_ms IS NOT NULL) as avg_processing_ms
            FROM webhook_events
            WHERE received_at > NOW() - INTERVAL '24 hours'
        `);

        res.json({
            events: result.rows,
            stats: stats.rows[0]
        });
    } catch (error) {
        logger.error('Error fetching webhook events', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/webhooks/square
 * Handle Square webhook events
 *
 * Subscription Events:
 *   - subscription.created, subscription.updated
 *   - invoice.payment_made, invoice.payment_failed
 *   - customer.deleted
 *
 * Catalog & Inventory Events (feature-flagged):
 *   - catalog.version.updated  → WEBHOOK_CATALOG_SYNC
 *   - inventory.count.updated  → WEBHOOK_INVENTORY_SYNC
 *   - order.created/updated    → WEBHOOK_ORDER_SYNC (syncs committed inventory)
 *   - order.fulfillment.updated → WEBHOOK_ORDER_SYNC (syncs committed + sales velocity)
 *
 * OAuth Events:
 *   - oauth.authorization.revoked → Logs warning, requires re-auth
 */
app.post('/api/webhooks/square', async (req, res) => {
    const startTime = Date.now();
    let webhookEventId = null;

    try {
        const signature = req.headers['x-square-hmacsha256-signature'];
        const event = req.body;

        // Verify webhook signature if configured
        const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
        if (signatureKey && process.env.WEBHOOK_SIGNATURE_VERIFY !== 'false') {
            const crypto = require('crypto');
            // Use the exact URL registered with Square (hardcode to avoid proxy issues)
            const notificationUrl = process.env.SQUARE_WEBHOOK_URL || `https://${req.get('host')}${req.originalUrl}`;
            // Use raw body to ensure exact match (JSON.stringify may alter formatting)
            const payload = req.rawBody || JSON.stringify(req.body);
            const hmac = crypto.createHmac('sha256', signatureKey);
            hmac.update(notificationUrl + payload);
            const expectedSignature = hmac.digest('base64');

            if (signature !== expectedSignature) {
                logger.warn('Invalid webhook signature', {
                    received: signature,
                    expected: expectedSignature,
                    url: notificationUrl,
                    hasRawBody: !!req.rawBody,
                    bodyLength: payload?.length
                });
                return res.status(401).json({ error: 'Invalid signature' });
            }
        } else if (!signatureKey) {
            logger.info('Webhook signature verification skipped (no key configured)');
        }

        // Check for duplicate events (idempotency)
        if (event.event_id) {
            const existing = await db.query(
                'SELECT id FROM webhook_events WHERE square_event_id = $1',
                [event.event_id]
            );
            if (existing.rows.length > 0) {
                logger.info('Duplicate webhook event ignored', { eventId: event.event_id });
                return res.json({ received: true, duplicate: true });
            }
        }

        // Log the incoming event
        const insertResult = await db.query(`
            INSERT INTO webhook_events (square_event_id, event_type, merchant_id, event_data, status)
            VALUES ($1, $2, $3, $4, 'processing')
            RETURNING id
        `, [event.event_id, event.type, event.merchant_id, JSON.stringify(event.data)]);
        webhookEventId = insertResult.rows[0]?.id;

        logger.info('Square webhook received', {
            eventType: event.type,
            eventId: event.event_id,
            merchantId: event.merchant_id
        });

        let subscriberId = null;
        let syncResults = {};
        const data = event.data?.object || {};

        // Handle different event types
        switch (event.type) {
            case 'subscription.created':
                // New subscription created
                if (data.subscription) {
                    const sub = data.subscription;
                    const subscriber = await subscriptionHandler.getSubscriberBySquareSubscriptionId(sub.id);
                    if (subscriber) {
                        subscriberId = subscriber.id;
                        await subscriptionHandler.updateSubscriberStatus(subscriber.id, 'active');
                        logger.info('Subscription activated via webhook', { subscriberId: subscriber.id });
                    }
                }
                break;

            case 'subscription.updated':
                // Subscription status changed
                if (data.subscription) {
                    const sub = data.subscription;
                    const subscriber = await subscriptionHandler.getSubscriberBySquareSubscriptionId(sub.id);
                    if (subscriber) {
                        subscriberId = subscriber.id;
                        // Map Square status to our status
                        const statusMap = {
                            'ACTIVE': 'active',
                            'CANCELED': 'canceled',
                            'DEACTIVATED': 'expired',
                            'PAUSED': 'past_due',
                            'PENDING': 'trial'
                        };
                        const newStatus = statusMap[sub.status] || 'active';
                        await subscriptionHandler.updateSubscriberStatus(subscriber.id, newStatus);
                        logger.info('Subscription status updated via webhook', {
                            subscriberId: subscriber.id,
                            newStatus,
                            squareStatus: sub.status
                        });
                    }
                }
                break;

            case 'invoice.payment_made':
                // Successful payment - ensure subscription is active
                if (data.invoice) {
                    const invoice = data.invoice;
                    const customerId = invoice.primary_recipient?.customer_id;
                    if (customerId) {
                        const subscriber = await subscriptionHandler.getSubscriberBySquareCustomerId(customerId);
                        if (subscriber) {
                            subscriberId = subscriber.id;
                            await subscriptionHandler.activateSubscription(subscriber.id);
                            await subscriptionHandler.recordPayment({
                                subscriberId: subscriber.id,
                                squarePaymentId: invoice.payment_requests?.[0]?.computed_amount_money ? null : invoice.id,
                                squareInvoiceId: invoice.id,
                                amountCents: invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0,
                                status: 'completed',
                                paymentType: 'subscription'
                            });
                            logger.info('Payment recorded via webhook', { subscriberId: subscriber.id });
                        }
                    }
                }
                break;

            case 'invoice.payment_failed':
                // Failed payment - mark subscription as past_due
                if (data.invoice) {
                    const invoice = data.invoice;
                    const customerId = invoice.primary_recipient?.customer_id;
                    if (customerId) {
                        const subscriber = await subscriptionHandler.getSubscriberBySquareCustomerId(customerId);
                        if (subscriber) {
                            subscriberId = subscriber.id;
                            await subscriptionHandler.updateSubscriberStatus(subscriber.id, 'past_due');
                            await subscriptionHandler.recordPayment({
                                subscriberId: subscriber.id,
                                squareInvoiceId: invoice.id,
                                amountCents: invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0,
                                status: 'failed',
                                paymentType: 'subscription',
                                failureReason: 'Payment failed'
                            });
                            logger.warn('Payment failed via webhook', { subscriberId: subscriber.id });
                        }
                    }
                }
                break;

            case 'customer.deleted':
                // Customer deleted from Square - mark subscription as canceled
                if (data.customer) {
                    const subscriber = await subscriptionHandler.getSubscriberBySquareCustomerId(data.customer.id);
                    if (subscriber) {
                        subscriberId = subscriber.id;
                        await subscriptionHandler.updateSubscriberStatus(subscriber.id, 'canceled');
                        logger.info('Customer deleted via webhook', { subscriberId: subscriber.id });
                    }
                }
                break;

            // ==================== CATALOG & INVENTORY WEBHOOKS ====================

            case 'catalog.version.updated':
                // Catalog changed in Square - sync to local database
                if (process.env.WEBHOOK_CATALOG_SYNC !== 'false') {
                    try {
                        logger.info('Catalog change detected via webhook, syncing...');
                        const catalogSyncResult = await squareApi.syncCatalog();
                        syncResults.catalog = {
                            items: catalogSyncResult.items,
                            variations: catalogSyncResult.variations
                        };
                        logger.info('Catalog sync completed via webhook', syncResults.catalog);
                    } catch (syncError) {
                        logger.error('Catalog sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                } else {
                    logger.info('Catalog webhook received but WEBHOOK_CATALOG_SYNC is disabled');
                    syncResults.skipped = true;
                }
                break;

            case 'inventory.count.updated':
                // Inventory changed in Square - sync to local database
                if (process.env.WEBHOOK_INVENTORY_SYNC !== 'false') {
                    try {
                        const inventoryChange = data.inventory_count;
                        logger.info('Inventory change detected via webhook', {
                            catalogObjectId: inventoryChange?.catalog_object_id,
                            quantity: inventoryChange?.quantity,
                            locationId: inventoryChange?.location_id
                        });
                        const inventorySyncResult = await squareApi.syncInventory();
                        syncResults.inventory = {
                            count: inventorySyncResult,
                            catalogObjectId: inventoryChange?.catalog_object_id
                        };
                        logger.info('Inventory sync completed via webhook', { count: inventorySyncResult });
                    } catch (syncError) {
                        logger.error('Inventory sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                } else {
                    logger.info('Inventory webhook received but WEBHOOK_INVENTORY_SYNC is disabled');
                    syncResults.skipped = true;
                }
                break;

            case 'order.created':
            case 'order.updated':
                // Order created/updated - sync committed inventory (open orders)
                if (process.env.WEBHOOK_ORDER_SYNC !== 'false') {
                    try {
                        const order = data.order;
                        logger.info('Order event detected via webhook', {
                            orderId: order?.id,
                            state: order?.state,
                            eventType: event.type
                        });
                        // Sync committed inventory for open orders
                        const committedResult = await squareApi.syncCommittedInventory();
                        syncResults.committedInventory = committedResult;
                        logger.info('Committed inventory sync completed via webhook', { count: committedResult });
                    } catch (syncError) {
                        logger.error('Committed inventory sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                } else {
                    logger.info('Order webhook received but WEBHOOK_ORDER_SYNC is disabled');
                    syncResults.skipped = true;
                }
                break;

            case 'order.fulfillment.updated':
                // Fulfillment status changed - update committed inventory and sales velocity
                if (process.env.WEBHOOK_ORDER_SYNC !== 'false') {
                    try {
                        const fulfillment = data.fulfillment;
                        logger.info('Order fulfillment updated via webhook', {
                            fulfillmentId: fulfillment?.uid,
                            state: fulfillment?.state,
                            orderId: data.order_id
                        });
                        // Sync committed inventory (fulfilled orders reduce committed qty)
                        const committedResult = await squareApi.syncCommittedInventory();
                        syncResults.committedInventory = committedResult;

                        // If fulfilled/completed, also sync sales velocity
                        if (fulfillment?.state === 'COMPLETED') {
                            await squareApi.syncSalesVelocity(91);
                            syncResults.salesVelocity = true;
                            logger.info('Sales velocity sync completed via fulfillment webhook');
                        }
                    } catch (syncError) {
                        logger.error('Fulfillment sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                } else {
                    logger.info('Fulfillment webhook received but WEBHOOK_ORDER_SYNC is disabled');
                    syncResults.skipped = true;
                }
                break;

            // ==================== OAUTH WEBHOOKS ====================

            case 'oauth.authorization.revoked':
                // Merchant or app revoked OAuth access
                try {
                    const revokedMerchantId = event.merchant_id;
                    logger.warn('OAuth authorization revoked via webhook', {
                        merchantId: revokedMerchantId,
                        revokedAt: event.created_at
                    });

                    // Log the revocation event prominently
                    syncResults.revoked = true;
                    syncResults.merchantId = revokedMerchantId;

                    // For future multi-tenant: mark merchant as disconnected
                    // await db.query(
                    //     'UPDATE merchants SET is_authorized = false, revoked_at = NOW() WHERE square_merchant_id = $1',
                    //     [revokedMerchantId]
                    // );

                    // For now, just log prominently - admin will need to reconnect
                    logger.error('⚠️ OAUTH REVOKED - Square access has been disconnected. Re-authorization required.', {
                        merchantId: revokedMerchantId
                    });
                } catch (revokeError) {
                    logger.error('Error handling OAuth revocation', { error: revokeError.message });
                    syncResults.error = revokeError.message;
                }
                break;

            default:
                logger.info('Unhandled webhook event type', { type: event.type });
                syncResults.unhandled = true;
        }

        // Log the event to subscription handler (legacy)
        await subscriptionHandler.logEvent({
            subscriberId,
            eventType: event.type,
            eventData: event.data,
            squareEventId: event.event_id
        });

        // Update webhook_events with results
        const processingTime = Date.now() - startTime;
        if (webhookEventId) {
            const status = syncResults.error ? 'failed' : (syncResults.skipped ? 'skipped' : 'completed');
            await db.query(`
                UPDATE webhook_events
                SET status = $1,
                    processed_at = NOW(),
                    sync_results = $2,
                    processing_time_ms = $3,
                    error_message = $4
                WHERE id = $5
            `, [status, JSON.stringify(syncResults), processingTime, syncResults.error || null, webhookEventId]);
        }

        res.json({ received: true, processingTimeMs: processingTime });

    } catch (error) {
        logger.error('Webhook processing error', { error: error.message, stack: error.stack });

        // Update webhook_events with error
        if (webhookEventId) {
            const processingTime = Date.now() - startTime;
            await db.query(`
                UPDATE webhook_events
                SET status = 'failed',
                    processed_at = NOW(),
                    error_message = $1,
                    processing_time_ms = $2
                WHERE id = $3
            `, [error.message, processingTime, webhookEventId]).catch(() => {});
        }

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
            logsDir: path.join(__dirname, 'output', 'logs'),
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

        // Ensure Square custom attributes exist (for expiry tracking, brands, etc.)
        try {
            logger.info('Checking Square custom attributes...');
            const attrResult = await squareApi.initializeCustomAttributes();
            if (attrResult.created > 0 || attrResult.updated > 0) {
                logger.info('Square custom attributes initialized', {
                    created: attrResult.created,
                    updated: attrResult.updated,
                    skipped: attrResult.skipped
                });
            } else {
                logger.info('Square custom attributes already configured');
            }
        } catch (squareAttrError) {
            // Don't fail startup if Square attributes can't be created
            // They may be created later when Square credentials are configured
            logger.warn('Could not initialize Square custom attributes', {
                error: squareAttrError.message
            });
        }

        // Start server
        app.listen(PORT, () => {
            // Log OAuth configuration for debugging
            const publicAppUrl = process.env.PUBLIC_APP_URL || '(auto-detect from request)';
            const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || '(not set)';

            const banner = [
                '='.repeat(60),
                'Square Dashboard Addon Tool',
                '='.repeat(60),
                `Server running on port ${PORT}`,
                `Environment: ${process.env.NODE_ENV || 'development'}`,
                `Database: ${process.env.DB_NAME || 'square_dashboard_addon'}`,
                '',
                'OAuth Configuration:',
                `  GOOGLE_REDIRECT_URI: ${googleRedirectUri}`,
                `  PUBLIC_APP_URL:      ${publicAppUrl}`,
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
                '',
                '  SQUARE CUSTOM ATTRIBUTES:',
                '  GET    /api/square/custom-attributes              (list definitions)',
                '  POST   /api/square/custom-attributes/init         (initialize custom attrs)',
                '  POST   /api/square/custom-attributes/definition   (create/update definition)',
                '  PUT    /api/square/custom-attributes/:objectId    (update values on object)',
                '  POST   /api/square/custom-attributes/push/case-pack    (push case packs)',
                '  POST   /api/square/custom-attributes/push/brand        (push brands)',
                '  POST   /api/square/custom-attributes/push/expiry       (push expiry dates)',
                '  POST   /api/square/custom-attributes/push/all          (push all)',
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

        // Initialize expiry discount automation cron job
        // Runs daily at 6:00 AM EST by default (configurable via database setting)
        const expiryCronSchedule = process.env.EXPIRY_DISCOUNT_CRON || '0 6 * * *';
        cron.schedule(expiryCronSchedule, async () => {
            logger.info('Running scheduled expiry discount automation');
            try {
                // Check if automation is enabled
                const autoApplyEnabled = await expiryDiscount.getSetting('auto_apply_enabled');
                if (autoApplyEnabled !== 'true') {
                    logger.info('Expiry discount automation is disabled, skipping');
                    return;
                }

                const result = await expiryDiscount.runExpiryDiscountAutomation({ dryRun: false });

                logger.info('Scheduled expiry discount automation completed', {
                    success: result.success,
                    tierChanges: result.evaluation?.tierChanges?.length || 0,
                    newAssignments: result.evaluation?.newAssignments?.length || 0,
                    discountsApplied: result.discountApplication?.applied?.length || 0,
                    duration: result.duration
                });

                // Send email notification for tier changes
                const tierChanges = result.evaluation?.tierChanges?.length || 0;
                const newAssignments = result.evaluation?.newAssignments?.length || 0;
                const needsPull = result.evaluation?.byTier?.EXPIRED || 0;

                if (tierChanges > 0 || newAssignments > 0 || needsPull > 0) {
                    const emailEnabled = await expiryDiscount.getSetting('email_notifications');
                    if (emailEnabled === 'true') {
                        try {
                            let emailBody = `Expiry Discount Automation Report\n\n`;
                            emailBody += `Run Time: ${new Date().toISOString()}\n\n`;
                            emailBody += `Summary:\n`;
                            emailBody += `- Total items evaluated: ${result.evaluation?.totalEvaluated || 0}\n`;
                            emailBody += `- Tier changes: ${tierChanges}\n`;
                            emailBody += `- New tier assignments: ${newAssignments}\n`;
                            emailBody += `- Discounts applied: ${result.discountApplication?.applied?.length || 0}\n`;
                            emailBody += `- Discounts removed: ${result.discountApplication?.removed?.length || 0}\n`;
                            emailBody += `- Items needing pull (EXPIRED): ${needsPull}\n`;
                            emailBody += `- Errors: ${result.errors?.length || 0}\n\n`;

                            // Add tier breakdown
                            emailBody += `Items by Tier:\n`;
                            for (const [tierCode, count] of Object.entries(result.evaluation?.byTier || {})) {
                                emailBody += `  ${tierCode}: ${count}\n`;
                            }

                            emailBody += `\nDuration: ${result.duration}ms`;

                            // Include urgent items if any
                            if (needsPull > 0) {
                                emailBody += `\n\n⚠️ ATTENTION: ${needsPull} item(s) are EXPIRED and need to be pulled from shelves!`;
                            }

                            await emailNotifier.sendAlert(
                                `Expiry Discount Report - ${tierChanges + newAssignments} Changes`,
                                emailBody
                            );
                        } catch (emailError) {
                            logger.error('Failed to send expiry discount automation email', { error: emailError.message });
                        }
                    }
                }

            } catch (error) {
                logger.error('Scheduled expiry discount automation failed', { error: error.message });
                await emailNotifier.sendAlert(
                    'Expiry Discount Automation Failed',
                    `Failed to run scheduled expiry discount automation:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        }, {
            timezone: 'America/Toronto'  // EST timezone
        });

        logger.info('Expiry discount cron job scheduled', { schedule: expiryCronSchedule, timezone: 'America/Toronto' });

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
