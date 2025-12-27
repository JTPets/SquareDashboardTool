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
        // Disable CSP for now - causing issues with Cloudflare
        // TODO: Configure proper CSP that works with the app
        contentSecurityPolicy: false,
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

            // If no specific origins configured, allow all (development mode)
            if (!allowedOrigins) {
                if (process.env.NODE_ENV === 'production') {
                    logger.warn('CORS: No ALLOWED_ORIGINS configured in production');
                }
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
    configureCors,
    corsErrorHandler
};
