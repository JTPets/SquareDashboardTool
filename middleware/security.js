/**
 * Security Middleware Configuration
 * Handles rate limiting, security headers, and CORS
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const logger = require('../utils/logger');

/**
 * Configure Helmet security headers
 */
function configureHelmet() {
    // Only upgrade to HTTPS if explicitly enabled (requires actual HTTPS setup)
    // Setting FORCE_HTTPS=true enables upgradeInsecureRequests directive
    const forceHttps = process.env.FORCE_HTTPS === 'true';

    return helmet({
        // Content Security Policy
        // P0-4 COMPLETE: Inline event handlers migrated to event delegation (29/29 files).
        // S-4 COMPLETE: Last inline <script> in cart-activity.html externalized to /js/cart-activity.js.
        // 'unsafe-eval' was removed 2026-01-26 after confirming no eval()/new Function() usage.
        // 'unsafe-inline' removed 2026-02-25 — all scripts now external.
        // Includes Cloudflare domains for tunnel/proxy compatibility
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: [
                    "'self'",
                    // Cloudflare scripts (Rocket Loader, Analytics, Challenge pages)
                    "https://*.cloudflare.com",
                    "https://*.cloudflareinsights.com",
                    "https://ajax.cloudflare.com",
                    "https://static.cloudflareinsights.com",
                    // Square Web Payments SDK
                    "https://web.squarecdn.com",
                    "https://*.squarecdn.com"
                ],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],  // Allow images from HTTPS sources
                connectSrc: [
                    "'self'",
                    "https://connect.squareup.com",
                    "https://connect.squareupsandbox.com",
                    // Square Web Payments SDK PCI compliance
                    "https://pci-connect.squareup.com",
                    // Cloudflare analytics beacons
                    "https://*.cloudflareinsights.com",
                    // Zebra Browser Print agent (runs on user's local machine)
                    "http://127.0.0.1:9100",
                    "https://127.0.0.1:9101"
                ],
                // Allow Cloudflare challenge iframes (CAPTCHA, etc.)
                // Note: 'none' cannot be combined with other values in CSP
                frameSrc: ["'self'", "https://challenges.cloudflare.com", "https://pci-connect.squareup.com"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                // Only upgrade HTTP to HTTPS if FORCE_HTTPS=true (requires HTTPS to be configured)
                upgradeInsecureRequests: forceHttps ? [] : null,
            },
            reportOnly: false,
        },
        // Prevent clickjacking
        frameguard: { action: 'deny' },
        // Prevent MIME type sniffing
        noSniff: true,
        // XSS filter
        xssFilter: true,
        // Hide X-Powered-By header
        hidePoweredBy: true,
        // HSTS - only in production with HTTPS
        hsts: process.env.NODE_ENV === 'production' ? {
            maxAge: 31536000,  // 1 year
            includeSubDomains: true
        } : false,
        // Referrer Policy
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
    });
}

/**
 * Configure general rate limiting
 */
function configureRateLimit() {
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;  // 15 minutes
    const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

    return rateLimit({
        windowMs,
        max,
        message: {
            error: 'Too many requests, please try again later',
            code: 'RATE_LIMITED',
            retryAfter: Math.ceil(windowMs / 1000)
        },
        standardHeaders: true,  // Return rate limit info in headers
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                method: req.method
            });
            res.status(429).json(options.message);
        },
        skip: (req) => {
            // Skip rate limiting for health checks
            if (req.path === '/api/health') return true;
            // Skip for AI autofill — authenticated batch operations that make
            // server-side API calls; throttled by Claude API limits, not ours
            if (req.path.startsWith('/api/ai-autofill/')) return true;
            return false;
        }
    });
}

/**
 * Configure stricter rate limiting for login attempts
 */
function configureLoginRateLimit() {
    const max = parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 5;

    return rateLimit({
        windowMs: 15 * 60 * 1000,  // 15 minutes
        max,
        message: {
            error: 'Too many login attempts, please try again in 15 minutes',
            code: 'LOGIN_RATE_LIMITED'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Login rate limit exceeded', {
                ip: req.ip,
                email: req.body?.email
            });
            res.status(429).json(options.message);
        },
        // Use email + IP as key to prevent targeted attacks
        keyGenerator: (req) => {
            const email = req.body?.email || '';
            return `${req.ip}-${email}`;
        }
    });
}

/**
 * Configure rate limiting for delivery API endpoints
 * More restrictive for expensive operations (route generation, sync)
 */
function configureDeliveryRateLimit() {
    return rateLimit({
        windowMs: 1 * 60 * 1000,  // 1 minute window
        max: 30,  // 30 requests per minute for general delivery endpoints
        message: {
            error: 'Too many delivery API requests, please slow down',
            code: 'DELIVERY_RATE_LIMITED'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Delivery rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                method: req.method,
                userId: req.session?.user?.id
            });
            res.status(429).json(options.message);
        },
        // Key by user ID if authenticated, otherwise by IP
        keyGenerator: (req) => {
            return req.session?.user?.id ? `user-${req.session.user.id}` : req.ip;
        }
    });
}

/**
 * Configure strict rate limiting for expensive delivery operations
 * (route generation, Square sync, bulk geocoding)
 */
