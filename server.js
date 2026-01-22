/**
 * Square Dashboard Addon Tool - Main Server
 * Express API server with Square POS integration
 */

// Early startup logging (logger not yet initialized)
const startupTime = Date.now();

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

// Safe sync queue for webhook-triggered syncs (prevents duplicate syncs while ensuring no data is missed)
// Instead of simple debounce (which could miss data), we track:
// 1. If a sync is currently running
// 2. If webhooks arrived during the sync (requiring a follow-up sync)
const catalogSyncInProgress = new Map(); // merchantId -> boolean
const catalogSyncPending = new Map(); // merchantId -> boolean (true if webhook arrived during sync)
const inventorySyncInProgress = new Map(); // merchantId -> boolean
const inventorySyncPending = new Map(); // merchantId -> boolean (true if webhook arrived during sync)

const squareApi = require('./utils/square-api');
const logger = require('./utils/logger');
const emailNotifier = require('./utils/email-notifier');
const subscriptionHandler = require('./utils/subscription-handler');
const { subscriptionCheck } = require('./middleware/subscription-check');
const crypto = require('crypto');
const expiryDiscount = require('./utils/expiry-discount');
const { encryptToken, decryptToken, isEncryptedToken } = require('./utils/token-encryption');
const deliveryApi = require('./utils/delivery-api');
const loyaltyService = require('./utils/loyalty-service');
const loyaltyReports = require('./utils/loyalty-reports');
const gmcApi = require('./utils/merchant-center-api');
const webhookRetry = require('./utils/webhook-retry');

// Security middleware
const { configureHelmet, configureRateLimit, configureDeliveryRateLimit, configureDeliveryStrictRateLimit, configureSensitiveOperationRateLimit, configureCors, corsErrorHandler } = require('./middleware/security');
const { requireAuth, requireAuthApi, requireAdmin } = require('./middleware/auth');
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
const { generateDailyBatch } = require('./utils/cycle-count-utils');
const syncRoutes = require('./routes/sync');
const { runSmartSync, isSyncNeeded, loggedSync } = require('./routes/sync');
const catalogRoutes = require('./routes/catalog');
const squareAttributesRoutes = require('./routes/square-attributes');
const googleOAuthRoutes = require('./routes/google-oauth');
const analyticsRoutes = require('./routes/analytics');
const merchantsRoutes = require('./routes/merchants');
const settingsRoutes = require('./routes/settings');
const logsRoutes = require('./routes/logs');

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
app.use('/api', syncRoutes);
app.use('/api', catalogRoutes);
app.use('/api', squareAttributesRoutes);
app.use('/api', googleOAuthRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', merchantsRoutes);
app.use('/api', settingsRoutes);
app.use('/api', logsRoutes);

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


// ==================== GMC ROUTES (EXTRACTED) ====================
// GMC routes have been extracted to routes/gmc.js
// 32 endpoints for Google Merchant Center feed and API management
// Includes: feed generation, brand management, taxonomy mapping, local inventory
// See routes/gmc.js for implementation

// ==================== VENDOR CATALOG (EXTRACTED) ====================
// Vendor and vendor catalog routes have been extracted to routes/vendor-catalog.js
// See routes/vendor-catalog.js for implementation

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

/**
 * Run automated database backup using pg_dump and email the result
 * Called by cron job and test endpoint
 * @returns {Promise<void>}
 */
async function runAutomatedBackup() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'square_dashboard_addon';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD;

    if (!dbPassword) {
        throw new Error('DB_PASSWORD environment variable is required for automated backup');
    }

    // Get database statistics first
    const statsResult = await db.query(`
        SELECT
            schemaname,
            relname AS tablename,
            n_live_tup AS row_count
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC
    `);

    const dbInfo = {
        database: dbName,
        host: dbHost,
        tables: statsResult.rows
    };

    // Run pg_dump with password via environment variable (secure)
    const pgDumpCmd = `PGPASSWORD="${dbPassword}" pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} --no-owner --no-acl`;

    try {
        const { stdout: sqlDump, stderr } = await execAsync(pgDumpCmd, {
            maxBuffer: 100 * 1024 * 1024, // 100MB buffer for large databases
            timeout: 300000 // 5 minute timeout
        });

        if (stderr && !stderr.includes('Warning')) {
            logger.warn('pg_dump warnings', { stderr });
        }

        // Send backup via email
        await emailNotifier.sendBackup(sqlDump, dbInfo);

        logger.info('Automated backup completed', {
            database: dbName,
            backupSize: `${(sqlDump.length / 1024 / 1024).toFixed(2)} MB`,
            tableCount: statsResult.rows.length
        });
    } catch (error) {
        // Check if pg_dump is not installed
        if (error.message.includes('pg_dump: not found') || error.message.includes('command not found')) {
            throw new Error('pg_dump is not installed. Please install PostgreSQL client tools.');
        }
        throw error;
    }
}

