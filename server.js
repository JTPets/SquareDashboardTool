/**
 * Square Dashboard Addon Tool - Main Server
 * Express API server with Square POS integration
 */

require('dotenv').config();

// C-3: Validate required environment variables before loading any modules
(function validateEnvironment() {
    const isProduction = process.env.NODE_ENV === 'production';

    // Database: need either DATABASE_URL or all individual DB vars
    const hasDbUrl = !!process.env.DATABASE_URL;
    const dbVars = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
    const hasAllDbVars = dbVars.every(v => !!process.env[v]);
    const missingDbVars = hasDbUrl ? [] : dbVars.filter(v => !process.env[v]);

    const requiredVars = ['TOKEN_ENCRYPTION_KEY', 'SESSION_SECRET', 'SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET'];
    const missingRequired = requiredVars.filter(v => !process.env[v]);

    const allMissing = [...missingRequired];
    if (!hasDbUrl && !hasAllDbVars) {
        allMissing.push(...missingDbVars.map(v => v + ' (or DATABASE_URL)'));
    }

    if (allMissing.length > 0) {
        const message = `Missing required environment variables: ${allMissing.join(', ')}`;
        if (isProduction) {
            console.error(`[FATAL] ${message}`);
            process.exit(1);
        } else {
            console.warn(`[WARNING] ${message}`);
        }
    }
})();

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs').promises;
const db = require('./utils/database');
const { ensureSchema } = require('./utils/schema-manager');

// Store cron task references for graceful shutdown
// Populated by jobs.initializeCronJobs() in startServer()
let cronTasks = [];
let httpServer = null;

// Sync queue is now managed by services/sync-queue.js
// Webhook processing is now handled by services/webhook-processor.js
const syncQueue = require('./services/sync-queue');

const squareApi = require('./services/square');
const logger = require('./utils/logger');
const emailNotifier = require('./utils/email-notifier');
const crypto = require('crypto');
const { encryptToken, decryptToken, isEncryptedToken } = require('./utils/token-encryption');
const webhookRetry = require('./utils/webhook-retry');

// Jobs module (cron jobs, backups, etc.)
const jobs = require('./jobs');

// Security middleware
const { configureHelmet, configurePermissionsPolicy, configureRateLimit, configureCors, corsErrorHandler } = require('./middleware/security');
const { requireAuth, requireAuthApi, requireAdmin } = require('./middleware/auth');
// LOGIC CHANGE: request correlation IDs for log tracing (Audit 8.x)
const requestId = require('./middleware/request-id');
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
const webhooksSquareRoute = require('./routes/webhooks/square');
const expiryDiscountsRoutes = require('./routes/expiry-discounts');
const vendorCatalogRoutes = require('./routes/vendor-catalog');
const cycleCountsRoutes = require('./routes/cycle-counts');
const syncRoutes = require('./routes/sync');
const { runSmartSync, isSyncNeeded } = require('./routes/sync');
const catalogRoutes = require('./routes/catalog');
const aiAutofillRoutes = require('./routes/ai-autofill');
const squareAttributesRoutes = require('./routes/square-attributes');
const googleOAuthRoutes = require('./routes/google-oauth');
const analyticsRoutes = require('./routes/analytics');
const bundlesRoutes = require('./routes/bundles');
const merchantsRoutes = require('./routes/merchants');
const settingsRoutes = require('./routes/settings');
const logsRoutes = require('./routes/logs');
const cartActivityRoutes = require('./routes/cart-activity');
const labelsRoutes = require('./routes/labels');
const seniorsRoutes = require('./routes/seniors');
const adminRoutes = require('./routes/admin');
const catalogHealthRoutes = require('./routes/catalog-health');
const staffRoutes = require('./routes/staff');

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

// ==================== SECURITY MIDDLEWARE ====================

// Trust proxy (required when behind Cloudflare, nginx, etc.)
// This ensures rate limiting and session cookies work correctly with X-Forwarded-For headers
app.set('trust proxy', 1);

