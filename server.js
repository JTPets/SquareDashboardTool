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
const multer = require('multer');
const cron = require('node-cron');
const db = require('./utils/database');

// Store cron task references for graceful shutdown
const cronTasks = [];
const squareApi = require('./utils/square-api');
const logger = require('./utils/logger');
const emailNotifier = require('./utils/email-notifier');
const subscriptionHandler = require('./utils/subscription-handler');
const { subscriptionCheck } = require('./middleware/subscription-check');
const { escapeCSVField, formatDateForSquare, formatMoney, formatGTIN, UTF8_BOM } = require('./utils/csv-helpers');
const { hashPassword, generateRandomPassword } = require('./utils/password');
const crypto = require('crypto');
const expiryDiscount = require('./utils/expiry-discount');
const { encryptToken, decryptToken, isEncryptedToken } = require('./utils/token-encryption');
const deliveryApi = require('./utils/delivery-api');
const loyaltyService = require('./utils/loyalty-service');
const loyaltyReports = require('./utils/loyalty-reports');

// Security middleware
const { configureHelmet, configureRateLimit, configureDeliveryRateLimit, configureDeliveryStrictRateLimit, configureCors, corsErrorHandler } = require('./middleware/security');
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

// Delivery-specific rate limiters (applied to routes below)
const deliveryRateLimit = configureDeliveryRateLimit();
const deliveryStrictRateLimit = configureDeliveryStrictRateLimit();

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

// SECURITY FIX: Generate cryptographically secure fallback secret
// Note: This is only for development; production requires SESSION_SECRET env var
const developmentSecret = crypto.randomBytes(64).toString('hex');

