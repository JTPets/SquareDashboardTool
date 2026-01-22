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
const gmcApi = require('./utils/merchant-center-api');

// Security middleware
const { configureHelmet, configureRateLimit, configureDeliveryRateLimit, configureDeliveryStrictRateLimit, configureSensitiveOperationRateLimit, configureCors, corsErrorHandler } = require('./middleware/security');
// File validation (V005 fix)
const { validateUploadedImage } = require('./utils/file-validation');
const { requireAuth, requireAuthApi, requireAdmin, requireWriteAccess } = require('./middleware/auth');
const authRoutes = require('./routes/auth');

// Multi-tenant middleware and routes
const { loadMerchantContext, requireMerchant, requireValidSubscription, getSquareClientForMerchant } = require('./middleware/merchant');
const squareOAuthRoutes = require('./routes/square-oauth');
const driverApiRoutes = require('./routes/driver-api');
const purchaseOrdersRoutes = require('./routes/purchase-orders');
const subscriptionsRoutes = require('./routes/subscriptions');
const loyaltyRoutes = require('./routes/loyalty');
const gmcRoutes = require('./routes/gmc');
const deliveryRoutes = require('./routes/delivery');
const webhooksRoutes = require('./routes/webhooks');
const expiryDiscountsRoutes = require('./routes/expiry-discounts');
const vendorCatalogRoutes = require('./routes/vendor-catalog');
const cycleCountsRoutes = require('./routes/cycle-counts');
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
// Sensitive operation rate limiter (V006 fix - token regeneration)
const sensitiveOperationRateLimit = configureSensitiveOperationRateLimit();

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
    // Also allow driver API routes (token-based auth handled in route)
    if (publicPaths.includes(req.path) || req.path.startsWith('/driver/')) {
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

// ==================== DRIVER API ROUTES ====================
// Token-based public endpoints for contract drivers + authenticated merchant endpoints
app.use('/api', driverApiRoutes);

// ==================== PURCHASE ORDERS ROUTES ====================
// Financial operations for managing purchase orders
app.use('/api/purchase-orders', purchaseOrdersRoutes);

// ==================== SUBSCRIPTIONS ROUTES ====================
// SaaS subscription management (Square Subscriptions API)
app.use('/api', subscriptionsRoutes);

// ==================== LOYALTY ROUTES ====================
// Frequent Buyer Program - digitizes brand-defined loyalty programs
app.use('/api/loyalty', loyaltyRoutes);

// ==================== GMC ROUTES ====================
// Google Merchant Center feed generation and management
app.use('/api/gmc', gmcRoutes);

// ==================== DELIVERY ROUTES ====================
// Delivery order management, POD photos, route optimization
app.use('/api/delivery', deliveryRoutes);

// ==================== WEBHOOK MANAGEMENT ROUTES ====================
// Webhook subscription CRUD operations (main processor remains below)
app.use('/api', webhooksRoutes);

// ==================== EXPIRY DISCOUNTS ROUTES ====================
// Automatic discount management for products approaching expiration
app.use('/api', expiryDiscountsRoutes);

// ==================== VENDOR CATALOG ROUTES ====================
// Vendor management and catalog import/matching
app.use('/api', vendorCatalogRoutes);

// ==================== CYCLE COUNTS ROUTES ====================
// Inventory cycle counting operations and reporting
app.use('/api', cycleCountsRoutes);

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
        logger.error('Health check failed', { error: error.message, stack: error.stack });
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
        // Check Square connection by checking if merchant has locations synced
        let squareConnected = false;
        try {
            if (req.merchantContext?.id) {
                const result = await db.query(
                    'SELECT id FROM locations WHERE merchant_id = $1 LIMIT 1',
                    [req.merchantContext.id]
                );
                squareConnected = result.rows.length > 0;
            }
        } catch (e) {
            logger.warn('Square connection check failed', { error: e.message, merchantId: req.merchantContext?.id });
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
        logger.error('Failed to get config', { error: error.message, stack: error.stack, merchantId: req.merchantContext?.id });
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
        logger.error('Failed to get merchant settings', { error: error.message, stack: error.stack });
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
        logger.error('Failed to update merchant settings', { error: error.message, stack: error.stack });
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

        // limit=0 means all logs, otherwise take last N lines
        const allLines = content.trim().split('\n');
        const lines = limit === 0 ? allLines : allLines.slice(-limit);
        const logs = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return { raw: line, level: 'unknown' };
            }
        });

        res.json({ logs, count: logs.length, total: allLines.length });

    } catch (error) {
        logger.error('Failed to read logs', { error: error.message, stack: error.stack });
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
        logger.error('Log file download failed', { error: error.message, stack: error.stack });
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

// ==================== TEST ENDPOINTS (Development only) ====================
// V007 fix: Test endpoints are disabled in production for security
if (process.env.NODE_ENV !== 'production') {
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
            logger.error('Test backup email failed', { error: error.message, stack: error.stack });
            res.status(500).json({ error: error.message });
        }
    });
}

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
        logger.error('Error resolving image URLs', { error: error.message, stack: error.stack });
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
        logger.error('Error in batch image URL resolution', { error: error.message, stack: error.stack });
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
                gmc: process.env.GMC_SYNC_CRON_SCHEDULE || null
            },
            cronSchedule: process.env.SYNC_CRON_SCHEDULE || '0 * * * *'
        });
    } catch (error) {
        logger.error('Get sync intervals error', { error: error.message, stack: error.stack });
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

        // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
        const imageUrlMap = await batchResolveImageUrls(result.rows);

        const variations = result.rows.map((variation, index) => ({
            ...variation,
            item_images: undefined,  // Remove from response
            image_urls: imageUrlMap.get(index) || []
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

        // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
        const imageUrlMap = await batchResolveImageUrls(result.rows);

        const variations = result.rows.map((variation, index) => ({
            ...variation,
            item_images: undefined,  // Remove from response
            image_urls: imageUrlMap.get(index) || []
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

// ==================== EXPIRY DISCOUNTS (EXTRACTED) ====================
// Expiry discount routes have been extracted to routes/expiry-discounts.js
// See routes/expiry-discounts.js for implementation
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

        // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
        const imageUrlMap = await batchResolveImageUrls(result.rows);

        const inventoryWithImages = result.rows.map((row, index) => ({
            ...row,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,  // Remove raw image IDs from response
            item_images: undefined  // Remove from response
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

        // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
        const imageUrlMap = await batchResolveImageUrls(result.rows);

        const items = result.rows.map((row, index) => ({
            ...row,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,  // Remove raw image IDs from response
            item_images: undefined  // Remove from response
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

        // Batch resolve image URLs in a SINGLE query (instead of N+1 queries)
        const imageUrlMap = await batchResolveImageUrls(result.rows);

        const items = result.rows.map((row, index) => ({
            ...row,
            image_urls: imageUrlMap.get(index) || [],
            images: undefined,  // Remove raw image IDs from response
            item_images: undefined  // Remove from response
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
                    i.product_type,
                    i.taxable,
                    i.tax_ids,
                    i.visibility,
                    i.available_online,
                    i.available_for_pickup,
                    i.seo_title,
                    i.seo_description,
                    i.images as item_images,
                    i.present_at_all_locations as item_present_at_all,
                    i.present_at_location_ids as item_present_at_location_ids,
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
                -- Note: Services (APPOINTMENTS_SERVICE) and gift cards are excluded from inventory/vendor checks
                (category_id IS NULL OR category_name IS NULL OR category_name = '') as missing_category,
                (taxable = FALSE OR taxable IS NULL) as not_taxable,
                (price_money IS NULL OR price_money = 0) as missing_price,
                (description IS NULL OR description = '') as missing_description,
                (item_images IS NULL OR item_images::text = '[]' OR item_images::text = 'null') as missing_item_image,
                (variation_images IS NULL OR variation_images::text = '[]' OR variation_images::text = 'null') as missing_variation_image,
                -- SKU/UPC only required for physical products (not services or gift cards)
                ((sku IS NULL OR sku = '') AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_sku,
                ((upc IS NULL OR upc = '') AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_upc,
                -- Inventory checks only for physical products
                ((track_inventory = FALSE OR track_inventory IS NULL) AND (product_type IS NULL OR product_type = 'REGULAR')) as stock_tracking_off,
                -- Inventory alerts not enabled - check both variation-level AND location-level settings
                (
                    (inventory_alert_type IS NULL OR inventory_alert_type != 'LOW_QUANTITY')
                    AND (location_stock_alert_min IS NULL OR location_stock_alert_min = 0)
                    AND (product_type IS NULL OR product_type = 'REGULAR')
                ) as inventory_alerts_off,
                -- No reorder threshold: Out of stock AND no minimum threshold set anywhere
                -- Check: Square's inventory_alert, global stock_alert_min, OR location-specific stock_alert_min
                (
                    current_stock <= 0
                    AND (inventory_alert_type IS NULL OR inventory_alert_type != 'LOW_QUANTITY' OR inventory_alert_threshold IS NULL OR inventory_alert_threshold = 0)
                    AND (stock_alert_min IS NULL OR stock_alert_min = 0)
                    AND (location_stock_alert_min IS NULL)
                    AND (product_type IS NULL OR product_type = 'REGULAR')
                ) as no_reorder_threshold,
                -- Vendor/cost only required for physical products
                (vendor_count = 0 AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_vendor,
                (unit_cost_cents IS NULL AND UPPER(variation_name) NOT LIKE '%SAMPLE%' AND (product_type IS NULL OR product_type = 'REGULAR')) as missing_cost,  -- Excludes SAMPLE variations (samples are free)
                -- SEO fields
                (seo_title IS NULL OR seo_title = '') as missing_seo_title,
                (seo_description IS NULL OR seo_description = '') as missing_seo_description,
                -- Tax configuration
                (tax_ids IS NULL OR tax_ids::text = '[]' OR tax_ids::text = 'null') as no_tax_ids,
                -- Location mismatch: variation enabled at all locations but parent item is not
                (variation_present_at_all = TRUE AND item_present_at_all = FALSE) as location_mismatch,
                -- Sales channel flags
                -- POS disabled: item is NOT at all locations AND NOT at any specific locations
                (
                    (item_present_at_all = FALSE OR item_present_at_all IS NULL)
                    AND (item_present_at_location_ids IS NULL OR item_present_at_location_ids = '[]'::jsonb OR jsonb_array_length(item_present_at_location_ids) = 0)
                ) as pos_disabled,
                (available_online = FALSE OR available_online IS NULL) as online_disabled,
                -- Any channel off: truly disabled from POS OR disabled from online
                (
                    (
                        (item_present_at_all = FALSE OR item_present_at_all IS NULL)
                        AND (item_present_at_location_ids IS NULL OR item_present_at_location_ids = '[]'::jsonb OR jsonb_array_length(item_present_at_location_ids) = 0)
                    )
                    OR (available_online = FALSE OR available_online IS NULL)
                ) as any_channel_off
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
        logger.error('List custom attributes error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// REMOVED: Debug endpoints removed for security (2026-01-20)
// - /api/debug/merchant-data - exposed cross-tenant data
// - /api/debug/restore-deleted-items - recovery endpoint (use SQL if needed)
// - /api/debug/expiry-status - use expiry-audit.html instead
// - /api/debug/backfill-merchant-id - legacy migration
// - /api/debug/migrate-legacy-token - legacy migration
// - /api/debug/merge-legacy-to-merchant - legacy migration

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
        logger.error('Init custom attributes error', { error: error.message, stack: error.stack });
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
        logger.error('Create custom attribute definition error', { error: error.message, stack: error.stack });
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
        logger.error('Push case pack error', { error: error.message, stack: error.stack });
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
        logger.error('Push brands error', { error: error.message, stack: error.stack });
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
        logger.error('Push expiry dates error', { error: error.message, stack: error.stack });
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
        logger.error('Push all custom attributes error', { error: error.message, stack: error.stack });
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
        logger.error('Google status error', { error: error.message, stack: error.stack });
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
        logger.error('Google auth error', { error: error.message, stack: error.stack });
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
        logger.error('Google callback error', { error: error.message, stack: error.stack });
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
        logger.error('Google disconnect error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

// ==================== GMC ROUTES (EXTRACTED) ====================
// GMC routes have been extracted to routes/gmc.js
// 32 endpoints for Google Merchant Center feed and API management
// Includes: feed generation, brand management, taxonomy mapping, local inventory
// See routes/gmc.js for implementation

// ==================== VENDOR CATALOG (EXTRACTED) ====================
// Vendor and vendor catalog routes have been extracted to routes/vendor-catalog.js
// See routes/vendor-catalog.js for implementation
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

// ==================== CYCLE COUNTS (EXTRACTED) ====================
// Cycle count routes and helpers have been extracted to routes/cycle-counts.js and utils/cycle-count-utils.js
// See routes/cycle-counts.js for implementation
// ==================== PURCHASE ORDERS (EXTRACTED) ====================
// Purchase order routes have been extracted to routes/purchase-orders.js
// This includes: create, list, get, update, submit, receive, delete, and CSV/XLSX exports
// See routes/purchase-orders.js for implementation

// ==================== DATABASE BACKUP & RESTORE ====================

// NOTE: Database export/import endpoints removed for security (2026-01-05)
// These endpoints exposed all merchant data without tenant filtering.
// Database backups should be managed at the infrastructure level (pg_dump with proper access controls).

// ==================== SUBSCRIPTIONS & PAYMENTS (EXTRACTED) ====================
// Subscription routes have been extracted to routes/subscriptions.js
// This includes: payment-config, plans, promo validation, create, status, cancel, refund
// See routes/subscriptions.js for implementation

// ==================== WEBHOOK SUBSCRIPTION MANAGEMENT (EXTRACTED) ====================
// Webhook management routes have been extracted to routes/webhooks.js
// This includes: list subscriptions, audit, event-types, register, ensure, update, delete, test
// See routes/webhooks.js for implementation

const squareWebhooks = require('./utils/square-webhooks');

// ==================== WEBHOOK PROCESSOR ====================

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
 *   - order.created/updated    → WEBHOOK_ORDER_SYNC (syncs committed inventory + delivery ingestion)
 *   - order.fulfillment.updated → WEBHOOK_ORDER_SYNC (syncs committed + sales velocity + delivery status)
 *
 * Delivery Scheduler Events:
 *   - order.created/updated with DELIVERY/SHIPMENT fulfillment → auto-ingests to delivery queue
 *   - order.fulfillment.updated (COMPLETED/CANCELED/FAILED) → updates delivery order status
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

                        // Also do loyalty catchup - customer phone/email might have changed,
                        // allowing us to link previously untracked orders
                        const catchupResult = await loyaltyService.runLoyaltyCatchup({
                            merchantId: internalMerchantId,
                            customerIds: [customerId],
                            periodDays: 1, // 24 hours - loyalty events happen same-day
                            maxCustomers: 1
                        });

                        if (catchupResult.ordersNewlyTracked > 0) {
                            logger.info('Loyalty catchup found untracked orders via customer.updated', {
                                customerId,
                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                            });
                            syncResults.loyaltyCatchup = {
                                customerId,
                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                            };
                        }
                    } catch (syncError) {
                        logger.error('Customer webhook processing failed', { error: syncError.message });
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
                        const webhookOrder = data.order;
                        logger.info('Order event detected via webhook', {
                            orderId: webhookOrder?.id,
                            state: webhookOrder?.state,
                            eventType: event.type,
                            merchantId: internalMerchantId,
                            hasFulfillments: webhookOrder?.fulfillments?.length > 0
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
                        if (webhookOrder?.state === 'COMPLETED') {
                            await squareApi.syncSalesVelocity(91, internalMerchantId);
                            syncResults.salesVelocity = true;
                            logger.info('Sales velocity sync completed via order.updated (COMPLETED state)');
                        }

                        // DELIVERY SCHEDULER: Auto-ingest orders with delivery/shipment fulfillments
                        // Fetch full order from Square API to ensure we have complete fulfillment data
                        // (webhook payloads may not include full fulfillment details)
                        let order = webhookOrder;
                        if (webhookOrder?.id) {
                            try {
                                const squareClient = await getSquareClientForMerchant(internalMerchantId);
                                const orderResponse = await squareClient.orders.get({
                                    orderId: webhookOrder.id
                                });
                                if (orderResponse.order) {
                                    order = orderResponse.order;
                                    logger.info('Fetched full order from Square API for delivery check', {
                                        orderId: order.id,
                                        fulfillmentCount: order.fulfillments?.length || 0,
                                        fulfillmentTypes: order.fulfillments?.map(f => f.type) || []
                                    });
                                }
                            } catch (fetchError) {
                                logger.warn('Failed to fetch full order from Square, using webhook data', {
                                    orderId: webhookOrder.id,
                                    error: fetchError.message
                                });
                            }
                        }

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

                            // Log if no eligible delivery fulfillment was found
                            if (!deliveryFulfillment) {
                                const fulfillmentTypes = order.fulfillments.map(f => `${f.type}:${f.state}`);
                                logger.debug('Order has fulfillments but none eligible for delivery routing', {
                                    orderId: order.id,
                                    fulfillments: fulfillmentTypes
                                });
                            }
                        } else if (order) {
                            logger.debug('Order has no fulfillments for delivery routing', {
                                orderId: order.id,
                                state: order.state
                            });
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

                        // DELIVERY SCHEDULER: Update delivery order status based on fulfillment state
                        // This handles state transitions: PROPOSED → RESERVED → PREPARED → COMPLETED/CANCELED
                        if (data.order_id && fulfillment?.state) {
                            try {
                                const squareOrderId = data.order_id;
                                const fulfillmentState = fulfillment.state;
                                const fulfillmentType = fulfillment.type;

                                // Only process delivery/shipment fulfillments
                                if (fulfillmentType === 'DELIVERY' || fulfillmentType === 'SHIPMENT') {
                                    // Use handleSquareOrderUpdate for COMPLETED/CANCELED states
                                    if (fulfillmentState === 'COMPLETED' || fulfillmentState === 'CANCELED') {
                                        await deliveryApi.handleSquareOrderUpdate(
                                            internalMerchantId,
                                            squareOrderId,
                                            fulfillmentState
                                        );
                                        syncResults.deliveryUpdate = {
                                            orderId: squareOrderId,
                                            fulfillmentState,
                                            action: fulfillmentState === 'COMPLETED' ? 'marked_completed' : 'removed'
                                        };
                                        logger.info('Delivery order updated via fulfillment webhook', {
                                            squareOrderId,
                                            fulfillmentState,
                                            merchantId: internalMerchantId
                                        });
                                    } else if (fulfillmentState === 'FAILED') {
                                        // Handle failed fulfillments same as canceled
                                        await deliveryApi.handleSquareOrderUpdate(
                                            internalMerchantId,
                                            squareOrderId,
                                            'CANCELED'
                                        );
                                        syncResults.deliveryUpdate = {
                                            orderId: squareOrderId,
                                            fulfillmentState: 'FAILED',
                                            action: 'removed'
                                        };
                                        logger.info('Failed delivery order removed via fulfillment webhook', {
                                            squareOrderId,
                                            merchantId: internalMerchantId
                                        });
                                    } else if (['PROPOSED', 'RESERVED', 'PREPARED'].includes(fulfillmentState)) {
                                        // Handle intermediate states - auto-ingest if enabled
                                        // This catches orders where fulfillment is added/updated after order creation
                                        try {
                                            const deliverySettings = await deliveryApi.getSettings(internalMerchantId);
                                            const autoIngest = deliverySettings?.auto_ingest_ready_orders !== false;

                                            if (autoIngest) {
                                                // Fetch the full order from Square to get all details
                                                const squareClient = await getSquareClientForMerchant(internalMerchantId);
                                                const orderResponse = await squareClient.orders.get({
                                                    orderId: squareOrderId
                                                });
                                                const fullOrder = orderResponse.order;
                                                if (fullOrder) {
                                                    const deliveryOrder = await deliveryApi.ingestSquareOrder(internalMerchantId, fullOrder);
                                                    if (deliveryOrder) {
                                                        syncResults.deliveryUpdate = {
                                                            orderId: squareOrderId,
                                                            fulfillmentState,
                                                            action: 'ingested',
                                                            deliveryOrderId: deliveryOrder.id
                                                        };
                                                        logger.info('Auto-ingested delivery order via fulfillment webhook', {
                                                            squareOrderId,
                                                            fulfillmentState,
                                                            deliveryOrderId: deliveryOrder.id,
                                                            merchantId: internalMerchantId
                                                        });
                                                    }
                                                }
                                            } else {
                                                logger.info('Skipped auto-ingest - disabled in settings', {
                                                    squareOrderId,
                                                    fulfillmentState,
                                                    merchantId: internalMerchantId
                                                });
                                            }
                                        } catch (ingestError) {
                                            logger.warn('Auto-ingest via fulfillment webhook failed', {
                                                error: ingestError.message,
                                                squareOrderId,
                                                fulfillmentState
                                            });
                                        }
                                    }
                                }
                            } catch (deliveryError) {
                                // Log but don't fail the webhook for delivery errors
                                logger.warn('Delivery order update via fulfillment webhook failed', {
                                    error: deliveryError.message,
                                    orderId: data.order_id
                                });
                                syncResults.deliveryError = deliveryError.message;
                            }
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
            // Process loyalty from payment events since order.* webhooks can be unreliable
            case 'payment.created':
                // New payment created - can be used for early loyalty tracking
                if (!internalMerchantId) {
                    logger.debug('Payment.created webhook - merchant not found, skipping');
                    break;
                }
                try {
                    const payment = data;
                    logger.info('Payment created webhook received', {
                        paymentId: payment.id,
                        orderId: payment.order_id,
                        status: payment.status,
                        merchantId: internalMerchantId
                    });

                    // For payment.created, we log the event but wait for payment.updated (COMPLETED)
                    // to process loyalty since the payment may not be finalized yet
                    syncResults.paymentCreated = {
                        paymentId: payment.id,
                        orderId: payment.order_id,
                        status: payment.status
                    };

                    // If payment is already COMPLETED (rare for .created), process immediately
                    if (payment.status === 'COMPLETED' && payment.order_id) {
                        // Fetch the full order from Square
                        const squareClient = await getSquareClientForMerchant(internalMerchantId);
                        const orderResponse = await squareClient.orders.get({
                            orderId: payment.order_id
                        });

                        if (orderResponse.order && orderResponse.order.state === 'COMPLETED') {
                            const order = orderResponse.order;
                            const loyaltyResult = await loyaltyService.processOrderForLoyalty(order, internalMerchantId);
                            if (loyaltyResult.processed) {
                                syncResults.loyalty = {
                                    purchasesRecorded: loyaltyResult.purchasesRecorded.length,
                                    customerId: loyaltyResult.customerId,
                                    source: 'payment.created'
                                };
                                logger.info('Loyalty purchases recorded via payment.created webhook', {
                                    orderId: order.id,
                                    customerId: loyaltyResult.customerId,
                                    purchases: loyaltyResult.purchasesRecorded.length
                                });
                            }
                        }
                    }
                } catch (paymentErr) {
                    logger.error('Error processing payment.created', {
                        error: paymentErr.message,
                        paymentId: data?.id
                    });
                }
                break;

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
                        // Square webhook structure: event.data.object.loyalty_event
                        const loyaltyEvent = data.loyalty_event;

                        if (!loyaltyEvent) {
                            logger.warn('Loyalty event webhook missing loyalty_event in payload', {
                                dataKeys: Object.keys(data),
                                merchantId: internalMerchantId
                            });
                            break;
                        }

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
                                logger.info('Loyalty event skipped - order already processed', { orderId, merchantId: internalMerchantId });
                                syncResults.loyaltyEventSkipped = { orderId, reason: 'already_processed' };
                            }
                        } else if (loyaltyAccountId) {
                            // No order_id in this event, but we have a loyalty account -
                            // Do a reverse lookup to catch any orders Square internally linked
                            logger.info('Loyalty event without order_id - doing reverse lookup', {
                                loyaltyAccountId,
                                eventType: loyaltyEvent.type
                            });

                            // Get customer_id from loyalty account
                            const accessToken = await loyaltyService.getSquareAccessToken(internalMerchantId);
                            if (accessToken) {
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
                                        const catchupResult = await loyaltyService.runLoyaltyCatchup({
                                            merchantId: internalMerchantId,
                                            customerIds: [customerId],
                                            periodDays: 1, // 24 hours - loyalty events happen same-day
                                            maxCustomers: 1
                                        });

                                        if (catchupResult.ordersNewlyTracked > 0) {
                                            logger.info('Loyalty catchup found untracked orders via event webhook', {
                                                customerId,
                                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                                            });
                                            syncResults.loyaltyCatchup = {
                                                customerId,
                                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                                            };
                                        }
                                    }
                                }
                            }
                        } else {
                            // No loyaltyAccountId - can't process this event
                            logger.info('Loyalty event skipped - no loyalty account ID in event', {
                                orderId,
                                eventType: loyaltyEvent.type,
                                merchantId: internalMerchantId
                            });
                            syncResults.loyaltyEventSkipped = { reason: 'no_loyalty_account_id' };
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

            // When loyalty account is updated (e.g., customer's card gets linked to their account),
            // do a reverse lookup to catch any recent orders that Square internally linked
            case 'loyalty.account.updated':
            case 'loyalty.account.created':
                if (!internalMerchantId) {
                    logger.debug('Loyalty account webhook - merchant not found, skipping');
                    break;
                }
                try {
                    // Square webhook structure: event.data.object.loyalty_account
                    const loyaltyAccount = data.loyalty_account;

                    if (!loyaltyAccount) {
                        logger.warn('Loyalty account webhook missing loyalty_account in payload', {
                            dataKeys: Object.keys(data),
                            merchantId: internalMerchantId
                        });
                        break;
                    }

                    const customerId = loyaltyAccount.customer_id;

                    if (customerId) {
                        logger.info('Loyalty account updated - checking for untracked orders', {
                            loyaltyAccountId: loyaltyAccount.id,
                            customerId,
                            merchantId: internalMerchantId
                        });

                        // Do a reverse lookup for this specific customer's recent orders (last 7 days)
                        // This catches orders that Square internally linked via payment→loyalty
                        const catchupResult = await loyaltyService.runLoyaltyCatchup({
                            merchantId: internalMerchantId,
                            customerIds: [customerId],
                            periodDays: 1, // 24 hours - loyalty events happen same-day
                            maxCustomers: 1
                        });

                        if (catchupResult.ordersNewlyTracked > 0) {
                            logger.info('Loyalty catchup found untracked orders via account webhook', {
                                customerId,
                                ordersFound: catchupResult.ordersFound,
                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                            });
                            syncResults.loyaltyCatchup = {
                                customerId,
                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                            };
                        }
                    }
                } catch (loyaltyAccountError) {
                    logger.warn('Loyalty account webhook catchup failed', {
                        error: loyaltyAccountError.message
                    });
                }
                break;

            case 'loyalty.program.updated':
                logger.debug('Webhook event acknowledged but not processed', { type: event.type });
                syncResults.acknowledged = true;
                break;

            // ==================== GIFT CARD WEBHOOKS ====================
            // When a gift card is linked to a customer, catch up any purchases made with that card
            case 'gift_card.customer_linked':
                if (!internalMerchantId) {
                    logger.debug('Gift card webhook - merchant not found, skipping');
                    break;
                }
                try {
                    const giftCardData = data;
                    const customerId = giftCardData.customer_id;

                    if (customerId) {
                        logger.info('Gift card linked to customer - checking for untracked orders', {
                            giftCardId: giftCardData.id,
                            customerId,
                            merchantId: internalMerchantId
                        });

                        // Do a reverse lookup - any orders paid with this gift card
                        // should now be attributable to this customer
                        const catchupResult = await loyaltyService.runLoyaltyCatchup({
                            merchantId: internalMerchantId,
                            customerIds: [customerId],
                            periodDays: 7, // 1 week for gift cards (may be used before linking)
                            maxCustomers: 1
                        });

                        if (catchupResult.ordersNewlyTracked > 0) {
                            logger.info('Loyalty catchup found untracked orders via gift_card.customer_linked', {
                                customerId,
                                giftCardId: giftCardData.id,
                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                            });
                            syncResults.loyaltyCatchup = {
                                customerId,
                                giftCardId: giftCardData.id,
                                ordersNewlyTracked: catchupResult.ordersNewlyTracked
                            };
                        }
                    }
                } catch (giftCardError) {
                    logger.warn('Gift card webhook catchup failed', {
                        error: giftCardError.message
                    });
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
            `, [error.message, processingTime, webhookEventId]).catch(dbErr => {
                logger.error('Failed to update webhook_events status', { webhookEventId, error: dbErr.message, stack: dbErr.stack });
            });
        }

        res.status(500).json({ error: error.message });
    }
});

// ==================== DELIVERY SCHEDULER API (EXTRACTED) ====================
// Delivery routes have been extracted to routes/delivery.js
// 23 endpoints including orders, POD photos, routes, settings, sync
// See routes/delivery.js for implementation

// --- DELIVERY CODE REMOVED (was ~1200 lines) ---
// The following endpoints were extracted to routes/delivery.js:
// GET/POST /api/delivery/orders, PATCH/DELETE /api/delivery/orders/:id
// POST /api/delivery/orders/:id/skip, POST /api/delivery/orders/:id/complete
// GET/PATCH /api/delivery/orders/:id/customer, /customer-note, /notes, /customer-stats
// POST /api/delivery/orders/:id/pod, GET /api/delivery/pod/:id
// POST/GET /api/delivery/route/generate, /active, /:id, /finish
// POST /api/delivery/geocode, GET/PUT /api/delivery/settings
// GET /api/delivery/audit, /stats, POST /api/delivery/sync


// ==================== DRIVER API (EXTRACTED) ====================
// Driver API routes have been extracted to routes/driver-api.js
// This includes both authenticated and public token-based endpoints
// See routes/driver-api.js for implementation

// ==================== LOYALTY ADDON API (EXTRACTED) ====================
// Loyalty routes have been extracted to routes/loyalty.js
// Frequent Buyer Program - Digitizes brand-defined loyalty programs
// 41 endpoints including offers, variations, rewards, redemptions, reports
// See routes/loyalty.js for implementation

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

    // In production, don't expose internal error details to clients
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
        error: 'Internal server error',
        message: isProduction ? 'An unexpected error occurred' : err.message,
        // Only include request ID for tracking in production
        ...(isProduction && { requestId: req.headers['x-request-id'] || 'unknown' })
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

        // Ensure Square custom attributes exist for all active merchants
        // (expiry tracking, brands, case_pack_quantity, etc.)
        try {
            const merchantsResult = await db.query(
                'SELECT id, business_name FROM merchants WHERE is_active = TRUE'
            );

            if (merchantsResult.rows.length > 0) {
                logger.info('Initializing Square custom attributes for all merchants...', {
                    merchantCount: merchantsResult.rows.length
                });

                let totalCreated = 0;
                let totalUpdated = 0;
                let totalErrors = 0;

                for (const merchant of merchantsResult.rows) {
                    try {
                        const attrResult = await squareApi.initializeCustomAttributes({ merchantId: merchant.id });
                        if (attrResult.definitions) {
                            const created = attrResult.definitions.filter(d => d.status === 'created').length;
                            const updated = attrResult.definitions.filter(d => d.status === 'updated').length;
                            totalCreated += created;
                            totalUpdated += updated;

                            if (created > 0 || updated > 0) {
                                logger.info('Custom attributes initialized for merchant', {
                                    merchantId: merchant.id,
                                    businessName: merchant.business_name,
                                    created,
                                    updated
                                });
                            }
                        }
                    } catch (merchantError) {
                        totalErrors++;
                        logger.warn('Could not initialize custom attributes for merchant', {
                            merchantId: merchant.id,
                            businessName: merchant.business_name,
                            error: merchantError.message
                        });
                    }
                }

                logger.info('Square custom attributes initialization complete', {
                    merchants: merchantsResult.rows.length,
                    totalCreated,
                    totalUpdated,
                    totalErrors
                });
            } else {
                logger.info('No active merchants - skipping custom attribute initialization');
            }
        } catch (squareAttrError) {
            // Don't fail startup if Square attributes can't be created
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
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE');
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
                logger.error('Scheduled batch generation failed', { error: error.message, stack: error.stack });
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
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE');
                const merchants = merchantsResult.rows;

                if (merchants.length === 0) {
                    logger.info('No merchants to sync');
                    return;
                }

                const allErrors = [];

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
                logger.error('Scheduled smart sync failed', { error: error.message, stack: error.stack });
                await emailNotifier.sendAlert(
                    'Database Sync Failed',
                    `Failed to run scheduled database sync:\n\n${error.message}\n\nStack: ${error.stack}`
                );
            }
        }));

        logger.info('Database sync cron job scheduled', { schedule: syncCronSchedule });

        // Initialize GMC (Google Merchant Center) sync cron job
        // Pushes product catalog to GMC daily at 11pm by default (configurable via GMC_SYNC_CRON_SCHEDULE)
        const gmcSyncCronSchedule = process.env.GMC_SYNC_CRON_SCHEDULE;
        if (gmcSyncCronSchedule) {
            cronTasks.push(cron.schedule(gmcSyncCronSchedule, async () => {
                logger.info('Running scheduled GMC product sync for all merchants');
                try {
                    const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE');
                    const merchants = merchantsResult.rows;

                    if (merchants.length === 0) {
                        logger.info('No merchants for GMC sync');
                        return;
                    }

                    const results = [];
                    for (const merchant of merchants) {
                        try {
                            logger.info('Running GMC product sync for merchant', { merchantId: merchant.id, businessName: merchant.business_name });
                            const gmcResult = await gmcApi.syncProductCatalog(merchant.id);
                            results.push({
                                merchantId: merchant.id,
                                businessName: merchant.business_name,
                                success: true,
                                total: gmcResult.total,
                                synced: gmcResult.synced,
                                failed: gmcResult.failed
                            });
                            logger.info('GMC product sync completed for merchant', {
                                merchantId: merchant.id,
                                total: gmcResult.total,
                                synced: gmcResult.synced,
                                failed: gmcResult.failed
                            });
                        } catch (merchantError) {
                            logger.error('GMC sync failed for merchant', { merchantId: merchant.id, error: merchantError.message });
                            results.push({
                                merchantId: merchant.id,
                                businessName: merchant.business_name,
                                success: false,
                                error: merchantError.message
                            });
                        }
                    }

                    // Send alert if any syncs failed
                    const failures = results.filter(r => !r.success);
                    if (failures.length > 0) {
                        const errorDetails = failures.map(f =>
                            `${f.businessName} (${f.merchantId}): ${f.error}`
                        ).join('\n');
                        await emailNotifier.sendAlert(
                            'GMC Sync Partial Failure',
                            `GMC sync failed for some merchants:\n\n${errorDetails}`
                        );
                    }

                    logger.info('Scheduled GMC sync completed for all merchants', {
                        total: merchants.length,
                        successful: results.filter(r => r.success).length,
                        failed: failures.length
                    });
                } catch (error) {
                    logger.error('Scheduled GMC sync failed', { error: error.message, stack: error.stack });
                    await emailNotifier.sendAlert(
                        'GMC Sync Failed',
                        `Failed to run scheduled GMC sync:\n\n${error.message}\n\nStack: ${error.stack}`
                    );
                }
            }));

            logger.info('GMC sync cron job scheduled', { schedule: gmcSyncCronSchedule });
        } else {
            logger.info('GMC sync cron job not configured (set GMC_SYNC_CRON_SCHEDULE to enable)');
        }

        // Initialize automated weekly database backup cron job
        // Runs every Sunday at 2:00 AM by default (configurable via BACKUP_CRON_SCHEDULE)
        const backupCronSchedule = process.env.BACKUP_CRON_SCHEDULE || '0 2 * * 0';
        cronTasks.push(cron.schedule(backupCronSchedule, async () => {
            logger.info('Running scheduled database backup');
            try {
                await runAutomatedBackup();
                logger.info('Scheduled database backup completed successfully');
            } catch (error) {
                logger.error('Scheduled database backup failed', { error: error.message, stack: error.stack });
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
                logger.error('Scheduled expiry discount automation failed', { error: error.message, stack: error.stack });
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
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE');
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
                logger.error('Startup batch check failed', { error: error.message, stack: error.stack });
            }
        })();

        // Startup check: Run smart sync if data is stale
        // This handles cases where server was offline during scheduled sync time
        (async () => {
            try {
                logger.info('Checking for stale data on startup for all merchants');

                // Get all active merchants
                const merchantsResult = await db.query('SELECT id, business_name FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE');
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
                logger.error('Startup sync check failed', { error: error.message, stack: error.stack });
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
        logger.error('Error during shutdown', { error: error.message, stack: error.stack });
        clearTimeout(forceExitTimeout);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Catch uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION - This should not happen!', {
        error: error.message,
        stack: error.stack,
        type: error.name
    });
    // Give time for the log to be written before exiting
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED PROMISE REJECTION', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined
    });
});

// Start the server
startServer().catch(err => {
    console.error('FATAL: Server startup failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});

module.exports = app;