// ==================== SUBSCRIPTIONS & PAYMENTS (EXTRACTED) ====================
// Subscription routes have been extracted to routes/subscriptions.js
// This includes: payment-config, plans, promo validation, create, status, cancel, refund
// See routes/subscriptions.js for implementation

// ==================== WEBHOOK SUBSCRIPTION MANAGEMENT (EXTRACTED) ====================
// Webhook management routes have been extracted to routes/webhooks.js
// This includes: list subscriptions, audit, event-types, register, ensure, update, delete, test
// See routes/webhooks.js for implementation

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
            // SECURITY: SQUARE_WEBHOOK_URL must be set to prevent Host header injection
            // The URL must match exactly what's registered with Square
            if (!process.env.SQUARE_WEBHOOK_URL) {
                logger.error('SECURITY: SQUARE_WEBHOOK_URL environment variable is required for webhook signature verification');
                return res.status(500).json({ error: 'Webhook URL not configured' });
            }
            const notificationUrl = process.env.SQUARE_WEBHOOK_URL;
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

                    // Safe sync queue: if sync already running, mark as pending (will resync after current completes)
                    if (catalogSyncInProgress.get(internalMerchantId)) {
                        logger.info('Catalog sync already in progress - marking for follow-up sync', {
                            merchantId: internalMerchantId
                        });
                        catalogSyncPending.set(internalMerchantId, true);
                        syncResults.queued = true;
                        break;
                    }

                    // Mark sync as in progress
                    catalogSyncInProgress.set(internalMerchantId, true);
                    catalogSyncPending.set(internalMerchantId, false);

                    try {
                        logger.info('Catalog change detected via webhook, syncing...', { merchantId: internalMerchantId });
                        const catalogSyncResult = await squareApi.syncCatalog(internalMerchantId);
                        syncResults.catalog = {
                            items: catalogSyncResult.items,
                            variations: catalogSyncResult.variations
                        };
                        logger.info('Catalog sync completed via webhook', syncResults.catalog);

                        // Check if more webhooks arrived during sync - if so, sync again to catch any changes
                        if (catalogSyncPending.get(internalMerchantId)) {
                            logger.info('Webhooks arrived during sync - running follow-up sync', { merchantId: internalMerchantId });
                            catalogSyncPending.set(internalMerchantId, false);
                            const followUpResult = await squareApi.syncCatalog(internalMerchantId);
                            syncResults.followUpSync = {
                                items: followUpResult.items,
                                variations: followUpResult.variations
                            };
                            logger.info('Follow-up catalog sync completed', syncResults.followUpSync);
                        }
                    } catch (syncError) {
                        logger.error('Catalog sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    } finally {
                        // Always clear the in-progress flag
                        catalogSyncInProgress.set(internalMerchantId, false);
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

                    // Safe sync queue: if sync already running, mark as pending (will resync after current completes)
                    if (inventorySyncInProgress.get(internalMerchantId)) {
                        logger.info('Inventory sync already in progress - marking for follow-up sync', {
                            merchantId: internalMerchantId
                        });
                        inventorySyncPending.set(internalMerchantId, true);
                        syncResults.queued = true;
                        break;
                    }

                    // Mark sync as in progress
                    inventorySyncInProgress.set(internalMerchantId, true);
                    inventorySyncPending.set(internalMerchantId, false);

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

                        // Check if more webhooks arrived during sync - if so, sync again to catch any changes
                        if (inventorySyncPending.get(internalMerchantId)) {
                            logger.info('Webhooks arrived during inventory sync - running follow-up sync', { merchantId: internalMerchantId });
                            inventorySyncPending.set(internalMerchantId, false);
                            const followUpResult = await squareApi.syncInventory(internalMerchantId);
                            syncResults.followUpSync = { count: followUpResult };
                            logger.info('Follow-up inventory sync completed', { count: followUpResult });
                        }
                    } catch (syncError) {
                        logger.error('Inventory sync via webhook failed', { error: syncError.message });
                        syncResults.error = syncError.message;
                    } finally {
                        // Always clear the in-progress flag
                        inventorySyncInProgress.set(internalMerchantId, false);
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

        // Mark webhook for retry with exponential backoff
        if (webhookEventId) {
            const processingTime = Date.now() - startTime;
            await webhookRetry.markForRetry(webhookEventId, error.message).catch(dbErr => {
                logger.error('Failed to mark webhook for retry', { webhookEventId, error: dbErr.message, stack: dbErr.stack });
            });
            // Also update processing time
            await db.query(`
                UPDATE webhook_events
                SET processing_time_ms = $1
                WHERE id = $2
            `, [processingTime, webhookEventId]).catch(err => {
                logger.warn('Failed to update webhook processing time', { webhookEventId, error: err.message });
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

    // Log error with appropriate level
    const logContext = {
        error: err.message,
        code: err.code,
        statusCode,
        path: req.path,
        method: req.method,
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
        ...(isProduction && { requestId: req.headers['x-request-id'] || crypto.randomUUID() }),
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

        // Initialize webhook retry processor cron job
        // Runs every minute to process failed webhooks with exponential backoff
        const webhookRetryCronSchedule = process.env.WEBHOOK_RETRY_CRON_SCHEDULE || '* * * * *';
        cronTasks.push(cron.schedule(webhookRetryCronSchedule, async () => {
            try {
                // Get events due for retry
                const events = await webhookRetry.getEventsForRetry(10);

                if (events.length === 0) {
                    return; // No events to retry, skip logging
                }

                logger.info('Processing webhook retries', { count: events.length });

                for (const event of events) {
                    const startTime = Date.now();
                    try {
                        logger.info('Retrying webhook event', {
                            webhookEventId: event.id,
                            eventType: event.event_type,
                            retryCount: event.retry_count,
                            squareEventId: event.square_event_id
                        });

                        // Look up internal merchant ID from Square merchant ID
                        const merchantResult = await db.query(
                            'SELECT id FROM merchants WHERE square_merchant_id = $1 AND is_active = TRUE',
                            [event.merchant_id]
                        );

                        if (merchantResult.rows.length === 0) {
                            await webhookRetry.incrementRetry(event.id, 'Merchant not found or inactive');
                            continue;
                        }

                        const internalMerchantId = merchantResult.rows[0].id;
                        let syncResult = null;

                        // Re-trigger appropriate sync based on event type
                        switch (event.event_type) {
                            case 'catalog.version.updated':
                                syncResult = await squareApi.syncCatalog(internalMerchantId);
                                break;

                            case 'inventory.count.updated':
                                syncResult = await squareApi.syncInventory(internalMerchantId);
                                break;

                            case 'order.created':
                            case 'order.updated':
                            case 'order.fulfillment.updated':
                                syncResult = await squareApi.syncCommittedInventory(internalMerchantId);
                                break;

                            case 'vendor.created':
                            case 'vendor.updated':
                                syncResult = await squareApi.syncVendors(internalMerchantId);
                                break;

                            case 'location.created':
                            case 'location.updated':
                                syncResult = await squareApi.syncLocations(internalMerchantId);
                                break;

                            default:
                                // For event types without a sync handler, mark as completed
                                // (the original webhook was received, just processing failed)
                                logger.info('No retry handler for event type', { eventType: event.event_type });
                                syncResult = { skipped: true, reason: 'No retry handler for event type' };
                        }

                        // Mark as successful
                        const processingTime = Date.now() - startTime;
                        await webhookRetry.markSuccess(event.id, syncResult || {}, processingTime);

                        logger.info('Webhook retry succeeded', {
                            webhookEventId: event.id,
                            eventType: event.event_type,
                            processingTimeMs: processingTime
                        });

                    } catch (retryError) {
                        logger.error('Webhook retry failed', {
                            webhookEventId: event.id,
                            eventType: event.event_type,
                            retryCount: event.retry_count,
                            error: retryError.message
                        });
                        await webhookRetry.incrementRetry(event.id, retryError.message);
                    }
                }
            } catch (error) {
                logger.error('Webhook retry processor error', { error: error.message, stack: error.stack });
            }
        }));

        logger.info('Webhook retry cron job scheduled', { schedule: webhookRetryCronSchedule });

        // Webhook cleanup cron - runs daily at 3 AM to remove old events
        const webhookCleanupCronSchedule = process.env.WEBHOOK_CLEANUP_CRON_SCHEDULE || '0 3 * * *';
        cronTasks.push(cron.schedule(webhookCleanupCronSchedule, async () => {
            try {
                const deletedCount = await webhookRetry.cleanupOldEvents(14, 30);
                if (deletedCount > 0) {
                    logger.info('Webhook cleanup completed', { deletedCount });
                }
            } catch (error) {
                logger.error('Webhook cleanup error', { error: error.message });
            }
        }));

        logger.info('Webhook cleanup cron job scheduled', { schedule: webhookCleanupCronSchedule });

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