// Security headers (helmet) - skip in development if causing issues
if (process.env.DISABLE_SECURITY_HEADERS !== 'true') {
    app.use(configureHelmet());
    app.use(configurePermissionsPolicy());
}

// Request correlation IDs — must be before rate limiting so IDs appear in rate limit logs
app.use(requestId);

// Rate limiting
app.use(configureRateLimit());


// CORS configuration
app.use(configureCors());
app.use(corsErrorHandler);

// Body parsing - capture raw body for webhook signature verification
// Note: 5mb is sufficient for API payloads; POD uploads use multer with separate limits
app.use(express.json({
    limit: '5mb',
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

logger.info('Initializing session middleware');

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

logger.info('Session middleware initialized');

// Session secret validation - refuse to start in production without it
if (!process.env.SESSION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('FATAL: SESSION_SECRET must be set in production environment');
        process.exit(1);
    }
    logger.warn('SESSION_SECRET not set! Using random secret. Sessions will be lost on restart.');
}

// ==================== PAGE AUTHENTICATION ====================
// Redirect unauthenticated users to login page for protected HTML pages
// NOTE: AUTH_DISABLED bypass removed for security (2026-01-05)

// Public pages that don't require authentication
const publicPages = ['/', '/index.html', '/login.html', '/subscribe.html', '/support.html', '/set-password.html', '/subscription-expired.html', '/accept-invite.html'];

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
// S-2: Require authentication for sensitive /output subdirectories (logs, backups)
// /output/feeds remains public for Google Merchant Center
app.use('/output/logs', requireAuth, express.static(path.join(__dirname, 'output/logs')));
app.use('/output/backups', requireAuth, express.static(path.join(__dirname, 'output/backups')));
app.use('/output', express.static(path.join(__dirname, 'output')));

// Structured request logging
app.use((req, res, next) => {
    // Skip logging for static assets
    if (req.path.match(/\.(js|css|png|jpg|ico|svg|woff|woff2)$/)) {
        return next();
    }
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const meta = { method: req.method, path: req.path, status: res.statusCode, duration, user: req.session?.user?.email };
        if (duration > 500 || res.statusCode >= 400 || req.method !== 'GET') {
            logger.info('HTTP request', meta);
        } else {
            logger.debug('HTTP request', meta);
        }
    });
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
// Authentication middleware for /api and /api/v1 routes
const apiAuthMiddleware = (req, res, next) => {
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
    // Also allow staff invitation acceptance (token-based, no login required)
    if (publicPaths.includes(req.path) || req.path.startsWith('/driver/') || req.path === '/staff/accept') {
        return next();
    }

    // Require authentication for all other API routes
    return requireAuthApi(req, res, next);
};

// Apply auth middleware to both /api and /api/v1
app.use('/api', apiAuthMiddleware);
logger.info('Authentication middleware enabled for /api and /api/v1');

// System B email-based subscriptionCheck removed — System A is the sole enforcement layer.
// System B (subscribers table) is now the payment processor only; it bridges to System A
// (merchants table) via services/subscription-bridge.js on payment events.

// ==================== SUBSCRIPTION ENFORCEMENT (System A — merchant-level) ====================
// Blocks API access for merchants with expired trials or suspended subscriptions.
// Must run AFTER loadMerchantContext (needs req.merchantContext).
// Skips routes that must work without an active subscription.
const subscriptionExcludedPaths = [
    '/health',
    '/auth/',
    '/square/oauth/',
    '/webhooks/',
    '/subscriptions/',
    '/driver/',
    '/admin/',
    '/config',
    '/merchants',
    '/gmc/feed.tsv',
    '/gmc/local-inventory-feed.tsv'
];

const platformSettings = require('./services/platform-settings');

const subscriptionEnforcementMiddleware = async (req, res, next) => {
    // Only apply to API routes
    const apiPath = req.path;

    // Skip excluded paths
    for (const excluded of subscriptionExcludedPaths) {
        if (apiPath === excluded || apiPath.startsWith(excluded)) {
            return next();
        }
    }

    // Skip if no merchant context (unauthenticated or no merchant connected — other middleware handles this)
    if (!req.merchantContext) {
        return next();
    }

    // Platform owner always bypasses subscription enforcement
    try {
        const ownerIdStr = await platformSettings.getSetting('platform_owner_merchant_id');
        if (ownerIdStr && req.merchantContext.id === parseInt(ownerIdStr, 10)) {
            return next();
        }
    } catch (_) {
        // If platform settings lookup fails, fall through to normal check
    }

    return requireValidSubscription(req, res, next);
};

app.use('/api', subscriptionEnforcementMiddleware);
logger.info('Subscription enforcement middleware enabled (System A — merchant-level trials)');

// ==================== FEATURE MODULE GATING ====================
// Gates paid feature modules. Base module routes are always accessible.
// Must run AFTER loadMerchantContext (needs req.merchantContext.features).
const { requireFeature } = require('./middleware/feature-gate');
const { requirePermission } = require('./middleware/require-permission');

// Helper: register permission + feature gates on both /api and /api/v1 prefixes
function gateApi(path, ...middleware) {
    app.use('/api' + path, ...middleware);
    app.use('/api/v1' + path, ...middleware);
}

// --- Paid feature module gates (feature + permission) ---
gateApi('/cycle-counts', requireFeature('cycle_counts'), requirePermission('cycle_counts', 'read'));
gateApi('/expiry-discounts', requireFeature('expiry'), requirePermission('expiry', 'read'));
gateApi('/expirations', requireFeature('expiry'), requirePermission('expiry', 'read'));
gateApi('/vendors', requireFeature('reorder'), requirePermission('reorder', 'read'));
gateApi('/vendor-catalog', requireFeature('reorder'), requirePermission('reorder', 'read'));
gateApi('/vendor-dashboard', requireFeature('reorder'), requirePermission('reorder', 'read'));
gateApi('/sales-velocity', requireFeature('reorder'), requirePermission('reorder', 'read'));
gateApi('/reorder-suggestions', requireFeature('reorder'), requirePermission('reorder', 'read'));
gateApi('/labels', requireFeature('reorder'), requirePermission('reorder', 'read'));
gateApi('/seniors', requireFeature('loyalty'), requirePermission('loyalty', 'read'));
gateApi('/deleted-items', requireFeature('loyalty'), requirePermission('loyalty', 'read'));
gateApi('/cart-activity', requireFeature('loyalty'), requirePermission('loyalty', 'read'));
gateApi('/google', requireFeature('gmc'), requirePermission('gmc', 'read'));

// --- Base module permission gates ---
gateApi('/settings', requirePermission('base', 'admin'));
gateApi('/logs', requirePermission('base', 'admin'));
gateApi('/square-attributes', requirePermission('base', 'read'));
gateApi('/square/custom-attributes', requirePermission('base', 'read'));
gateApi('/catalog-audit', requirePermission('base', 'read'));
gateApi('/catalog', requirePermission('base', 'read'));
gateApi('/sync', requirePermission('base', 'read'));
gateApi('/sync-sales', requirePermission('base', 'read'));
gateApi('/sync-smart', requirePermission('base', 'read'));
gateApi('/sync-history', requirePermission('base', 'read'));
gateApi('/sync-intervals', requirePermission('base', 'read'));
gateApi('/sync-status', requirePermission('base', 'read'));
gateApi('/locations', requirePermission('base', 'read'));
gateApi('/categories', requirePermission('base', 'read'));
gateApi('/items', requirePermission('base', 'read'));
gateApi('/variations', requirePermission('base', 'read'));
gateApi('/inventory', requirePermission('base', 'read'));
gateApi('/low-stock', requirePermission('base', 'read'));
gateApi('/bundles', requirePermission('base', 'read'));
gateApi('/merchants', requirePermission('base', 'read'));
gateApi('/merchant/features', requirePermission('base', 'read'));
gateApi('/config', requirePermission('base', 'read'));
gateApi('/analytics', requireFeature('reorder'), requirePermission('reorder', 'read'));

// --- Virtual feature gates (with public path exemptions) ---
gateApi('/admin', requirePermission('staff', 'admin'));
gateApi('/staff', (req, res, next) => {
    // /accept and /validate-token are public (token-based, no login required)
    if (req.path === '/accept' || req.path === '/validate-token') return next();
    return requirePermission('staff', 'read')(req, res, next);
});
gateApi('/subscriptions', (req, res, next) => {
    // Public subscription endpoints (no auth required)
    const publicPaths = ['/plans', '/create', '/status', '/promo/validate'];
    if (publicPaths.includes(req.path)) return next();
    return requirePermission('subscription', 'read')(req, res, next);
});
gateApi('/webhooks', (req, res, next) => {
    // /square webhook receiver is public (signature-verified, no login)
    if (req.path === '/square' || req.path.startsWith('/square/')) return next();
    return requirePermission('base', 'admin')(req, res, next);
});

logger.info('Feature module and permission gating enabled');

// ==================== MERCHANT FEATURES ENDPOINT ====================
const featureRegistry = require('./config/feature-registry');
const { sendSuccess } = require('./utils/response-helper');

app.get('/api/merchant/features', requireMerchant, async (req, res) => {
    try {
        const isPlatformOwner = req.merchantContext.subscriptionStatus === 'platform_owner';
        const enabledFeatures = isPlatformOwner
            ? featureRegistry.getPaidModules().map(m => m.key)
            : (req.merchantContext.features || []);

        const available = featureRegistry.getPaidModules().map(mod => ({
            key: mod.key,
            name: mod.name,
            price_cents: mod.price_cents,
            enabled: isPlatformOwner || enabledFeatures.includes(mod.key)
        }));

        sendSuccess(res, {
            enabled: enabledFeatures,
            available,
            is_platform_owner: isPlatformOwner
        });
    } catch (error) {
        logger.error('Failed to load merchant features', { error: error.message, merchantId: req.merchantContext.id });
        res.status(500).json({ success: false, error: 'Failed to load features' });
    }
});

// ==================== STAFF ROUTES ====================
// Staff membership and invitation management (BACKLOG-41)
app.use('/api/staff', staffRoutes);

// ==================== ADMIN ROUTES ====================
// Platform administration endpoints (merchant management, settings)
app.use('/api/admin', adminRoutes);
// Catalog health monitor debug tool (admin only, merchant 3 only)
app.use('/api/admin/catalog-health', catalogHealthRoutes);

// ==================== DRIVER API ROUTES ====================
// Token-based public endpoints for contract drivers + authenticated merchant endpoints
app.use('/api', driverApiRoutes);

// ==================== PURCHASE ORDERS ROUTES ====================
// Financial operations for managing purchase orders
app.use('/api/purchase-orders', requireFeature('reorder'), requirePermission('reorder', 'read'), purchaseOrdersRoutes);

// ==================== SUBSCRIPTIONS ROUTES ====================
// SaaS subscription management (Square Subscriptions API)
app.use('/api', subscriptionsRoutes);

// ==================== LOYALTY ROUTES ====================
// Frequent Buyer Program - digitizes brand-defined loyalty programs
app.use('/api/loyalty', requireFeature('loyalty'), requirePermission('loyalty', 'read'), loyaltyRoutes);

// ==================== GMC ROUTES ====================
// Google Merchant Center feed generation and management
app.use('/api/gmc', requireFeature('gmc'), requirePermission('gmc', 'read'), gmcRoutes);

// ==================== DELIVERY ROUTES ====================
// Delivery order management, POD photos, route optimization
app.use('/api/delivery', requireFeature('delivery'), requirePermission('delivery', 'read'), deliveryRoutes);

// ==================== CART ACTIVITY ROUTES ====================
// Shopping cart tracking for DRAFT orders from Square Online
app.use('/api/cart-activity', requireFeature('loyalty'), requirePermission('loyalty', 'read'), cartActivityRoutes);

// ==================== WEBHOOK ROUTES ====================
// Webhook subscription CRUD operations
app.use('/api', webhooksRoutes);
// Main webhook processor (POST /api/webhooks/square)
app.use('/api/webhooks', webhooksSquareRoute);

// ==================== EXPIRY DISCOUNTS ROUTES ====================
// Automatic discount management for products approaching expiration
app.use('/api', expiryDiscountsRoutes);

// ==================== VENDOR CATALOG ROUTES ====================
// Vendor management and catalog import/matching
app.use('/api', vendorCatalogRoutes);

// ==================== CYCLE COUNTS ROUTES ====================
// Inventory cycle counting operations and reporting
app.use('/api', cycleCountsRoutes);
app.use('/api', syncRoutes);
app.use('/api', catalogRoutes);
app.use('/api/ai-autofill', requireFeature('ai_tools'), requirePermission('ai_tools', 'read'), aiAutofillRoutes);
app.use('/api', squareAttributesRoutes);
app.use('/api', googleOAuthRoutes);
app.use('/api', analyticsRoutes);
app.use('/api/bundles', bundlesRoutes);
app.use('/api', merchantsRoutes);
app.use('/api', settingsRoutes);
app.use('/api', logsRoutes);

// ==================== LABEL PRINTING ROUTES ====================
// ZPL label generation for Zebra printers via Browser Print
app.use('/api', labelsRoutes);

// ==================== SENIORS DISCOUNT ROUTES ====================
// Monitoring and configuration for monthly seniors day discount
app.use('/api', seniorsRoutes);

// ==================== API VERSIONING (v1) ====================
// Versioned routes for future API changes - currently aliases to unversioned routes
// New integrations should use /api/v1/*, existing clients can continue using /api/*
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/square/oauth', squareOAuthRoutes);
app.use('/api/v1/purchase-orders', requireFeature('reorder'), requirePermission('reorder', 'read'), purchaseOrdersRoutes);
app.use('/api/v1/loyalty', requireFeature('loyalty'), requirePermission('loyalty', 'read'), loyaltyRoutes);
app.use('/api/v1/gmc', requireFeature('gmc'), requirePermission('gmc', 'read'), gmcRoutes);
app.use('/api/v1/delivery', requireFeature('delivery'), requirePermission('delivery', 'read'), deliveryRoutes);
app.use('/api/v1/webhooks', webhooksSquareRoute);
app.use('/api/v1', driverApiRoutes);
app.use('/api/v1', subscriptionsRoutes);
app.use('/api/v1', webhooksRoutes);
app.use('/api/v1', expiryDiscountsRoutes);
app.use('/api/v1', vendorCatalogRoutes);
app.use('/api/v1', cycleCountsRoutes);
app.use('/api/v1', syncRoutes);
app.use('/api/v1', catalogRoutes);
app.use('/api/v1/ai-autofill', requireFeature('ai_tools'), requirePermission('ai_tools', 'read'), aiAutofillRoutes);
app.use('/api/v1', squareAttributesRoutes);
app.use('/api/v1', googleOAuthRoutes);
app.use('/api/v1', analyticsRoutes);
app.use('/api/v1/bundles', bundlesRoutes);
app.use('/api/v1', merchantsRoutes);
app.use('/api/v1', settingsRoutes);
app.use('/api/v1', logsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1', labelsRoutes);

// ==================== HEALTH & STATUS ====================

/**
 * GET /api/health
 * S-8: Public health check — returns minimal status (no internal details)
 */
app.get('/api/health', async (req, res) => {
    try {
        const dbConnected = await db.testConnection();

        res.json({
            status: dbConnected ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        });
    } catch (error) {
        logger.error('Health check failed', { error: error.message, stack: error.stack });
        res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /api/health/detailed
 * S-8: Authenticated health check — full diagnostics for operators
 */
app.get('/api/health/detailed', requireAuth, requireAdmin, async (req, res) => {
    try {
        const dbConnected = await db.testConnection();

        // TODO(pre-franchise): check all merchants or accept merchantId param (MT-9)
        // Check Square connection status from database
        let squareStatus = 'not_configured';
        let squareError = null;
        try {
            const merchantResult = await db.query(
                'SELECT id FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE LIMIT 1'
            );
            if (merchantResult.rows.length > 0) {
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

        // Webhook health stats (last 24h)
        let webhookHealth = null;
        try {
            const stats = await webhookRetry.getRetryStats();
            webhookHealth = {
                dead_24h: parseInt(stats.exhausted_retries) || 0,
                in_retry_24h: (parseInt(stats.pending_retries) || 0) + (parseInt(stats.scheduled_retries) || 0),
                failed_total_24h: parseInt(stats.failed_total) || 0,
                completed_24h: parseInt(stats.completed) || 0
            };
        } catch (whErr) {
            logger.warn('Health check: webhook stats query failed', { error: whErr.message });
        }

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
            webhooks: webhookHealth,
            nodeVersion: process.version,
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        });
    } catch (error) {
        logger.error('Detailed health check failed', { error: error.message, stack: error.stack });
        res.status(500).json({
            status: 'error',
            database: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
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
            await jobs.runAutomatedBackup();
            res.json({ success: true, message: 'Test backup email sent successfully' });
        } catch (error) {
            logger.error('Test backup email failed', { error: error.message, stack: error.stack });
            res.status(500).json({ error: error.message });
        }
    });
}

// LOGIC CHANGE: removed ~10 stale EXTRACTED section comments (DEAD-6-12, 2026-03-17)
// Routes are in routes/, handlers in services/webhook-handlers/, jobs in jobs/

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
    const isProduction = process.env.NODE_ENV === 'production';

    // Determine appropriate status code
    let statusCode = err.statusCode || err.status || 500;

    // Map common error patterns to status codes
    if (!err.statusCode) {
        if (err.code === 'UNAUTHORIZED' || err.message?.includes('unauthorized')) {
            statusCode = 401;
        } else if (err.code === 'FORBIDDEN' || err.message?.includes('permission')) {
            statusCode = 403;
        } else if (err.code === 'NOT_FOUND') {
            statusCode = 404;
        } else if (err.code === 'RATE_LIMITED' || err.message?.includes('rate limit')) {
            statusCode = 429;
        } else if (err.code === 'VALIDATION_ERROR' || err.name === 'ValidationError') {
            statusCode = 422;
        }
    }

    // LOGIC CHANGE: include requestId in error logs for correlation (Audit 8.x)
    const logContext = {
        error: err.message,
        code: err.code,
        statusCode,
        path: req.path,
        method: req.method,
        requestId: req.requestId,
        merchantId: req.merchantContext?.id,
        userId: req.session?.userId,
        ...(statusCode >= 500 && { stack: err.stack })
    };

    if (statusCode >= 500) {
        logger.error('Server error', logContext);
    } else if (statusCode >= 400) {
        logger.warn('Client error', logContext);
    }

    // Build user-friendly response
    const response = {
        error: getUserFriendlyMessage(statusCode, err),
        ...(err.code && { code: err.code }),
        ...(err.errors && { errors: err.errors }), // For validation errors
        ...(err.retryAfter && { retryAfter: err.retryAfter }), // For rate limits
        // LOGIC CHANGE: always include requestId from middleware (Audit 8.x)
        ...(req.requestId && { requestId: req.requestId }),
        ...(!isProduction && { details: err.message })
    };

    res.status(statusCode).json(response);
});

/**
 * Maps HTTP status codes to user-friendly error messages
 */
function getUserFriendlyMessage(statusCode, err) {
    // Use custom message for operational errors
    if (err.isOperational && err.message) {
        return err.message;
    }

    const messages = {
        400: 'The request was invalid. Please check your input and try again.',
        401: 'You are not authorized. Please log in again.',
        403: 'Access denied. You don\'t have permission for this action.',
        404: 'The requested resource was not found.',
        409: 'A conflict occurred. The resource may have been modified.',
        422: 'Validation failed. Please check your input.',
        429: 'Too many requests. Please wait a moment before trying again.',
        500: 'An unexpected error occurred. Our team has been notified.',
        502: 'A service is temporarily unavailable. Please try again.',
        503: 'Service is temporarily unavailable. Please try again later.',
        504: 'Request timed out. Please try again.'
    };

    return messages[statusCode] || 'Something went wrong. Please try again.';
}

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
        await ensureSchema();

        // NOTE: Legacy backfill code removed (2026-01-05)
        // The startup backfill for NULL merchant_id and orphan user linking has been removed.
        // Multi-tenant migration is complete. Records without merchant_id will fail as expected.

        // Ensure Square custom attributes exist for uninitialized merchants
        // BACKLOG-13: Only run for merchants missing the initialized_at flag
        try {
            const merchantsResult = await db.query(
                'SELECT id, business_name FROM merchants WHERE is_active = TRUE AND custom_attributes_initialized_at IS NULL'
            );

            if (merchantsResult.rows.length > 0) {
                logger.info('Initializing Square custom attributes for new merchants...', {
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

                        // Mark merchant as initialized so we skip on next restart
                        await db.query(
                            'UPDATE merchants SET custom_attributes_initialized_at = NOW() WHERE id = $1',
                            [merchant.id]
                        );
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
                logger.info('All merchants have custom attributes initialized - skipping');
            }
        } catch (squareAttrError) {
            // Don't fail startup if Square attributes can't be created
            logger.warn('Could not initialize Square custom attributes', {
                error: squareAttrError.message
            });
        }

        // Start server
        httpServer = app.listen(PORT, () => {
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

        httpServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.error(`Port ${PORT} already in use. Is another instance running?`);
                process.exit(1);
            } else {
                throw err;
            }
        });

        // Initialize all cron jobs (cycle count, webhook retry, sync, backup, expiry discount)
        // See jobs/cron-scheduler.js for individual job configurations
        cronTasks = jobs.initializeCronJobs();

        // Run startup tasks (batch check for missed cron runs)
        jobs.runStartupTasks();

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
            emailNotifier.sendCritical('Database Connection Lost', err)
                .catch(emailErr => logger.error('Failed to send DB error email', { error: emailErr.message }));
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

    // Set a force-exit timeout (45 seconds to allow sync drain)
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, 45000);

    try {
        // 1. Stop accepting new HTTP requests
        if (httpServer) {
            logger.info('Closing HTTP server (stop accepting new requests)');
            await new Promise((resolve) => httpServer.close(resolve));
        }

        // 2. Stop all cron jobs (prevent new syncs from starting)
        logger.info(`Stopping ${cronTasks.length} cron tasks`);
        jobs.stopCronJobs();

        // 2b. Clear background timers in Square API module
        const squareApiModule = require('./services/square/api');
        squareApiModule.cleanup();

        // 3. Wait for active syncs to complete (up to 30 seconds)
        const syncDrainStart = Date.now();
        const syncDrainTimeout = 30000;
        let status = syncQueue.getStatus();
        let hasActiveSyncs = status.catalog.inProgress.length > 0 || status.inventory.inProgress.length > 0;

        if (hasActiveSyncs) {
            logger.info('Waiting for active syncs to complete before closing database', {
                catalogInProgress: status.catalog.inProgress,
                inventoryInProgress: status.inventory.inProgress
            });
        }

        while (hasActiveSyncs && (Date.now() - syncDrainStart) < syncDrainTimeout) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            status = syncQueue.getStatus();
            hasActiveSyncs = status.catalog.inProgress.length > 0 || status.inventory.inProgress.length > 0;
        }

        if (hasActiveSyncs) {
            logger.warn('Sync drain timed out, proceeding with database close', {
                catalogInProgress: status.catalog.inProgress,
                inventoryInProgress: status.inventory.inProgress
            });
        }

        // 4. Close database connections
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
// LOGIC CHANGE: replaced console.error with logger.error (L-1)
startServer().catch(err => {
    logger.error('FATAL: Server startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
});

module.exports = app;