function configureDeliveryStrictRateLimit() {
    return rateLimit({
        windowMs: 5 * 60 * 1000,  // 5 minute window
        max: 10,  // 10 expensive operations per 5 minutes
        message: {
            error: 'Too many route/sync operations, please wait before trying again',
            code: 'DELIVERY_OPERATION_RATE_LIMITED'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Delivery strict rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                userId: req.session?.user?.id
            });
            res.status(429).json(options.message);
        },
        keyGenerator: (req) => {
            return req.session?.user?.id ? `user-${req.session.user.id}` : req.ip;
        }
    });
}

/**
 * Configure rate limiting for sensitive operations
 * (token regeneration, API key creation, etc.)
 * V006 fix: Prevents abuse of token generation endpoints
 */
function configureSensitiveOperationRateLimit() {
    return rateLimit({
        windowMs: 60 * 60 * 1000,  // 1 hour window
        max: 5,  // 5 token regenerations per hour per user
        message: {
            error: 'Too many token regeneration attempts, please try again later',
            code: 'TOKEN_REGEN_RATE_LIMITED'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Sensitive operation rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                userId: req.session?.user?.id,
                merchantId: req.merchantContext?.id
            });
            res.status(429).json(options.message);
        },
        keyGenerator: (req) => {
            // Key by merchant ID to prevent one merchant from regenerating too often
            return req.merchantContext?.id ? `merchant-${req.merchantContext.id}` : req.ip;
        }
    });
}

/**
 * Configure rate limiting for webhook endpoint
 * P1-8: Prevents DDoS and replay attacks on webhook processing
 */
function configureWebhookRateLimit() {
    return rateLimit({
        windowMs: 60 * 1000,  // 1 minute
        max: 100,  // 100 webhooks per minute per merchant
        message: {
            error: 'Too many webhook requests',
            code: 'WEBHOOK_RATE_LIMITED'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Webhook rate limit exceeded', {
                ip: req.ip,
                merchantId: req.body?.merchant_id || 'unknown'
            });
            res.status(429).json(options.message);
        },
        // Key by Square merchant ID from payload
        keyGenerator: (req) => {
            const merchantId = req.body?.merchant_id || req.ip;
            return `webhook-${merchantId}`;
        }
    });
}

/**
 * Configure rate limiting for password reset endpoint
 * P1-7: Prevents brute-force attacks on password reset tokens
 */
function configurePasswordResetRateLimit() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,  // 15 minutes
        max: 5,  // 5 attempts per 15 minutes per token
        message: {
            error: 'Too many password reset attempts, please try again later',
            code: 'RESET_RATE_LIMITED'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn('Password reset rate limit exceeded', {
                ip: req.ip,
                token: req.body?.token ? req.body.token.substring(0, 10) + '...' : 'none'
            });
            res.status(429).json(options.message);
        },
        // Key by token to limit attempts per reset token
        keyGenerator: (req) => {
            const token = req.body?.token || '';
            return `reset-${token.substring(0, 16)}`;  // Use first 16 chars for key
        }
    });
}

/**
 * Configure Permissions-Policy header
 * Disables access to sensitive browser features not needed by this application.
 * Helmet v7 does not include this natively, so we set it as custom middleware.
 */
function configurePermissionsPolicy() {
    const policy = [
        'geolocation=()',
        'camera=()',
        'microphone=()',
        'payment=()',
        'usb=()'
    ].join(', ');

    return (req, res, next) => {
        res.setHeader('Permissions-Policy', policy);
        next();
    };
}

/**
 * Configure CORS
 */
function configureCors() {
    // Get allowed origins from environment
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
    let allowedOrigins;

    if (allowedOriginsEnv) {
        // Parse origins: split by comma, trim whitespace, and strip any surrounding quotes
        allowedOrigins = allowedOriginsEnv
            .split(',')
            .map(origin => origin.trim().replace(/^["']|["']$/g, ''))
            .filter(origin => origin.length > 0);

        // Log configured origins on startup for debugging
        logger.info('CORS: Configured allowed origins', { origins: allowedOrigins });
    } else {
        // Default: allow same origin only (will be determined by request)
        allowedOrigins = null;
    }

    return cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (same-origin, Postman, curl, etc.)
            if (!origin) {
                return callback(null, true);
            }

            // If no specific origins configured, block in production, allow in development
            if (!allowedOrigins) {
                if (process.env.NODE_ENV === 'production') {
                    logger.error('CORS: ALLOWED_ORIGINS must be configured in production - blocking request', { origin });
                    return callback(new Error('CORS not configured for production'), false);
                }
                // Development mode - allow all origins with warning
                logger.warn('CORS: Development mode - allowing all origins. Configure ALLOWED_ORIGINS for production.');
                return callback(null, true);
            }

            // Check if origin is in allowed list
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            // Origin not allowed - log with more context for debugging
            logger.warn('CORS: Origin not allowed', {
                origin,
                allowedOrigins,
                hint: 'Check ALLOWED_ORIGINS in .env - remove quotes if present'
            });
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,  // Allow cookies
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
        maxAge: 86400  // Cache preflight for 24 hours
    });
}

/**
 * Error handler for CORS errors
 */
function corsErrorHandler(err, req, res, next) {
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({
            error: 'Cross-origin request blocked',
            code: 'CORS_ERROR'
        });
    }
    next(err);
}

module.exports = {
    configureHelmet,
    configurePermissionsPolicy,
    configureRateLimit,
    configureLoginRateLimit,
    configurePasswordResetRateLimit,
    configureWebhookRateLimit,
    configureDeliveryRateLimit,
    configureDeliveryStrictRateLimit,
    configureSensitiveOperationRateLimit,
    configureCors,
    corsErrorHandler
};
