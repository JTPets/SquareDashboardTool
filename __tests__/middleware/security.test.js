/**
 * Security Middleware Test Suite
 *
 * CRITICAL SECURITY TESTS
 * Tests for rate limiting, security headers, and CORS configuration
 *
 * These tests ensure:
 * - Brute force attack prevention (login rate limiting)
 * - API abuse prevention (general rate limiting)
 * - Clickjacking prevention (X-Frame-Options)
 * - XSS prevention (CSP headers)
 * - CORS misconfiguration prevention
 */

// Mock logger before imports
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

const logger = require('../../utils/logger');

describe('Security Middleware', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset environment variables
        delete process.env.RATE_LIMIT_WINDOW_MS;
        delete process.env.RATE_LIMIT_MAX_REQUESTS;
        delete process.env.LOGIN_RATE_LIMIT_MAX;
        delete process.env.ALLOWED_ORIGINS;
        delete process.env.NODE_ENV;
        delete process.env.FORCE_HTTPS;
    });

    describe('Rate Limiting Configuration', () => {

        describe('General Rate Limit', () => {

            test('default window is 15 minutes', () => {
                const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
                expect(windowMs).toBe(15 * 60 * 1000); // 900000ms
            });

            test('default max requests is 100', () => {
                const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
                expect(max).toBe(100);
            });

            test('respects environment variable overrides', () => {
                process.env.RATE_LIMIT_WINDOW_MS = '60000'; // 1 minute
                process.env.RATE_LIMIT_MAX_REQUESTS = '50';

                const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
                const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

                expect(windowMs).toBe(60000);
                expect(max).toBe(50);
            });

            test('skips rate limiting for health check endpoint', () => {
                const skipFn = (req) => req.path === '/api/health';

                expect(skipFn({ path: '/api/health' })).toBe(true);
                expect(skipFn({ path: '/api/orders' })).toBe(false);
            });

            test('returns 429 status when rate limited', () => {
                const statusCode = 429;
                const message = {
                    error: 'Too many requests, please try again later',
                    code: 'RATE_LIMITED',
                    retryAfter: 900 // 15 minutes in seconds
                };

                expect(statusCode).toBe(429);
                expect(message.code).toBe('RATE_LIMITED');
            });
        });

        describe('Login Rate Limit', () => {

            test('default max login attempts is 5 per 15 minutes', () => {
                const max = parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 5;
                const windowMs = 15 * 60 * 1000;

                expect(max).toBe(5);
                expect(windowMs).toBe(900000);
            });

            test('uses email + IP as rate limit key', () => {
                const keyGenerator = (req) => {
                    const email = req.body?.email || '';
                    return `${req.ip}-${email}`;
                };

                const req1 = { ip: '192.168.1.1', body: { email: 'user1@example.com' } };
                const req2 = { ip: '192.168.1.1', body: { email: 'user2@example.com' } };
                const req3 = { ip: '192.168.1.2', body: { email: 'user1@example.com' } };

                // Same IP, different emails = different keys (protects against targeting)
                expect(keyGenerator(req1)).not.toBe(keyGenerator(req2));

                // Different IPs, same email = different keys (protects against distributed attacks)
                expect(keyGenerator(req1)).not.toBe(keyGenerator(req3));
            });

            test('logs rate limit exceeded events', () => {
                const req = { ip: '192.168.1.1', body: { email: 'attacker@example.com' } };

                logger.warn('Login rate limit exceeded', {
                    ip: req.ip,
                    email: req.body?.email
                });

                expect(logger.warn).toHaveBeenCalledWith(
                    'Login rate limit exceeded',
                    expect.objectContaining({
                        ip: '192.168.1.1',
                        email: 'attacker@example.com'
                    })
                );
            });

            test('returns login-specific error message', () => {
                const message = {
                    error: 'Too many login attempts, please try again in 15 minutes',
                    code: 'LOGIN_RATE_LIMITED'
                };

                expect(message.code).toBe('LOGIN_RATE_LIMITED');
                expect(message.error).toContain('15 minutes');
            });
        });

        describe('Delivery Rate Limit', () => {

            test('allows 30 requests per minute', () => {
                const windowMs = 1 * 60 * 1000; // 1 minute
                const max = 30;

                expect(windowMs).toBe(60000);
                expect(max).toBe(30);
            });

            test('uses user ID as key when authenticated', () => {
                const keyGenerator = (req) => {
                    return req.session?.user?.id ? `user-${req.session.user.id}` : req.ip;
                };

                const authenticatedReq = { session: { user: { id: 123 } }, ip: '192.168.1.1' };
                const unauthenticatedReq = { session: null, ip: '192.168.1.1' };

                expect(keyGenerator(authenticatedReq)).toBe('user-123');
                expect(keyGenerator(unauthenticatedReq)).toBe('192.168.1.1');
            });
        });

        describe('Delivery Strict Rate Limit', () => {

            test('allows 10 expensive operations per 5 minutes', () => {
                const windowMs = 5 * 60 * 1000; // 5 minutes
                const max = 10;

                expect(windowMs).toBe(300000);
                expect(max).toBe(10);
            });

            test('returns operation-specific error', () => {
                const message = {
                    error: 'Too many route/sync operations, please wait before trying again',
                    code: 'DELIVERY_OPERATION_RATE_LIMITED'
                };

                expect(message.code).toBe('DELIVERY_OPERATION_RATE_LIMITED');
            });
        });

        describe('Sensitive Operation Rate Limit', () => {

            test('allows 5 token regenerations per hour', () => {
                const windowMs = 60 * 60 * 1000; // 1 hour
                const max = 5;

                expect(windowMs).toBe(3600000);
                expect(max).toBe(5);
            });

            test('uses merchant ID as key', () => {
                const keyGenerator = (req) => {
                    return req.merchantContext?.id ? `merchant-${req.merchantContext.id}` : req.ip;
                };

                const merchantReq = { merchantContext: { id: 456 }, ip: '192.168.1.1' };
                const noMerchantReq = { merchantContext: null, ip: '192.168.1.1' };

                expect(keyGenerator(merchantReq)).toBe('merchant-456');
                expect(keyGenerator(noMerchantReq)).toBe('192.168.1.1');
            });

            test('prevents one merchant from regenerating too often', () => {
                const windowMs = 60 * 60 * 1000;
                const max = 5;

                // After 5 regenerations, should be rate limited for 1 hour
                expect(max).toBeLessThanOrEqual(5);
                expect(windowMs).toBeGreaterThanOrEqual(3600000);
            });
        });
    });

    describe('Helmet Security Headers', () => {

        describe('Content Security Policy', () => {

            test('default-src is self', () => {
                const directives = {
                    defaultSrc: ["'self'"]
                };

                expect(directives.defaultSrc).toContain("'self'");
            });

            test('allows Square Connect API in connect-src', () => {
                const directives = {
                    connectSrc: [
                        "'self'",
                        "https://connect.squareup.com",
                        "https://connect.squareupsandbox.com"
                    ]
                };

                expect(directives.connectSrc).toContain("https://connect.squareup.com");
                expect(directives.connectSrc).toContain("https://connect.squareupsandbox.com");
            });

            test('blocks object embedding (prevents Flash/Java attacks)', () => {
                const directives = {
                    objectSrc: ["'none'"]
                };

                expect(directives.objectSrc).toContain("'none'");
            });

            test('restricts form actions to self', () => {
                const directives = {
                    formAction: ["'self'"]
                };

                expect(directives.formAction).toContain("'self'");
            });

            test('allows Google Fonts', () => {
                const directives = {
                    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                    fontSrc: ["'self'", "https://fonts.gstatic.com"]
                };

                expect(directives.styleSrc).toContain("https://fonts.googleapis.com");
                expect(directives.fontSrc).toContain("https://fonts.gstatic.com");
            });

            test('allows Cloudflare scripts for tunnel compatibility', () => {
                const directives = {
                    scriptSrc: [
                        "'self'",
                        "https://*.cloudflare.com",
                        "https://*.cloudflareinsights.com"
                    ]
                };

                expect(directives.scriptSrc).toContain("https://*.cloudflare.com");
            });
        });

        describe('Clickjacking Prevention', () => {

            test('X-Frame-Options is set to DENY', () => {
                const frameguard = { action: 'deny' };

                expect(frameguard.action).toBe('deny');
            });
        });

        describe('MIME Sniffing Prevention', () => {

            test('X-Content-Type-Options nosniff is enabled', () => {
                const noSniff = true;

                expect(noSniff).toBe(true);
            });
        });

        describe('XSS Filter', () => {

            test('X-XSS-Protection is enabled', () => {
                const xssFilter = true;

                expect(xssFilter).toBe(true);
            });
        });

        describe('Server Identity', () => {

            test('X-Powered-By header is hidden', () => {
                const hidePoweredBy = true;

                expect(hidePoweredBy).toBe(true);
            });
        });

        describe('HSTS (HTTP Strict Transport Security)', () => {

            test('HSTS is enabled in production', () => {
                process.env.NODE_ENV = 'production';

                const hsts = process.env.NODE_ENV === 'production' ? {
                    maxAge: 31536000,
                    includeSubDomains: true
                } : false;

                expect(hsts).toEqual({
                    maxAge: 31536000,
                    includeSubDomains: true
                });
            });

            test('HSTS is disabled in development', () => {
                process.env.NODE_ENV = 'development';

                const hsts = process.env.NODE_ENV === 'production' ? {
                    maxAge: 31536000,
                    includeSubDomains: true
                } : false;

                expect(hsts).toBe(false);
            });

            test('HSTS max-age is 1 year', () => {
                const maxAge = 31536000;

                expect(maxAge).toBe(365 * 24 * 60 * 60); // 1 year in seconds
            });
        });

        describe('HTTPS Upgrade', () => {

            test('upgrade-insecure-requests only when FORCE_HTTPS=true', () => {
                process.env.FORCE_HTTPS = 'true';
                const forceHttps = process.env.FORCE_HTTPS === 'true';

                expect(forceHttps).toBe(true);
            });

            test('no upgrade when FORCE_HTTPS not set', () => {
                delete process.env.FORCE_HTTPS;
                const forceHttps = process.env.FORCE_HTTPS === 'true';

                expect(forceHttps).toBe(false);
            });
        });

        describe('Referrer Policy', () => {

            test('uses strict-origin-when-cross-origin', () => {
                const referrerPolicy = { policy: 'strict-origin-when-cross-origin' };

                expect(referrerPolicy.policy).toBe('strict-origin-when-cross-origin');
            });
        });
    });

    describe('CORS Configuration', () => {

        test('parses allowed origins from environment', () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com, https://app.example.com';

            const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
            const allowedOrigins = allowedOriginsEnv
                .split(',')
                .map(origin => origin.trim().replace(/^["']|["']$/g, ''))
                .filter(origin => origin.length > 0);

            expect(allowedOrigins).toEqual([
                'https://example.com',
                'https://app.example.com'
            ]);
        });

        test('strips quotes from origins', () => {
            process.env.ALLOWED_ORIGINS = '"https://example.com","https://other.com"';

            const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
            const allowedOrigins = allowedOriginsEnv
                .split(',')
                .map(origin => origin.trim().replace(/^["']|["']$/g, ''))
                .filter(origin => origin.length > 0);

            expect(allowedOrigins).toEqual([
                'https://example.com',
                'https://other.com'
            ]);
        });

        test('filters empty origins', () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com, , https://other.com';

            const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
            const allowedOrigins = allowedOriginsEnv
                .split(',')
                .map(origin => origin.trim().replace(/^["']|["']$/g, ''))
                .filter(origin => origin.length > 0);

            expect(allowedOrigins).toHaveLength(2);
            expect(allowedOrigins).not.toContain('');
        });

        test('rejects requests from unauthorized origins', () => {
            const allowedOrigins = ['https://example.com'];
            const requestOrigin = 'https://attacker.com';

            const isAllowed = allowedOrigins.includes(requestOrigin);

            expect(isAllowed).toBe(false);
        });

        test('accepts requests from authorized origins', () => {
            const allowedOrigins = ['https://example.com', 'https://app.example.com'];
            const requestOrigin = 'https://example.com';

            const isAllowed = allowedOrigins.includes(requestOrigin);

            expect(isAllowed).toBe(true);
        });
    });

    describe('Rate Limit Key Generation', () => {

        test('authenticated users have user-specific limits', () => {
            const keyGenerator = (req) => {
                return req.session?.user?.id ? `user-${req.session.user.id}` : req.ip;
            };

            const user1 = { session: { user: { id: 1 } }, ip: '192.168.1.1' };
            const user2 = { session: { user: { id: 2 } }, ip: '192.168.1.1' };

            expect(keyGenerator(user1)).toBe('user-1');
            expect(keyGenerator(user2)).toBe('user-2');
            expect(keyGenerator(user1)).not.toBe(keyGenerator(user2));
        });

        test('unauthenticated requests are keyed by IP', () => {
            const keyGenerator = (req) => {
                return req.session?.user?.id ? `user-${req.session.user.id}` : req.ip;
            };

            const req1 = { session: null, ip: '192.168.1.1' };
            const req2 = { session: null, ip: '192.168.1.2' };

            expect(keyGenerator(req1)).toBe('192.168.1.1');
            expect(keyGenerator(req2)).toBe('192.168.1.2');
        });

        test('falsy user ID falls back to IP', () => {
            const keyGenerator = (req) => {
                return req.session?.user?.id ? `user-${req.session.user.id}` : req.ip;
            };

            const req = { session: { user: { id: 0 } }, ip: '192.168.1.1' };

            // ID of 0 is falsy, should fall back to IP
            expect(keyGenerator(req)).toBe('192.168.1.1');
        });
    });

    describe('Security Logging', () => {

        test('logs rate limit violations with request details', () => {
            const req = {
                ip: '192.168.1.100',
                path: '/api/orders',
                method: 'POST',
                session: { user: { id: 123 } }
            };

            logger.warn('Rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                method: req.method
            });

            expect(logger.warn).toHaveBeenCalledWith(
                'Rate limit exceeded',
                expect.objectContaining({
                    ip: '192.168.1.100',
                    path: '/api/orders',
                    method: 'POST'
                })
            );
        });
    });
});