app.use(session({
    store: pgSessionStore,
    secret: process.env.SESSION_SECRET || developmentSecret,
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

// Session secret validation - refuse to start in production without it
if (!process.env.SESSION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('FATAL: SESSION_SECRET must be set in production environment');
        console.error('FATAL: SESSION_SECRET must be set in production environment');
        process.exit(1);
    }
    logger.warn('SESSION_SECRET not set! Using random secret. Sessions will be lost on restart.');
}

// ==================== PAGE AUTHENTICATION ====================
// Redirect unauthenticated users to login page for protected HTML pages
// NOTE: AUTH_DISABLED bypass removed for security (2026-01-05)

// Public pages that don't require authentication
const publicPages = ['/', '/index.html', '/login.html', '/subscribe.html', '/support.html', '/set-password.html', '/subscription-expired.html'];

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

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output'))); // Serve generated files

// Configure multer for POD photo uploads
const podUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max
    },
    fileFilter: (req, file, cb) => {
        // Only accept images
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

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
// Protect all API routes - auth is always enabled (AUTH_DISABLED bypass removed 2026-01-05)
app.use('/api', (req, res, next) => {
    // Public routes that don't require authentication
    const publicPaths = [
        '/health',
        '/webhooks/square',
        '/square/payment-config',
        '/subscriptions/plans',
        '/subscriptions/create',
        '/subscriptions/status',
        '/subscriptions/promo/validate',
        // Auth routes (login, password reset)
        '/auth/login',
        '/auth/forgot-password',
        '/auth/reset-password',
        '/auth/verify-reset-token',
        // GMC feed endpoints (use token-based auth, handled in route)
        '/gmc/feed.tsv',
        '/gmc/local-inventory-feed.tsv'
    ];

    // Allow public routes without auth
    if (publicPaths.includes(req.path)) {
        return next();
    }

    // Require authentication for all other API routes
    return requireAuthApi(req, res, next);
});
logger.info('Authentication middleware enabled');

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

        // Check Square connection status from database
        // (Uses synced data rather than live API call for faster health checks)
        let squareStatus = 'not_configured';
        let squareError = null;
        try {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE LIMIT 1'
            );
            if (merchantResult.rows.length > 0) {
                // Check if we have synced locations for this merchant
                const locationsResult = await db.query(
                    'SELECT COUNT(*) as count FROM locations WHERE merchant_id = $1 AND active = TRUE',
                    [merchantResult.rows[0].id]
                );
                const locationCount = parseInt(locationsResult.rows[0].count, 10);
                squareStatus = locationCount > 0 ? 'connected' : 'no_locations';
            }
        } catch (e) {
            squareStatus = 'error';
            squareError = e.message;
            logger.warn('Health check error', { error: e.message });
        }

        // Format uptime
        const uptimeSeconds = process.uptime();
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

        res.json({
            status: 'ok',
            database: dbConnected ? 'connected' : 'disconnected',
            square: squareStatus,
            squareError: squareError,
            uptime: uptime,
            memory: {
                heapUsed: process.memoryUsage().heapUsed,
                heapTotal: process.memoryUsage().heapTotal
            },
            nodeVersion: process.version,
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
app.get('/api/config', requireAuth, async (req, res) => {
    try {
        // Check Square connection
        let squareConnected = false;
        try {
            const locations = await squareApi.getLocations();
            squareConnected = locations && locations.length > 0;
        } catch (e) {
            squareConnected = false;
        }

        // Try to load merchant settings if merchant context available
        let merchantSettings = null;
        const merchantId = req.merchantContext?.id;
        if (merchantId) {
            try {
                merchantSettings = await db.getMerchantSettings(merchantId);
            } catch (e) {
                logger.warn('Failed to load merchant settings for config', { merchantId, error: e.message });
            }
        }

        // Use merchant settings if available, otherwise fall back to env vars
        res.json({
            defaultSupplyDays: merchantSettings?.default_supply_days ??
                parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45'),
            reorderSafetyDays: merchantSettings?.reorder_safety_days ??
                parseInt(process.env.REORDER_SAFETY_DAYS || '7'),
            reorderPriorityThresholds: {
                urgent: merchantSettings?.reorder_priority_urgent_days ??
                    parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0'),
                high: merchantSettings?.reorder_priority_high_days ??
                    parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7'),
                medium: merchantSettings?.reorder_priority_medium_days ??
                    parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14'),
                low: merchantSettings?.reorder_priority_low_days ??
                    parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30')
            },
            square_connected: squareConnected,
            square_environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
            email_configured: process.env.EMAIL_ENABLED === 'true' && !!process.env.EMAIL_USER,
            sync_intervals: {
                catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL || '60'),
                inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL || '15'),
                sales: parseInt(process.env.SYNC_SALES_INTERVAL || '60')
            },
            usingMerchantSettings: !!merchantSettings
        });
    } catch (error) {
        logger.error('Failed to get config', { error: error.message });
        res.status(500).json({ error: 'Failed to get configuration' });
    }
});

// ==================== MERCHANT SETTINGS ENDPOINTS ====================

/**
 * GET /api/settings/merchant
 * Get merchant-specific settings (reorder rules, cycle count config, etc.)
 * Settings are stored per-merchant and override global env var defaults
 */
app.get('/api/settings/merchant', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const settings = await db.getMerchantSettings(merchantId);

        res.json({
            success: true,
            settings,
            merchantId
        });

    } catch (error) {
        logger.error('Failed to get merchant settings', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/settings/merchant
 * Update merchant-specific settings
 * Only allows updating known setting fields
 */
app.put('/api/settings/merchant', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const settings = req.body;

        // Validate numeric fields
        const numericFields = [
            'reorder_safety_days', 'default_supply_days',
            'reorder_priority_urgent_days', 'reorder_priority_high_days',
            'reorder_priority_medium_days', 'reorder_priority_low_days',
            'daily_count_target'
        ];

        for (const field of numericFields) {
            if (settings.hasOwnProperty(field)) {
                const value = parseInt(settings[field]);
                if (isNaN(value) || value < 0) {
                    return res.status(400).json({ error: `Invalid value for ${field}: must be a non-negative number` });
                }
                settings[field] = value;
            }
        }

        // Validate boolean fields
        const booleanFields = ['cycle_count_email_enabled', 'cycle_count_report_email', 'low_stock_alerts_enabled'];
        for (const field of booleanFields) {
            if (settings.hasOwnProperty(field)) {
                settings[field] = Boolean(settings[field]);
            }
        }

        const updated = await db.updateMerchantSettings(merchantId, settings);

        logger.info('Merchant settings updated', {
            merchantId,
            fields: Object.keys(settings)
        });

        res.json({
            success: true,
            settings: updated,
            message: 'Settings saved successfully'
        });

    } catch (error) {
        logger.error('Failed to update merchant settings', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/settings/merchant/defaults
 * Get default merchant settings (from env vars)
 * Useful for resetting to defaults
 */
app.get('/api/settings/merchant/defaults', requireAuth, async (req, res) => {
    res.json({
        success: true,
        defaults: db.DEFAULT_MERCHANT_SETTINGS
    });
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

        const content = await fs.readFile(logFile, 'utf-8').catch(() => '');
        if (!content.trim()) {
            return res.json({ logs: [], count: 0, message: 'No logs for today yet' });
        }

        const lines = content.trim().split('\n').slice(-limit);
        const logs = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return { raw: line, level: 'unknown' };
            }
        });

        res.json({ logs, count: logs.length });

    } catch (error) {
        logger.error('Failed to read logs', { error: error.message });
        res.json({ logs: [], count: 0, error: error.message });
    }
});

/**
 * GET /api/logs/errors
 * View errors only
 */
app.get('/api/logs/errors', requireAdmin, async (req, res) => {
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
app.get('/api/logs/download', requireAdmin, async (req, res) => {
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
app.get('/api/logs/stats', requireAdmin, async (req, res) => {
    try {
        const logsDir = path.join(__dirname, 'output', 'logs');
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `app-${today}.log`);
        const errorFile = path.join(logsDir, `error-${today}.log`);

        const logContent = await fs.readFile(logFile, 'utf-8').catch(() => '');
        const errorContent = await fs.readFile(errorFile, 'utf-8').catch(() => '');

        const logLines = logContent.trim().split('\n').filter(Boolean);
        const errorLines = errorContent.trim().split('\n').filter(Boolean);

        const logs = logLines.map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const errors = errorLines.map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

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
app.post('/api/test-email', requireAdmin, async (req, res) => {
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
app.post('/api/test-error', requireAdmin, async (req, res) => {
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
app.post('/api/test-backup-email', requireAdmin, async (req, res) => {
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
 * @param {number} merchantId - Merchant ID to record sync history for
 * @returns {Promise<Object>} Result with records synced
 */
async function loggedSync(syncType, syncFunction, merchantId) {
    const startTime = Date.now();
    const startedAt = new Date();

    try {
        // Create sync history record
        const insertResult = await db.query(`
            INSERT INTO sync_history (sync_type, started_at, status, merchant_id)
            VALUES ($1, $2, 'running', $3)
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
 * Run automated database backup and email it
 * This is used by the weekly backup cron job
 * @returns {Promise<void>}
 */
async function runAutomatedBackup() {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    logger.info('Starting automated database backup');

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'square_dashboard_addon';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || '';

    // SECURITY FIX: Validate database connection parameters to prevent injection
    // Only allow alphanumeric, dots, underscores, and hyphens in host/dbname/user
    const safePattern = /^[a-zA-Z0-9._-]+$/;
    if (!safePattern.test(dbHost) || !safePattern.test(dbName) || !safePattern.test(dbUser)) {
        throw new Error('Invalid database configuration: contains disallowed characters');
    }
    // Port must be numeric
    if (!/^\d+$/.test(dbPort)) {
        throw new Error('Invalid database port: must be numeric');
    }

    // Find pg_dump command (handles Windows paths)
    const pgDumpCmd = process.platform === 'win32' ? findPgDumpOnWindows() : 'pg_dump';

    // Set PGPASSWORD environment variable for pg_dump
    const env = { ...process.env, PGPASSWORD: dbPassword };

    // SECURITY FIX: Use execFile with array arguments instead of string interpolation
    // This prevents command injection via environment variables
    const args = [
        '-h', dbHost,
        '-p', dbPort,
        '-U', dbUser,
        '-d', dbName,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges'
    ];

    const { stdout, stderr } = await execFileAsync(pgDumpCmd, args, {
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
            logger.error('Inventory sync error', { merchantId, error: error.message });
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

    // Tiered optimization strategy:
    // - If 365d is due → fetch 365d, calculate all three periods
    // - If 182d is due (but not 365d) → fetch 182d, calculate 91d + 182d
    // - If only 91d is due → fetch 91d only (smallest fetch, efficient for webhook-heavy setups)
    if (sales365Check.needed) {
        // Tier 1: 365d is due - fetch all 365 days, sync all periods
        try {
            logger.info('Syncing all sales velocity periods (365d due - full fetch)', { merchantId });

            const result = await squareApi.syncSalesVelocityAllPeriods(merchantId, 365);

            // Update sync_history for ALL periods since we synced them all
            for (const period of ['sales_91d', 'sales_182d', 'sales_365d']) {
                const days = period.replace('sales_', '').replace('d', '');
                await db.query(`
                    INSERT INTO sync_history (sync_type, records_synced, merchant_id, synced_at)
                    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                    ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                        records_synced = EXCLUDED.records_synced,
                        synced_at = CURRENT_TIMESTAMP
                `, [period, result[`${days}d`] || 0, merchantId]);
            }

            synced.push('sales_91d', 'sales_182d', 'sales_365d');
            summary.sales_91d = result['91d'];
            summary.sales_182d = result['182d'];
            summary.sales_365d = result['365d'];
            summary.salesVelocityOptimization = 'tier1_365d_full_fetch';
        } catch (error) {
            logger.error('Sales velocity sync error (365d)', { error: error.message });
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
                    INSERT INTO sync_history (sync_type, records_synced, merchant_id, synced_at)
                    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                    ON CONFLICT (sync_type, merchant_id) DO UPDATE SET
                        records_synced = EXCLUDED.records_synced,
                        synced_at = CURRENT_TIMESTAMP
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
            logger.error('Sales velocity sync error (182d)', { error: error.message });
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
app.post('/api/sync', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Full sync requested', { merchantId });
        const summary = await squareApi.fullSync(merchantId);

        // Generate GMC feed after sync completes
        let gmcFeedResult = null;
        try {
            logger.info('Generating GMC feed after sync...');
            const gmcFeedModule = require('./utils/gmc-feed');
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
 * Sync only sales velocity data - optimized to fetch orders once for all periods
 */
app.post('/api/sync-sales', requireAuth, requireMerchant, async (req, res) => {
    try {
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
app.post('/api/sync-smart', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Smart sync requested', { merchantId });
        const result = await runSmartSync({ merchantId });
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
app.get('/api/sync-history', requireAuth, requireMerchant, async (req, res) => {
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
 * GET /api/sync-intervals
 * Get configured sync intervals (read-only, from env vars)
 */
app.get('/api/sync-intervals', requireAuth, async (req, res) => {
    try {
        res.json({
            intervals: {
                catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS || '3'),
                locations: parseInt(process.env.SYNC_LOCATIONS_INTERVAL_HOURS || '3'),
                vendors: parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS || '24'),
                inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS || '3'),
                sales_91d: parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS || '3'),
                sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
                sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168'),
                gmc: process.env.GMC_SYNC_INTERVAL_HOURS ? parseInt(process.env.GMC_SYNC_INTERVAL_HOURS) : null
            },
            cronSchedule: process.env.SYNC_CRON_SCHEDULE || '0 * * * *'
        });
    } catch (error) {
        logger.error('Get sync intervals error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sync-status
 * Get current sync status for all sync types
 */
app.get('/api/sync-status', requireAuth, requireMerchant, async (req, res) => {
    try {
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
app.get('/api/categories', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/items', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/variations', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/variations-with-costs', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
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
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $1
            LEFT JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $1
            WHERE v.price_money IS NOT NULL AND v.merchant_id = $1
            ORDER BY i.name, v.name, ve.name
        `;

        const result = await db.query(query, [merchantId]);

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
app.patch('/api/variations/:id/extended', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const merchantId = req.merchantContext.id;

        // Verify variation belongs to this merchant
        const varCheck = await db.query('SELECT id FROM variations WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
        if (varCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
        }

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
        values.push(merchantId);

        const query = `
            UPDATE variations
            SET ${updates.join(', ')}
            WHERE id = $${paramCount} AND merchant_id = $${paramCount + 1}
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
                }, { merchantId });
                logger.info('Case pack synced to Square', { variation_id: id, case_pack: newCasePackValue, merchantId });
            } catch (syncError) {
                logger.error('Failed to sync case pack to Square', { variation_id: id, merchantId, error: syncError.message });
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
app.patch('/api/variations/:id/min-stock', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const { min_stock, location_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Validate input
        if (min_stock !== null && (typeof min_stock !== 'number' || min_stock < 0)) {
            return res.status(400).json({
                error: 'min_stock must be a non-negative number or null'
            });
        }

        // Get variation details (verify ownership)
        const variationResult = await db.query(
            `SELECT v.id, v.sku, v.name, v.item_id, v.track_inventory,
                    v.inventory_alert_threshold, i.name as item_name
             FROM variations v
             JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
             WHERE v.id = $1 AND v.merchant_id = $2`,
            [id, merchantId]
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
                 JOIN locations l ON ic.location_id = l.id AND l.merchant_id = $2
                 WHERE ic.catalog_object_id = $1 AND l.active = TRUE AND ic.state = 'IN_STOCK'
                   AND ic.merchant_id = $2
                 ORDER BY ic.quantity DESC NULLS LAST
                 LIMIT 1`,
                [id, merchantId]
            );

            if (inventoryLocationResult.rows.length > 0) {
                targetLocationId = inventoryLocationResult.rows[0].location_id;
            } else {
                // Fall back to the primary/first active location
                const locationResult = await db.query(
                    'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1 ORDER BY name LIMIT 1',
                    [merchantId]
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
            await squareApi.setSquareInventoryAlertThreshold(id, targetLocationId, min_stock, { merchantId });
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
             WHERE id = $3 AND merchant_id = $4`,
            [
                min_stock,
                min_stock !== null && min_stock > 0 ? 'LOW_QUANTITY' : 'NONE',
                id,
                merchantId
            ]
        );

        // Also update location-specific settings if table exists
        await db.query(
            `INSERT INTO variation_location_settings (variation_id, location_id, stock_alert_min, merchant_id, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (variation_id, location_id, merchant_id)
             DO UPDATE SET stock_alert_min = EXCLUDED.stock_alert_min, updated_at = CURRENT_TIMESTAMP`,
            [id, targetLocationId, min_stock, merchantId]
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
app.patch('/api/variations/:id/cost', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const { cost_cents, vendor_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Validate input
        if (cost_cents === undefined || cost_cents === null) {
            return res.status(400).json({ error: 'cost_cents is required' });
        }

        if (typeof cost_cents !== 'number' || cost_cents < 0) {
            return res.status(400).json({ error: 'cost_cents must be a non-negative number' });
        }

        // Pre-validate vendor_id if provided (security: ensure vendor belongs to this merchant)
        if (vendor_id) {
            const vendorCheck = await db.query(
                'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
                [vendor_id, merchantId]
            );
            if (vendorCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Invalid vendor or vendor does not belong to this merchant' });
            }
        }

        // Get variation details (verify ownership)
        const variationResult = await db.query(`
            SELECT v.id, v.sku, v.name, i.name as item_name,
                   vv.vendor_id, vv.unit_cost_money as current_cost,
                   ven.name as vendor_name
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
            LEFT JOIN vendors ven ON vv.vendor_id = ven.id AND ven.merchant_id = $2
            WHERE v.id = $1 AND v.merchant_id = $2
            ORDER BY vv.unit_cost_money ASC NULLS LAST
            LIMIT 1
        `, [id, merchantId]);

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
                    'CAD',
                    { merchantId }
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
app.post('/api/variations/bulk-update-extended', requireAuth, requireMerchant, async (req, res) => {
    try {
        const updates = req.body;
        const merchantId = req.merchantContext.id;

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
                    values.push(merchantId);

                    // Get variation ID before updating (needed for Square sync)
                    const variationResult = await db.query(
                        'SELECT id FROM variations WHERE sku = $1 AND merchant_id = $2',
                        [update.sku, merchantId]
                    );

                    await db.query(`
                        UPDATE variations
                        SET ${sets.join(', ')}
                        WHERE sku = $${paramCount} AND merchant_id = $${paramCount + 1}
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
                            }, { merchantId });
                            squarePushResults.success++;
                            logger.info('Case pack synced to Square (bulk)', { variation_id: variationId, sku: update.sku, case_pack: newCasePackValue, merchantId });
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
app.get('/api/expirations', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { expiry, category } = req.query;
        const merchantId = req.merchantContext.id;

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
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK' AND ic.merchant_id = $1
            WHERE COALESCE(v.is_deleted, FALSE) = FALSE AND v.merchant_id = $1
        `;
        const params = [merchantId];

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
                const days = parseInt(expiry, 10);
                if (!isNaN(days) && days >= 0 && days <= 3650) {
                    // SECURITY FIX: Use parameterized query instead of string interpolation
                    params.push(days);
                    query += ` HAVING ve.expiration_date IS NOT NULL
                              AND ve.does_not_expire = FALSE
                              AND ve.expiration_date <= NOW() + ($${params.length} || ' days')::interval
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
app.post('/api/expirations', requireAuth, requireMerchant, async (req, res) => {
    try {
        const changes = req.body;
        const merchantId = req.merchantContext.id;

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

            // Verify variation belongs to this merchant
            const varCheck = await db.query(
                'SELECT id FROM variations WHERE id = $1 AND merchant_id = $2',
                [variation_id, merchantId]
            );
            if (varCheck.rows.length === 0) {
                logger.warn('Skipping change - variation not found for merchant', { variation_id, merchantId });
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
                INSERT INTO variation_expiration (variation_id, expiration_date, does_not_expire, updated_at, merchant_id)
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
                ON CONFLICT (variation_id, merchant_id)
                DO UPDATE SET
                    expiration_date = EXCLUDED.expiration_date,
                    does_not_expire = EXCLUDED.does_not_expire,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                variation_id,
                effectiveExpirationDate,
                does_not_expire === true,
                merchantId
            ]);

            // Check if new date puts item into a discount tier (AUTO25/AUTO50)
            // If so, clear reviewed_at so it appears in expiry-audit for sticker confirmation
            if (expiration_date && does_not_expire !== true) {
                const daysUntilExpiry = expiryDiscount.calculateDaysUntilExpiry(expiration_date);
                const tiers = await expiryDiscount.getActiveTiers(merchantId);
                const newTier = expiryDiscount.determineTier(daysUntilExpiry, tiers);

                if (newTier && (newTier.tier_code === 'AUTO25' || newTier.tier_code === 'AUTO50')) {
                    // Clear reviewed_at so item shows up in audit for sticker confirmation
                    await db.query(`
                        UPDATE variation_expiration
                        SET reviewed_at = NULL, reviewed_by = NULL
                        WHERE variation_id = $1 AND merchant_id = $2
                    `, [variation_id, merchantId]);
                    logger.info('Cleared reviewed_at for discount tier item', {
                        variation_id,
                        daysUntilExpiry,
                        tier: newTier.tier_code,
                        merchantId
                    });
                }
            }

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

                await squareApi.updateCustomAttributeValues(variation_id, customAttributeValues, { merchantId });
                squarePushResults.success++;
                logger.info('Pushed expiry to Square', { variation_id, expiration_date, does_not_expire, merchantId });
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
app.post('/api/expirations/review', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { variation_ids, reviewed_by } = req.body;
        const merchantId = req.merchantContext.id;

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
            // Verify variation belongs to this merchant
            const varCheck = await db.query(
                'SELECT id FROM variations WHERE id = $1 AND merchant_id = $2',
                [variation_id, merchantId]
            );
            if (varCheck.rows.length === 0) {
                continue;
            }

            // Save to local database
            await db.query(`
                INSERT INTO variation_expiration (variation_id, reviewed_at, reviewed_by, updated_at, merchant_id)
                VALUES ($1, NOW(), $2, NOW(), $3)
                ON CONFLICT (variation_id, merchant_id)
                DO UPDATE SET
                    reviewed_at = NOW(),
                    reviewed_by = COALESCE($2, variation_expiration.reviewed_by),
                    updated_at = NOW()
            `, [variation_id, reviewed_by || 'User', merchantId]);

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
                await squareApi.updateCustomAttributeValues(variation_id, customAttributeValues, { merchantId });
                squarePushResults.success++;
            } catch (squareError) {
                squarePushResults.failed++;
                squarePushResults.errors.push({ variation_id, error: squareError.message });
                logger.warn('Failed to push review data to Square', {
                    variation_id,
                    merchantId,
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
app.get('/api/expiry-discounts/status', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const summary = await expiryDiscount.getDiscountStatusSummary(merchantId);
        res.json(summary);
    } catch (error) {
        logger.error('Get expiry discount status error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/tiers
 * Get all discount tier configurations
 * Creates default tiers for new merchants if none exist
 */
app.get('/api/expiry-discounts/tiers', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Ensure merchant has default tiers configured
        await expiryDiscount.ensureMerchantTiers(merchantId);

        const result = await db.query(`
            SELECT * FROM expiry_discount_tiers
            WHERE merchant_id = $1
            ORDER BY priority DESC
        `, [merchantId]);
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
app.patch('/api/expiry-discounts/tiers/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const merchantId = req.merchantContext.id;

        // Build dynamic update query
        const allowedFields = [
            'tier_name', 'min_days_to_expiry', 'max_days_to_expiry',
            'discount_percent', 'is_auto_apply', 'requires_review',
            'color_code', 'priority', 'is_active'
        ];

        const setClauses = [];
        const params = [id, merchantId];

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
            WHERE id = $1 AND merchant_id = $2
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
app.get('/api/expiry-discounts/variations', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { tier_code, needs_pull, limit = 100, offset = 0 } = req.query;
        const merchantId = req.merchantContext.id;

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
            JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
            LEFT JOIN variation_expiration ve ON v.id = ve.variation_id AND ve.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE') AND ic.merchant_id = $1
            WHERE v.is_deleted = FALSE
        `;

        const params = [merchantId];

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
            JOIN variations v ON vds.variation_id = v.id AND vds.merchant_id = $1 AND v.merchant_id = $1
            LEFT JOIN expiry_discount_tiers edt ON vds.current_tier_id = edt.id AND edt.merchant_id = $1
            WHERE v.is_deleted = FALSE
        `;
        const countParams = [merchantId];

        if (tier_code) {
            countParams.push(tier_code);
            countQuery += ` AND edt.tier_code = $${countParams.length}`;
        }
        if (needs_pull === 'true') {
            countQuery += ` AND vds.needs_pull = TRUE`;
        }

        const countResult = await db.query(countQuery, countParams);

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
app.post('/api/expiry-discounts/evaluate', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { dry_run = false } = req.body;
        const merchantId = req.merchantContext.id;

        logger.info('Manual expiry evaluation requested', { dry_run, merchantId });

        const result = await expiryDiscount.evaluateAllVariations({
            dryRun: dry_run,
            triggeredBy: 'MANUAL',
            merchantId
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
app.post('/api/expiry-discounts/apply', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { dry_run = false } = req.body;
        const merchantId = req.merchantContext.id;

        logger.info('Manual discount application requested', { dry_run, merchantId });

        const result = await expiryDiscount.applyDiscounts({ dryRun: dry_run, merchantId });

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
app.post('/api/expiry-discounts/run', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { dry_run = false } = req.body;
        const merchantId = req.merchantContext.id;

        logger.info('Full expiry discount automation requested', { dry_run, merchantId });

        const result = await expiryDiscount.runExpiryDiscountAutomation({ dryRun: dry_run, merchantId });

        // Send email notification if enabled and not dry run
        if (!dry_run && result.evaluation) {
            const tierChanges = result.evaluation.tierChanges?.length || 0;
            const newAssignments = result.evaluation.newAssignments?.length || 0;

            if (tierChanges > 0 || newAssignments > 0) {
                const emailEnabled = await expiryDiscount.getSetting('email_notifications', merchantId);
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
app.post('/api/expiry-discounts/init-square', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Square discount initialization requested', { merchantId });

        const result = await expiryDiscount.initializeSquareDiscounts(merchantId);

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
app.get('/api/expiry-discounts/audit-log', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { variation_id, limit = 100 } = req.query;
        const merchantId = req.merchantContext.id;

        const logs = await expiryDiscount.getAuditLog(merchantId, {
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
app.get('/api/expiry-discounts/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT setting_key, setting_value, description
            FROM expiry_discount_settings
            WHERE merchant_id = $1
            ORDER BY setting_key
        `, [merchantId]);

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
app.patch('/api/expiry-discounts/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const updates = req.body;
        const merchantId = req.merchantContext.id;

        for (const [key, value] of Object.entries(updates)) {
            await expiryDiscount.updateSetting(key, value, merchantId);
        }

        logger.info('Updated expiry discount settings', { updates, merchantId });

        res.json({ success: true, message: 'Settings updated' });

    } catch (error) {
        logger.error('Update expiry discount settings error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/expiry-discounts/validate
 * Validate expiry discount configuration in Square
 * Checks that discount percentages match and pricing rules are correctly configured
 */
app.get('/api/expiry-discounts/validate', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await expiryDiscount.validateExpiryDiscounts({
            merchantId,
            fix: false
        });
        res.json(result);
    } catch (error) {
        logger.error('Validate expiry discounts error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/expiry-discounts/validate-and-fix
 * Validate expiry discount configuration and fix any issues found
 */
app.post('/api/expiry-discounts/validate-and-fix', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await expiryDiscount.validateExpiryDiscounts({
            merchantId,
            fix: true
        });

        logger.info('Validated and fixed expiry discount issues', {
            merchantId,
            tiersChecked: result.tiersChecked,
            issues: result.issues.length,
            fixed: result.fixed.length
        });

        res.json(result);
    } catch (error) {
        logger.error('Validate and fix expiry discounts error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== INVENTORY ENDPOINTS ====================

/**
 * GET /api/inventory
 * Get current inventory levels
 */
app.get('/api/inventory', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/low-stock', requireAuth, requireMerchant, async (req, res) => {
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
 * Get soft-deleted AND archived items for cleanup/management
 * Query params:
 *   - age_months: filter to items deleted/archived more than X months ago
 *   - status: 'deleted', 'archived', or 'all' (default: 'all')
 */
app.get('/api/deleted-items', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { age_months, status = 'all' } = req.query;
        const merchantId = req.merchantContext.id;

        // Build the WHERE clause based on status filter
        let statusCondition;
        if (status === 'deleted') {
            // Only truly deleted items (not in Square anymore)
            statusCondition = 'v.is_deleted = TRUE AND COALESCE(i.is_archived, FALSE) = FALSE';
        } else if (status === 'archived') {
            // Only archived items (still in Square but hidden)
            statusCondition = 'COALESCE(i.is_archived, FALSE) = TRUE AND COALESCE(v.is_deleted, FALSE) = FALSE';
        } else {
            // Both deleted and archived
            statusCondition = '(v.is_deleted = TRUE OR COALESCE(i.is_archived, FALSE) = TRUE)';
        }

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
                COALESCE(i.is_archived, FALSE) as is_archived,
                i.archived_at,
                CASE
                    WHEN v.is_deleted = TRUE THEN 'deleted'
                    WHEN COALESCE(i.is_archived, FALSE) = TRUE THEN 'archived'
                    ELSE 'unknown'
                END as status,
                COALESCE(SUM(ic.quantity), 0) as current_stock,
                CASE
                    WHEN v.is_deleted = TRUE THEN DATE_PART('day', NOW() - v.deleted_at)
                    WHEN COALESCE(i.is_archived, FALSE) = TRUE THEN DATE_PART('day', NOW() - i.archived_at)
                    ELSE 0
                END as days_inactive,
                v.images,
                i.images as item_images
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state = 'IN_STOCK' AND ic.merchant_id = $1
            WHERE ${statusCondition} AND v.merchant_id = $1
        `;
        const params = [merchantId];

        // Filter by age if specified
        if (age_months) {
            const months = parseInt(age_months, 10);
            // SECURITY FIX: Use parameterized query instead of string interpolation
            // Also validate the months value is reasonable (1-120 months = 10 years max)
            if (!isNaN(months) && months > 0 && months <= 120) {
                params.push(months);
                query += ` AND (
                    (v.deleted_at IS NOT NULL AND v.deleted_at <= NOW() - ($${params.length} || ' months')::interval)
                    OR (i.archived_at IS NOT NULL AND i.archived_at <= NOW() - ($${params.length} || ' months')::interval)
                )`;
            }
        }

        query += `
            GROUP BY v.id, i.name, v.name, v.sku, v.price_money, v.currency,
                     i.category_name, v.deleted_at, v.is_deleted, i.is_archived, i.archived_at, v.images, i.images
            ORDER BY
                COALESCE(v.deleted_at, i.archived_at) DESC NULLS LAST,
                i.name, v.name
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

        // Count by status
        const deletedCount = items.filter(i => i.status === 'deleted').length;
        const archivedCount = items.filter(i => i.status === 'archived').length;

        res.json({
            count: items.length,
            deleted_count: deletedCount,
            archived_count: archivedCount,
            deleted_items: items  // Keep the key name for backward compatibility
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
app.get('/api/catalog-audit', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { location_id, issue_type } = req.query;
        const merchantId = req.merchantContext.id;

        // SECURITY FIX: Validate location_id format if provided (Square location IDs are alphanumeric)
        const sanitizedLocationId = location_id && /^[A-Za-z0-9_-]+$/.test(location_id) ? location_id : null;

        // Build comprehensive audit query
        // SECURITY FIX: Use parameterized query for location_id ($2) instead of string interpolation
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
                    (SELECT COUNT(*) FROM variation_vendors vv WHERE vv.variation_id = v.id AND vv.merchant_id = v.merchant_id) as vendor_count,
                    -- Get primary vendor info
                    (SELECT ve.name
                     FROM variation_vendors vv
                     JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = v.merchant_id
                     WHERE vv.variation_id = v.id AND vv.merchant_id = v.merchant_id
                     ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                     LIMIT 1
                    ) as vendor_name,
                    -- Get unit cost
                    (SELECT vv.unit_cost_money
                     FROM variation_vendors vv
                     WHERE vv.variation_id = v.id AND vv.merchant_id = v.merchant_id
                     ORDER BY vv.unit_cost_money ASC, vv.created_at ASC
                     LIMIT 1
                    ) as unit_cost_cents,
                    -- Get current stock (sum across all locations or specific location)
                    -- SECURITY: Uses parameterized query ($2) for location filter
                    (SELECT COALESCE(SUM(ic.quantity), 0)
                     FROM inventory_counts ic
                     WHERE ic.catalog_object_id = v.id
                       AND ic.state = 'IN_STOCK'
                       AND ic.merchant_id = v.merchant_id
                       AND ($2::text IS NULL OR ic.location_id = $2)
                    ) as current_stock,
                    -- Check if ANY location has a stock_alert_min set (for reorder threshold check)
                    (SELECT MAX(vls.stock_alert_min)
                     FROM variation_location_settings vls
                     WHERE vls.variation_id = v.id
                       AND vls.stock_alert_min IS NOT NULL
                       AND vls.stock_alert_min > 0
                       AND vls.merchant_id = v.merchant_id
                    ) as location_stock_alert_min,
                    -- Sales velocity (all periods like reorder.html)
                    COALESCE(sv91.daily_avg_quantity, 0) as daily_velocity,
                    COALESCE(sv91.weekly_avg_quantity, 0) as weekly_avg_91d,
                    COALESCE(sv182.weekly_avg_quantity, 0) as weekly_avg_182d,
                    COALESCE(sv365.weekly_avg_quantity, 0) as weekly_avg_365d,
                    COALESCE(sv91.total_quantity_sold, 0) as total_sold_91d
                FROM variations v
                JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
                LEFT JOIN sales_velocity sv91 ON v.id = sv91.variation_id AND sv91.period_days = 91 AND sv91.merchant_id = $1
                LEFT JOIN sales_velocity sv182 ON v.id = sv182.variation_id AND sv182.period_days = 182 AND sv182.merchant_id = $1
                LEFT JOIN sales_velocity sv365 ON v.id = sv365.variation_id AND sv365.period_days = 365 AND sv365.merchant_id = $1
                WHERE v.merchant_id = $1
                  AND COALESCE(v.is_deleted, FALSE) = FALSE
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

        // SECURITY FIX: Use parameterized query with location_id as $2
        const params = [merchantId, sanitizedLocationId];
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
app.post('/api/catalog-audit/fix-locations', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Starting location mismatch fix from API', { merchantId });

        const result = await squareApi.fixLocationMismatches(merchantId);

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
app.get('/api/square/custom-attributes', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const definitions = await squareApi.listCustomAttributeDefinitions({ merchantId });
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

// REMOVED: /api/debug/merchant-data endpoint - exposed cross-tenant data (security audit 2026-01-05)

/**
 * POST /api/debug/restore-deleted-items
 * Recovery endpoint to restore items/variations incorrectly marked as deleted
 * This is used to fix the multi-tenant deletion bug
 */
app.post('/api/debug/restore-deleted-items', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Restore all items for this merchant
        const itemsResult = await db.query(`
            UPDATE items
            SET is_deleted = FALSE, deleted_at = NULL
            WHERE merchant_id = $1 AND is_deleted = TRUE
        `, [merchantId]);

        // Restore all variations for this merchant
        const variationsResult = await db.query(`
            UPDATE variations
            SET is_deleted = FALSE, deleted_at = NULL
            WHERE merchant_id = $1 AND is_deleted = TRUE
        `, [merchantId]);

        logger.info('Restored deleted items', {
            merchantId,
            itemsRestored: itemsResult.rowCount,
            variationsRestored: variationsResult.rowCount
        });

        res.json({
            success: true,
            itemsRestored: itemsResult.rowCount,
            variationsRestored: variationsResult.rowCount,
            message: `Restored ${itemsResult.rowCount} items and ${variationsResult.rowCount} variations`
        });
    } catch (error) {
        logger.error('Restore deleted items error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// NOTE: Legacy migration endpoints removed (2026-01-05)
// - POST /api/debug/backfill-merchant-id
// - POST /api/debug/migrate-legacy-token
// - POST /api/debug/merge-legacy-to-merchant
// These were temporary bridging functions for single-tenant to multi-tenant migration.

/**
 * GET /api/debug/expiry-status
 * Debug endpoint to check expiration sync status
 */
app.get('/api/debug/expiry-status', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { sku, variation_id } = req.query;
        const merchantId = req.merchantContext.id;

        let query = `
            SELECT ve.variation_id, ve.expiration_date, ve.does_not_expire,
                   ve.reviewed_at, ve.reviewed_by, ve.updated_at,
                   v.sku, v.name as variation_name, v.custom_attributes,
                   i.name as item_name
            FROM variation_expiration ve
            JOIN variations v ON ve.variation_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE ve.merchant_id = $1
        `;
        const params = [merchantId];

        if (sku) {
            params.push(sku);
            query += ` AND v.sku = $${params.length}`;
        } else if (variation_id) {
            params.push(variation_id);
            query += ` AND ve.variation_id = $${params.length}`;
        } else {
            // Show recently reviewed items
            query += ` AND ve.reviewed_at IS NOT NULL ORDER BY ve.reviewed_at DESC LIMIT 10`;
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
app.post('/api/square/custom-attributes/init', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Initializing custom attribute definitions', { merchantId });
        const result = await squareApi.initializeCustomAttributes({ merchantId });
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
app.post('/api/square/custom-attributes/definition', requireAuth, requireMerchant, async (req, res) => {
    try {
        const definition = req.body;
        const merchantId = req.merchantContext.id;

        if (!definition.key || !definition.name) {
            return res.status(400).json({ error: 'key and name are required' });
        }

        const result = await squareApi.upsertCustomAttributeDefinition(definition, { merchantId });
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
app.delete('/api/square/custom-attributes/definition/:key', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { key } = req.params;
        const merchantId = req.merchantContext.id;
        logger.info('Deleting custom attribute definition', { key, merchantId });
        const result = await squareApi.deleteCustomAttributeDefinition(key, { merchantId });
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
app.put('/api/square/custom-attributes/:objectId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { objectId } = req.params;
        const customAttributeValues = req.body;
        const merchantId = req.merchantContext.id;

        if (!customAttributeValues || Object.keys(customAttributeValues).length === 0) {
            return res.status(400).json({ error: 'customAttributeValues object is required' });
        }

        const result = await squareApi.updateCustomAttributeValues(objectId, customAttributeValues, { merchantId });
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
app.post('/api/square/custom-attributes/push/case-pack', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing case pack quantities to Square', { merchantId });
        const result = await squareApi.pushCasePackToSquare({ merchantId });
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
app.post('/api/square/custom-attributes/push/brand', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing brand assignments to Square', { merchantId });
        const result = await squareApi.pushBrandsToSquare({ merchantId });
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
app.post('/api/square/custom-attributes/push/expiry', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing expiry dates to Square', { merchantId });
        const result = await squareApi.pushExpiryDatesToSquare({ merchantId });
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
app.post('/api/square/custom-attributes/push/all', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing all custom attributes to Square', { merchantId });

        const results = {
            success: true,
            casePack: null,
            brand: null,
            expiry: null,
            errors: []
        };

        // Push case pack quantities
        try {
            results.casePack = await squareApi.pushCasePackToSquare({ merchantId });
        } catch (error) {
            results.errors.push({ type: 'casePack', error: error.message });
            results.success = false;
        }

        // Push brand assignments
        try {
            results.brand = await squareApi.pushBrandsToSquare({ merchantId });
        } catch (error) {
            results.errors.push({ type: 'brand', error: error.message });
            results.success = false;
        }

        // Push expiry dates
        try {
            results.expiry = await squareApi.pushExpiryDatesToSquare({ merchantId });
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
 * Check Google OAuth authentication status for current merchant
 */
app.get('/api/google/status', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const status = await googleSheets.getAuthStatus(merchantId);
        res.json(status);
    } catch (error) {
        logger.error('Google status error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/google/auth
 * Start Google OAuth flow for current merchant - redirects to Google consent screen
 * Uses GOOGLE_REDIRECT_URI from environment (not request hostname) to prevent private IP issues
 */
app.get('/api/google/auth', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const authUrl = googleSheets.getAuthUrl(merchantId);
        logger.info('Redirecting to Google OAuth', {
            merchantId,
            redirectUri: process.env.GOOGLE_REDIRECT_URI
        });
        res.redirect(authUrl);
    } catch (error) {
        logger.error('Google auth error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/google/callback
 * Google OAuth callback - exchanges code for tokens
 * Merchant ID is encoded in the state parameter
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
        const { code, state, error: oauthError } = req.query;

        if (oauthError) {
            logger.error('Google OAuth error', { error: oauthError });
            return res.redirect(`${publicUrl}/gmc-feed.html?google_error=${encodeURIComponent(oauthError)}`);
        }

        if (!code || !state) {
            return res.redirect(`${publicUrl}/gmc-feed.html?google_error=missing_code_or_state`);
        }

        // Parse merchant ID from state
        const { merchantId } = googleSheets.parseAuthState(state);
        if (!merchantId) {
            return res.redirect(`${publicUrl}/gmc-feed.html?google_error=invalid_state`);
        }

        await googleSheets.exchangeCodeForTokens(code, merchantId);
        logger.info('Google OAuth successful for merchant', { merchantId, publicUrl });
        res.redirect(`${publicUrl}/gmc-feed.html?google_connected=true`);
    } catch (error) {
        logger.error('Google callback error', { error: error.message });
        res.redirect(`${publicUrl}/gmc-feed.html?google_error=${encodeURIComponent(error.message)}`);
    }
});

/**
 * POST /api/google/disconnect
 * Disconnect Google OAuth for current merchant (remove tokens)
 */
app.post('/api/google/disconnect', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        await googleSheets.disconnect(merchantId);
        res.json({ success: true, message: 'Google account disconnected' });
    } catch (error) {
        logger.error('Google disconnect error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== GOOGLE MERCHANT CENTER FEED ENDPOINTS ====================

const gmcFeed = require('./utils/gmc-feed');

/**
 * GET /api/gmc/feed
 * Generate and return GMC feed data as JSON
 */
app.get('/api/gmc/feed', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { location_id, include_products } = req.query;
        const merchantId = req.merchantContext.id;
        const { products, stats, settings } = await gmcFeed.generateFeedData({
            locationId: location_id,
            includeProducts: include_products === 'true',
            merchantId
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
 * GET /api/gmc/feed.tsv
 * Download the current GMC feed as TSV
 * Supports multiple auth methods:
 *   1. Query param: ?token=xxx
 *   2. HTTP Basic Auth: password = token (GMC standard method)
 *   3. Session auth (for logged-in users)
 */
app.get('/api/gmc/feed.tsv', async (req, res) => {
    try {
        const { location_id, token } = req.query;
        let merchantId = null;
        let feedToken = token;

        // Check for HTTP Basic Auth (GMC's preferred method)
        // Format: Authorization: Basic base64(username:password)
        // We use the password field as the token
        const authHeader = req.headers.authorization;
        if (!feedToken && authHeader && authHeader.startsWith('Basic ')) {
            try {
                const base64Credentials = authHeader.split(' ')[1];
                const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
                const [, password] = credentials.split(':');
                if (password) {
                    feedToken = password;
                }
            } catch (e) {
                logger.warn('Failed to parse Basic Auth header', { error: e.message });
            }
        }

        // Check for feed token (query param or Basic Auth)
        if (feedToken) {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE gmc_feed_token = $1 AND is_active = TRUE',
                [feedToken]
            );
            if (merchantResult.rows.length === 0) {
                res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
                return res.status(401).json({ error: 'Invalid or expired feed token' });
            }
            merchantId = merchantResult.rows[0].id;
        }
        // Check for authenticated session
        else if (req.session?.user && req.merchantContext?.id) {
            merchantId = req.merchantContext.id;
        }
        // No auth provided - send Basic Auth challenge
        else {
            res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
            return res.status(401).json({
                error: 'Authentication required. Use ?token=<feed_token> or HTTP Basic Auth.'
            });
        }

        const { products } = await gmcFeed.generateFeedData({ locationId: location_id, merchantId });
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
app.get('/api/gmc/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const settings = await gmcFeed.getSettings(merchantId);
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
app.put('/api/gmc/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { settings } = req.body;
        const merchantId = req.merchantContext.id;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Settings object required' });
        }

        for (const [key, value] of Object.entries(settings)) {
            await db.query(`
                INSERT INTO gmc_settings (setting_key, setting_value, updated_at, merchant_id)
                VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
                ON CONFLICT (setting_key, merchant_id) DO UPDATE SET
                    setting_value = EXCLUDED.setting_value,
                    updated_at = CURRENT_TIMESTAMP
            `, [key, value, merchantId]);
        }

        const updatedSettings = await gmcFeed.getSettings(merchantId);
        res.json({ success: true, settings: updatedSettings });
    } catch (error) {
        logger.error('GMC settings update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/feed-url
 * Get the merchant's GMC feed URL with token for Google Merchant Center
 */
app.get('/api/gmc/feed-url', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const result = await db.query(
            'SELECT gmc_feed_token FROM merchants WHERE id = $1',
            [merchantId]
        );

        if (result.rows.length === 0 || !result.rows[0].gmc_feed_token) {
            return res.status(404).json({ error: 'Feed token not found. Please contact support.' });
        }

        const token = result.rows[0].gmc_feed_token;
        const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
        const feedUrl = `${baseUrl}/api/gmc/feed.tsv?token=${token}`;

        res.json({
            success: true,
            feedUrl,
            token,
            instructions: 'Use this URL in Google Merchant Center as your product feed URL. Keep the token secret.'
        });
    } catch (error) {
        logger.error('GMC feed URL error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/regenerate-token
 * Regenerate the GMC feed token (invalidates old feed URLs)
 */
app.post('/api/gmc/regenerate-token', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const crypto = require('crypto');
        const newToken = crypto.randomBytes(32).toString('hex');

        await db.query(
            'UPDATE merchants SET gmc_feed_token = $1, updated_at = NOW() WHERE id = $2',
            [newToken, merchantId]
        );

        const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
        const feedUrl = `${baseUrl}/api/gmc/feed.tsv?token=${newToken}`;

        logger.info('GMC feed token regenerated', { merchantId });

        res.json({
            success: true,
            feedUrl,
            token: newToken,
            warning: 'Your previous feed URL is now invalid. Update Google Merchant Center with the new URL.'
        });
    } catch (error) {
        logger.error('GMC token regeneration error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/brands
 * List all brands
 */
app.get('/api/gmc/brands', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query('SELECT * FROM brands WHERE merchant_id = $1 ORDER BY name', [merchantId]);
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
app.post('/api/gmc/brands/import', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { brands } = req.body;
        const merchantId = req.merchantContext.id;
        if (!Array.isArray(brands)) {
            return res.status(400).json({ error: 'Brands array required' });
        }

        const imported = await gmcFeed.importBrands(brands, merchantId);
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
app.post('/api/gmc/brands', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { name, logo_url, website } = req.body;
        const merchantId = req.merchantContext.id;
        if (!name) {
            return res.status(400).json({ error: 'Brand name required' });
        }

        const result = await db.query(
            'INSERT INTO brands (name, logo_url, website, merchant_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, logo_url, website, merchantId]
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
app.put('/api/gmc/items/:itemId/brand', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { itemId } = req.params;
        const { brand_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Verify item belongs to this merchant
        const itemCheck = await db.query('SELECT id FROM items WHERE id = $1 AND merchant_id = $2', [itemId, merchantId]);
        if (itemCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        let squareSyncResult = null;
        let brandName = null;

        if (!brand_id) {
            // Remove brand assignment
            await db.query('DELETE FROM item_brands WHERE item_id = $1 AND merchant_id = $2', [itemId, merchantId]);

            // Also remove from Square (set to empty string)
            try {
                squareSyncResult = await squareApi.updateCustomAttributeValues(itemId, {
                    brand: { string_value: '' }
                }, { merchantId });
                logger.info('Brand removed from Square', { item_id: itemId, merchantId });
            } catch (syncError) {
                logger.error('Failed to remove brand from Square', { item_id: itemId, merchantId, error: syncError.message });
                squareSyncResult = { success: false, error: syncError.message };
            }

            return res.json({ success: true, message: 'Brand removed from item', square_sync: squareSyncResult });
        }

        // Get brand name for Square sync
        const brandResult = await db.query('SELECT name FROM brands WHERE id = $1 AND merchant_id = $2', [brand_id, merchantId]);
        if (brandResult.rows.length === 0) {
            return res.status(404).json({ error: 'Brand not found' });
        }
        brandName = brandResult.rows[0].name;

        // Save to local database
        await db.query(`
            INSERT INTO item_brands (item_id, brand_id, merchant_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
        `, [itemId, brand_id, merchantId]);

        // Auto-sync brand to Square
        try {
            squareSyncResult = await squareApi.updateCustomAttributeValues(itemId, {
                brand: { string_value: brandName }
            }, { merchantId });
            logger.info('Brand synced to Square', { item_id: itemId, brand: brandName, merchantId });
        } catch (syncError) {
            logger.error('Failed to sync brand to Square', { item_id: itemId, merchantId, error: syncError.message });
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
app.post('/api/gmc/brands/auto-detect', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { brands: brandList } = req.body;
        const merchantId = req.merchantContext.id;

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

        // Ensure all brands exist in our brands table for this merchant
        for (const brandName of cleanedBrands) {
            await db.query(
                'INSERT INTO brands (name, merchant_id) VALUES ($1, $2) ON CONFLICT (name, merchant_id) DO NOTHING',
                [brandName, merchantId]
            );
        }

        // Get the brands from the master list with their DB IDs
        // Sort by length DESC so longer brand names match first (e.g., "Blue Buffalo" before "Blue")
        const brandsResult = await db.query(
            `SELECT id, name FROM brands WHERE name = ANY($1) AND merchant_id = $2 ORDER BY LENGTH(name) DESC`,
            [cleanedBrands, merchantId]
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
            LEFT JOIN item_brands ib ON i.id = ib.item_id AND ib.merchant_id = $1
            WHERE ib.item_id IS NULL
              AND i.is_deleted = FALSE
              AND i.merchant_id = $1
            ORDER BY i.name
        `, [merchantId]);

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
app.post('/api/gmc/brands/bulk-assign', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { assignments } = req.body;
        const merchantId = req.merchantContext.id;

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

        // Get brand names for Square sync (filtered by merchant)
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
                    INSERT INTO item_brands (item_id, brand_id, merchant_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (item_id, merchant_id) DO UPDATE SET brand_id = EXCLUDED.brand_id
                `, [item_id, brand_id, merchantId]);

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
app.get('/api/gmc/taxonomy', requireAuth, async (req, res) => {
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
app.post('/api/gmc/taxonomy/import', requireAdmin, async (req, res) => {
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
app.put('/api/gmc/categories/:categoryId/taxonomy', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { google_taxonomy_id } = req.body;
        const merchantId = req.merchantContext.id;

        // Verify category belongs to this merchant
        const catCheck = await db.query('SELECT id FROM categories WHERE id = $1 AND merchant_id = $2', [categoryId, merchantId]);
        if (catCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        if (!google_taxonomy_id) {
            // Remove mapping
            await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);
            return res.json({ success: true, message: 'Taxonomy mapping removed' });
        }

        await db.query(`
            INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id, merchant_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (category_id, merchant_id) DO UPDATE SET
                google_taxonomy_id = EXCLUDED.google_taxonomy_id,
                updated_at = CURRENT_TIMESTAMP
        `, [categoryId, google_taxonomy_id, merchantId]);

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
app.delete('/api/gmc/categories/:categoryId/taxonomy', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { categoryId } = req.params;
        const merchantId = req.merchantContext.id;
        await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);
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
app.get('/api/gmc/category-mappings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await db.query(`
            SELECT
                c.id as category_id,
                c.name as category_name,
                gt.id as google_taxonomy_id,
                gt.name as google_taxonomy_name
            FROM categories c
            LEFT JOIN category_taxonomy_mapping ctm ON c.id = ctm.category_id AND ctm.merchant_id = $1
            LEFT JOIN google_taxonomy gt ON ctm.google_taxonomy_id = gt.id
            WHERE c.merchant_id = $1
            ORDER BY c.name
        `, [merchantId]);
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
app.put('/api/gmc/category-taxonomy', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { category_name, google_taxonomy_id } = req.body;
        const merchantId = req.merchantContext.id;

        if (!category_name) {
            return res.status(400).json({ error: 'category_name is required' });
        }
        if (!google_taxonomy_id) {
            return res.status(400).json({ error: 'google_taxonomy_id is required' });
        }

        // Find or create the category by name for this merchant
        let categoryResult = await db.query(
            'SELECT id FROM categories WHERE name = $1 AND merchant_id = $2',
            [category_name, merchantId]
        );

        let categoryId;
        if (categoryResult.rows.length === 0) {
            // Create the category (use name as ID since Square categories use UUIDs)
            const insertResult = await db.query(
                'INSERT INTO categories (id, name, merchant_id) VALUES ($1, $2, $3) RETURNING id',
                [category_name, category_name, merchantId]
            );
            categoryId = insertResult.rows[0].id;
        } else {
            categoryId = categoryResult.rows[0].id;
        }

        // Create or update the mapping
        await db.query(`
            INSERT INTO category_taxonomy_mapping (category_id, google_taxonomy_id, merchant_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (category_id, merchant_id) DO UPDATE SET
                google_taxonomy_id = EXCLUDED.google_taxonomy_id,
                updated_at = CURRENT_TIMESTAMP
        `, [categoryId, google_taxonomy_id, merchantId]);

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
app.delete('/api/gmc/category-taxonomy', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { category_name } = req.body;
        const merchantId = req.merchantContext.id;

        if (!category_name) {
            return res.status(400).json({ error: 'category_name is required' });
        }

        // Find the category by name for this merchant
        const categoryResult = await db.query(
            'SELECT id FROM categories WHERE name = $1 AND merchant_id = $2',
            [category_name, merchantId]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const categoryId = categoryResult.rows[0].id;
        await db.query('DELETE FROM category_taxonomy_mapping WHERE category_id = $1 AND merchant_id = $2', [categoryId, merchantId]);

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
app.get('/api/gmc/taxonomy/fetch-google', requireAdmin, async (req, res) => {
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
 * GET /api/gmc/location-settings
 * Get GMC location settings (Google store codes) for all locations
 */
app.get('/api/gmc/location-settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Get all locations with their GMC settings
        const result = await db.query(`
            SELECT
                l.id as location_id,
                l.name as location_name,
                l.address as location_address,
                l.active,
                COALESCE(gls.google_store_code, '') as google_store_code,
                COALESCE(gls.enabled, true) as enabled
            FROM locations l
            LEFT JOIN gmc_location_settings gls ON l.id = gls.location_id AND gls.merchant_id = $1
            WHERE l.merchant_id = $1
            ORDER BY l.name
        `, [merchantId]);

        res.json({
            success: true,
            locations: result.rows
        });
    } catch (error) {
        logger.error('GMC location settings error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/location-settings/:locationId
 * Update GMC settings for a specific location
 */
app.put('/api/gmc/location-settings/:locationId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { locationId } = req.params;
        const { google_store_code, enabled } = req.body;
        const merchantId = req.merchantContext.id;

        // Verify location belongs to this merchant
        const locationCheck = await db.query(
            'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
            [locationId, merchantId]
        );

        if (locationCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        await gmcFeed.saveLocationSettings(merchantId, locationId, {
            google_store_code,
            enabled
        });

        res.json({
            success: true,
            message: 'Location settings updated'
        });
    } catch (error) {
        logger.error('GMC location settings update error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/local-inventory-feed-url
 * Get the merchant's local inventory feed URL with token for Google Merchant Center
 */
app.get('/api/gmc/local-inventory-feed-url', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const result = await db.query(
            'SELECT gmc_feed_token FROM merchants WHERE id = $1',
            [merchantId]
        );

        if (result.rows.length === 0 || !result.rows[0].gmc_feed_token) {
            return res.status(404).json({ error: 'Feed token not found. Please contact support.' });
        }

        const token = result.rows[0].gmc_feed_token;
        const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
        const feedUrl = `${baseUrl}/api/gmc/local-inventory-feed.tsv?token=${token}`;

        res.json({
            success: true,
            feedUrl,
            token,
            instructions: 'Use this URL in Google Merchant Center for local inventory. Keep the token secret.'
        });
    } catch (error) {
        logger.error('Local inventory feed URL error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/gmc/local-inventory-feed.tsv
 * Download combined local inventory feed TSV for all enabled locations
 * Supports multiple auth methods:
 *   1. Query param: ?token=xxx
 *   2. HTTP Basic Auth: password = token (GMC standard method)
 *   3. Session auth (for logged-in users)
 */
app.get('/api/gmc/local-inventory-feed.tsv', async (req, res) => {
    try {
        const { token } = req.query;
        let merchantId = null;
        let feedToken = token;

        // Check for HTTP Basic Auth (GMC's preferred method)
        // Format: Authorization: Basic base64(username:password)
        // We use the password field as the token
        const authHeader = req.headers.authorization;
        if (!feedToken && authHeader && authHeader.startsWith('Basic ')) {
            try {
                const base64Credentials = authHeader.split(' ')[1];
                const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
                const [, password] = credentials.split(':');
                if (password) {
                    feedToken = password;
                }
            } catch (e) {
                logger.warn('Failed to parse Basic Auth header', { error: e.message });
            }
        }

        // Check for feed token (query param or Basic Auth)
        if (feedToken) {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE gmc_feed_token = $1 AND is_active = TRUE',
                [feedToken]
            );
            if (merchantResult.rows.length === 0) {
                // Return 401 with WWW-Authenticate header for Basic Auth challenge
                res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
                return res.status(401).json({ error: 'Invalid or expired feed token' });
            }
            merchantId = merchantResult.rows[0].id;
        }
        // Check for session auth (for manual download)
        else if (req.session?.user && req.merchantContext?.id) {
            merchantId = req.merchantContext.id;
        }
        // No auth provided - send Basic Auth challenge
        else {
            res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
            return res.status(401).json({
                error: 'Authentication required. Use ?token=<feed_token> or HTTP Basic Auth.'
            });
        }

        // Get all enabled locations for this merchant
        const locationsResult = await db.query(`
            SELECT gls.location_id, gls.google_store_code
            FROM gmc_location_settings gls
            WHERE gls.merchant_id = $1 AND gls.enabled = TRUE AND gls.google_store_code IS NOT NULL AND gls.google_store_code != ''
        `, [merchantId]);

        if (locationsResult.rows.length === 0) {
            return res.status(400).json({
                error: 'No enabled locations with store codes found. Configure location settings first.'
            });
        }

        // Generate combined feed for all locations
        let allItems = [];
        for (const loc of locationsResult.rows) {
            try {
                const { items } = await gmcFeed.generateLocalInventoryFeed({
                    merchantId,
                    locationId: loc.location_id
                });
                allItems = allItems.concat(items);
            } catch (err) {
                logger.warn('Skipping location in combined feed', { locationId: loc.location_id, error: err.message });
            }
        }

        const tsvContent = gmcFeed.generateLocalInventoryTsvContent(allItems);

        res.setHeader('Content-Type', 'text/tab-separated-values');
        res.setHeader('Content-Disposition', 'attachment; filename="local-inventory-feed.tsv"');
        res.send(tsvContent);
    } catch (error) {
        logger.error('Combined local inventory TSV error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== MERCHANT CENTER API ENDPOINTS ====================

const gmcApi = require('./utils/merchant-center-api');

/**
 * GET /api/gmc/api-settings
 * Get GMC API settings (Merchant Center ID, etc.)
 */
app.get('/api/gmc/api-settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const settings = await gmcApi.getGmcApiSettings(merchantId);
        res.json({ success: true, settings });
    } catch (error) {
        logger.error('GMC API settings fetch error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/gmc/api-settings
 * Save GMC API settings
 */
app.put('/api/gmc/api-settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { settings } = req.body;

        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Settings object required' });
        }

        await gmcApi.saveGmcApiSettings(merchantId, settings);
        res.json({ success: true, message: 'GMC API settings saved' });
    } catch (error) {
        logger.error('GMC API settings save error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/gmc/api/test-connection
 * Test connection to Google Merchant Center API
 */
app.post('/api/gmc/api/test-connection', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await gmcApi.testConnection(merchantId);
        res.json(result);
    } catch (error) {
        logger.error('GMC API test connection error', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/gmc/api/data-source-info
 * Get data source configuration from Google Merchant Center
 */
app.get('/api/gmc/api/data-source-info', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const settings = await gmcApi.getGmcApiSettings(merchantId);

        if (!settings.gmc_merchant_id || !settings.gmc_data_source_id) {
            return res.status(400).json({
                success: false,
                error: 'GMC Merchant ID and Data Source ID must be configured'
            });
        }

        const dataSourceInfo = await gmcApi.getDataSourceInfo(
            merchantId,
            settings.gmc_merchant_id,
            settings.gmc_data_source_id
        );

        res.json({ success: true, dataSource: dataSourceInfo, settings });
    } catch (error) {
        logger.error('GMC data source info error', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/gmc/api/sync-products
 * Sync product catalog to Google Merchant Center
 * Runs async in background to avoid timeout
 */
app.post('/api/gmc/api/sync-products', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Return immediately, run sync in background
        res.json({ success: true, message: 'Sync started. Check Sync History for progress.', async: true });

        // Run sync in background (don't await)
        gmcApi.syncProductCatalog(merchantId).catch(err => {
            logger.error('Background GMC product sync error', { error: err.message, stack: err.stack });
        });
    } catch (error) {
        logger.error('GMC product sync error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/gmc/api/sync-status
 * Get last sync status for each sync type
 */
app.get('/api/gmc/api/sync-status', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const status = await gmcApi.getLastSyncStatus(merchantId);
        res.json({ success: true, status });
    } catch (error) {
        logger.error('Get GMC sync status error', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/gmc/api/sync-history
 * Get sync history for the merchant
 */
app.get('/api/gmc/api/sync-history', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const limit = parseInt(req.query.limit) || 20;
        const history = await gmcApi.getSyncHistory(merchantId, limit);
        res.json({ success: true, history });
    } catch (error) {
        logger.error('Get GMC sync history error', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== VENDOR ENDPOINTS ====================

/**
 * GET /api/vendors
 * List all vendors
 */
app.get('/api/vendors', requireAuth, requireMerchant, async (req, res) => {
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
app.post('/api/vendor-catalog/import', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { data, fileType, fileName, defaultVendorName } = req.body;
        const merchantId = req.merchantContext.id;

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
            defaultVendorName: defaultVendorName || null,
            merchantId
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
app.post('/api/vendor-catalog/preview', requireAuth, requireMerchant, async (req, res) => {
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
app.post('/api/vendor-catalog/import-mapped', requireAuth, requireMerchant, async (req, res) => {
    try {
        // Accept both 'mappings' (frontend) and 'columnMappings' (API) for compatibility
        const { data, fileType, fileName, columnMappings, mappings, vendorId, vendorName, importName } = req.body;
        const resolvedMappings = columnMappings || mappings;
        const merchantId = req.merchantContext.id;

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
            importName: importName || null,
            merchantId
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
app.get('/api/vendor-catalog/field-types', requireAuth, (req, res) => {
    res.json({ fieldTypes: vendorCatalog.FIELD_TYPES });
});

/**
 * GET /api/vendor-catalog
 * Search and list vendor catalog items
 */
app.get('/api/vendor-catalog', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { vendor_id, vendor_name, upc, search, matched_only, limit, offset } = req.query;
        const merchantId = req.merchantContext.id;

        const items = await vendorCatalog.searchVendorCatalog({
            vendorId: vendor_id,
            vendorName: vendor_name,
            upc,
            search,
            matchedOnly: matched_only === 'true',
            limit: parseInt(limit) || 100,
            offset: parseInt(offset) || 0,
            merchantId
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
app.get('/api/vendor-catalog/lookup/:upc', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { upc } = req.params;
        const merchantId = req.merchantContext.id;

        if (!upc) {
            return res.status(400).json({ error: 'UPC is required' });
        }

        const items = await vendorCatalog.lookupByUPC(upc, merchantId);

        // Also look up our catalog item by UPC
        const ourItem = await db.query(`
            SELECT
                v.id, v.sku, v.name as variation_name, v.upc, v.price_money,
                i.name as item_name, i.category_name,
                vv.unit_cost_money as current_cost_cents,
                vv.vendor_id as current_vendor_id
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
            WHERE v.upc = $1
              AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
              AND v.merchant_id = $2
            LIMIT 1
        `, [upc, merchantId]);

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
app.get('/api/vendor-catalog/batches', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { include_archived } = req.query;
        const merchantId = req.merchantContext.id;
        const batches = await vendorCatalog.getImportBatches({
            includeArchived: include_archived === 'true',
            merchantId
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
app.post('/api/vendor-catalog/batches/:batchId/archive', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const archivedCount = await vendorCatalog.archiveImportBatch(batchId, merchantId);
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
app.post('/api/vendor-catalog/batches/:batchId/unarchive', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const unarchivedCount = await vendorCatalog.unarchiveImportBatch(batchId, merchantId);
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
app.delete('/api/vendor-catalog/batches/:batchId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const deletedCount = await vendorCatalog.deleteImportBatch(batchId, merchantId);
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
app.get('/api/vendor-catalog/stats', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const stats = await vendorCatalog.getStats(merchantId);
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
app.post('/api/vendor-catalog/push-price-changes', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { priceChanges } = req.body;
        const merchantId = req.merchantContext.id;

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

        // Verify all variations belong to this merchant
        const variationIds = priceChanges.map(c => c.variationId);
        const placeholders = variationIds.map((_, i) => `$${i + 1}`).join(',');
        const verifyResult = await db.query(
            `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${variationIds.length + 1}`,
            [...variationIds, merchantId]
        );

        if (verifyResult.rows.length !== variationIds.length) {
            return res.status(403).json({
                success: false,
                error: 'One or more variations do not belong to this merchant'
            });
        }

        logger.info('Pushing price changes to Square', { count: priceChanges.length, merchantId });

        const squareApi = require('./utils/square-api');
        const result = await squareApi.batchUpdateVariationPrices(priceChanges, merchantId);

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
app.get('/api/locations', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/sales-velocity', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/reorder-suggestions', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const {
            vendor_id,
            supply_days,
            location_id,
            min_cost
        } = req.query;

        // Load merchant settings for reorder calculations
        const merchantSettings = await db.getMerchantSettings(merchantId);

        // Use supply_days from query, or fall back to merchant setting, or env default
        const defaultSupplyDays = merchantSettings.default_supply_days ||
            parseInt(process.env.DEFAULT_SUPPLY_DAYS || '45');
        const supplyDaysParam = supply_days || defaultSupplyDays;

        // Use merchant settings for safety days, fall back to env var
        const safetyDays = merchantSettings.reorder_safety_days ??
            parseInt(process.env.REORDER_SAFETY_DAYS || '7');

        // Debug logging for reorder issues
        logger.info('Reorder suggestions request', {
            merchantId,
            merchantName: req.merchantContext.businessName,
            vendor_id,
            supply_days: supplyDaysParam,
            safety_days: safetyDays,
            reorder_threshold: parseInt(supplyDaysParam) + safetyDays,
            location_id,
            usingMerchantSettings: true
        });

        // Input validation
        const supplyDaysNum = parseInt(supplyDaysParam);
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
                v.price_money as retail_price_cents,
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
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
            LEFT JOIN vendors ve ON vv.vendor_id = ve.id AND ve.merchant_id = $2
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

                  -- APPLY SUPPLY_DAYS + SAFETY_DAYS: Items with available stock that will run out within threshold period
                  -- Only applies to items with active sales velocity (sv91.daily_avg_quantity > 0)
                  -- $1 is (supply_days + safety_days) to include safety buffer
                  (sv91.daily_avg_quantity > 0
                      AND (COALESCE(ic.quantity, 0) - COALESCE(ic_committed.quantity, 0)) / sv91.daily_avg_quantity < $1)
              )
        `;

        // Combine supply days and safety days for the reorder threshold
        const reorderThreshold = supplyDaysNum + safetyDays;
        const params = [reorderThreshold, merchantId];

        if (vendor_id === 'none') {
            // Filter for items with NO vendor assigned
            query += ` AND vv.vendor_id IS NULL`;
        } else if (vendor_id) {
            params.push(vendor_id);
            query += ` AND vv.vendor_id = $${params.length}`;
        }

        if (location_id) {
            params.push(location_id);
            query += ` AND (ic.location_id = $${params.length} OR ic.location_id IS NULL)`;
            query += ` AND (sv91.location_id = $${params.length} OR sv91.location_id IS NULL)`;
        }

        const result = await db.query(query, params);

        // Debug: log query results
        logger.info('Reorder query results', {
            merchantId,
            rowCount: result.rows.length,
            params: params.slice(0, 3) // First 3 params for debugging
        });

        // Get priority thresholds from merchant settings, fall back to env vars
        const urgentDays = merchantSettings.reorder_priority_urgent_days ??
            parseInt(process.env.REORDER_PRIORITY_URGENT_DAYS || '0');
        const highDays = merchantSettings.reorder_priority_high_days ??
            parseInt(process.env.REORDER_PRIORITY_HIGH_DAYS || '7');
        const mediumDays = merchantSettings.reorder_priority_medium_days ??
            parseInt(process.env.REORDER_PRIORITY_MEDIUM_DAYS || '14');
        const lowDays = merchantSettings.reorder_priority_low_days ??
            parseInt(process.env.REORDER_PRIORITY_LOW_DAYS || '30');

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
                // 3. Include items that will stockout within supply_days + safety_days period (only if has velocity)
                const isOutOfStock = availableQty <= 0;
                const reorderThreshold = supplyDaysNum + safetyDays; // Include safety buffer
                const needsReorder = isOutOfStock || row.below_minimum || daysUntilStockout < reorderThreshold;
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

                // Calculate quantity needed to reach (supply_days + safety_days) worth of stock
                // Safety days adds buffer inventory to protect against demand variability
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
                    // baseSuggestedQty already includes safety days (from SQL: daily_avg * reorderThreshold)
                    // where reorderThreshold = supply_days + safety_days
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
                const retailPrice = parseInt(row.retail_price_cents) || 0;
                const pendingPoQty = parseInt(row.pending_po_quantity) || 0;

                // Calculate gross margin percentage: ((retail - cost) / retail) * 100
                const grossMarginPercent = retailPrice > 0 && unitCost > 0
                    ? Math.round(((retailPrice - unitCost) / retailPrice) * 1000) / 10  // 1 decimal place
                    : null;

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
                    retail_price_cents: retailPrice,
                    gross_margin_percent: grossMarginPercent,
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
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 */
async function generateDailyBatch(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for generateDailyBatch');
    }
    try {
        logger.info('Starting daily cycle count batch generation', { merchantId });
        const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');

        // Create today's session
        await db.query(
            `INSERT INTO count_sessions (session_date, items_expected, merchant_id)
             VALUES (CURRENT_DATE, $1, $2)
             ON CONFLICT (session_date, merchant_id) DO NOTHING`,
            [dailyTarget, merchantId]
        );

        // STEP 1: Auto-add recent inaccurate counts to priority queue for verification
        // This helps identify if discrepancies were one-off miscounts or real inventory issues
        // Looks back 7 days to catch items missed due to skipped cron jobs
        const recentInaccurateQuery = `
            SELECT DISTINCT ch.catalog_object_id, v.sku, i.name as item_name,
                   DATE(ch.last_counted_date) as count_date
            FROM count_history ch
            JOIN variations v ON ch.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN count_queue_priority cqp ON ch.catalog_object_id = cqp.catalog_object_id
                AND cqp.completed = FALSE AND cqp.merchant_id = $1
            WHERE ch.merchant_id = $1
              AND ch.is_accurate = FALSE
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
                  AND ch2.merchant_id = $1
                  AND ch2.last_counted_date > ch.last_counted_date
              )
        `;

        const recentInaccurate = await db.query(recentInaccurateQuery, [merchantId]);
        const recentInaccurateCount = recentInaccurate.rows.length;

        if (recentInaccurateCount > 0) {
            logger.info(`Found ${recentInaccurateCount} inaccurate counts from the past 7 days to recount`, { merchantId });

            // Add to priority queue for today (only if not already in queue)
            const priorityInserts = recentInaccurate.rows.map(item => {
                const daysAgo = item.count_date ? Math.floor((Date.now() - new Date(item.count_date)) / (1000 * 60 * 60 * 24)) : 1;
                const timeRef = daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
                return db.query(
                    `INSERT INTO count_queue_priority (catalog_object_id, notes, added_by, added_date, merchant_id)
                     SELECT $1, $2, 'System', CURRENT_TIMESTAMP, $3
                     WHERE NOT EXISTS (
                         SELECT 1 FROM count_queue_priority
                         WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $3
                     )`,
                    [item.catalog_object_id, `Recount - Inaccurate ${timeRef} (${item.sku})`, merchantId]
                );
            });

            await Promise.all(priorityInserts);
            logger.info(`Added ${recentInaccurateCount} items from recent inaccurate counts to priority queue`, { merchantId });
        } else {
            logger.info('No recent inaccurate counts to recount', { merchantId });
        }

        // Count uncompleted items from previous batches (for reporting)
        const uncompletedResult = await db.query(`
            SELECT COUNT(DISTINCT catalog_object_id) as count
            FROM count_queue_daily
            WHERE completed = FALSE AND merchant_id = $1
        `, [merchantId]);
        const uncompletedCount = parseInt(uncompletedResult.rows[0]?.count || 0);

        logger.info(`Found ${uncompletedCount} uncompleted items from previous batches`, { merchantId });

        // ALWAYS add the full daily target (30 items) regardless of backlog
        // This ensures we add 30 new items every day, and backlog accumulates
        const itemsToAdd = dailyTarget;

        // Get items to add (oldest count dates first, excluding already queued items)
        // Priority: Never counted > Oldest counted > Alphabetically
        const newItemsQuery = `
            SELECT v.id
            FROM variations v
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id AND ch.merchant_id = $2
            LEFT JOIN count_queue_daily cqd ON v.id = cqd.catalog_object_id AND cqd.completed = FALSE AND cqd.merchant_id = $2
            LEFT JOIN count_queue_priority cqp ON v.id = cqp.catalog_object_id AND cqp.completed = FALSE AND cqp.merchant_id = $2
            WHERE v.merchant_id = $2
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqd.id IS NULL
              AND cqp.id IS NULL
            ORDER BY ch.last_counted_date ASC NULLS FIRST, i.name, v.name
            LIMIT $1
        `;

        const newItems = await db.query(newItemsQuery, [itemsToAdd, merchantId]);

        if (newItems.rows.length === 0) {
            logger.info('No new items available to add to batch', { merchantId });
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
                `INSERT INTO count_queue_daily (catalog_object_id, batch_date, notes, merchant_id)
                 VALUES ($1, CURRENT_DATE, 'Auto-generated daily batch', $2)
                 ON CONFLICT (catalog_object_id, batch_date, merchant_id) DO NOTHING`,
                [item.id, merchantId]
            )
        );

        await Promise.all(insertPromises);

        logger.info(`Successfully added ${newItems.rows.length} new items to daily batch`, { merchantId });

        return {
            success: true,
            uncompleted: uncompletedCount,
            new_items_added: newItems.rows.length,
            yesterday_inaccurate_added: recentInaccurateCount,
            total_in_batch: uncompletedCount + newItems.rows.length
        };

    } catch (error) {
        logger.error('Daily batch generation failed', { merchantId, error: error.message });
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
app.get('/api/cycle-counts/pending', requireAuth, requireMerchant, async (req, res) => {
    try {
        const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');
        const merchantId = req.merchantContext.id;

        // Get today's session or create it
        await db.query(
            `INSERT INTO count_sessions (session_date, items_expected, merchant_id)
             VALUES (CURRENT_DATE, $1, $2)
             ON CONFLICT (session_date, merchant_id) DO NOTHING`,
            [dailyTarget, merchantId]
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
            JOIN variations v ON cqp.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE') AND ic.merchant_id = $1
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id AND ch.merchant_id = $1
            WHERE cqp.completed = FALSE AND cqp.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
            GROUP BY v.id, i.name, i.category_name, i.images, ch.last_counted_date, ch.counted_by,
                     cqp.added_date, cqp.notes
            ORDER BY i.name ASC, v.name ASC
        `;

        const priorityItems = await db.query(priorityQuery, [merchantId]);
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
            JOIN variations v ON cqd.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            LEFT JOIN inventory_counts ic ON v.id = ic.catalog_object_id AND ic.state IN ('IN_STOCK', 'RESERVED_FOR_SALE') AND ic.merchant_id = $1
            LEFT JOIN count_history ch ON v.id = ch.catalog_object_id AND ch.merchant_id = $1
            LEFT JOIN count_queue_priority cqp ON v.id = cqp.catalog_object_id AND cqp.completed = FALSE AND cqp.merchant_id = $1
            WHERE cqd.completed = FALSE AND cqd.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
              AND v.track_inventory = TRUE
              AND cqp.id IS NULL
            GROUP BY v.id, i.name, i.category_name, i.images, ch.last_counted_date, ch.counted_by,
                     cqd.batch_date, cqd.added_date
            ORDER BY i.name ASC, v.name ASC
        `;

        const dailyBatchItems = await db.query(dailyBatchQuery, [merchantId]);

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
app.post('/api/cycle-counts/:id/complete', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const { counted_by, is_accurate, actual_quantity, expected_quantity, notes } = req.body;
        const merchantId = req.merchantContext.id;

        // Validate catalog_object_id
        if (!id || id === 'null' || id === 'undefined') {
            logger.error('Invalid catalog_object_id received', { id, body: req.body });
            return res.status(400).json({
                error: 'Invalid item ID. Please refresh the page and try again.'
            });
        }

        // Verify variation belongs to this merchant
        const varCheck = await db.query(
            'SELECT id FROM variations WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
        );
        if (varCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found' });
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
                is_accurate, actual_quantity, expected_quantity, variance, notes, merchant_id
             )
             VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (catalog_object_id, merchant_id)
             DO UPDATE SET
                last_counted_date = CURRENT_TIMESTAMP,
                counted_by = EXCLUDED.counted_by,
                is_accurate = EXCLUDED.is_accurate,
                actual_quantity = EXCLUDED.actual_quantity,
                expected_quantity = EXCLUDED.expected_quantity,
                variance = EXCLUDED.variance,
                notes = EXCLUDED.notes`,
            [id, counted_by || 'System', is_accurate, actual_quantity, expected_quantity, variance, notes, merchantId]
        );

        // Mark priority item as completed if it exists
        await db.query(
            `UPDATE count_queue_priority
             SET completed = TRUE, completed_date = CURRENT_TIMESTAMP
             WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $2`,
            [id, merchantId]
        );

        // Mark daily batch item as completed if it exists
        await db.query(
            `UPDATE count_queue_daily
             SET completed = TRUE, completed_date = CURRENT_TIMESTAMP
             WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $2`,
            [id, merchantId]
        );

        // Update session completed count
        await db.query(
            `UPDATE count_sessions
             SET items_completed = items_completed + 1,
                 completion_rate = (items_completed + 1)::DECIMAL / items_expected * 100
             WHERE session_date = CURRENT_DATE AND merchant_id = $1`,
            [merchantId]
        );

        // Check if we've reached 100% completion for today
        const completionCheck = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE completed = FALSE) as pending_count,
                COUNT(*) as total_count
            FROM (
                SELECT catalog_object_id, completed FROM count_queue_daily WHERE batch_date <= CURRENT_DATE AND merchant_id = $1
                UNION
                SELECT catalog_object_id, completed FROM count_queue_priority WHERE merchant_id = $1
            ) combined
        `, [merchantId]);

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
app.post('/api/cycle-counts/:id/sync-to-square', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const { actual_quantity, location_id } = req.body;
        const merchantId = req.merchantContext.id;

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
             JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
             WHERE v.id = $1 AND v.merchant_id = $2`,
            [id, merchantId]
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
                'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1 ORDER BY name LIMIT 1',
                [merchantId]
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
               AND state = 'IN_STOCK'
               AND merchant_id = $3`,
            [id, targetLocationId, merchantId]
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

        const squareQuantity = await squareApi.getSquareInventoryCount(id, targetLocationId, merchantId);

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
            `Cycle count adjustment - SKU: ${variation.sku || 'N/A'}`,
            merchantId
        );

        // Update our local database with the new quantity
        await db.query(
            `INSERT INTO inventory_counts (catalog_object_id, location_id, state, quantity, updated_at, merchant_id)
             VALUES ($1, $2, 'IN_STOCK', $3, CURRENT_TIMESTAMP, $4)
             ON CONFLICT (catalog_object_id, location_id, state, merchant_id)
             DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
            [id, targetLocationId, actualQty, merchantId]
        );

        // Update the count_history to mark it as synced
        await db.query(
            `UPDATE count_history
             SET notes = COALESCE(notes, '') || ' [Synced to Square at ' || TO_CHAR(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') || ']'
             WHERE catalog_object_id = $1 AND merchant_id = $2`,
            [id, merchantId]
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
app.post('/api/cycle-counts/send-now', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { skus, added_by, notes } = req.body;
        const merchantId = req.merchantContext.id;

        if (!skus || !Array.isArray(skus) || skus.length === 0) {
            return res.status(400).json({ error: 'SKUs array is required' });
        }

        // Find variation IDs for given SKUs
        const variations = await db.query(
            `SELECT id, sku FROM variations
             WHERE sku = ANY($1::text[])
             AND COALESCE(is_deleted, FALSE) = FALSE
             AND merchant_id = $2`,
            [skus, merchantId]
        );

        if (variations.rows.length === 0) {
            return res.status(404).json({ error: 'No valid SKUs found' });
        }

        // Insert into priority queue (only if not already in queue)
        const insertPromises = variations.rows.map(row =>
            db.query(
                `INSERT INTO count_queue_priority (catalog_object_id, added_by, notes, merchant_id)
                 SELECT $1, $2, $3, $4
                 WHERE NOT EXISTS (
                     SELECT 1 FROM count_queue_priority
                     WHERE catalog_object_id = $1 AND completed = FALSE AND merchant_id = $4
                 )`,
                [row.id, added_by || 'System', notes || null, merchantId]
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
app.get('/api/cycle-counts/stats', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { days } = req.query;
        const lookbackDays = parseInt(days || '30');
        const merchantId = req.merchantContext.id;

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
              AND merchant_id = $1
            ORDER BY session_date DESC
        `;

        const sessions = await db.query(sessionsQuery, [merchantId]);

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
            WHERE merchant_id = $1
        `;

        const overall = await db.query(overallQuery, [merchantId]);

        // Get total variations that need counting
        const totalQuery = `
            SELECT COUNT(*) as total_variations
            FROM variations
            WHERE COALESCE(is_deleted, FALSE) = FALSE
              AND track_inventory = TRUE
              AND merchant_id = $1
        `;

        const total = await db.query(totalQuery, [merchantId]);

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
app.get('/api/cycle-counts/history', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { date, start_date, end_date } = req.query;
        const merchantId = req.merchantContext.id;

        let dateFilter = '';
        const params = [merchantId];

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
            JOIN variations v ON ch.catalog_object_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            WHERE ch.merchant_id = $1
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
app.post('/api/cycle-counts/email-report', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await sendCycleCountReport(merchantId);

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
app.post('/api/cycle-counts/generate-batch', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Manual batch generation requested', { merchantId });
        const result = await generateDailyBatch(merchantId);

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
app.post('/api/cycle-counts/reset', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { preserve_history } = req.body;
        const merchantId = req.merchantContext.id;

        if (preserve_history !== false) {
            // Add all variations that don't have count history yet
            await db.query(`
                INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by, merchant_id)
                SELECT v.id, '1970-01-01'::timestamp, 'System Reset', $1
                FROM variations v
                WHERE COALESCE(v.is_deleted, FALSE) = FALSE
                  AND v.track_inventory = TRUE
                  AND v.merchant_id = $1
                  AND NOT EXISTS (
                    SELECT 1 FROM count_history ch
                    WHERE ch.catalog_object_id = v.id AND ch.merchant_id = $1
                  )
            `, [merchantId]);
        } else {
            // Complete reset - clear all history for this merchant
            await db.query('DELETE FROM count_history WHERE merchant_id = $1', [merchantId]);
            await db.query('DELETE FROM count_queue_priority WHERE merchant_id = $1', [merchantId]);
            await db.query('DELETE FROM count_sessions WHERE merchant_id = $1', [merchantId]);

            // Re-initialize with all current variations
            await db.query(`
                INSERT INTO count_history (catalog_object_id, last_counted_date, counted_by, merchant_id)
                SELECT id, '1970-01-01'::timestamp, 'System Reset', $1
                FROM variations
                WHERE COALESCE(is_deleted, FALSE) = FALSE
                  AND track_inventory = TRUE
                  AND merchant_id = $1
            `, [merchantId]);
        }

        const countResult = await db.query('SELECT COUNT(*) as count FROM count_history WHERE merchant_id = $1', [merchantId]);

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
app.post('/api/purchase-orders', requireAuth, requireMerchant, async (req, res) => {
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

        // Security: Pre-validate vendor_id belongs to this merchant
        const vendorCheck = await db.query(
            'SELECT id FROM vendors WHERE id = $1 AND merchant_id = $2',
            [vendor_id, merchantId]
        );
        if (vendorCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid vendor or vendor does not belong to this merchant' });
        }

        // Security: Pre-validate location_id belongs to this merchant
        const locationCheck = await db.query(
            'SELECT id FROM locations WHERE id = $1 AND merchant_id = $2',
            [location_id, merchantId]
        );
        if (locationCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid location or location does not belong to this merchant' });
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
app.get('/api/purchase-orders', requireAuth, requireMerchant, async (req, res) => {
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
app.get('/api/purchase-orders/:id', requireAuth, requireMerchant, async (req, res) => {
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

        // Get PO items with vendor code and UPC for reconciliation
        const itemsResult = await db.query(`
            SELECT
                poi.*,
                v.sku,
                v.upc as gtin,
                i.name as item_name,
                v.name as variation_name,
                vv.vendor_code
            FROM purchase_order_items poi
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $2
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $3 AND vv.merchant_id = $2
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $2
            ORDER BY i.name, v.name
        `, [id, merchantId, po.vendor_id]);

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
app.patch('/api/purchase-orders/:id', requireAuth, requireMerchant, async (req, res) => {
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
app.post('/api/purchase-orders/:id/submit', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const merchantId = req.merchantContext.id;

        const result = await db.query(`
            UPDATE purchase_orders po
            SET
                status = 'SUBMITTED',
                order_date = COALESCE(order_date, CURRENT_DATE),
                expected_delivery_date = CURRENT_DATE + (
                    SELECT COALESCE(lead_time_days, 7) FROM vendors WHERE id = po.vendor_id AND merchant_id = $2
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'DRAFT' AND merchant_id = $2
            RETURNING *
        `, [id, merchantId]);

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
app.post('/api/purchase-orders/:id/receive', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const { items } = req.body;
        const merchantId = req.merchantContext.id;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'items array is required' });
        }

        // Verify PO belongs to this merchant
        const poCheck = await db.query(
            'SELECT id FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
        );
        if (poCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase order not found' });
        }

        await db.transaction(async (client) => {
            // Update received quantities
            for (const item of items) {
                await client.query(`
                    UPDATE purchase_order_items
                    SET received_quantity = $1
                    WHERE id = $2 AND purchase_order_id = $3 AND merchant_id = $4
                `, [item.received_quantity, item.id, id, merchantId]);

                // TODO: Update inventory_counts when items are received
                // This would require Square API write access
            }

            // Check if all items fully received
            const checkResult = await client.query(`
                SELECT
                    COUNT(*) as total,
                    COUNT(CASE WHEN received_quantity >= quantity_ordered THEN 1 END) as received
                FROM purchase_order_items
                WHERE purchase_order_id = $1 AND merchant_id = $2
            `, [id, merchantId]);

            const { total, received } = checkResult.rows[0];

            // Update PO status if all items received
            if (parseInt(total) === parseInt(received)) {
                await client.query(`
                    UPDATE purchase_orders
                    SET status = 'RECEIVED', actual_delivery_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND merchant_id = $2
                `, [id, merchantId]);
            } else {
                await client.query(`
                    UPDATE purchase_orders
                    SET status = 'PARTIAL', updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND merchant_id = $2
                `, [id, merchantId]);
            }
        });

        // Return updated PO
        const result = await db.query('SELECT * FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
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
app.delete('/api/purchase-orders/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { id } = req.params;
        const merchantId = req.merchantContext.id;

        // Check if PO exists and is in DRAFT status
        const poCheck = await db.query(
            'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 AND merchant_id = $2',
            [id, merchantId]
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
        await db.query('DELETE FROM purchase_orders WHERE id = $1 AND merchant_id = $2', [id, merchantId]);

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
app.get('/api/purchase-orders/:po_number/export-csv', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { po_number } = req.params;
        const merchantId = req.merchantContext.id;

        // Get PO header with vendor and location info
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name,
                l.address as location_address
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
            WHERE po.po_number = $1 AND po.merchant_id = $2
        `, [po_number, merchantId]);

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
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3
            ORDER BY i.name, v.name
        `, [po.id, po.vendor_id, merchantId]);

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
app.get('/api/purchase-orders/:po_number/export-xlsx', requireAuth, requireMerchant, async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const { po_number } = req.params;
        const merchantId = req.merchantContext.id;

        // Get PO header with vendor and location info
        const poResult = await db.query(`
            SELECT
                po.*,
                v.name as vendor_name,
                v.lead_time_days,
                l.name as location_name
            FROM purchase_orders po
            JOIN vendors v ON po.vendor_id = v.id AND v.merchant_id = $2
            JOIN locations l ON po.location_id = l.id AND l.merchant_id = $2
            WHERE po.po_number = $1 AND po.merchant_id = $2
        `, [po_number, merchantId]);

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
            JOIN variations v ON poi.variation_id = v.id AND v.merchant_id = $3
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $3
            LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.vendor_id = $2 AND vv.merchant_id = $3
            WHERE poi.purchase_order_id = $1 AND poi.merchant_id = $3
            ORDER BY i.name, v.name
        `, [po.id, po.vendor_id, merchantId]);

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

// NOTE: Database export/import endpoints removed for security (2026-01-05)
// These endpoints exposed all merchant data without tenant filtering.
// Database backups should be managed at the infrastructure level (pg_dump with proper access controls).

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
 * POST /api/subscriptions/promo/validate
 * Validate a promo code and return discount info
 */
app.post('/api/subscriptions/promo/validate', async (req, res) => {
    try {
        const { code, plan, priceCents } = req.body;

        if (!code) {
            return res.status(400).json({ valid: false, error: 'Promo code is required' });
        }

        // Look up the promo code
        const result = await db.query(`
            SELECT * FROM promo_codes
            WHERE UPPER(code) = UPPER($1)
              AND is_active = TRUE
              AND (valid_from IS NULL OR valid_from <= NOW())
              AND (valid_until IS NULL OR valid_until >= NOW())
              AND (max_uses IS NULL OR times_used < max_uses)
        `, [code.trim()]);

        if (result.rows.length === 0) {
            return res.json({ valid: false, error: 'Invalid or expired promo code' });
        }

        const promo = result.rows[0];

        // Check plan restriction
        if (promo.applies_to_plans && promo.applies_to_plans.length > 0 && plan) {
            if (!promo.applies_to_plans.includes(plan)) {
                return res.json({ valid: false, error: 'This code does not apply to the selected plan' });
            }
        }

        // Check minimum purchase
        if (promo.min_purchase_cents && priceCents && priceCents < promo.min_purchase_cents) {
            return res.json({
                valid: false,
                error: `Minimum purchase of $${(promo.min_purchase_cents / 100).toFixed(2)} required`
            });
        }

        // Calculate discount
        let discountCents = 0;
        if (promo.discount_type === 'percent') {
            discountCents = Math.floor((priceCents || 0) * promo.discount_value / 100);
        } else {
            discountCents = promo.discount_value;
        }

        // Don't let discount exceed price
        if (priceCents && discountCents > priceCents) {
            discountCents = priceCents;
        }

        res.json({
            valid: true,
            code: promo.code,
            description: promo.description,
            discountType: promo.discount_type,
            discountValue: promo.discount_value,
            discountCents,
            discountDisplay: promo.discount_type === 'percent'
                ? `${promo.discount_value}% off`
                : `$${(promo.discount_value / 100).toFixed(2)} off`
        });

    } catch (error) {
        logger.error('Promo code validation error', { error: error.message });
        res.status(500).json({ valid: false, error: 'Failed to validate promo code' });
    }
});

/**
 * POST /api/subscriptions/create
 * Create a new subscription using Square Subscriptions API
 *
 * SECURITY: No credit card data is stored locally. All payment data is held by Square.
 * We only store Square IDs (customer_id, card_id, subscription_id).
 * Square handles all recurring billing, PCI compliance, and payment processing.
 */
app.post('/api/subscriptions/create', async (req, res) => {
    try {
        const { email, businessName, plan, sourceId, promoCode, termsAcceptedAt } = req.body;

        if (!email || !plan || !sourceId) {
            return res.status(400).json({ error: 'Email, plan, and payment source are required' });
        }

        if (!termsAcceptedAt) {
            return res.status(400).json({ error: 'Terms of Service must be accepted' });
        }

        // Verify Square configuration
        const locationId = process.env.SQUARE_LOCATION_ID;
        if (!locationId) {
            logger.error('SQUARE_LOCATION_ID not configured');
            return res.status(500).json({ error: 'Payment system not configured. Please contact support.' });
        }

        // Check if subscriber already exists
        const existing = await subscriptionHandler.getSubscriberByEmail(email);
        if (existing) {
            return res.status(400).json({ error: 'An account with this email already exists' });
        }

        // Get plan pricing and Square plan variation ID
        const plans = await subscriptionHandler.getPlans();
        const selectedPlan = plans.find(p => p.plan_key === plan);
        if (!selectedPlan) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Verify Square subscription plan exists
        if (!selectedPlan.square_plan_id) {
            logger.error('Square plan not configured', { plan: plan });
            return res.status(500).json({
                error: 'Subscription plan not configured. Please contact support.'
            });
        }

        // Validate and apply promo code if provided
        let promoCodeId = null;
        let discountCents = 0;
        let finalPriceCents = selectedPlan.price_cents;

        if (promoCode) {
            const promoResult = await db.query(`
                SELECT * FROM promo_codes
                WHERE UPPER(code) = UPPER($1)
                  AND is_active = TRUE
                  AND (valid_from IS NULL OR valid_from <= NOW())
                  AND (valid_until IS NULL OR valid_until >= NOW())
                  AND (max_uses IS NULL OR times_used < max_uses)
            `, [promoCode.trim()]);

            if (promoResult.rows.length > 0) {
                const promo = promoResult.rows[0];

                // Check plan restriction
                if (!promo.applies_to_plans || promo.applies_to_plans.length === 0 || promo.applies_to_plans.includes(plan)) {
                    promoCodeId = promo.id;

                    // Calculate discount
                    if (promo.discount_type === 'percent') {
                        discountCents = Math.floor(selectedPlan.price_cents * promo.discount_value / 100);
                    } else {
                        discountCents = promo.discount_value;
                    }

                    // Don't let discount exceed price
                    if (discountCents > selectedPlan.price_cents) {
                        discountCents = selectedPlan.price_cents;
                    }

                    finalPriceCents = selectedPlan.price_cents - discountCents;

                    logger.info('Promo code applied', {
                        code: promo.code,
                        discountCents,
                        originalPrice: selectedPlan.price_cents,
                        finalPrice: finalPriceCents
                    });
                }
            }
        }

        // ==================== SQUARE CUSTOMER & CARD SETUP ====================
        // Create customer and card on file in Square (no card numbers stored locally)
        let squareCustomerId = null;
        let cardId = null;
        let cardBrand = null;
        let cardLastFour = null;

        // Create Square customer
        const customerResponse = await squareApi.makeSquareRequest('/v2/customers', {
            method: 'POST',
            body: JSON.stringify({
                email_address: email,
                company_name: businessName || undefined,
                idempotency_key: `customer-${email}-${Date.now()}`
            })
        });

        if (!customerResponse.customer) {
            const errorMsg = customerResponse.errors?.[0]?.detail || 'Failed to create customer';
            logger.error('Square customer creation failed', { error: errorMsg });
            return res.status(400).json({ error: errorMsg });
        }

        squareCustomerId = customerResponse.customer.id;

        // Create card on file (Square tokenizes the card - we never see card numbers)
        const cardResponse = await squareApi.makeSquareRequest('/v2/cards', {
            method: 'POST',
            body: JSON.stringify({
                source_id: sourceId,
                idempotency_key: `card-${email}-${Date.now()}`,
                card: {
                    customer_id: squareCustomerId
                }
            })
        });

        if (!cardResponse.card) {
            const errorMsg = cardResponse.errors?.[0]?.detail || 'Failed to save payment method';
            logger.error('Square card creation failed', { error: errorMsg, customerId: squareCustomerId });
            return res.status(400).json({ error: errorMsg });
        }

        cardId = cardResponse.card.id;
        cardBrand = cardResponse.card.card_brand;
        cardLastFour = cardResponse.card.last_4;

        // ==================== CREATE LOCAL SUBSCRIBER RECORD ====================
        const subscriber = await subscriptionHandler.createSubscriber({
            email: email.toLowerCase(),
            businessName,
            plan,
            squareCustomerId,
            cardBrand,
            cardLastFour,
            cardId
        });

        // ==================== PAYMENT & SUBSCRIPTION LOGIC ====================
        // Strategy:
        // - If promo code gives discount: Make first payment manually with discount,
        //   then create subscription starting next billing cycle
        // - If no promo: Create subscription immediately (Square handles first payment)

        let paymentResult = null;
        let squareSubscription = null;
        const squareSubscriptions = require('./utils/square-subscriptions');

        if (discountCents > 0 && finalPriceCents > 0) {
            // PROMO CODE: Make first discounted payment manually, then schedule subscription
            try {
                const paymentNote = `Square Dashboard Addon - ${selectedPlan.name} (Promo: -$${(discountCents/100).toFixed(2)})`;

                const paymentResponse = await squareApi.makeSquareRequest('/v2/payments', {
                    method: 'POST',
                    body: JSON.stringify({
                        source_id: cardId,
                        idempotency_key: `payment-${subscriber.id}-${Date.now()}`,
                        amount_money: {
                            amount: finalPriceCents,
                            currency: 'CAD'
                        },
                        customer_id: squareCustomerId,
                        note: paymentNote
                    })
                });

                if (paymentResponse.payment) {
                    paymentResult = paymentResponse.payment;

                    // Record payment
                    await subscriptionHandler.recordPayment({
                        subscriberId: subscriber.id,
                        squarePaymentId: paymentResult.id,
                        amountCents: finalPriceCents,
                        currency: 'CAD',
                        status: paymentResult.status === 'COMPLETED' ? 'completed' : 'pending',
                        paymentType: 'subscription',
                        receiptUrl: paymentResult.receipt_url
                    });
                }

                // Calculate next billing date based on plan
                const nextBillingDate = new Date();
                if (plan === 'annual') {
                    nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
                } else {
                    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
                }
                const startDate = nextBillingDate.toISOString().split('T')[0]; // YYYY-MM-DD

                // Create Square subscription starting next billing cycle
                squareSubscription = await squareSubscriptions.createSubscription({
                    customerId: squareCustomerId,
                    cardId: cardId,
                    planVariationId: selectedPlan.square_plan_id,
                    locationId: locationId,
                    startDate: startDate
                });

            } catch (paymentError) {
                logger.error('Discounted payment failed', { error: paymentError.message });
                return res.status(400).json({
                    error: 'Payment failed: ' + (paymentError.message || 'Please check your card details')
                });
            }

        } else if (finalPriceCents === 0) {
            // 100% DISCOUNT: Create subscription starting next billing cycle (no immediate payment)
            const nextBillingDate = new Date();
            if (plan === 'annual') {
                nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
            } else {
                nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
            }
            const startDate = nextBillingDate.toISOString().split('T')[0];

            squareSubscription = await squareSubscriptions.createSubscription({
                customerId: squareCustomerId,
                cardId: cardId,
                planVariationId: selectedPlan.square_plan_id,
                locationId: locationId,
                startDate: startDate
            });

            logger.info('Subscription created with 100% promo discount - no payment processed', {
                subscriberId: subscriber.id,
                promoCode,
                nextBillingDate: startDate
            });

        } else {
            // NO PROMO: Create subscription immediately (Square handles first payment)
            try {
                squareSubscription = await squareSubscriptions.createSubscription({
                    customerId: squareCustomerId,
                    cardId: cardId,
                    planVariationId: selectedPlan.square_plan_id,
                    locationId: locationId
                    // No startDate = starts immediately
                });

                // Square handles the first payment - record it when webhook arrives
                logger.info('Square subscription created - first payment handled by Square', {
                    subscriberId: subscriber.id,
                    squareSubscriptionId: squareSubscription.id
                });

            } catch (subError) {
                logger.error('Subscription creation failed', { error: subError.message });
                return res.status(400).json({
                    error: 'Subscription failed: ' + (subError.message || 'Please try again')
                });
            }
        }

        // Update subscriber with Square subscription ID
        if (squareSubscription) {
            await db.query(`
                UPDATE subscribers
                SET square_subscription_id = $1, subscription_status = 'active', updated_at = NOW()
                WHERE id = $2
            `, [squareSubscription.id, subscriber.id]);
        }

        // Log subscription event
        await subscriptionHandler.logEvent({
            subscriberId: subscriber.id,
            eventType: 'subscription.created',
            eventData: {
                plan,
                originalAmount: selectedPlan.price_cents,
                discountCents,
                finalAmount: finalPriceCents,
                promoCode: promoCode || null,
                payment_id: paymentResult?.id || null,
                square_subscription_id: squareSubscription?.id || null
            }
        });

        // Record promo code usage
        if (promoCodeId) {
            try {
                await db.query(`
                    INSERT INTO promo_code_uses (promo_code_id, subscriber_id, discount_applied_cents)
                    VALUES ($1, $2, $3)
                `, [promoCodeId, subscriber.id, discountCents]);

                // Update promo code usage count
                await db.query(`
                    UPDATE promo_codes SET times_used = times_used + 1, updated_at = NOW()
                    WHERE id = $1
                `, [promoCodeId]);

                // Update subscriber with promo info
                await db.query(`
                    UPDATE subscribers SET promo_code_id = $1, discount_applied_cents = $2
                    WHERE id = $3
                `, [promoCodeId, discountCents, subscriber.id]);
            } catch (promoError) {
                logger.error('Failed to record promo code usage', { error: promoError.message });
                // Don't fail the subscription
            }
        }

        // ==================== CREATE USER ACCOUNT ====================
        // Create a user account so the subscriber can log in
        let passwordSetupToken = null;
        let userId = null;

        try {
            const normalizedEmail = email.toLowerCase().trim();

            // Check if user already exists
            const existingUser = await db.query(
                'SELECT id FROM users WHERE email = $1',
                [normalizedEmail]
            );

            if (existingUser.rows.length === 0) {
                // Generate a random temporary password (user will reset via token)
                const tempPassword = generateRandomPassword();
                const passwordHash = await hashPassword(tempPassword);

                // Create user account
                const userResult = await db.query(`
                    INSERT INTO users (email, password_hash, name, role, terms_accepted_at)
                    VALUES ($1, $2, $3, 'user', $4)
                    RETURNING id
                `, [normalizedEmail, passwordHash, businessName || null, termsAcceptedAt]);

                userId = userResult.rows[0].id;

                // Generate password setup token
                passwordSetupToken = crypto.randomBytes(32).toString('hex');
                const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

                await db.query(`
                    INSERT INTO password_reset_tokens (user_id, token, expires_at)
                    VALUES ($1, $2, $3)
                `, [userId, passwordSetupToken, tokenExpiry]);

                // Link subscriber to user
                await db.query(`
                    UPDATE subscribers SET user_id = $1 WHERE id = $2
                `, [userId, subscriber.id]);

                logger.info('User account created for subscriber', {
                    userId,
                    subscriberId: subscriber.id,
                    email: normalizedEmail
                });
            } else {
                userId = existingUser.rows[0].id;
                logger.info('User account already exists for subscriber', {
                    userId,
                    subscriberId: subscriber.id
                });
            }
        } catch (userError) {
            logger.error('Failed to create user account', { error: userError.message });
            // Don't fail the subscription - they can use forgot password later
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
            } : null,
            // Include password setup token for new users
            passwordSetupToken: passwordSetupToken,
            passwordSetupUrl: passwordSetupToken ? `/set-password.html?token=${passwordSetupToken}` : null
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
 * Cancel a subscription (cancels in both local DB and Square)
 *
 * SECURITY: Cancellation is processed through Square's API to ensure
 * billing is properly stopped. No payment data is handled locally.
 */
app.post('/api/subscriptions/cancel', requireAuth, async (req, res) => {
    try {
        const { email, reason } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
        if (!subscriber) {
            return res.status(404).json({ error: 'Subscriber not found' });
        }

        // Cancel in Square first (if subscription exists)
        if (subscriber.square_subscription_id) {
            try {
                const squareSubscriptions = require('./utils/square-subscriptions');
                await squareSubscriptions.cancelSubscription(subscriber.square_subscription_id);
                logger.info('Square subscription canceled', {
                    subscriberId: subscriber.id,
                    squareSubscriptionId: subscriber.square_subscription_id
                });
            } catch (squareError) {
                // Log but don't fail - Square webhook will update status anyway
                logger.warn('Failed to cancel Square subscription', {
                    error: squareError.message,
                    squareSubscriptionId: subscriber.square_subscription_id
                });
            }
        }

        // Update local status
        const updated = await subscriptionHandler.cancelSubscription(subscriber.id, reason);

        // Log event
        await subscriptionHandler.logEvent({
            subscriberId: subscriber.id,
            eventType: 'subscription.canceled',
            eventData: {
                reason,
                square_subscription_id: subscriber.square_subscription_id
            }
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
app.post('/api/subscriptions/refund', requireAdmin, async (req, res) => {
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
app.get('/api/subscriptions/admin/list', requireAdmin, async (req, res) => {
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
 * GET /api/subscriptions/admin/plans
 * Get subscription plans with Square status (admin endpoint)
 */
app.get('/api/subscriptions/admin/plans', requireAdmin, async (req, res) => {
    try {
        const squareSubscriptions = require('./utils/square-subscriptions');
        const plans = await squareSubscriptions.listPlans();

        res.json({
            success: true,
            plans,
            squareConfigured: !!process.env.SQUARE_LOCATION_ID
        });

    } catch (error) {
        logger.error('List subscription plans error', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/admin/setup-plans
 * Initialize or update subscription plans in Square (SUPER ADMIN ONLY)
 *
 * SECURITY: This creates subscription plans in Square's catalog.
 * Only super admins can run this to prevent unauthorized plan creation.
 */
app.post('/api/subscriptions/admin/setup-plans', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Super-admin check
        const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        const userEmail = req.session?.user?.email?.toLowerCase();

        if (!superAdminEmails.includes(userEmail)) {
            logger.warn('Unauthorized attempt to setup subscription plans', { email: userEmail });
            return res.status(403).json({
                error: 'Super admin access required',
                message: 'Only super admins can setup subscription plans in Square.'
            });
        }

        // Verify Square configuration
        if (!process.env.SQUARE_LOCATION_ID) {
            return res.status(400).json({
                error: 'SQUARE_LOCATION_ID not configured',
                message: 'Please configure SQUARE_LOCATION_ID in your environment before setting up plans.'
            });
        }

        if (!process.env.SQUARE_ACCESS_TOKEN) {
            return res.status(400).json({
                error: 'SQUARE_ACCESS_TOKEN not configured',
                message: 'Please configure SQUARE_ACCESS_TOKEN in your environment before setting up plans.'
            });
        }

        const squareSubscriptions = require('./utils/square-subscriptions');
        const result = await squareSubscriptions.setupSubscriptionPlans();

        logger.info('Subscription plans setup completed', {
            plans: result.plans.length,
            errors: result.errors.length,
            adminEmail: userEmail
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('Setup subscription plans error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/webhooks/events
 * View recent webhook events (SUPER ADMIN ONLY - cross-tenant debugging)
 * Requires user email to be in SUPER_ADMIN_EMAILS environment variable
 */
app.get('/api/webhooks/events', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Super-admin check: only users in SUPER_ADMIN_EMAILS can access cross-tenant data
        const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        const userEmail = req.session?.user?.email?.toLowerCase();

        if (!superAdminEmails.includes(userEmail)) {
            logger.warn('Unauthorized access attempt to webhook events', { email: userEmail });
            return res.status(403).json({
                error: 'Super admin access required',
                message: 'This endpoint requires super-admin privileges. Contact system administrator.'
            });
        }

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

        // Verify webhook signature - MANDATORY in production
        const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
        if (!signatureKey) {
            if (process.env.NODE_ENV === 'production') {
                logger.error('SECURITY: Webhook rejected - SQUARE_WEBHOOK_SIGNATURE_KEY not configured in production');
                return res.status(500).json({ error: 'Webhook verification not configured' });
            }
            logger.warn('Development mode: Webhook signature verification skipped (configure SQUARE_WEBHOOK_SIGNATURE_KEY for production)');
        } else {
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

        // Look up internal merchant ID from Square's merchant ID for multi-tenant sync
        let internalMerchantId = null;
        if (event.merchant_id) {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE square_merchant_id = $1 AND is_active = TRUE',
                [event.merchant_id]
            );
            if (merchantResult.rows.length > 0) {
                internalMerchantId = merchantResult.rows[0].id;
                logger.info('Webhook merchant resolved', {
                    squareMerchantId: event.merchant_id,
                    internalMerchantId
                });
            } else {
                logger.warn('Webhook received for unknown/inactive merchant', {
                    squareMerchantId: event.merchant_id
                });
            }
        }

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

            case 'customer.updated':
                // Customer updated in Square - sync notes to delivery orders
                if (data.customer && internalMerchantId) {
                    try {
                        const customerId = data.customer.id;
                        const customerNote = data.customer.note || null;

                        // Update customer_note on all delivery orders for this customer
                        const updateResult = await db.query(
                            `UPDATE delivery_orders
                             SET customer_note = $1, updated_at = NOW()
                             WHERE merchant_id = $2 AND square_customer_id = $3`,
                            [customerNote, internalMerchantId, customerId]
                        );

                        if (updateResult.rowCount > 0) {
                            logger.info('Customer notes synced via webhook', {
                                merchantId: internalMerchantId,
                                customerId,
                                ordersUpdated: updateResult.rowCount
                            });
                            syncResults.customerNotes = {
                                customerId,
                                ordersUpdated: updateResult.rowCount
                            };
                        }
                    } catch (syncError) {
                        logger.error('Customer notes sync failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                }
                break;

            // ==================== CATALOG & INVENTORY WEBHOOKS ====================

            case 'catalog.version.updated':
                // Catalog changed in Square - sync to local database
                if (process.env.WEBHOOK_CATALOG_SYNC !== 'false') {
                    if (!internalMerchantId) {
                        logger.warn('Cannot sync catalog - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        logger.info('Catalog change detected via webhook, syncing...', { merchantId: internalMerchantId });
                        const catalogSyncResult = await squareApi.syncCatalog(internalMerchantId);
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
                    if (!internalMerchantId) {
                        logger.warn('Cannot sync inventory - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const inventoryChange = data.inventory_count;
                        logger.info('Inventory change detected via webhook', {
                            catalogObjectId: inventoryChange?.catalog_object_id,
                            quantity: inventoryChange?.quantity,
                            locationId: inventoryChange?.location_id,
                            merchantId: internalMerchantId
                        });
                        const inventorySyncResult = await squareApi.syncInventory(internalMerchantId);
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
                // Also sync sales velocity when order is COMPLETED (catches delivery orders)
                if (process.env.WEBHOOK_ORDER_SYNC !== 'false') {
                    if (!internalMerchantId) {
                        logger.warn('Cannot sync committed inventory - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const order = data.order;
                        logger.info('Order event detected via webhook', {
                            orderId: order?.id,
                            state: order?.state,
                            eventType: event.type,
                            merchantId: internalMerchantId
                        });
                        // Sync committed inventory for open orders
                        const committedResult = await squareApi.syncCommittedInventory(internalMerchantId);
                        syncResults.committedInventory = committedResult;
                        if (committedResult?.skipped) {
                            logger.info('Committed inventory sync skipped via webhook', { reason: committedResult.reason });
                        } else {
                            logger.info('Committed inventory sync completed via webhook', { count: committedResult });
                        }

                        // If order is COMPLETED, also sync sales velocity
                        // This catches delivery orders that may not trigger fulfillment webhooks
                        if (order?.state === 'COMPLETED') {
                            await squareApi.syncSalesVelocity(91, internalMerchantId);
                            syncResults.salesVelocity = true;
                            logger.info('Sales velocity sync completed via order.updated (COMPLETED state)');
                        }

                        // DELIVERY SCHEDULER: Auto-ingest orders with delivery/shipment fulfillments
                        // Check if order has a delivery-type fulfillment that's ready
                        if (order && order.fulfillments && order.fulfillments.length > 0) {
                            const deliveryFulfillment = order.fulfillments.find(f =>
                                (f.type === 'DELIVERY' || f.type === 'SHIPMENT') &&
                                (f.state === 'PROPOSED' || f.state === 'RESERVED' || f.state === 'PREPARED')
                            );

                            if (deliveryFulfillment) {
                                try {
                                    // Check if delivery settings allow auto-ingestion
                                    const deliverySettings = await deliveryApi.getSettings(internalMerchantId);
                                    const autoIngest = deliverySettings?.auto_ingest_ready_orders !== false;

                                    if (autoIngest) {
                                        const deliveryOrder = await deliveryApi.ingestSquareOrder(internalMerchantId, order);
                                        if (deliveryOrder) {
                                            syncResults.deliveryOrder = {
                                                id: deliveryOrder.id,
                                                customerName: deliveryOrder.customer_name,
                                                isNew: !deliveryOrder.square_synced_at
                                            };
                                            logger.info('Ingested Square order for delivery', {
                                                merchantId: internalMerchantId,
                                                squareOrderId: order.id,
                                                deliveryOrderId: deliveryOrder.id
                                            });
                                        }
                                    }
                                } catch (deliveryError) {
                                    logger.error('Failed to ingest order for delivery', {
                                        error: deliveryError.message,
                                        orderId: order.id
                                    });
                                    // Don't fail the whole webhook for delivery errors
                                }
                            }

                            // Handle order cancellation - remove from delivery queue
                            if (order.state === 'CANCELED') {
                                try {
                                    await deliveryApi.handleSquareOrderUpdate(internalMerchantId, order.id, 'CANCELED');
                                    logger.info('Removed cancelled order from delivery queue', {
                                        squareOrderId: order.id
                                    });
                                } catch (cancelError) {
                                    logger.error('Failed to handle order cancellation for delivery', {
                                        error: cancelError.message,
                                        orderId: order.id
                                    });
                                }
                            }

                            // Handle order completion from Square POS/Dashboard
                            if (order.state === 'COMPLETED') {
                                try {
                                    await deliveryApi.handleSquareOrderUpdate(internalMerchantId, order.id, 'COMPLETED');
                                    syncResults.deliveryCompletion = { squareOrderId: order.id };
                                    logger.info('Marked delivery order as completed via webhook', {
                                        squareOrderId: order.id
                                    });
                                } catch (completeError) {
                                    logger.error('Failed to handle order completion for delivery', {
                                        error: completeError.message,
                                        orderId: order.id
                                    });
                                }
                            }
                        }

                        // LOYALTY ADDON: Process qualifying purchases for frequent buyer program
                        // Only process COMPLETED orders to ensure payment was successful
                        if (order && order.state === 'COMPLETED') {
                            try {
                                const loyaltyResult = await loyaltyService.processOrderForLoyalty(order, internalMerchantId);
                                if (loyaltyResult.processed) {
                                    syncResults.loyalty = {
                                        purchasesRecorded: loyaltyResult.purchasesRecorded.length,
                                        customerId: loyaltyResult.customerId
                                    };
                                    logger.info('Loyalty purchases processed via webhook', {
                                        orderId: order.id,
                                        purchaseCount: loyaltyResult.purchasesRecorded.length,
                                        merchantId: internalMerchantId
                                    });

                                    // Check if any rewards were earned and trigger notification
                                    for (const purchase of loyaltyResult.purchasesRecorded) {
                                        if (purchase.reward && purchase.reward.status === 'earned') {
                                            logger.info('Customer earned a loyalty reward!', {
                                                orderId: order.id,
                                                customerId: loyaltyResult.customerId,
                                                rewardId: purchase.reward.rewardId
                                            });
                                            // TODO (vNext): Trigger Square receipt message for reward earned
                                        }
                                    }
                                }

                                // Check if this order used a reward discount (auto-detect redemption)
                                const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, internalMerchantId);
                                if (redemptionResult.detected) {
                                    syncResults.loyaltyRedemption = {
                                        rewardId: redemptionResult.rewardId,
                                        offerName: redemptionResult.offerName
                                    };
                                    logger.info('Loyalty reward redemption detected and processed', {
                                        orderId: order.id,
                                        rewardId: redemptionResult.rewardId,
                                        offerName: redemptionResult.offerName,
                                        merchantId: internalMerchantId
                                    });
                                }

                                // Process any refunds in the order
                                if (order.refunds && order.refunds.length > 0) {
                                    const refundResult = await loyaltyService.processOrderRefundsForLoyalty(order, internalMerchantId);
                                    if (refundResult.processed) {
                                        syncResults.loyaltyRefunds = {
                                            refundsProcessed: refundResult.refundsProcessed.length
                                        };
                                        logger.info('Loyalty refunds processed via webhook', {
                                            orderId: order.id,
                                            refundCount: refundResult.refundsProcessed.length
                                        });
                                    }
                                }
                            } catch (loyaltyError) {
                                logger.error('Failed to process order for loyalty', {
                                    error: loyaltyError.message,
                                    orderId: order.id,
                                    merchantId: internalMerchantId
                                });
                                // Don't fail the whole webhook for loyalty errors
                                syncResults.loyaltyError = loyaltyError.message;
                            }
                        }
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
                    if (!internalMerchantId) {
                        logger.warn('Cannot sync fulfillment - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const fulfillment = data.fulfillment;
                        logger.info('Order fulfillment updated via webhook', {
                            fulfillmentId: fulfillment?.uid,
                            state: fulfillment?.state,
                            orderId: data.order_id,
                            merchantId: internalMerchantId
                        });
                        // Sync committed inventory (fulfilled orders reduce committed qty)
                        const committedResult = await squareApi.syncCommittedInventory(internalMerchantId);
                        syncResults.committedInventory = committedResult;
                        if (committedResult?.skipped) {
                            logger.info('Committed inventory sync skipped via fulfillment webhook', { reason: committedResult.reason });
                        }

                        // If fulfilled/completed, also sync sales velocity
                        if (fulfillment?.state === 'COMPLETED') {
                            await squareApi.syncSalesVelocity(91, internalMerchantId);
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

            // ==================== VENDOR WEBHOOKS ====================

            case 'vendor.created':
            case 'vendor.updated':
                // Vendor created or updated in Square - sync to local database
                if (process.env.WEBHOOK_CATALOG_SYNC !== 'false') {
                    if (!internalMerchantId) {
                        logger.warn('Cannot sync vendor - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const vendor = data.vendor;
                        logger.info('Vendor change detected via webhook', {
                            vendorId: vendor?.id,
                            vendorName: vendor?.name,
                            status: vendor?.status,
                            eventType: event.type,
                            merchantId: internalMerchantId
                        });

                        // Sync the specific vendor directly
                        if (vendor) {
                            await db.query(`
                                INSERT INTO vendors (
                                    id, name, status, contact_name, contact_email, contact_phone, merchant_id, updated_at
                                )
                                VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                                ON CONFLICT (id) DO UPDATE SET
                                    name = EXCLUDED.name,
                                    status = EXCLUDED.status,
                                    contact_name = EXCLUDED.contact_name,
                                    contact_email = EXCLUDED.contact_email,
                                    contact_phone = EXCLUDED.contact_phone,
                                    merchant_id = EXCLUDED.merchant_id,
                                    updated_at = CURRENT_TIMESTAMP
                            `, [
                                vendor.id,
                                vendor.name,
                                vendor.status,
                                vendor.contacts?.[0]?.name || null,
                                vendor.contacts?.[0]?.email_address || null,
                                vendor.contacts?.[0]?.phone_number || null,
                                internalMerchantId
                            ]);
                            syncResults.vendor = {
                                id: vendor.id,
                                name: vendor.name,
                                status: vendor.status
                            };
                            logger.info('Vendor synced via webhook', { vendorId: vendor.id, vendorName: vendor.name });
                        }
                    } catch (syncError) {
                        logger.error('Vendor sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                } else {
                    logger.info('Vendor webhook received but WEBHOOK_CATALOG_SYNC is disabled');
                    syncResults.skipped = true;
                }
                break;

            // ==================== LOCATION WEBHOOKS ====================

            case 'location.created':
            case 'location.updated':
                // Location created or updated in Square - sync to local database
                if (process.env.WEBHOOK_CATALOG_SYNC !== 'false') {
                    if (!internalMerchantId) {
                        logger.warn('Cannot sync location - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const location = data.location;
                        logger.info('Location change detected via webhook', {
                            locationId: location?.id,
                            locationName: location?.name,
                            status: location?.status,
                            eventType: event.type,
                            merchantId: internalMerchantId
                        });

                        // Sync the specific location directly
                        if (location) {
                            await db.query(`
                                INSERT INTO locations (id, name, square_location_id, active, address, timezone, merchant_id, updated_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                                ON CONFLICT (id) DO UPDATE SET
                                    name = EXCLUDED.name,
                                    square_location_id = EXCLUDED.square_location_id,
                                    active = EXCLUDED.active,
                                    address = EXCLUDED.address,
                                    timezone = EXCLUDED.timezone,
                                    merchant_id = EXCLUDED.merchant_id,
                                    updated_at = CURRENT_TIMESTAMP
                            `, [
                                location.id,
                                location.name,
                                location.id,
                                location.status === 'ACTIVE',
                                location.address ? JSON.stringify(location.address) : null,
                                location.timezone,
                                internalMerchantId
                            ]);
                            syncResults.location = {
                                id: location.id,
                                name: location.name,
                                status: location.status
                            };
                            logger.info('Location synced via webhook', { locationId: location.id, locationName: location.name });
                        }
                    } catch (syncError) {
                        logger.error('Location sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    }
                } else {
                    logger.info('Location webhook received but WEBHOOK_CATALOG_SYNC is disabled');
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

                    // Mark merchant as disconnected in database
                    await db.query(`
                        UPDATE merchants
                        SET is_active = FALSE,
                            square_access_token = 'REVOKED',
                            square_refresh_token = NULL,
                            updated_at = NOW()
                        WHERE square_merchant_id = $1
                    `, [revokedMerchantId]);

                    logger.error('⚠️ OAUTH REVOKED - Square access has been disconnected. Re-authorization required.', {
                        merchantId: revokedMerchantId
                    });
                } catch (revokeError) {
                    logger.error('Error handling OAuth revocation', { error: revokeError.message });
                    syncResults.error = revokeError.message;
                }
                break;

            // ==================== PAYMENT WEBHOOKS ====================
            // Process loyalty from payment.updated since order.* webhooks are unreliable (BETA)
            case 'payment.updated':
                if (!internalMerchantId) {
                    logger.debug('Payment webhook - merchant not found, skipping loyalty');
                    break;
                }
                try {
                    const payment = data;
                    // Only process COMPLETED payments with an order_id
                    if (payment.status === 'COMPLETED' && payment.order_id) {
                        logger.info('Payment completed - fetching order for loyalty processing', {
                            paymentId: payment.id,
                            orderId: payment.order_id
                        });

                        // Fetch the full order from Square
                        const squareClient = await getSquareClientForMerchant(internalMerchantId);
                        const orderResponse = await squareClient.orders.get({
                            orderId: payment.order_id
                        });

                        if (orderResponse.order && orderResponse.order.state === 'COMPLETED') {
                            const order = orderResponse.order;

                            // Process for loyalty
                            const loyaltyResult = await loyaltyService.processOrderForLoyalty(order, internalMerchantId);
                            if (loyaltyResult.processed) {
                                syncResults.loyalty = {
                                    purchasesRecorded: loyaltyResult.purchasesRecorded.length,
                                    customerId: loyaltyResult.customerId,
                                    source: 'payment.updated'
                                };
                                logger.info('Loyalty purchases recorded via payment webhook', {
                                    orderId: order.id,
                                    customerId: loyaltyResult.customerId,
                                    purchases: loyaltyResult.purchasesRecorded.length
                                });

                                // Check for earned rewards and create discounts
                                if (loyaltyResult.purchasesRecorded.length > 0) {
                                    for (const purchase of loyaltyResult.purchasesRecorded) {
                                        if (purchase.rewardEarned) {
                                            try {
                                                await loyaltyService.createRewardDiscount({
                                                    merchantId: internalMerchantId,
                                                    squareCustomerId: loyaltyResult.customerId,
                                                    internalRewardId: purchase.rewardId
                                                });
                                                logger.info('Created reward discount via payment webhook', {
                                                    rewardId: purchase.rewardId
                                                });
                                            } catch (discountErr) {
                                                logger.error('Failed to create reward discount', {
                                                    error: discountErr.message,
                                                    rewardId: purchase.rewardId
                                                });
                                            }
                                        }
                                    }
                                }
                            }

                            // Check for reward redemption
                            const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, internalMerchantId);
                            if (redemptionResult.detected) {
                                syncResults.loyaltyRedemption = {
                                    rewardId: redemptionResult.rewardId,
                                    offerName: redemptionResult.offerName
                                };
                                logger.info('Reward redemption detected via payment webhook', {
                                    orderId: order.id,
                                    rewardId: redemptionResult.rewardId
                                });
                            }
                        }
                    }
                } catch (paymentErr) {
                    logger.error('Error processing payment for loyalty', {
                        error: paymentErr.message,
                        paymentId: data?.id
                    });
                    // Don't set syncResults.error - this is non-critical
                }
                break;

            // ==================== REFUND WEBHOOKS ====================
            // Handle refund events directly (in addition to order.updated with refunds)
            case 'refund.created':
            case 'refund.updated':
                if (process.env.WEBHOOK_ORDER_SYNC !== 'false') {
                    if (!internalMerchantId) {
                        logger.warn('Cannot process refund - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const refund = data;
                        logger.info('Refund event received via webhook', {
                            refundId: refund.id,
                            orderId: refund.order_id,
                            status: refund.status,
                            merchantId: internalMerchantId
                        });

                        // Only process completed refunds
                        if (refund.status === 'COMPLETED' && refund.order_id) {
                            // Fetch the full order to process refund line items
                            const accessToken = await loyaltyService.getSquareAccessToken(internalMerchantId);
                            if (accessToken) {
                                const orderResponse = await fetch(
                                    `https://connect.squareup.com/v2/orders/${refund.order_id}`,
                                    {
                                        headers: {
                                            'Authorization': `Bearer ${accessToken}`,
                                            'Content-Type': 'application/json',
                                            'Square-Version': '2024-01-18'
                                        }
                                    }
                                );

                                if (orderResponse.ok) {
                                    const orderData = await orderResponse.json();
                                    const order = orderData.order;

                                    if (order && order.refunds && order.refunds.length > 0) {
                                        const refundResult = await loyaltyService.processOrderRefundsForLoyalty(order, internalMerchantId);
                                        if (refundResult.processed) {
                                            syncResults.loyaltyRefunds = {
                                                refundsProcessed: refundResult.refundsProcessed.length
                                            };
                                            logger.info('Loyalty refunds processed via refund webhook', {
                                                orderId: order.id,
                                                refundCount: refundResult.refundsProcessed.length
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    } catch (refundError) {
                        logger.error('Refund webhook processing failed', { error: refundError.message });
                        syncResults.error = refundError.message;
                    }
                }
                break;

            // ==================== LOYALTY WEBHOOKS ====================
            // Handle loyalty events to catch orders where customer was linked after initial webhook
            case 'loyalty.event.created':
                if (process.env.WEBHOOK_ORDER_SYNC !== 'false') {
                    if (!internalMerchantId) {
                        logger.warn('Cannot process loyalty event - merchant not found for webhook');
                        syncResults.error = 'Merchant not found';
                        break;
                    }
                    try {
                        const loyaltyEvent = data;

                        // Extract order_id from the loyalty event (can be in different places depending on event type)
                        const orderId = loyaltyEvent.accumulate_points?.order_id
                            || loyaltyEvent.redeem_reward?.order_id
                            || loyaltyEvent.order_id;

                        const loyaltyAccountId = loyaltyEvent.loyalty_account_id;

                        logger.info('Loyalty event received via webhook', {
                            eventId: loyaltyEvent.id,
                            eventType: loyaltyEvent.type,
                            orderId,
                            loyaltyAccountId,
                            merchantId: internalMerchantId
                        });

                        // Only process if we have an order_id to link
                        if (orderId && loyaltyAccountId) {
                            // Check if we've already processed this order for loyalty
                            const alreadyProcessed = await loyaltyService.isOrderAlreadyProcessedForLoyalty(orderId, internalMerchantId);

                            if (!alreadyProcessed) {
                                logger.info('Loyalty event for unprocessed order - attempting to process', {
                                    orderId,
                                    loyaltyAccountId,
                                    merchantId: internalMerchantId
                                });

                                // Get the customer_id from the loyalty account
                                const accessToken = await loyaltyService.getSquareAccessToken(internalMerchantId);
                                if (accessToken) {
                                    // Fetch the loyalty account to get customer_id
                                    const accountResponse = await fetch(
                                        `https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}`,
                                        {
                                            headers: {
                                                'Authorization': `Bearer ${accessToken}`,
                                                'Content-Type': 'application/json',
                                                'Square-Version': '2025-01-16'
                                            }
                                        }
                                    );

                                    if (accountResponse.ok) {
                                        const accountData = await accountResponse.json();
                                        const customerId = accountData.loyalty_account?.customer_id;

                                        if (customerId) {
                                            // Fetch the order
                                            const orderResponse = await fetch(
                                                `https://connect.squareup.com/v2/orders/${orderId}`,
                                                {
                                                    headers: {
                                                        'Authorization': `Bearer ${accessToken}`,
                                                        'Content-Type': 'application/json',
                                                        'Square-Version': '2025-01-16'
                                                    }
                                                }
                                            );

                                            if (orderResponse.ok) {
                                                const orderData = await orderResponse.json();
                                                const order = orderData.order;

                                                if (order && order.state === 'COMPLETED') {
                                                    // Process with the customer_id we got from loyalty account
                                                    // Override the order's customer_id if it's missing
                                                    const effectiveOrder = {
                                                        ...order,
                                                        customer_id: order.customer_id || customerId
                                                    };

                                                    const loyaltyResult = await loyaltyService.processOrderForLoyalty(
                                                        effectiveOrder,
                                                        internalMerchantId,
                                                        { customerSourceOverride: 'loyalty_api' }
                                                    );

                                                    if (loyaltyResult.processed) {
                                                        syncResults.loyaltyEventRecovery = {
                                                            orderId,
                                                            customerId,
                                                            purchasesRecorded: loyaltyResult.purchasesRecorded.length
                                                        };
                                                        logger.info('Successfully processed order via loyalty event webhook', {
                                                            orderId,
                                                            customerId,
                                                            purchaseCount: loyaltyResult.purchasesRecorded.length,
                                                            merchantId: internalMerchantId
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            } else {
                                logger.debug('Order already processed for loyalty, skipping', { orderId });
                                syncResults.loyaltyEventSkipped = { orderId, reason: 'already_processed' };
                            }
                        }
                    } catch (loyaltyEventError) {
                        logger.error('Loyalty event webhook processing failed', {
                            error: loyaltyEventError.message,
                            stack: loyaltyEventError.stack
                        });
                        syncResults.loyaltyEventError = loyaltyEventError.message;
                    }
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

// ==================== DELIVERY SCHEDULER API ====================

/**
 * GET /api/delivery/orders
 * List delivery orders with optional filtering
 */
app.get('/api/delivery/orders', requireAuth, requireMerchant, async (req, res) => {
    try {
        const { status, routeDate, routeId, includeCompleted, limit, offset } = req.query;
        const merchantId = req.merchantContext.id;

        const orders = await deliveryApi.getOrders(merchantId, {
            status: status ? status.split(',') : null,
            routeDate,
            routeId,
            includeCompleted: includeCompleted === 'true',
            limit: parseInt(limit) || 100,
            offset: parseInt(offset) || 0
        });

        res.json({ orders });
    } catch (error) {
        logger.error('Error fetching delivery orders', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/orders
 * Create a manual delivery order
 */
app.post('/api/delivery/orders', deliveryRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const { customerName, address, phone, notes } = req.body;
        const merchantId = req.merchantContext.id;

        if (!customerName || !address) {
            return res.status(400).json({ error: 'Customer name and address are required' });
        }

        const order = await deliveryApi.createOrder(merchantId, {
            customerName,
            address,
            phone,
            notes
        });

        // Attempt geocoding
        const settings = await deliveryApi.getSettings(merchantId);
        const coords = await deliveryApi.geocodeAddress(address, settings?.openrouteservice_api_key);

        if (coords) {
            await deliveryApi.updateOrder(merchantId, order.id, {
                addressLat: coords.lat,
                addressLng: coords.lng,
                geocodedAt: new Date()
            });
            order.address_lat = coords.lat;
            order.address_lng = coords.lng;
            order.geocoded_at = new Date();
        }

        await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_created', order.id, null, {
            manual: true,
            customerName
        });

        res.status(201).json({ order });
    } catch (error) {
        logger.error('Error creating delivery order', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/orders/:id
 * Get a single delivery order
 */
app.get('/api/delivery/orders/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const order = await deliveryApi.getOrderById(merchantId, req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ order });
    } catch (error) {
        logger.error('Error fetching delivery order', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/delivery/orders/:id
 * Update a delivery order (notes, status)
 */
app.patch('/api/delivery/orders/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const updates = {};

        // Only allow updating certain fields
        if (req.body.notes !== undefined) updates.notes = req.body.notes;
        if (req.body.phone !== undefined) updates.phone = req.body.phone;
        if (req.body.customerName !== undefined) updates.customerName = req.body.customerName;
        if (req.body.address !== undefined) updates.address = req.body.address;

        const order = await deliveryApi.updateOrder(merchantId, req.params.id, updates);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Re-geocode if address changed
        if (req.body.address) {
            const settings = await deliveryApi.getSettings(merchantId);
            const coords = await deliveryApi.geocodeAddress(req.body.address, settings?.openrouteservice_api_key);

            if (coords) {
                await deliveryApi.updateOrder(merchantId, order.id, {
                    addressLat: coords.lat,
                    addressLng: coords.lng,
                    geocodedAt: new Date()
                });
            }
        }

        res.json({ order });
    } catch (error) {
        logger.error('Error updating delivery order', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/delivery/orders/:id
 * Delete a manual delivery order (only allowed for manual orders not on route)
 */
app.delete('/api/delivery/orders/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const deleted = await deliveryApi.deleteOrder(merchantId, req.params.id);

        if (!deleted) {
            return res.status(400).json({
                error: 'Cannot delete this order. Only manual orders not yet delivered can be deleted.'
            });
        }

        await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_deleted', req.params.id);

        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting delivery order', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/orders/:id/skip
 * Mark an order as skipped (driver couldn't deliver)
 */
app.post('/api/delivery/orders/:id/skip', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const order = await deliveryApi.skipOrder(merchantId, req.params.id, req.session.user.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ order });
    } catch (error) {
        logger.error('Error skipping delivery order', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/orders/:id/complete
 * Mark an order as completed and sync to Square
 */
app.post('/api/delivery/orders/:id/complete', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const order = await deliveryApi.getOrderById(merchantId, req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        let squareSynced = false;
        let squareSyncError = null;

        // If Square order, sync fulfillment completion to Square
        if (order.square_order_id) {
            try {
                const squareClient = await getSquareClientForMerchant(merchantId);

                // First, get the current order to find fulfillment UID and version
                let squareOrder = await squareClient.orders.get({
                    orderId: order.square_order_id
                });

                if (squareOrder.order && squareOrder.order.fulfillments) {
                    // Find the delivery/shipment fulfillment (check multiple types)
                    let fulfillment = squareOrder.order.fulfillments.find(f =>
                        f.type === 'DELIVERY' || f.type === 'SHIPMENT' || f.type === 'PICKUP'
                    ) || squareOrder.order.fulfillments[0]; // Fall back to first fulfillment

                    if (fulfillment) {
                        logger.info('Current fulfillment state', {
                            orderId: order.id,
                            squareOrderId: order.square_order_id,
                            fulfillmentUid: fulfillment.uid,
                            fulfillmentType: fulfillment.type,
                            currentState: fulfillment.state
                        });

                        // Define the state transition order
                        // Square requires stepping through states: PROPOSED → RESERVED → PREPARED → COMPLETED
                        const stateOrder = ['PROPOSED', 'RESERVED', 'PREPARED', 'COMPLETED'];
                        const currentStateIndex = stateOrder.indexOf(fulfillment.state);

                        if (fulfillment.state === 'COMPLETED') {
                            squareSynced = true; // Already completed
                        } else if (currentStateIndex >= 0) {
                            // Need to transition through each state to reach COMPLETED
                            for (let i = currentStateIndex + 1; i < stateOrder.length; i++) {
                                const nextState = stateOrder[i];

                                // Re-fetch to get current version (required for optimistic concurrency)
                                squareOrder = await squareClient.orders.get({
                                    orderId: order.square_order_id
                                });

                                // Re-find fulfillment (version may have changed)
                                fulfillment = squareOrder.order.fulfillments.find(f => f.uid === fulfillment.uid);

                                if (!fulfillment) {
                                    throw new Error('Fulfillment not found after re-fetch');
                                }

                                logger.info('Transitioning fulfillment state', {
                                    orderId: order.id,
                                    from: fulfillment.state,
                                    to: nextState
                                });

                                await squareClient.orders.update({
                                    orderId: order.square_order_id,
                                    order: {
                                        locationId: squareOrder.order.locationId,
                                        version: squareOrder.order.version,
                                        fulfillments: [{
                                            uid: fulfillment.uid,
                                            state: nextState
                                        }]
                                    },
                                    idempotencyKey: `complete-${order.id}-${nextState}-${Date.now()}`
                                });
                            }

                            squareSynced = true;
                            logger.info('Synced delivery completion to Square', {
                                merchantId,
                                orderId: order.id,
                                squareOrderId: order.square_order_id,
                                fulfillmentUid: fulfillment.uid,
                                fulfillmentType: fulfillment.type,
                                originalState: stateOrder[currentStateIndex]
                            });
                        } else {
                            // Unknown state (CANCELED, FAILED, etc.)
                            logger.warn('Fulfillment in unexpected state', {
                                orderId: order.id,
                                state: fulfillment.state
                            });
                            squareSyncError = `Fulfillment in ${fulfillment.state} state`;
                        }
                    }
                } else {
                    logger.warn('Square order has no fulfillments', {
                        orderId: order.id,
                        squareOrderId: order.square_order_id
                    });
                }
            } catch (squareError) {
                squareSyncError = squareError.message;
                logger.error('Failed to sync completion to Square', {
                    error: squareError.message,
                    orderId: order.id,
                    squareOrderId: order.square_order_id
                });
                // Continue anyway - mark as complete locally
            }
        }

        const completedOrder = await deliveryApi.completeOrder(merchantId, req.params.id, req.session.user.id);

        res.json({
            order: completedOrder,
            square_synced: squareSynced,
            square_sync_error: squareSyncError
        });
    } catch (error) {
        logger.error('Error completing delivery order', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/orders/:id/customer
 * Get customer info and notes from Square
 */
app.get('/api/delivery/orders/:id/customer', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const order = await deliveryApi.getOrderById(merchantId, req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        let customerData = {
            order_notes: order.notes,        // Order-specific notes from Square
            customer_note: order.customer_note,  // Cached customer note
            square_customer_id: order.square_customer_id
        };

        // If we have a Square customer ID, fetch fresh data from Square
        if (order.square_customer_id) {
            try {
                const squareClient = await getSquareClientForMerchant(merchantId);
                const customerResponse = await squareClient.customers.get({
                    customerId: order.square_customer_id
                });

                if (customerResponse.customer) {
                    const customer = customerResponse.customer;
                    customerData = {
                        ...customerData,
                        customer_note: customer.note || null,
                        customer_email: customer.emailAddress || customer.email_address,
                        customer_phone: customer.phoneNumber || customer.phone_number,
                        customer_name: [customer.givenName || customer.given_name, customer.familyName || customer.family_name].filter(Boolean).join(' '),
                        customer_company: customer.companyName || customer.company_name
                    };

                    // Update cached customer note if different
                    if (customer.note !== order.customer_note) {
                        await deliveryApi.updateOrder(merchantId, order.id, {
                            customerNote: customer.note || null
                        });
                    }
                }
            } catch (squareError) {
                logger.warn('Failed to fetch customer from Square', {
                    error: squareError.message,
                    customerId: order.square_customer_id
                });
                // Return cached data if Square fetch fails
            }
        }

        res.json(customerData);
    } catch (error) {
        logger.error('Error fetching customer info', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/delivery/orders/:id/customer-note
 * Update customer note (syncs to Square)
 */
app.patch('/api/delivery/orders/:id/customer-note', deliveryRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { note } = req.body;
        const order = await deliveryApi.getOrderById(merchantId, req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        if (!order.square_customer_id) {
            return res.status(400).json({ error: 'No Square customer linked to this order' });
        }

        let squareSynced = false;

        // Update customer note in Square
        try {
            const squareClient = await getSquareClientForMerchant(merchantId);

            // First get current customer to get version
            const customerResponse = await squareClient.customers.get({
                customerId: order.square_customer_id
            });

            if (customerResponse.customer) {
                await squareClient.customers.update({
                    customerId: order.square_customer_id,
                    note: note || null,
                    version: customerResponse.customer.version
                });
                squareSynced = true;
            }
        } catch (squareError) {
            logger.error('Failed to update customer note in Square', {
                error: squareError.message,
                customerId: order.square_customer_id
            });
        }

        // Update cached note locally
        await deliveryApi.updateOrder(merchantId, order.id, {
            customerNote: note || null
        });

        res.json({
            success: true,
            square_synced: squareSynced,
            customer_note: note
        });
    } catch (error) {
        logger.error('Error updating customer note', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/delivery/orders/:id/notes
 * Update order notes (local only - order-specific instructions)
 */
app.patch('/api/delivery/orders/:id/notes', deliveryRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { notes } = req.body;
        const order = await deliveryApi.getOrderById(merchantId, req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        await deliveryApi.updateOrder(merchantId, order.id, {
            notes: notes || null
        });

        res.json({
            success: true,
            notes: notes
        });
    } catch (error) {
        logger.error('Error updating order notes', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/orders/:id/customer-stats
 * Get customer stats: order count, loyalty status, payment status
 */
app.get('/api/delivery/orders/:id/customer-stats', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const order = await deliveryApi.getOrderById(merchantId, req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const stats = {
            order_count: 0,
            is_repeat_customer: false,
            is_loyalty_member: false,
            loyalty_balance: null,
            payment_status: 'unknown', // 'paid', 'unpaid', 'partial'
            total_amount: null,
            amount_paid: null
        };

        // If no Square customer ID, return basic stats
        if (!order.square_customer_id) {
            return res.json(stats);
        }

        const squareClient = await getSquareClientForMerchant(merchantId);
        const merchant = await MerchantDB.getMerchantById(merchantId);

        // Fetch order count, loyalty status, and payment info in parallel
        const [orderCountResult, loyaltyResult, squareOrderResult] = await Promise.allSettled([
            // Count previous orders by this customer
            squareClient.orders.search({
                locationIds: [merchant.square_location_id],
                query: {
                    filter: {
                        customerFilter: {
                            customerIds: [order.square_customer_id]
                        },
                        stateFilter: {
                            states: ['COMPLETED']
                        }
                    }
                }
            }),

            // Check loyalty status
            (async () => {
                try {
                    // Use 'main' keyword to retrieve the seller's loyalty program
                    // (listLoyaltyPrograms is deprecated)
                    const programResponse = await squareClient.loyalty.programs.retrieve({
                        programId: 'main'
                    });

                    if (programResponse.program) {
                        // Search for loyalty account by customer ID
                        const accountsResponse = await squareClient.loyalty.accounts.search({
                            query: {
                                customerIds: [order.square_customer_id]
                            }
                        });

                        if (accountsResponse.loyaltyAccounts && accountsResponse.loyaltyAccounts.length > 0) {
                            const account = accountsResponse.loyaltyAccounts[0];
                            return {
                                isMember: true,
                                balance: account.balance || 0
                            };
                        }
                    }
                } catch (loyaltyError) {
                    // 404 means seller doesn't have a loyalty program - that's fine
                    if (!loyaltyError.message?.includes('NOT_FOUND')) {
                        logger.warn('Error checking loyalty status', { error: loyaltyError.message });
                    }
                }
                return { isMember: false, balance: null };
            })(),

            // Get Square order for payment status
            order.square_order_id ? squareClient.orders.get({
                orderId: order.square_order_id
            }) : Promise.resolve(null)
        ]);

        // Process order count
        if (orderCountResult.status === 'fulfilled' && orderCountResult.value.orders) {
            stats.order_count = orderCountResult.value.orders.length;
            stats.is_repeat_customer = stats.order_count > 1;
        }

        // Process loyalty status
        if (loyaltyResult.status === 'fulfilled') {
            stats.is_loyalty_member = loyaltyResult.value.isMember;
            stats.loyalty_balance = loyaltyResult.value.balance;
        }

        // Process payment status
        if (squareOrderResult.status === 'fulfilled' && squareOrderResult.value?.order) {
            const squareOrder = squareOrderResult.value.order;
            const totalMoney = squareOrder.totalMoney?.amount || squareOrder.total_money?.amount || 0;
            const tenders = squareOrder.tenders || [];

            let amountPaid = 0;
            for (const tender of tenders) {
                amountPaid += tender.amountMoney?.amount || tender.amount_money?.amount || 0;
            }

            stats.total_amount = totalMoney;
            stats.amount_paid = amountPaid;

            if (amountPaid >= totalMoney && totalMoney > 0) {
                stats.payment_status = 'paid';
            } else if (amountPaid > 0) {
                stats.payment_status = 'partial';
            } else {
                stats.payment_status = 'unpaid';
            }
        }

        res.json(stats);
    } catch (error) {
        logger.error('Error fetching customer stats', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/orders/:id/pod
 * Upload proof of delivery photo
 */
app.post('/api/delivery/orders/:id/pod', deliveryRateLimit, requireAuth, requireMerchant, podUpload.single('photo'), async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        if (!req.file) {
            return res.status(400).json({ error: 'No photo uploaded' });
        }

        const pod = await deliveryApi.savePodPhoto(merchantId, req.params.id, req.file.buffer, {
            originalFilename: req.file.originalname,
            mimeType: req.file.mimetype,
            latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
            longitude: req.body.longitude ? parseFloat(req.body.longitude) : null
        });

        await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'pod_uploaded', req.params.id, null, {
            podId: pod.id,
            hasGps: !!(req.body.latitude && req.body.longitude)
        });

        res.status(201).json({ pod });
    } catch (error) {
        logger.error('Error uploading POD', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/pod/:id
 * Serve a POD photo (authenticated)
 */
app.get('/api/delivery/pod/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const pod = await deliveryApi.getPodPhoto(merchantId, req.params.id);

        if (!pod) {
            return res.status(404).json({ error: 'POD not found' });
        }

        // Serve the file
        const fsSync = require('fs');
        if (!fsSync.existsSync(pod.full_path)) {
            return res.status(404).json({ error: 'POD file not found' });
        }

        res.setHeader('Content-Type', pod.mime_type || 'image/jpeg');
        res.setHeader('Content-Disposition', `inline; filename="${pod.original_filename || 'pod.jpg'}"`);
        res.sendFile(pod.full_path);
    } catch (error) {
        logger.error('Error serving POD', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/route/generate
 * Generate an optimized route for pending orders
 */
app.post('/api/delivery/route/generate', deliveryStrictRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { routeDate, orderIds, force } = req.body;

        const route = await deliveryApi.generateRoute(merchantId, req.session.user.id, {
            routeDate,
            orderIds,
            force
        });

        res.status(201).json({ route });
    } catch (error) {
        logger.error('Error generating route', { error: error.message });
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/route/active
 * Get today's active route with orders
 */
app.get('/api/delivery/route/active', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { routeDate } = req.query;

        const route = await deliveryApi.getActiveRoute(merchantId, routeDate);

        if (!route) {
            return res.json({ route: null, orders: [] });
        }

        const orders = await deliveryApi.getOrders(merchantId, { routeId: route.id });

        res.json({ route, orders });
    } catch (error) {
        logger.error('Error fetching active route', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/route/:id
 * Get a specific route with orders
 */
app.get('/api/delivery/route/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const route = await deliveryApi.getRouteWithOrders(merchantId, req.params.id);

        if (!route) {
            return res.status(404).json({ error: 'Route not found' });
        }

        res.json({ route });
    } catch (error) {
        logger.error('Error fetching route', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/route/finish
 * Finish the active route and roll skipped orders back to pending
 */
app.post('/api/delivery/route/finish', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { routeId } = req.body;

        if (!routeId) {
            // Get active route for today
            const activeRoute = await deliveryApi.getActiveRoute(merchantId);
            if (!activeRoute) {
                return res.status(400).json({ error: 'No active route found' });
            }
            req.body.routeId = activeRoute.id;
        }

        const result = await deliveryApi.finishRoute(merchantId, req.body.routeId, req.session.user.id);

        res.json({ result });
    } catch (error) {
        logger.error('Error finishing route', { error: error.message });
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/geocode
 * Geocode pending orders that don't have coordinates
 */
app.post('/api/delivery/geocode', deliveryStrictRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { limit } = req.body;

        const result = await deliveryApi.geocodePendingOrders(merchantId, limit || 10);

        res.json({ result });
    } catch (error) {
        logger.error('Error geocoding orders', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/settings
 * Get delivery settings for the merchant
 */
app.get('/api/delivery/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        let settings = await deliveryApi.getSettings(merchantId);

        // Return defaults if no settings exist
        if (!settings) {
            settings = {
                merchant_id: merchantId,
                start_address: null,
                end_address: null,
                same_day_cutoff: '17:00',
                pod_retention_days: 180,
                auto_ingest_ready_orders: true
            };
        }

        res.json({ settings });
    } catch (error) {
        logger.error('Error fetching delivery settings', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/delivery/settings
 * Update delivery settings for the merchant
 */
app.put('/api/delivery/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const {
            startAddress,
            endAddress,
            sameDayCutoff,
            podRetentionDays,
            autoIngestReadyOrders,
            openrouteserviceApiKey
        } = req.body;

        // Geocode start and end addresses if provided
        let startLat = null, startLng = null, endLat = null, endLng = null;

        if (startAddress) {
            const currentSettings = await deliveryApi.getSettings(merchantId);
            const coords = await deliveryApi.geocodeAddress(startAddress, currentSettings?.openrouteservice_api_key || openrouteserviceApiKey);
            if (coords) {
                startLat = coords.lat;
                startLng = coords.lng;
            }
        }

        if (endAddress) {
            const currentSettings = await deliveryApi.getSettings(merchantId);
            const coords = await deliveryApi.geocodeAddress(endAddress, currentSettings?.openrouteservice_api_key || openrouteserviceApiKey);
            if (coords) {
                endLat = coords.lat;
                endLng = coords.lng;
            }
        }

        const settings = await deliveryApi.updateSettings(merchantId, {
            startAddress,
            startAddressLat: startLat,
            startAddressLng: startLng,
            endAddress,
            endAddressLat: endLat,
            endAddressLng: endLng,
            sameDayCutoff,
            podRetentionDays,
            autoIngestReadyOrders,
            openrouteserviceApiKey
        });

        await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'settings_updated', null, null, {
            startAddress: !!startAddress,
            endAddress: !!endAddress
        });

        res.json({ settings });
    } catch (error) {
        logger.error('Error updating delivery settings', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/audit
 * Get delivery audit log
 */
app.get('/api/delivery/audit', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { limit, offset, action, orderId, routeId } = req.query;

        const entries = await deliveryApi.getAuditLog(merchantId, {
            limit: parseInt(limit) || 100,
            offset: parseInt(offset) || 0,
            action,
            orderId,
            routeId
        });

        res.json({ entries });
    } catch (error) {
        logger.error('Error fetching audit log', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/delivery/stats
 * Get delivery statistics for dashboard
 */
app.get('/api/delivery/stats', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const today = new Date().toISOString().split('T')[0];

        // Get counts by status
        const statusCounts = await db.query(`
            SELECT status, COUNT(*) as count
            FROM delivery_orders
            WHERE merchant_id = $1
            GROUP BY status
        `, [merchantId]);

        // Get today's route info
        const activeRoute = await deliveryApi.getActiveRoute(merchantId, today);

        // Get recent completions
        const recentCompletions = await db.query(`
            SELECT COUNT(*) as count
            FROM delivery_orders
            WHERE merchant_id = $1
              AND status = 'completed'
              AND updated_at >= NOW() - INTERVAL '7 days'
        `, [merchantId]);

        res.json({
            stats: {
                byStatus: statusCounts.rows.reduce((acc, row) => {
                    acc[row.status] = parseInt(row.count);
                    return acc;
                }, {}),
                activeRoute: activeRoute ? {
                    id: activeRoute.id,
                    totalStops: activeRoute.order_count,
                    completedStops: activeRoute.completed_count,
                    skippedStops: activeRoute.skipped_count
                } : null,
                completedLast7Days: parseInt(recentCompletions.rows[0]?.count || 0)
            }
        });
    } catch (error) {
        logger.error('Error fetching delivery stats', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/delivery/sync
 * Sync open orders from Square that have delivery/shipment fulfillments
 * Use this to backfill orders that were missed while server was offline
 */
app.post('/api/delivery/sync', deliveryStrictRateLimit, requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { daysBack = 7 } = req.body;

        logger.info('Starting delivery order sync from Square', { merchantId, daysBack });

        // Get Square client for this merchant
        const squareClient = await getSquareClientForMerchant(merchantId);

        // Calculate date range
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysBack);

        // Search for orders with fulfillments
        const searchResponse = await squareClient.orders.search({
            locationIds: await getLocationIds(merchantId),
            query: {
                filter: {
                    dateTimeFilter: {
                        createdAt: {
                            startAt: startDate.toISOString()
                        }
                    },
                    stateFilter: {
                        states: ['OPEN', 'COMPLETED']
                    },
                    fulfillmentFilter: {
                        fulfillmentTypes: ['DELIVERY', 'SHIPMENT']
                    }
                },
                sort: {
                    sortField: 'CREATED_AT',
                    sortOrder: 'DESC'
                }
            },
            limit: 100
        });

        const orders = searchResponse.orders || [];
        let imported = 0;
        let skipped = 0;
        let errors = [];

        for (const order of orders) {
            try {
                // Check if order has delivery-type fulfillment
                const deliveryFulfillment = order.fulfillments?.find(f =>
                    (f.type === 'DELIVERY' || f.type === 'SHIPMENT')
                );

                if (!deliveryFulfillment) {
                    skipped++;
                    continue;
                }

                // Skip if already completed in Square and in our system
                if (order.state === 'COMPLETED') {
                    const existing = await deliveryApi.getOrderBySquareId(merchantId, order.id);
                    if (existing && existing.status === 'completed') {
                        skipped++;
                        continue;
                    }
                }

                // Try to ingest
                const result = await deliveryApi.ingestSquareOrder(merchantId, order);
                if (result) {
                    imported++;
                } else {
                    skipped++;
                }
            } catch (orderError) {
                errors.push({ orderId: order.id, error: orderError.message });
            }
        }

        logger.info('Delivery order sync completed', { merchantId, found: orders.length, imported, skipped, errors: errors.length });

        res.json({
            success: true,
            found: orders.length,
            imported,
            skipped,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        logger.error('Error syncing delivery orders', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * Helper to get location IDs for a merchant
 */
async function getLocationIds(merchantId) {
    const result = await db.query(
        'SELECT id FROM locations WHERE merchant_id = $1 AND active = TRUE',
        [merchantId]
    );
    return result.rows.map(r => r.id);
}

// ==================== LOYALTY ADDON API ====================
// Frequent Buyer Program - Digitizes brand-defined loyalty programs
// BUSINESS RULES: One offer = one brand + size group, never mix sizes, full redemption only

/**
 * GET /api/loyalty/offers
 * List all loyalty offers for the merchant
 */
app.get('/api/loyalty/offers', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { activeOnly, brandName } = req.query;

        const offers = await loyaltyService.getOffers(merchantId, {
            activeOnly: activeOnly === 'true',
            brandName
        });

        res.json({ offers });
    } catch (error) {
        logger.error('Error fetching loyalty offers', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/offers
 * Create a new loyalty offer (frequent buyer program)
 * Requires admin role
 */
app.post('/api/loyalty/offers', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { offerName, brandName, sizeGroup, requiredQuantity, windowMonths, description } = req.body;

        if (!brandName || !sizeGroup || !requiredQuantity) {
            return res.status(400).json({
                error: 'brandName, sizeGroup, and requiredQuantity are required'
            });
        }

        const offer = await loyaltyService.createOffer({
            merchantId,
            offerName,
            brandName,
            sizeGroup,
            requiredQuantity: parseInt(requiredQuantity),
            windowMonths: windowMonths ? parseInt(windowMonths) : 12,
            description,
            createdBy: req.session.user.id
        });

        logger.info('Created loyalty offer', {
            offerId: offer.id,
            brandName,
            sizeGroup,
            merchantId
        });

        res.status(201).json({ offer });
    } catch (error) {
        logger.error('Error creating loyalty offer', { error: error.message });
        if (error.message.includes('unique') || error.message.includes('duplicate')) {
            return res.status(409).json({
                error: 'An offer for this brand and size group already exists'
            });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/offers/:id
 * Get a single loyalty offer with details
 */
app.get('/api/loyalty/offers/:id', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const offer = await loyaltyService.getOfferById(req.params.id, merchantId);

        if (!offer) {
            return res.status(404).json({ error: 'Offer not found' });
        }

        // Get qualifying variations
        const variations = await loyaltyService.getQualifyingVariations(req.params.id, merchantId);

        res.json({ offer, variations });
    } catch (error) {
        logger.error('Error fetching loyalty offer', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/loyalty/offers/:id
 * Update a loyalty offer
 * Note: requiredQuantity cannot be changed to preserve integrity, but windowMonths can be adjusted
 */
app.patch('/api/loyalty/offers/:id', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { offer_name, description, is_active, window_months } = req.body;

        const updates = {};
        if (offer_name !== undefined) updates.offer_name = offer_name;
        if (description !== undefined) updates.description = description;
        if (is_active !== undefined) updates.is_active = is_active;
        if (window_months !== undefined && window_months > 0) updates.window_months = parseInt(window_months);

        const offer = await loyaltyService.updateOffer(
            req.params.id,
            updates,
            merchantId,
            req.session.user.id
        );

        res.json({ offer });
    } catch (error) {
        logger.error('Error updating loyalty offer', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/loyalty/offers/:id
 * Delete a loyalty offer (discontinued by vendor)
 * Note: Historical rewards/redemptions are preserved for audit
 */
app.delete('/api/loyalty/offers/:id', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await loyaltyService.deleteOffer(
            req.params.id,
            merchantId,
            req.session.user.id
        );

        logger.info('Deleted loyalty offer', {
            offerId: req.params.id,
            offerName: result.offerName,
            hadActiveRewards: result.hadActiveRewards,
            merchantId
        });

        res.json(result);
    } catch (error) {
        logger.error('Error deleting loyalty offer', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/offers/:id/variations
 * Add qualifying variations to an offer
 * IMPORTANT: Only explicitly added variations qualify for the offer
 */
app.post('/api/loyalty/offers/:id/variations', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { variations } = req.body;

        if (!variations || !Array.isArray(variations) || variations.length === 0) {
            return res.status(400).json({ error: 'variations array is required' });
        }

        const added = await loyaltyService.addQualifyingVariations(
            req.params.id,
            variations,
            merchantId,
            req.session.user.id
        );

        logger.info('Added qualifying variations to offer', {
            offerId: req.params.id,
            addedCount: added.length,
            merchantId
        });

        res.json({ added });
    } catch (error) {
        logger.error('Error adding qualifying variations', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/offers/:id/variations
 * Get qualifying variations for an offer
 */
app.get('/api/loyalty/offers/:id/variations', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const variations = await loyaltyService.getQualifyingVariations(req.params.id, merchantId);
        res.json({ variations });
    } catch (error) {
        logger.error('Error fetching qualifying variations', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/loyalty/offers/:offerId/variations/:variationId
 * Remove a qualifying variation from an offer
 */
app.delete('/api/loyalty/offers/:offerId/variations/:variationId', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { offerId, variationId } = req.params;

        const result = await db.query(`
            UPDATE loyalty_qualifying_variations
            SET is_active = FALSE, updated_at = NOW()
            WHERE offer_id = $1 AND variation_id = $2 AND merchant_id = $3
            RETURNING *
        `, [offerId, variationId, merchantId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Variation not found in offer' });
        }

        await loyaltyService.logAuditEvent({
            merchantId,
            action: 'VARIATION_REMOVED',
            offerId,
            triggeredBy: 'ADMIN',
            userId: req.session.user.id,
            details: { variationId }
        });

        res.json({ success: true });
    } catch (error) {
        logger.error('Error removing qualifying variation', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/customer/:customerId
 * Get loyalty status for a specific customer
 */
app.get('/api/loyalty/customer/:customerId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const status = await loyaltyService.getCustomerLoyaltyStatus(req.params.customerId, merchantId);
        res.json(status);
    } catch (error) {
        logger.error('Error fetching customer loyalty status', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/customer/:customerId/history
 * Get full loyalty history for a customer
 */
app.get('/api/loyalty/customer/:customerId/history', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { limit, offerId } = req.query;

        const history = await loyaltyService.getCustomerLoyaltyHistory(
            req.params.customerId,
            merchantId,
            { limit: parseInt(limit) || 50, offerId }
        );

        res.json(history);
    } catch (error) {
        logger.error('Error fetching customer loyalty history', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/customer/:customerId/rewards
 * Get earned (available) rewards for a customer
 */
app.get('/api/loyalty/customer/:customerId/rewards', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const rewards = await loyaltyService.getCustomerEarnedRewards(req.params.customerId, merchantId);
        res.json({ rewards });
    } catch (error) {
        logger.error('Error fetching customer rewards', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/customer/:customerId/audit-history
 * Get 91-day order history for manual loyalty audit
 * Returns orders with qualifying/non-qualifying items analysis
 */
app.get('/api/loyalty/customer/:customerId/audit-history', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const customerId = req.params.customerId;
        const days = parseInt(req.query.days) || 91;

        const result = await loyaltyService.getCustomerOrderHistoryForAudit({
            squareCustomerId: customerId,
            merchantId,
            periodDays: days
        });

        res.json(result);
    } catch (error) {
        logger.error('Error fetching customer audit history', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/customer/:customerId/add-orders
 * Add selected orders to loyalty tracking (manual backfill for specific customer)
 */
app.post('/api/loyalty/customer/:customerId/add-orders', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const customerId = req.params.customerId;
        const { orderIds } = req.body;

        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ error: 'orderIds array is required' });
        }

        const result = await loyaltyService.addOrdersToLoyaltyTracking({
            squareCustomerId: customerId,
            merchantId,
            orderIds
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Error adding orders to loyalty tracking', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/rewards/:rewardId/redeem
 * Redeem a loyalty reward
 * BUSINESS RULE: Full redemption only - one reward = one free unit
 */
app.post('/api/loyalty/rewards/:rewardId/redeem', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { squareOrderId, redeemedVariationId, redeemedValueCents, adminNotes } = req.body;

        const result = await loyaltyService.redeemReward({
            merchantId,
            rewardId: req.params.rewardId,
            squareOrderId,
            redemptionType: req.body.redemptionType || 'manual_admin',
            redeemedVariationId,
            redeemedValueCents: redeemedValueCents ? parseInt(redeemedValueCents) : null,
            redeemedByUserId: req.session.user.id,
            adminNotes
        });

        logger.info('Loyalty reward redeemed', {
            rewardId: req.params.rewardId,
            redemptionId: result.redemption.id,
            merchantId
        });

        res.json(result);
    } catch (error) {
        logger.error('Error redeeming reward', { error: error.message });
        if (error.message.includes('Cannot redeem')) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/rewards
 * Get rewards with filtering (earned, redeemed, etc.)
 */
app.get('/api/loyalty/rewards', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { status, offerId, customerId, limit, offset } = req.query;

        let query = `
            SELECT r.*, o.offer_name, o.brand_name, o.size_group
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.merchant_id = $1
        `;
        const params = [merchantId];

        if (status) {
            params.push(status);
            query += ` AND r.status = $${params.length}`;
        }

        if (offerId) {
            params.push(offerId);
            query += ` AND r.offer_id = $${params.length}`;
        }

        if (customerId) {
            params.push(customerId);
            query += ` AND r.square_customer_id = $${params.length}`;
        }

        query += ` ORDER BY r.created_at DESC`;

        params.push(parseInt(limit) || 100);
        query += ` LIMIT $${params.length}`;

        params.push(parseInt(offset) || 0);
        query += ` OFFSET $${params.length}`;

        const result = await db.query(query, params);

        res.json({ rewards: result.rows });
    } catch (error) {
        logger.error('Error fetching rewards', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/redemptions
 * Get redemption history with filtering
 */
app.get('/api/loyalty/redemptions', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { offerId, customerId, startDate, endDate, limit, offset } = req.query;

        let query = `
            SELECT rd.*, o.offer_name, o.brand_name, o.size_group
            FROM loyalty_redemptions rd
            JOIN loyalty_offers o ON rd.offer_id = o.id
            WHERE rd.merchant_id = $1
        `;
        const params = [merchantId];

        if (offerId) {
            params.push(offerId);
            query += ` AND rd.offer_id = $${params.length}`;
        }

        if (customerId) {
            params.push(customerId);
            query += ` AND rd.square_customer_id = $${params.length}`;
        }

        if (startDate) {
            params.push(startDate);
            query += ` AND rd.redeemed_at >= $${params.length}`;
        }

        if (endDate) {
            params.push(endDate);
            query += ` AND rd.redeemed_at <= $${params.length}`;
        }

        query += ` ORDER BY rd.redeemed_at DESC`;

        params.push(parseInt(limit) || 100);
        query += ` LIMIT $${params.length}`;

        params.push(parseInt(offset) || 0);
        query += ` OFFSET $${params.length}`;

        const result = await db.query(query, params);

        res.json({ redemptions: result.rows });
    } catch (error) {
        logger.error('Error fetching redemptions', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/audit
 * Get loyalty audit log entries
 */
app.get('/api/loyalty/audit', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { action, squareCustomerId, offerId, limit, offset } = req.query;

        const entries = await loyaltyService.getAuditLogs(merchantId, {
            action,
            squareCustomerId,
            offerId,
            limit: parseInt(limit) || 100,
            offset: parseInt(offset) || 0
        });

        res.json({ entries });
    } catch (error) {
        logger.error('Error fetching loyalty audit log', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/stats
 * Get loyalty program statistics for dashboard
 */
app.get('/api/loyalty/stats', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Get offer counts
        const offerStats = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE is_active = TRUE) as active_offers,
                COUNT(*) as total_offers
            FROM loyalty_offers
            WHERE merchant_id = $1
        `, [merchantId]);

        // Get reward counts by status
        const rewardStats = await db.query(`
            SELECT status, COUNT(*) as count
            FROM loyalty_rewards
            WHERE merchant_id = $1
            GROUP BY status
        `, [merchantId]);

        // Get recent activity
        const recentEarned = await db.query(`
            SELECT COUNT(*) as count
            FROM loyalty_rewards
            WHERE merchant_id = $1
              AND status IN ('earned', 'redeemed')
              AND earned_at >= NOW() - INTERVAL '30 days'
        `, [merchantId]);

        const recentRedeemed = await db.query(`
            SELECT COUNT(*) as count
            FROM loyalty_redemptions
            WHERE merchant_id = $1
              AND redeemed_at >= NOW() - INTERVAL '30 days'
        `, [merchantId]);

        // Get total redemption value
        const totalValue = await db.query(`
            SELECT COALESCE(SUM(redeemed_value_cents), 0) as total_cents
            FROM loyalty_redemptions
            WHERE merchant_id = $1
        `, [merchantId]);

        res.json({
            stats: {
                offers: {
                    active: parseInt(offerStats.rows[0]?.active_offers || 0),
                    total: parseInt(offerStats.rows[0]?.total_offers || 0)
                },
                rewards: rewardStats.rows.reduce((acc, row) => {
                    acc[row.status] = parseInt(row.count);
                    return acc;
                }, {}),
                last30Days: {
                    earned: parseInt(recentEarned.rows[0]?.count || 0),
                    redeemed: parseInt(recentRedeemed.rows[0]?.count || 0)
                },
                totalRedemptionValueCents: parseInt(totalValue.rows[0]?.total_cents || 0)
            }
        });
    } catch (error) {
        logger.error('Error fetching loyalty stats', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// SQUARE LOYALTY INTEGRATION ENDPOINTS
// ============================================================================

/**
 * GET /api/loyalty/square-program
 * Get the merchant's Square Loyalty program and available reward tiers
 */
app.get('/api/loyalty/square-program', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        const program = await loyaltyService.getSquareLoyaltyProgram(merchantId);

        if (!program) {
            return res.json({
                hasProgram: false,
                message: 'No Square Loyalty program found. Set up Square Loyalty in your Square Dashboard first.',
                setupUrl: 'https://squareup.com/dashboard/loyalty'
            });
        }

        // Extract reward tiers for configuration UI
        const rewardTiers = (program.reward_tiers || []).map(tier => ({
            id: tier.id,
            name: tier.name,
            points: tier.points,
            definition: tier.definition
        }));

        res.json({
            hasProgram: true,
            programId: program.id,
            programName: program.terminology?.one || 'Loyalty',
            rewardTiers
        });

    } catch (error) {
        logger.error('Error fetching Square Loyalty program', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/loyalty/offers/:id/square-tier
 * Link an offer to a Square Loyalty reward tier
 */
app.put('/api/loyalty/offers/:id/square-tier', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const offerId = req.params.id;
        const { squareRewardTierId } = req.body;

        // Update the offer with the Square reward tier ID
        const result = await db.query(
            `UPDATE loyalty_offers
             SET square_reward_tier_id = $1, updated_at = NOW()
             WHERE id = $2 AND merchant_id = $3
             RETURNING id, offer_name, square_reward_tier_id`,
            [squareRewardTierId || null, offerId, merchantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Offer not found' });
        }

        logger.info('Linked offer to Square Loyalty tier', {
            merchantId,
            offerId,
            squareRewardTierId
        });

        res.json({
            success: true,
            offer: result.rows[0]
        });

    } catch (error) {
        logger.error('Error linking offer to Square tier', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/rewards/:id/create-square-reward
 * Manually create a Square Customer Group Discount for an earned reward
 * This makes the reward auto-apply at Square POS when customer is identified
 *
 * Query params:
 *   force=true - Delete existing discount and recreate (for fixing broken discounts)
 */
app.post('/api/loyalty/rewards/:id/create-square-reward', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const rewardId = req.params.id;
        const force = req.query.force === 'true' || req.body.force === true;

        // Get the reward details
        const rewardResult = await db.query(
            `SELECT r.*, o.offer_name
             FROM loyalty_rewards r
             JOIN loyalty_offers o ON r.offer_id = o.id
             WHERE r.id = $1 AND r.merchant_id = $2`,
            [rewardId, merchantId]
        );

        if (rewardResult.rows.length === 0) {
            return res.status(404).json({ error: 'Reward not found' });
        }

        const reward = rewardResult.rows[0];

        if (reward.status !== 'earned') {
            return res.status(400).json({ error: 'Reward must be in "earned" status to sync to POS' });
        }

        // Check if already synced (has Customer Group Discount created)
        if (reward.square_group_id && reward.square_discount_id) {
            if (!force) {
                return res.json({
                    success: true,
                    message: 'Already synced to Square POS',
                    groupId: reward.square_group_id,
                    discountId: reward.square_discount_id
                });
            }

            // Force mode: cleanup existing discount first
            logger.info('Force re-sync: cleaning up existing Square discount', {
                rewardId,
                merchantId,
                existingGroupId: reward.square_group_id
            });

            await loyaltyService.cleanupSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: rewardId
            });
        }

        // Create the Square Customer Group Discount
        const result = await loyaltyService.createSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId: reward.square_customer_id,
            internalRewardId: rewardId,
            offerId: reward.offer_id
        });

        res.json(result);

    } catch (error) {
        logger.error('Error creating Square reward', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/rewards/sync-to-pos
 * Bulk sync earned rewards to Square POS
 * Creates Customer Group Discounts for earned rewards
 *
 * Query/Body params:
 *   force=true - Re-sync ALL earned rewards (delete and recreate discounts)
 */
app.post('/api/loyalty/rewards/sync-to-pos', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const force = req.query.force === 'true' || req.body.force === true;

        // Find earned rewards to sync
        // If force=true, get ALL earned rewards; otherwise only those not yet synced
        let query;
        if (force) {
            query = `
                SELECT r.id, r.square_customer_id, r.offer_id, o.offer_name,
                       r.square_group_id, r.square_discount_id
                FROM loyalty_rewards r
                JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.merchant_id = $1
                  AND r.status = 'earned'
            `;
        } else {
            query = `
                SELECT r.id, r.square_customer_id, r.offer_id, o.offer_name,
                       r.square_group_id, r.square_discount_id
                FROM loyalty_rewards r
                JOIN loyalty_offers o ON r.offer_id = o.id
                WHERE r.merchant_id = $1
                  AND r.status = 'earned'
                  AND (r.square_group_id IS NULL OR r.square_discount_id IS NULL)
            `;
        }

        const pendingResult = await db.query(query, [merchantId]);
        const pending = pendingResult.rows;

        if (pending.length === 0) {
            return res.json({
                success: true,
                message: force ? 'No earned rewards to re-sync' : 'All earned rewards are already synced to POS',
                synced: 0
            });
        }

        logger.info('Syncing earned rewards to Square POS', {
            merchantId,
            pendingCount: pending.length,
            force
        });

        const results = [];
        for (const reward of pending) {
            try {
                // If force mode and reward has existing Square objects, clean them up first
                if (force && reward.square_group_id) {
                    await loyaltyService.cleanupSquareCustomerGroupDiscount({
                        merchantId,
                        squareCustomerId: reward.square_customer_id,
                        internalRewardId: reward.id
                    });
                }

                const result = await loyaltyService.createSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId: reward.square_customer_id,
                    internalRewardId: reward.id,
                    offerId: reward.offer_id
                });

                results.push({
                    rewardId: reward.id,
                    offerName: reward.offer_name,
                    success: result.success,
                    error: result.error || null
                });
            } catch (err) {
                results.push({
                    rewardId: reward.id,
                    offerName: reward.offer_name,
                    success: false,
                    error: err.message
                });
            }
        }

        const successCount = results.filter(r => r.success).length;
        logger.info('Finished syncing rewards to POS', {
            merchantId,
            total: pending.length,
            success: successCount,
            force
        });

        res.json({
            success: true,
            message: `Synced ${successCount} of ${pending.length} rewards to Square POS`,
            synced: successCount,
            total: pending.length,
            results
        });

    } catch (error) {
        logger.error('Error bulk syncing rewards to POS', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/rewards/pending-sync
 * Get count of earned rewards - both pending sync and already synced
 */
app.get('/api/loyalty/rewards/pending-sync', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Get count of pending (not yet synced) rewards
        const pendingResult = await db.query(`
            SELECT COUNT(*) as count
            FROM loyalty_rewards
            WHERE merchant_id = $1
              AND status = 'earned'
              AND (square_group_id IS NULL OR square_discount_id IS NULL)
        `, [merchantId]);

        // Get count of synced rewards
        const syncedResult = await db.query(`
            SELECT COUNT(*) as count
            FROM loyalty_rewards
            WHERE merchant_id = $1
              AND status = 'earned'
              AND square_group_id IS NOT NULL
              AND square_discount_id IS NOT NULL
        `, [merchantId]);

        res.json({
            pendingCount: parseInt(pendingResult.rows[0].count, 10),
            syncedCount: parseInt(syncedResult.rows[0].count, 10)
        });

    } catch (error) {
        logger.error('Error getting pending sync count', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/debug
 * Diagnostic endpoint to help troubleshoot loyalty tracking issues
 */
app.get('/api/loyalty/debug', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Check loyalty enabled setting
        const loyaltyEnabled = await loyaltyService.getSetting('loyalty_enabled', merchantId);

        // Get configured offers with their variation IDs
        const offersResult = await db.query(`
            SELECT
                o.id,
                o.offer_name,
                o.brand_name,
                o.size_group,
                o.is_active,
                COUNT(qv.id) as variation_count,
                ARRAY_AGG(qv.variation_id) FILTER (WHERE qv.variation_id IS NOT NULL) as variation_ids
            FROM loyalty_offers o
            LEFT JOIN loyalty_qualifying_variations qv ON o.id = qv.offer_id AND qv.is_active = TRUE
            WHERE o.merchant_id = $1
            GROUP BY o.id
            ORDER BY o.created_at DESC
        `, [merchantId]);

        // Get recent purchase events (last 10)
        const recentPurchases = await db.query(`
            SELECT
                pe.id,
                pe.square_order_id,
                pe.square_customer_id,
                pe.variation_id,
                pe.quantity,
                pe.purchased_at,
                o.offer_name
            FROM loyalty_purchase_events pe
            JOIN loyalty_offers o ON pe.offer_id = o.id
            WHERE pe.merchant_id = $1
            ORDER BY pe.purchased_at DESC
            LIMIT 10
        `, [merchantId]);

        // Get qualifying variation details for easy viewing
        const qualifyingVariations = await db.query(`
            SELECT
                qv.variation_id,
                qv.item_name,
                qv.variation_name,
                qv.sku,
                o.offer_name
            FROM loyalty_qualifying_variations qv
            JOIN loyalty_offers o ON qv.offer_id = o.id
            WHERE qv.merchant_id = $1 AND qv.is_active = TRUE AND o.is_active = TRUE
            ORDER BY o.offer_name, qv.item_name
        `, [merchantId]);

        res.json({
            debug: {
                loyaltyEnabled: loyaltyEnabled !== 'false',
                offers: offersResult.rows.map(o => ({
                    id: o.id,
                    name: o.offer_name,
                    brand: o.brand_name,
                    sizeGroup: o.size_group,
                    isActive: o.is_active,
                    variationCount: parseInt(o.variation_count),
                    variationIds: o.variation_ids || []
                })),
                qualifyingVariations: qualifyingVariations.rows,
                recentLoyaltyPurchases: recentPurchases.rows,
                troubleshooting: {
                    tip1: 'Check loyaltyEnabled is true',
                    tip2: 'Ensure your offer has variations (variationCount > 0)',
                    tip3: 'Orders MUST have a Square customer attached at checkout',
                    tip4: 'The variation_id in the Square order must match one in qualifyingVariations exactly',
                    tip5: 'Check server logs for "Processing order for loyalty" messages'
                }
            }
        });
    } catch (error) {
        logger.error('Error in loyalty debug endpoint', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/process-order/:orderId
 * Manually fetch and process a specific Square order for loyalty
 * Useful for testing/debugging when webhooks aren't working
 */
app.post('/api/loyalty/process-order/:orderId', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const squareOrderId = req.params.orderId;

        logger.info('Manually processing order for loyalty', { squareOrderId, merchantId });

        // Get and decrypt access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token configured for this merchant' });
        }
        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        // Fetch the order from Square using raw API
        const orderResponse = await fetch(`https://connect.squareup.com/v2/orders/${squareOrderId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            }
        });

        if (!orderResponse.ok) {
            const errText = await orderResponse.text();
            return res.status(orderResponse.status).json({ error: `Square API error: ${errText}` });
        }

        const orderData = await orderResponse.json();
        const order = orderData.order;

        if (!order) {
            return res.status(404).json({ error: 'Order not found in Square' });
        }

        // Fetch customer details if customer_id exists
        let customerDetails = null;
        if (order.customer_id) {
            customerDetails = await loyaltyService.getCustomerDetails(order.customer_id, merchantId);
        }

        // Return diagnostic info about the order
        const diagnostics = {
            orderId: order.id,
            customerId: order.customer_id || null,
            hasCustomer: !!order.customer_id,
            customerDetails,
            state: order.state,
            createdAt: order.created_at,
            lineItems: (order.line_items || []).map(li => ({
                name: li.name,
                quantity: li.quantity,
                catalogObjectId: li.catalog_object_id,
                variationName: li.variation_name
            }))
        };

        if (!order.customer_id) {
            return res.json({
                processed: false,
                reason: 'Order has no customer ID attached',
                diagnostics,
                tip: 'The sale must have a customer attached in Square POS before payment'
            });
        }

        // Process the order for loyalty (use snake_case since we're using raw API response)
        const loyaltyResult = await loyaltyService.processOrderForLoyalty(order, merchantId);

        res.json({
            processed: loyaltyResult.processed,
            result: loyaltyResult,
            diagnostics
        });

    } catch (error) {
        logger.error('Error manually processing order for loyalty', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/customer/:customerId
 * Lookup customer details from Square by customer ID
 */
app.get('/api/loyalty/customer/:customerId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const customerId = req.params.customerId;

        const customerDetails = await loyaltyService.getCustomerDetails(customerId, merchantId);

        if (!customerDetails) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Also get their loyalty status
        const loyaltyStatus = await loyaltyService.getCustomerLoyaltyStatus(customerId, merchantId);

        res.json({
            customer: customerDetails,
            loyalty: loyaltyStatus
        });

    } catch (error) {
        logger.error('Error fetching customer details', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/customers/search
 * Search customers by phone number, email, or name
 * First checks local cache, then Square API if needed
 */
app.get('/api/loyalty/customers/search', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const query = req.query.q?.trim();

        if (!query || query.length < 2) {
            return res.status(400).json({ error: 'Search query must be at least 2 characters' });
        }

        // Normalize phone number - remove spaces, dashes, parentheses
        const normalizedQuery = query.replace(/[\s\-\(\)\.]/g, '');
        const isPhoneSearch = /^\+?\d{7,}$/.test(normalizedQuery);
        const isEmailSearch = query.includes('@');

        // First, search local cache for loyalty customers
        const cachedCustomers = await loyaltyService.searchCachedCustomers(query, merchantId);

        // If we found exact matches in cache (especially for phone), return them
        if (cachedCustomers.length > 0 && isPhoneSearch) {
            logger.debug('Returning cached customer results', { query, count: cachedCustomers.length });
            return res.json({
                query,
                searchType: 'phone',
                customers: cachedCustomers,
                source: 'cache'
            });
        }

        // Search Square API for more results
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            // No Square token - return cached results only
            if (cachedCustomers.length > 0) {
                return res.json({
                    query,
                    searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
                    customers: cachedCustomers,
                    source: 'cache'
                });
            }
            return res.status(400).json({ error: 'No Square access token configured' });
        }
        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        let searchFilter = {};

        if (isPhoneSearch) {
            searchFilter = {
                phone_number: {
                    exact: normalizedQuery.startsWith('+') ? normalizedQuery : `+1${normalizedQuery}`
                }
            };
        } else if (isEmailSearch) {
            searchFilter = {
                email_address: {
                    fuzzy: query
                }
            };
        }

        // Search customers using Square API
        const searchBody = {
            limit: 20
        };

        if (Object.keys(searchFilter).length > 0) {
            searchBody.query = { filter: searchFilter };
        } else {
            // For name searches, get recent customers and filter client-side
            searchBody.query = {
                filter: {},
                sort: {
                    field: 'CREATED_AT',
                    order: 'DESC'
                }
            };
        }

        const response = await fetch('https://connect.squareup.com/v2/customers/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2025-01-16'
            },
            body: JSON.stringify(searchBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error('Square customer search failed', { status: response.status, error: errText });
            // Return cached results if Square API fails
            if (cachedCustomers.length > 0) {
                return res.json({
                    query,
                    searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
                    customers: cachedCustomers,
                    source: 'cache'
                });
            }
            return res.status(response.status).json({ error: 'Square API error' });
        }

        const data = await response.json();
        const squareCustomers = (data.customers || []).map(c => ({
            id: c.id,
            displayName: [c.given_name, c.family_name].filter(Boolean).join(' ') || c.company_name || 'Unknown',
            givenName: c.given_name || null,
            familyName: c.family_name || null,
            phone: c.phone_number || null,
            email: c.email_address || null,
            companyName: c.company_name || null,
            createdAt: c.created_at
        }));

        // For name searches, filter client-side
        let filteredSquareCustomers = squareCustomers;
        if (!isPhoneSearch && !isEmailSearch) {
            const lowerQuery = query.toLowerCase();
            filteredSquareCustomers = squareCustomers.filter(c =>
                c.displayName?.toLowerCase().includes(lowerQuery) ||
                c.givenName?.toLowerCase().includes(lowerQuery) ||
                c.familyName?.toLowerCase().includes(lowerQuery) ||
                c.phone?.includes(query) ||
                c.email?.toLowerCase().includes(lowerQuery)
            );
        }

        // Cache Square customers for future lookups (async, don't wait)
        for (const customer of filteredSquareCustomers) {
            loyaltyService.cacheCustomerDetails(customer, merchantId).catch(err => {
                logger.warn('Failed to cache customer', { error: err.message, customerId: customer.id });
            });
        }

        // Merge cached and Square results, deduplicate by ID
        const seenIds = new Set();
        const mergedCustomers = [];

        // Add Square results first (fresher data)
        for (const c of filteredSquareCustomers) {
            if (!seenIds.has(c.id)) {
                seenIds.add(c.id);
                mergedCustomers.push(c);
            }
        }

        // Add any cached customers not in Square results
        for (const c of cachedCustomers) {
            if (!seenIds.has(c.id)) {
                seenIds.add(c.id);
                mergedCustomers.push(c);
            }
        }

        res.json({
            query,
            searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
            customers: mergedCustomers,
            source: 'merged'
        });

    } catch (error) {
        logger.error('Error searching customers', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/backfill
 * Fetch recent orders from Square and process them for loyalty
 * Useful for catching up on orders that weren't processed via webhook
 */
app.post('/api/loyalty/backfill', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { days = 7 } = req.body; // Default to last 7 days

        logger.info('Starting loyalty backfill', { merchantId, days });

        // Get location IDs
        const locationsResult = await db.query(
            'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
            [merchantId]
        );
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            return res.json({ error: 'No active locations found', processed: 0 });
        }

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        // Get and decrypt access token (same pattern as getMerchantToken in square-api.js)
        // Token is not included in merchantContext for security - fetch from DB directly
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token configured for this merchant' });
        }
        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        let cursor = null;
        let ordersProcessed = 0;
        let ordersWithCustomer = 0;
        let ordersWithQualifyingItems = 0;
        let loyaltyPurchasesRecorded = 0;
        const results = [];
        const diagnostics = { sampleOrdersWithoutCustomer: [], sampleVariationIds: [] };

        // Get qualifying variation IDs for comparison
        const qualifyingResult = await db.query(
            `SELECT DISTINCT qv.variation_id
             FROM loyalty_qualifying_variations qv
             JOIN loyalty_offers lo ON qv.offer_id = lo.id
             WHERE lo.merchant_id = $1 AND lo.is_active = TRUE`,
            [merchantId]
        );
        const qualifyingVariationIds = new Set(qualifyingResult.rows.map(r => r.variation_id));

        // OPTIMIZATION: Pre-fetch ALL loyalty events once at the start
        // This reduces 100s of API calls to just 1-2 paginated calls
        logger.info('Pre-fetching loyalty events for batch processing', { merchantId, days });
        const prefetchedLoyalty = await loyaltyService.prefetchRecentLoyaltyEvents(merchantId, days);
        logger.info('Pre-fetch complete', {
            merchantId,
            eventsFound: prefetchedLoyalty.events.length,
            accountsMapped: Object.keys(prefetchedLoyalty.loyaltyAccounts).length
        });

        let customersFoundViaPrefetch = 0;

        // Use raw Square API (same approach as sales velocity sync)
        do {
            const requestBody = {
                location_ids: locationIds,
                query: {
                    filter: {
                        state_filter: {
                            states: ['COMPLETED']
                        },
                        date_time_filter: {
                            closed_at: {
                                start_at: startDate.toISOString(),
                                end_at: endDate.toISOString()
                            }
                        }
                    }
                },
                limit: 50
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const response = await fetch('https://connect.squareup.com/v2/orders/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Square API error: ${response.status} - ${errText}`);
            }

            const data = await response.json();
            const orders = data.orders || [];

            // Process each order for loyalty
            for (const order of orders) {
                ordersProcessed++;

                // Collect sample variation IDs from orders for diagnostics
                const orderVariationIds = (order.line_items || [])
                    .map(li => li.catalog_object_id)
                    .filter(Boolean);
                if (diagnostics.sampleVariationIds.length < 10) {
                    orderVariationIds.forEach(vid => {
                        if (!diagnostics.sampleVariationIds.includes(vid)) {
                            diagnostics.sampleVariationIds.push(vid);
                        }
                    });
                }

                // Check if order has qualifying items (for diagnostics)
                const hasQualifyingItem = orderVariationIds.some(vid => qualifyingVariationIds.has(vid));
                if (hasQualifyingItem) {
                    ordersWithQualifyingItems++;
                }

                // Track orders with direct customer_id
                if (order.customer_id) {
                    ordersWithCustomer++;
                }

                // OPTIMIZATION: Skip orders without qualifying items
                // No point doing loyalty lookup if there's nothing to track
                if (!hasQualifyingItem) {
                    continue;
                }

                try {
                    // If order has no customer_id, try to find one from prefetched loyalty data
                    // Also check tenders for customer_id
                    let customerId = order.customer_id;
                    if (!customerId && order.tenders) {
                        for (const tender of order.tenders) {
                            if (tender.customer_id) {
                                customerId = tender.customer_id;
                                break;
                            }
                        }
                    }
                    if (!customerId) {
                        customerId = loyaltyService.findCustomerFromPrefetchedEvents(
                            order.id,
                            prefetchedLoyalty
                        );
                        if (customerId) {
                            customersFoundViaPrefetch++;
                        }
                    }

                    // Skip if still no customer after prefetch lookup
                    if (!customerId) {
                        if (diagnostics.sampleOrdersWithoutCustomer.length < 3) {
                            diagnostics.sampleOrdersWithoutCustomer.push({
                                orderId: order.id,
                                createdAt: order.created_at,
                                hasQualifyingItem
                            });
                        }
                        continue;
                    }

                    // Transform to camelCase for loyaltyService
                    // Now we pass the customer_id we found (either from order or prefetch)
                    const orderForLoyalty = {
                        id: order.id,
                        customer_id: customerId,
                        customerId: customerId,
                        state: order.state,
                        created_at: order.created_at,
                        location_id: order.location_id,
                        line_items: order.line_items,
                        lineItems: (order.line_items || []).map(li => ({
                            ...li,
                            catalogObjectId: li.catalog_object_id,
                            quantity: li.quantity,
                            name: li.name
                        }))
                    };

                    const loyaltyResult = await loyaltyService.processOrderForLoyalty(orderForLoyalty, merchantId);
                    if (loyaltyResult.processed && loyaltyResult.purchasesRecorded.length > 0) {
                        loyaltyPurchasesRecorded += loyaltyResult.purchasesRecorded.length;
                        results.push({
                            orderId: order.id,
                            customerId: loyaltyResult.customerId,
                            customerSource: order.customer_id ? 'order' : 'loyalty_prefetch',
                            purchasesRecorded: loyaltyResult.purchasesRecorded.length
                        });
                    }
                } catch (err) {
                    logger.warn('Failed to process order for loyalty during backfill', {
                        orderId: order.id,
                        error: err.message
                    });
                }
            }

            cursor = data.cursor;
        } while (cursor);

        logger.info('Loyalty backfill complete', {
            merchantId,
            days,
            ordersProcessed,
            ordersWithQualifyingItems,
            customersFoundViaPrefetch,
            loyaltyPurchasesRecorded
        });

        res.json({
            success: true,
            ordersProcessed,
            ordersWithCustomer,
            ordersWithQualifyingItems,
            customersFoundViaPrefetch,
            loyaltyPurchasesRecorded,
            results,
            diagnostics: {
                qualifyingVariationIdsConfigured: Array.from(qualifyingVariationIds),
                sampleVariationIdsInOrders: diagnostics.sampleVariationIds,
                sampleOrdersWithoutCustomer: diagnostics.sampleOrdersWithoutCustomer,
                prefetchedLoyaltyEvents: prefetchedLoyalty.events.length,
                prefetchedLoyaltyAccounts: Object.keys(prefetchedLoyalty.loyaltyAccounts).length
            }
        });

    } catch (error) {
        logger.error('Error during loyalty backfill', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/debug/recent-orders
 * Debug endpoint to fetch last 5 orders from Square with ALL raw data
 * Used to inspect where customer information is stored
 */
app.get('/api/loyalty/debug/recent-orders', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Get the access token from the database (not in merchantContext for security)
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token configured for this merchant' });
        }

        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        // Get location IDs for this merchant
        const locationResult = await db.query(
            'SELECT id FROM locations WHERE merchant_id = $1 AND active = TRUE',
            [merchantId]
        );
        const locationIds = locationResult.rows.map(r => r.id).filter(Boolean);

        if (locationIds.length === 0) {
            return res.status(400).json({ error: 'No Square locations configured for this merchant' });
        }

        // Fetch last 5 orders using raw Square API
        const requestBody = {
            location_ids: locationIds,
            limit: 5,
            sort_field: 'CREATED_AT',
            sort_order: 'DESC',
            query: {
                filter: {
                    state_filter: {
                        states: ['COMPLETED']
                    }
                }
            }
        };

        const response = await fetch('https://connect.squareup.com/v2/orders/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Square API error: ${response.status} - ${errText}`);
        }

        const data = await response.json();
        const orders = data.orders || [];

        // Return the complete raw order data
        res.json({
            success: true,
            orderCount: orders.length,
            orders: orders.map(order => ({
                // Return everything - don't filter any fields
                ...order,
                // Also highlight key fields at top level for easier inspection
                _debug_summary: {
                    id: order.id,
                    created_at: order.created_at,
                    customer_id: order.customer_id || 'NOT SET',
                    tenders_customer_ids: (order.tenders || []).map(t => t.customer_id || 'NOT SET'),
                    line_item_count: (order.line_items || []).length,
                    has_fulfillments: !!(order.fulfillments && order.fulfillments.length > 0),
                    total_money: order.total_money
                }
            }))
        });

    } catch (error) {
        logger.error('Error fetching recent orders for debug', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/debug/all-loyalty-events
 * Debug endpoint to get ALL recent loyalty events (for timestamp matching)
 */
app.get('/api/loyalty/debug/all-loyalty-events', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Get access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token' });
        }

        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        // Search ALL recent loyalty events - no filters, just get recent ones
        const eventsResponse = await fetch('https://connect.squareup.com/v2/loyalty/events/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                limit: 30
            })
        });

        const eventsData = await eventsResponse.json();
        const events = eventsData.events || [];

        res.json({
            httpStatus: eventsResponse.status,
            eventCount: events.length,
            events: events,
            rawResponse: eventsData
        });

    } catch (error) {
        logger.error('Error fetching all loyalty events', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/debug/loyalty-events/:orderId
 * Debug endpoint to check Square's Loyalty Events for a specific order
 */
app.get('/api/loyalty/debug/loyalty-events/:orderId', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { orderId } = req.params;

        // Get access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token' });
        }

        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        // Search loyalty events by order ID
        const eventsResponse = await fetch('https://connect.squareup.com/v2/loyalty/events/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                query: {
                    filter: {
                        order_filter: {
                            order_id: orderId
                        }
                    }
                },
                limit: 30
            })
        });

        const eventsText = await eventsResponse.text();
        let eventsData;
        try {
            eventsData = JSON.parse(eventsText);
        } catch (e) {
            eventsData = { raw: eventsText };
        }

        res.json({
            orderId,
            httpStatus: eventsResponse.status,
            events: eventsData.events || [],
            rawResponse: eventsData
        });

    } catch (error) {
        logger.error('Error in loyalty events debug', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/debug/matching
 * Debug endpoint to see why prefetch matching might fail
 * Shows loyalty events and qualifying orders side by side with timestamps
 */
app.get('/api/loyalty/debug/matching', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const days = parseInt(req.query.days) || 1;

        // Prefetch loyalty events
        const prefetchedData = await loyaltyService.prefetchRecentLoyaltyEvents(merchantId, days);

        // Get qualifying variation IDs
        const qualifyingResult = await db.query(
            `SELECT DISTINCT qv.variation_id, qv.item_name, qv.variation_name
             FROM loyalty_qualifying_variations qv
             JOIN loyalty_offers lo ON qv.offer_id = lo.id
             WHERE lo.merchant_id = $1 AND lo.is_active = TRUE`,
            [merchantId]
        );
        const qualifyingVariations = qualifyingResult.rows;
        const qualifyingVariationIds = new Set(qualifyingVariations.map(r => r.variation_id));

        // Get recent orders with qualifying items
        const locationsResult = await db.query(
            'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
            [merchantId]
        );
        const locationIds = locationsResult.rows.map(r => r.id);

        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const ordersResponse = await fetch('https://connect.squareup.com/v2/orders/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                location_ids: locationIds,
                query: {
                    filter: {
                        state_filter: { states: ['COMPLETED'] },
                        date_time_filter: {
                            closed_at: { start_at: startDate.toISOString() }
                        }
                    }
                },
                limit: 50
            })
        });

        const ordersData = await ordersResponse.json();
        const allOrders = ordersData.orders || [];

        // Find orders with qualifying items
        const qualifyingOrders = [];
        for (const order of allOrders) {
            const lineItems = order.line_items || [];
            const qualifyingItems = lineItems.filter(li => qualifyingVariationIds.has(li.catalog_object_id));

            if (qualifyingItems.length > 0) {
                // Try matching by order_id only (reliable)
                const foundCustomer = loyaltyService.findCustomerFromPrefetchedEvents(
                    order.id,
                    prefetchedData
                );

                qualifyingOrders.push({
                    orderId: order.id,
                    hasCustomerId: !!order.customer_id,
                    customerId: order.customer_id,
                    createdAt: order.created_at,
                    closedAt: order.closed_at,
                    createdAtMs: new Date(order.created_at).getTime(),
                    closedAtMs: order.closed_at ? new Date(order.closed_at).getTime() : null,
                    qualifyingItems: qualifyingItems.map(li => ({
                        name: li.name,
                        variationId: li.catalog_object_id,
                        quantity: li.quantity
                    })),
                    matchedCustomerFromPrefetch: foundCustomer
                });
            }
        }

        // Format loyalty events for comparison
        const loyaltyEventsFormatted = prefetchedData.byTimestamp.map(e => ({
            loyaltyAccountId: e.loyaltyAccountId,
            orderId: e.orderId,
            createdAtMs: e.createdAt,
            createdAt: new Date(e.createdAt).toISOString(),
            customerId: prefetchedData.loyaltyAccounts[e.loyaltyAccountId]
        }));

        // Calculate time differences for debugging
        const MATCH_WINDOW_MS = 5 * 60 * 1000;
        const matchAttempts = [];
        for (const order of qualifyingOrders) {
            if (!order.hasCustomerId) {
                for (const event of loyaltyEventsFormatted) {
                    const timeDiffCreated = Math.abs(event.createdAtMs - order.createdAtMs);
                    const timeDiffClosed = order.closedAtMs ? Math.abs(event.createdAtMs - order.closedAtMs) : null;

                    matchAttempts.push({
                        orderId: order.orderId,
                        orderCreatedAt: order.createdAt,
                        orderClosedAt: order.closedAt,
                        loyaltyEventAt: event.createdAt,
                        loyaltyAccountId: event.loyaltyAccountId,
                        customerId: event.customerId,
                        timeDiffFromCreatedSeconds: Math.round(timeDiffCreated / 1000),
                        timeDiffFromClosedSeconds: timeDiffClosed ? Math.round(timeDiffClosed / 1000) : null,
                        wouldMatchCreated: timeDiffCreated <= MATCH_WINDOW_MS,
                        wouldMatchClosed: timeDiffClosed ? timeDiffClosed <= MATCH_WINDOW_MS : null
                    });
                }
            }
        }

        res.json({
            summary: {
                days,
                totalOrders: allOrders.length,
                qualifyingOrders: qualifyingOrders.length,
                loyaltyEvents: prefetchedData.events.length,
                loyaltyAccounts: Object.keys(prefetchedData.loyaltyAccounts).length,
                matchWindowMinutes: 5
            },
            qualifyingOrders,
            loyaltyEvents: loyaltyEventsFormatted,
            matchAttempts: matchAttempts.slice(0, 50) // Limit output
        });

    } catch (error) {
        logger.error('Error in matching debug', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/debug/customer-identification
 * Test customer identification for recent orders
 * Use this to verify the "cash sale + points sign-in after" flow works
 *
 * SECURITY: Admin-only endpoint, masks customer IDs in response
 */
app.get('/api/loyalty/debug/customer-identification', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const minutes = parseInt(req.query.minutes) || 30;

        // Get merchant's access token
        const merchantResult = await db.query(
            'SELECT square_access_token, square_token_scopes FROM merchants WHERE id = $1',
            [merchantId]
        );

        if (!merchantResult.rows[0]?.square_access_token) {
            return res.status(400).json({ error: 'No Square access token' });
        }

        const rawToken = merchantResult.rows[0].square_access_token;
        const { isEncryptedToken, decryptToken } = require('./utils/token-encryption');
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;
        const scopes = merchantResult.rows[0].square_token_scopes || [];

        // Check required scopes
        const requiredScopes = ['LOYALTY_READ', 'ORDERS_READ', 'CUSTOMERS_READ'];
        const missingScopes = requiredScopes.filter(s => !scopes.includes(s));

        // Get merchant's locations for the search
        const locationsResult = await db.query(
            'SELECT square_location_id FROM locations WHERE merchant_id = $1 AND active = TRUE',
            [merchantId]
        );
        const locationIds = locationsResult.rows.map(r => r.square_location_id).filter(Boolean);

        if (locationIds.length === 0) {
            return res.status(400).json({ error: 'No active locations found for merchant' });
        }

        // Fetch recent orders from Square
        const startTime = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        const ordersResponse = await fetch('https://connect.squareup.com/v2/orders/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                location_ids: locationIds,
                query: {
                    filter: {
                        date_time_filter: {
                            created_at: { start_at: startTime }
                        },
                        state_filter: { states: ['COMPLETED'] }
                    },
                    sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
                },
                limit: 20
            })
        });

        const ordersData = await ordersResponse.json();
        const orders = ordersData.orders || [];

        // Handle API errors
        if (!ordersResponse.ok) {
            logger.error('Square Orders API error in customer identification', {
                merchantId,
                status: ordersResponse.status,
                errors: ordersData.errors
            });
            return res.status(502).json({ error: 'Failed to fetch orders from Square' });
        }

        // Helper to mask customer IDs for security (show last 4 chars only)
        const maskId = (id) => id ? `***${id.slice(-4)}` : null;

        // For each order, check all identification methods
        const results = [];
        for (const order of orders) {
            const identification = {
                orderId: order.id,
                createdAt: order.created_at,
                state: order.state,
                totalMoney: order.total_money,

                // Method 1: Direct order.customer_id
                orderCustomerId: order.customer_id || null,

                // Method 2: Check tenders for customer_id
                tenderCustomerId: null,
                tenders: (order.tenders || []).map(t => ({
                    type: t.type,
                    customerId: t.customer_id || null
                })),

                // Method 3: Loyalty event by order_id
                loyaltyEventCustomerId: null,
                loyaltyEvent: null,

                // Final result
                identifiedCustomerId: null,
                identificationMethod: null
            };

            // Check tenders
            for (const tender of order.tenders || []) {
                if (tender.customer_id) {
                    identification.tenderCustomerId = tender.customer_id;
                    break;
                }
            }

            // Check loyalty events by order_id
            try {
                const loyaltyResponse = await fetch('https://connect.squareup.com/v2/loyalty/events/search', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Square-Version': '2024-01-18'
                    },
                    body: JSON.stringify({
                        query: {
                            filter: {
                                order_filter: { order_id: order.id }
                            }
                        },
                        limit: 5
                    })
                });

                if (loyaltyResponse.ok) {
                    const loyaltyData = await loyaltyResponse.json();
                    const events = loyaltyData.events || [];

                    if (events.length > 0) {
                        const event = events[0];
                        identification.loyaltyEvent = {
                            id: event.id,
                            type: event.type,
                            loyaltyAccountId: event.loyalty_account_id,
                            createdAt: event.created_at
                        };

                        // Get customer_id from loyalty account
                        const accountResponse = await fetch(
                            `https://connect.squareup.com/v2/loyalty/accounts/${event.loyalty_account_id}`,
                            {
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
                                    'Content-Type': 'application/json',
                                    'Square-Version': '2024-01-18'
                                }
                            }
                        );

                        if (accountResponse.ok) {
                            const accountData = await accountResponse.json();
                            identification.loyaltyEventCustomerId = accountData.loyalty_account?.customer_id || null;
                        }
                    }
                }
            } catch (loyaltyErr) {
                identification.loyaltyError = loyaltyErr.message;
            }

            // Determine final identification
            if (identification.orderCustomerId) {
                identification.identifiedCustomerId = identification.orderCustomerId;
                identification.identificationMethod = 'order.customer_id';
            } else if (identification.tenderCustomerId) {
                identification.identifiedCustomerId = identification.tenderCustomerId;
                identification.identificationMethod = 'tender.customer_id';
            } else if (identification.loyaltyEventCustomerId) {
                identification.identifiedCustomerId = identification.loyaltyEventCustomerId;
                identification.identificationMethod = 'loyalty_event_order_id';
            }

            results.push(identification);
        }

        // Summary
        const identified = results.filter(r => r.identifiedCustomerId);
        const byMethod = {
            'order.customer_id': results.filter(r => r.identificationMethod === 'order.customer_id').length,
            'tender.customer_id': results.filter(r => r.identificationMethod === 'tender.customer_id').length,
            'loyalty_event_order_id': results.filter(r => r.identificationMethod === 'loyalty_event_order_id').length,
            'unidentified': results.filter(r => !r.identifiedCustomerId).length
        };

        // Build sanitized response - mask customer IDs for security
        const sanitizedOrders = results.map(r => ({
            orderId: r.orderId,
            createdAt: r.createdAt,
            totalAmount: r.totalMoney?.amount ? `${(r.totalMoney.amount / 100).toFixed(2)} ${r.totalMoney.currency}` : null,
            paymentMethod: r.tenders?.[0]?.type || 'unknown',
            identified: !!r.identifiedCustomerId,
            identificationMethod: r.identificationMethod,
            customerId: maskId(r.identifiedCustomerId)  // Masked for security
        }));

        res.json({
            title: 'Customer Identification Test',
            description: 'Verifies loyalty tracking works for cash sales with points sign-in',
            timeWindow: `Last ${minutes} minutes`,
            scopeStatus: missingScopes.length === 0 ? 'OK' : `Missing: ${missingScopes.join(', ')}`,
            summary: {
                totalOrders: results.length,
                identifiedOrders: identified.length,
                identificationRate: results.length > 0
                    ? `${Math.round(identified.length / results.length * 100)}%`
                    : 'N/A',
                byMethod
            },
            orders: sanitizedOrders
        });

    } catch (error) {
        logger.error('Error in customer identification debug', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/manual-entry
 * Manually record a loyalty purchase for orders where customer wasn't attached
 * Used to backfill purchases that couldn't be auto-detected
 */
app.post('/api/loyalty/manual-entry', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { squareOrderId, squareCustomerId, variationId, quantity, purchasedAt } = req.body;

        if (!squareOrderId || !squareCustomerId || !variationId) {
            return res.status(400).json({
                error: 'Missing required fields: squareOrderId, squareCustomerId, variationId'
            });
        }

        const qty = parseInt(quantity) || 1;

        logger.info('Manual loyalty entry', {
            merchantId,
            squareOrderId,
            squareCustomerId,
            variationId,
            quantity: qty
        });

        // Process the purchase using the loyalty service
        const result = await loyaltyService.processQualifyingPurchase({
            merchantId,
            squareOrderId,
            squareCustomerId,
            variationId,
            quantity: qty,
            unitPriceCents: 0,  // Unknown for manual entry
            purchasedAt: purchasedAt || new Date(),
            squareLocationId: null,
            customerSource: 'manual'
        });

        if (!result.processed) {
            return res.status(400).json({
                success: false,
                reason: result.reason,
                message: result.reason === 'variation_not_qualifying'
                    ? 'This variation is not configured as a qualifying item for any loyalty offer'
                    : result.reason === 'already_processed'
                    ? 'This purchase has already been recorded'
                    : 'Could not process this purchase'
            });
        }

        res.json({
            success: true,
            purchaseEvent: result.purchaseEvent,
            reward: result.reward,
            message: `Recorded ${qty} purchase(s). Progress: ${result.reward.currentQuantity}/${result.reward.requiredQuantity}`
        });

    } catch (error) {
        logger.error('Error in manual loyalty entry', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/process-expired
 * Process expired window entries (run periodically or on-demand)
 * This removes purchases outside the rolling window AND processes expired earned rewards
 */
app.post('/api/loyalty/process-expired', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Process expired window entries (purchases that aged out)
        const windowResult = await loyaltyService.processExpiredWindowEntries(merchantId);

        // Also process expired earned rewards (earned rewards with all expired purchases)
        const earnedResult = await loyaltyService.processExpiredEarnedRewards(merchantId);

        logger.info('Processed expired loyalty entries', {
            merchantId,
            windowEntriesProcessed: windowResult.processedCount,
            earnedRewardsRevoked: earnedResult.processedCount
        });

        res.json({
            windowEntries: windowResult,
            expiredEarnedRewards: earnedResult
        });
    } catch (error) {
        logger.error('Error processing expired entries', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/discounts/validate
 * Validate earned rewards discounts against Square
 * Returns list of issues found (missing discounts, deleted discounts, etc.)
 */
app.get('/api/loyalty/discounts/validate', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await loyaltyService.validateEarnedRewardsDiscounts({
            merchantId,
            fixIssues: false
        });

        res.json(result);
    } catch (error) {
        logger.error('Error validating discounts', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/loyalty/discounts/validate-and-fix
 * Validate earned rewards discounts and fix any issues found
 * Recreates missing/deleted discounts and re-adds customers to groups
 */
app.post('/api/loyalty/discounts/validate-and-fix', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const result = await loyaltyService.validateEarnedRewardsDiscounts({
            merchantId,
            fixIssues: true
        });

        logger.info('Validated and fixed discount issues', {
            merchantId,
            totalEarned: result.totalEarned,
            validated: result.validated,
            issues: result.issues.length,
            fixed: result.fixed.length
        });

        res.json(result);
    } catch (error) {
        logger.error('Error validating and fixing discounts', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/settings
 * Get loyalty settings for the merchant
 */
app.get('/api/loyalty/settings', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;

        // Ensure default settings exist
        await loyaltyService.initializeDefaultSettings(merchantId);

        const result = await db.query(`
            SELECT setting_key, setting_value, description
            FROM loyalty_settings
            WHERE merchant_id = $1
        `, [merchantId]);

        const settings = result.rows.reduce((acc, row) => {
            acc[row.setting_key] = row.setting_value;
            return acc;
        }, {});

        res.json({ settings });
    } catch (error) {
        logger.error('Error fetching loyalty settings', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/loyalty/settings
 * Update loyalty settings
 */
app.put('/api/loyalty/settings', requireAuth, requireMerchant, requireWriteAccess, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const updates = req.body;

        for (const [key, value] of Object.entries(updates)) {
            await loyaltyService.updateSetting(key, String(value), merchantId);
        }

        logger.info('Updated loyalty settings', { merchantId, keys: Object.keys(updates) });

        res.json({ success: true });
    } catch (error) {
        logger.error('Error updating loyalty settings', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// ==================== LOYALTY REPORT EXPORTS ====================
// Vendor receipts and audit exports for reimbursement compliance
// This is a FIRST-CLASS FEATURE, not an afterthought

/**
 * GET /api/loyalty/reports/vendor-receipt/:redemptionId
 * Generate vendor receipt for a specific redemption (HTML/PDF)
 */
app.get('/api/loyalty/reports/vendor-receipt/:redemptionId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { format = 'html' } = req.query;

        const receipt = await loyaltyReports.generateVendorReceipt(req.params.redemptionId, merchantId);

        if (format === 'html') {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('Content-Disposition', `inline; filename="${receipt.filename}"`);
            return res.send(receipt.html);
        }

        // Return data for client-side PDF generation or other processing
        res.json({
            html: receipt.html,
            data: receipt.data,
            filename: receipt.filename
        });
    } catch (error) {
        logger.error('Error generating vendor receipt', { error: error.message });
        if (error.message === 'Redemption not found') {
            return res.status(404).json({ error: 'Redemption not found' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/reports/redemptions/csv
 * Export redemptions as CSV
 */
app.get('/api/loyalty/reports/redemptions/csv', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { startDate, endDate, offerId, brandName } = req.query;

        const result = await loyaltyReports.generateRedemptionsCSV(merchantId, {
            startDate,
            endDate,
            offerId,
            brandName
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.csv);
    } catch (error) {
        logger.error('Error generating redemptions CSV', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/reports/audit/csv
 * Export detailed audit log as CSV
 */
app.get('/api/loyalty/reports/audit/csv', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { startDate, endDate, offerId, squareCustomerId } = req.query;

        const result = await loyaltyReports.generateAuditCSV(merchantId, {
            startDate,
            endDate,
            offerId,
            squareCustomerId
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.csv);
    } catch (error) {
        logger.error('Error generating audit CSV', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/reports/summary/csv
 * Export summary by brand/offer as CSV
 */
app.get('/api/loyalty/reports/summary/csv', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { startDate, endDate } = req.query;

        const result = await loyaltyReports.generateSummaryCSV(merchantId, {
            startDate,
            endDate
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.csv);
    } catch (error) {
        logger.error('Error generating summary CSV', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/reports/customers/csv
 * Export customer activity as CSV
 */
app.get('/api/loyalty/reports/customers/csv', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const { offerId, minPurchases } = req.query;

        const result = await loyaltyReports.generateCustomerActivityCSV(merchantId, {
            offerId,
            minPurchases: minPurchases ? parseInt(minPurchases) : 1
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.csv);
    } catch (error) {
        logger.error('Error generating customers CSV', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/loyalty/reports/redemption/:redemptionId
 * Get full redemption details with all contributing transactions
 */
app.get('/api/loyalty/reports/redemption/:redemptionId', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const details = await loyaltyReports.getRedemptionDetails(req.params.redemptionId, merchantId);

        if (!details) {
            return res.status(404).json({ error: 'Redemption not found' });
        }

        res.json({ redemption: details });
    } catch (error) {
        logger.error('Error fetching redemption details', { error: error.message });
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

        // NOTE: Legacy backfill code removed (2026-01-05)
        // The startup backfill for NULL merchant_id and orphan user linking has been removed.
        // Multi-tenant migration is complete. Records without merchant_id will fail as expected.

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
        cronTasks.push(cron.schedule(cronSchedule, async () => {
            logger.info('Running scheduled daily batch generation for all merchants');
            try {
                // Get all active merchants
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL');
                const merchants = merchantsResult.rows;

                if (merchants.length === 0) {
                    logger.info('No merchants for batch generation');
                    return;
                }

                const results = [];
                for (const merchant of merchants) {
                    try {
                        const result = await generateDailyBatch(merchant.id);
                        results.push({ merchantId: merchant.id, businessName: merchant.business_name, ...result });
                        logger.info('Batch generation completed for merchant', { merchantId: merchant.id, businessName: merchant.business_name, ...result });
                    } catch (merchantError) {
                        logger.error('Batch generation failed for merchant', { merchantId: merchant.id, businessName: merchant.business_name, error: merchantError.message });
                        results.push({ merchantId: merchant.id, businessName: merchant.business_name, error: merchantError.message });
                    }
                }

                logger.info('Scheduled batch generation completed for all merchants', { merchantCount: merchants.length, results });
            } catch (error) {
                logger.error('Scheduled batch generation failed', { error: error.message });
                await emailNotifier.sendAlert(
                    'Cycle Count Batch Generation Failed',
                    `Failed to generate daily cycle count batch:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        }));

        logger.info('Cycle count cron job scheduled', { schedule: cronSchedule });

        // Initialize automated database sync cron job
        // Runs hourly by default (configurable via SYNC_CRON_SCHEDULE)
        // Iterates over all merchants and syncs each one
        const syncCronSchedule = process.env.SYNC_CRON_SCHEDULE || '0 * * * *';
        cronTasks.push(cron.schedule(syncCronSchedule, async () => {
            logger.info('Running scheduled smart sync for all merchants');
            try {
                // Get all active merchants
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL');
                const merchants = merchantsResult.rows;

                if (merchants.length === 0) {
                    logger.info('No merchants to sync');
                    return;
                }

                const allErrors = [];
                const gmcSyncInterval = process.env.GMC_SYNC_INTERVAL_HOURS ? parseInt(process.env.GMC_SYNC_INTERVAL_HOURS) : null;

                for (const merchant of merchants) {
                    try {
                        logger.info('Running smart sync for merchant', { merchantId: merchant.id, businessName: merchant.business_name });
                        const result = await runSmartSync({ merchantId: merchant.id });
                        logger.info('Scheduled smart sync completed for merchant', {
                            merchantId: merchant.id,
                            synced: result.synced,
                            skipped: Object.keys(result.skipped).length,
                            errors: result.errors?.length || 0
                        });

                        if (result.errors && result.errors.length > 0) {
                            allErrors.push({ merchantId: merchant.id, businessName: merchant.business_name, errors: result.errors });
                        }

                        // GMC Product Sync - push to Google Merchant Center if configured
                        if (gmcSyncInterval) {
                            try {
                                const gmcSyncNeeded = await isSyncNeeded('gmc_product_catalog', gmcSyncInterval, merchant.id);
                                if (gmcSyncNeeded.needed) {
                                    logger.info('Running scheduled GMC product sync for merchant', { merchantId: merchant.id });
                                    const gmcResult = await gmcApi.syncProductCatalog(merchant.id);
                                    logger.info('Scheduled GMC product sync completed', {
                                        merchantId: merchant.id,
                                        total: gmcResult.total,
                                        synced: gmcResult.synced,
                                        failed: gmcResult.failed
                                    });
                                } else {
                                    logger.debug('GMC sync not needed yet', { merchantId: merchant.id, nextDue: gmcSyncNeeded.nextDue });
                                }
                            } catch (gmcError) {
                                logger.error('Scheduled GMC sync failed for merchant', { merchantId: merchant.id, error: gmcError.message });
                                allErrors.push({ merchantId: merchant.id, businessName: merchant.business_name, errors: [{ type: 'gmc_sync', error: gmcError.message }] });
                            }
                        }
                    } catch (error) {
                        logger.error('Smart sync failed for merchant', { merchantId: merchant.id, error: error.message });
                        allErrors.push({ merchantId: merchant.id, businessName: merchant.business_name, errors: [{ type: 'general', error: error.message }] });
                    }
                }

                // Send alert if there were errors for any merchant
                if (allErrors.length > 0) {
                    const errorDetails = allErrors.map(m =>
                        `Merchant ${m.businessName} (${m.merchantId}):\n${m.errors.map(e => `  - ${e.type}: ${e.error}`).join('\n')}`
                    ).join('\n\n');
                    await emailNotifier.sendAlert(
                        'Database Sync Partial Failure',
                        `Some sync operations failed:\n\n${errorDetails}`
                    );
                }
            } catch (error) {
                logger.error('Scheduled smart sync failed', { error: error.message });
                await emailNotifier.sendAlert(
                    'Database Sync Failed',
                    `Failed to run scheduled database sync:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        }));

        logger.info('Database sync cron job scheduled', { schedule: syncCronSchedule });

        // Initialize automated weekly database backup cron job
        // Runs every Sunday at 2:00 AM by default (configurable via BACKUP_CRON_SCHEDULE)
        const backupCronSchedule = process.env.BACKUP_CRON_SCHEDULE || '0 2 * * 0';
        cronTasks.push(cron.schedule(backupCronSchedule, async () => {
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
        }));

        logger.info('Database backup cron job scheduled', { schedule: backupCronSchedule });

        // Initialize expiry discount automation cron job
        // Runs daily at 6:00 AM EST by default (configurable via database setting)
        const expiryCronSchedule = process.env.EXPIRY_DISCOUNT_CRON || '0 6 * * *';
        cronTasks.push(cron.schedule(expiryCronSchedule, async () => {
            logger.info('Running scheduled expiry discount automation');
            try {
                // Get all active merchants for multi-tenant automation
                const merchantsResult = await db.query(
                    'SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE'
                );
                const merchants = merchantsResult.rows;

                if (merchants.length === 0) {
                    logger.info('No active merchants for expiry discount automation');
                    return;
                }

                for (const merchant of merchants) {
                    const merchantId = merchant.id;
                    try {
                        // Check if automation is enabled for this merchant
                        const autoApplyEnabled = await expiryDiscount.getSetting('auto_apply_enabled', merchantId);
                        if (autoApplyEnabled !== 'true') {
                            logger.info('Expiry discount automation is disabled for merchant, skipping', { merchantId, businessName: merchant.business_name });
                            continue;
                        }

                        const result = await expiryDiscount.runExpiryDiscountAutomation({ merchantId, dryRun: false });

                        logger.info('Scheduled expiry discount automation completed for merchant', {
                            merchantId,
                            businessName: merchant.business_name,
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
                            const emailEnabled = await expiryDiscount.getSetting('email_notifications', merchantId);
                            if (emailEnabled === 'true') {
                                try {
                                    let emailBody = `Expiry Discount Automation Report\n\n`;
                                    emailBody += `Merchant: ${merchant.business_name}\n`;
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
                                        `Expiry Discount Report - ${merchant.business_name} - ${tierChanges + newAssignments} Changes`,
                                        emailBody
                                    );
                                } catch (emailError) {
                                    logger.error('Failed to send expiry discount automation email', { merchantId, error: emailError.message });
                                }
                            }
                        }
                    } catch (merchantError) {
                        logger.error('Scheduled expiry discount automation failed for merchant', { merchantId, businessName: merchant.business_name, error: merchantError.message });
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
        }));

        logger.info('Expiry discount cron job scheduled', { schedule: expiryCronSchedule, timezone: 'America/Toronto' });

        // Startup check: Generate today's batch if it doesn't exist yet for each merchant
        // This handles cases where server was offline during scheduled cron time
        (async () => {
            try {
                // Get all active merchants
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL');
                const merchants = merchantsResult.rows;

                if (merchants.length === 0) {
                    logger.info('No merchants for startup batch check');
                    return;
                }

                for (const merchant of merchants) {
                    try {
                        // Check if any items have been added to today's batch for this merchant
                        const batchCheck = await db.query(`
                            SELECT COUNT(*) as count
                            FROM count_queue_daily
                            WHERE batch_date = CURRENT_DATE AND merchant_id = $1
                        `, [merchant.id]);

                        const todaysBatchCount = parseInt(batchCheck.rows[0]?.count || 0);

                        if (todaysBatchCount === 0) {
                            logger.info('No batch found for today - generating startup batch', { merchantId: merchant.id, businessName: merchant.business_name });
                            const result = await generateDailyBatch(merchant.id);
                            logger.info('Startup batch generation completed', { merchantId: merchant.id, businessName: merchant.business_name, ...result });
                        } else {
                            logger.info('Today\'s batch already exists', { merchantId: merchant.id, businessName: merchant.business_name, items_count: todaysBatchCount });
                        }
                    } catch (merchantError) {
                        logger.error('Startup batch check failed for merchant', { merchantId: merchant.id, businessName: merchant.business_name, error: merchantError.message });
                    }
                }
            } catch (error) {
                logger.error('Startup batch check failed', { error: error.message });
            }
        })();

        // Startup check: Run smart sync if data is stale
        // This handles cases where server was offline during scheduled sync time
        (async () => {
            try {
                logger.info('Checking for stale data on startup for all merchants');

                // Get all active merchants
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL');
                const merchants = merchantsResult.rows;

                if (merchants.length === 0) {
                    logger.info('No merchants to check on startup');
                    return;
                }

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

                const allErrors = [];
                for (const merchant of merchants) {
                    try {
                        // Check if any sync type is stale for this merchant
                        let needsSync = false;
                        const staleTypes = [];

                        for (const [syncType, intervalHours] of Object.entries(intervals)) {
                            const check = await isSyncNeeded(syncType, intervalHours, merchant.id);
                            if (check.needed) {
                                needsSync = true;
                                staleTypes.push(syncType);
                            }
                        }

                        if (needsSync) {
                            logger.info('Stale data detected on startup for merchant - running smart sync', {
                                merchantId: merchant.id,
                                businessName: merchant.business_name,
                                stale_types: staleTypes
                            });
                            const result = await runSmartSync({ merchantId: merchant.id });
                            logger.info('Startup smart sync completed for merchant', {
                                merchantId: merchant.id,
                                synced: result.synced,
                                skipped: Object.keys(result.skipped).length,
                                errors: result.errors?.length || 0
                            });

                            if (result.errors && result.errors.length > 0) {
                                allErrors.push({ merchantId: merchant.id, businessName: merchant.business_name, errors: result.errors });
                            }
                        } else {
                            logger.info('All data is current for merchant - no sync needed on startup', {
                                merchantId: merchant.id,
                                businessName: merchant.business_name
                            });
                        }
                    } catch (error) {
                        logger.error('Startup sync failed for merchant', { merchantId: merchant.id, error: error.message });
                        allErrors.push({ merchantId: merchant.id, businessName: merchant.business_name, errors: [{ type: 'general', error: error.message }] });
                    }
                }

                // Send alert if there were errors for any merchant
                if (allErrors.length > 0) {
                    const errorDetails = allErrors.map(m =>
                        `Merchant ${m.businessName} (${m.merchantId}):\n${m.errors.map(e => `  - ${e.type}: ${e.error}`).join('\n')}`
                    ).join('\n\n');
                    await emailNotifier.sendAlert(
                        'Startup Database Sync Partial Failure',
                        `Some sync operations failed during startup:\n\n${errorDetails}`
                    );
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
async function gracefulShutdown(signal) {
    logger.info(`${signal} received, starting graceful shutdown`);

    // Set a force-exit timeout (10 seconds)
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, 10000);

    try {
        // Stop all cron jobs
        logger.info(`Stopping ${cronTasks.length} cron tasks`);
        cronTasks.forEach(task => {
            try {
                task.stop();
            } catch (e) {
                // Ignore errors stopping individual tasks
            }
        });

        // Close database connections
        logger.info('Closing database connections');
        await db.close();

        logger.info('Graceful shutdown complete');
        clearTimeout(forceExitTimeout);
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        clearTimeout(forceExitTimeout);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
startServer().catch(err => {
    console.error('FATAL: Server startup failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});

module.exports = app;
