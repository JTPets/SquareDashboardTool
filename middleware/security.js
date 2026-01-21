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
    return helmet({
        // Content Security Policy - permissive but still provides protection
        // Allows inline scripts/styles for compatibility but blocks external malicious sources
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],  // Required for inline handlers
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],  // Allow images from HTTPS sources
                connectSrc: [
                    "'self'",
                    "https://connect.squareup.com",
                    "https://connect.squareupsandbox.com"
                ],
                frameSrc: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
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
            return req.path === '/api/health';
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
 * Configure CORS
 */
function configureCors() {
    // Get allowed origins from environment
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
    let allowedOrigins;

    if (allowedOriginsEnv) {
        allowedOrigins = allowedOriginsEnv.split(',').map(origin => origin.trim());
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

            // Origin not allowed
            logger.warn('CORS: Origin not allowed', { origin, allowedOrigins });
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
    configureRateLimit,
    configureLoginRateLimit,
    configureDeliveryRateLimit,
    configureDeliveryStrictRateLimit,
    configureSensitiveOperationRateLimit,
    configureCors,
    corsErrorHandler
};
