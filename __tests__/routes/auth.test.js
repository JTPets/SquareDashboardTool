/**
 * Authentication Routes Test Suite
 *
 * Tests routes/auth.js endpoints via supertest:
 * - POST /api/auth/login
 * - POST /api/auth/logout
 * - GET  /api/auth/me
 * - POST /api/auth/change-password
 * - GET  /api/auth/users (admin)
 * - POST /api/auth/users (admin)
 * - PUT  /api/auth/users/:id (admin)
 * - POST /api/auth/users/:id/reset-password (admin)
 * - POST /api/auth/users/:id/unlock (admin)
 * - POST /api/auth/forgot-password (public)
 * - POST /api/auth/reset-password (public)
 * - GET  /api/auth/verify-reset-token (public)
 */

// ============================================================================
// MOCK SETUP
// ============================================================================

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../utils/password', () => ({
    hashPassword: jest.fn().mockResolvedValue('$2b$10$hashedpassword'),
    verifyPassword: jest.fn(),
    validatePassword: jest.fn().mockReturnValue({ valid: true, errors: [] }),
    generateRandomPassword: jest.fn().mockReturnValue('GenPass123!'),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    },
    requireAdmin: (req, res, next) => {
        if (req.session?.user?.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    },
    logAuthEvent: jest.fn().mockResolvedValue(undefined),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));

jest.mock('../../middleware/security', () => ({
    configureLoginRateLimit: () => (req, res, next) => next(),
    configurePasswordResetRateLimit: () => (req, res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const db = require('../../utils/database');
const { verifyPassword, hashPassword, generateRandomPassword } = require('../../utils/password');
const { logAuthEvent } = require('../../middleware/auth');

// ============================================================================
// TEST APP SETUP
// ============================================================================

function createTestApp(opts = {}) {
    const {
        authenticated = false,
        isAdmin = false,
        activeMerchantId = null,
        userId = 1,
    } = opts;
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));

    app.use((req, res, next) => {
        if (authenticated) {
            req.session.user = {
                id: userId,
                email: 'admin@test.com',
                name: 'Test Admin',
                role: isAdmin ? 'admin' : 'user',
            };
        }
        if (activeMerchantId) {
            req.session.activeMerchantId = activeMerchantId;
        }
        // Stub session methods the login route needs
        if (!req.session.regenerate) {
            req.session.regenerate = function (cb) { cb(null); };
        }
        if (!req.session.save) {
            req.session.save = function (cb) { cb(null); };
        }
        next();
    });

    const authRoutes = require('../../routes/auth');
    app.use('/api/auth', authRoutes);

    // Error handler
    app.use((err, req, res, _next) => {
        res.status(500).json({ error: err.message });
    });

    return app;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Auth Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ========================================================================
    // POST /api/auth/login
    // ========================================================================

    describe('POST /api/auth/login', () => {

        it('returns 400 for missing email', async () => {
            const app = createTestApp();
            const res = await request(app)
                .post('/api/auth/login')
                .send({ password: 'Test1234!' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Validation failed');
        });

        it('returns 400 for missing password', async () => {
            const app = createTestApp();
            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user@test.com' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Validation failed');
        });

        it('returns 401 for non-existent user (prevents enumeration)', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'nobody@test.com', password: 'Test1234!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Invalid email or password');
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'login_failed',
                details: { reason: 'user_not_found' },
            }));
        });

        it('returns 401 for inactive account', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, email: 'inactive@test.com', is_active: false }],
            });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'inactive@test.com', password: 'Test1234!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('This account has been deactivated');
        });

        it('returns 401 for locked account with remaining time', async () => {
            const app = createTestApp();
            const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1, email: 'locked@test.com', is_active: true,
                    locked_until: lockedUntil.toISOString(),
                }],
            });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'locked@test.com', password: 'Test1234!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toMatch(/Account is locked/);
        });

        it('returns 401 for wrong password and increments attempts', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 5, email: 'user@test.com', is_active: true,
                    locked_until: null, password_hash: '$2b$10$hash',
                    failed_login_attempts: 2,
                }],
            });
            verifyPassword.mockResolvedValueOnce(false);
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE failed_login_attempts

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user@test.com', password: 'WrongPass1!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Invalid email or password');
            // Should increment attempts from 2 to 3
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE users SET failed_login_attempts'),
                [3, null, 5]
            );
        });

        it('locks account after 5th failed attempt', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 5, email: 'user@test.com', is_active: true,
                    locked_until: null, password_hash: '$2b$10$hash',
                    failed_login_attempts: 4,
                }],
            });
            verifyPassword.mockResolvedValueOnce(false);
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user@test.com', password: 'WrongPass1!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toMatch(/Too many failed attempts/);
            // locked_until should be set (not null)
            const updateCall = db.query.mock.calls[1];
            expect(updateCall[1][0]).toBe(5); // newFailedAttempts
            expect(updateCall[1][1]).toBeInstanceOf(Date); // lockUntil
        });

        it('succeeds with valid credentials', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 10, email: 'user@test.com', name: 'User',
                    role: 'user', is_active: true, locked_until: null,
                    password_hash: '$2b$10$hash', failed_login_attempts: 0,
                }],
            });
            verifyPassword.mockResolvedValueOnce(true);
            db.query.mockResolvedValueOnce({ rows: [] }); // reset attempts

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user@test.com', password: 'Valid1234!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.user).toEqual({
                id: 10, email: 'user@test.com', name: 'User', role: 'user',
            });
        });

        it('normalizes email to lowercase', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app)
                .post('/api/auth/login')
                .send({ email: 'USER@TEST.COM', password: 'Test1234!' });

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('SELECT'),
                ['user@test.com']
            );
        });

        it('allows login after lockout period expires', async () => {
            const app = createTestApp();
            const expiredLock = new Date(Date.now() - 5 * 60 * 1000);
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1, email: 'user@test.com', is_active: true,
                    locked_until: expiredLock.toISOString(),
                    password_hash: '$2b$10$hash', failed_login_attempts: 5,
                }],
            });
            verifyPassword.mockResolvedValueOnce(true);
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user@test.com', password: 'Valid1234!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ========================================================================
    // POST /api/auth/logout
    // ========================================================================

    describe('POST /api/auth/logout', () => {

        it('succeeds and clears session for authenticated user', async () => {
            const app = createTestApp({ authenticated: true });

            const res = await request(app)
                .post('/api/auth/logout');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'logout',
            }));
        });

        it('succeeds even without session (anonymous user)', async () => {
            const app = createTestApp({ authenticated: false });

            const res = await request(app)
                .post('/api/auth/logout');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(logAuthEvent).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // GET /api/auth/me
    // ========================================================================

    describe('GET /api/auth/me', () => {

        it('returns user info when authenticated', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true });

            const res = await request(app).get('/api/auth/me');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.authenticated).toBe(true);
            expect(res.body.user).toMatchObject({
                id: 1,
                email: 'admin@test.com',
                role: 'admin',
            });
        });

        it('returns 401 when not authenticated', async () => {
            const app = createTestApp({ authenticated: false });

            const res = await request(app).get('/api/auth/me');

            expect(res.status).toBe(401);
            expect(res.body.authenticated).toBe(false);
        });
    });

    // ========================================================================
    // POST /api/auth/change-password
    // ========================================================================

    describe('POST /api/auth/change-password', () => {

        it('returns 401 when not authenticated', async () => {
            const app = createTestApp({ authenticated: false });

            const res = await request(app)
                .post('/api/auth/change-password')
                .send({ currentPassword: 'Old1234!', newPassword: 'New1234!' });

            expect(res.status).toBe(401);
        });

        it('returns 400 for missing fields', async () => {
            const app = createTestApp({ authenticated: true });

            const res = await request(app)
                .post('/api/auth/change-password')
                .send({});

            expect(res.status).toBe(400);
        });

        it('returns 401 if current password is wrong', async () => {
            const app = createTestApp({ authenticated: true });
            db.query.mockResolvedValueOnce({
                rows: [{ password_hash: '$2b$10$hash' }],
            });
            verifyPassword.mockResolvedValueOnce(false);

            const res = await request(app)
                .post('/api/auth/change-password')
                .send({ currentPassword: 'Wrong1234!', newPassword: 'New12345!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Current password is incorrect');
        });

        it('returns 404 if user not found in DB', async () => {
            const app = createTestApp({ authenticated: true });
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/auth/change-password')
                .send({ currentPassword: 'Old1234!', newPassword: 'New12345!' });

            expect(res.status).toBe(404);
        });

        it('succeeds with valid current and new password', async () => {
            const app = createTestApp({ authenticated: true });
            db.query.mockResolvedValueOnce({
                rows: [{ password_hash: '$2b$10$oldhash' }],
            });
            verifyPassword.mockResolvedValueOnce(true);
            hashPassword.mockResolvedValueOnce('$2b$10$newhash');
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

            const res = await request(app)
                .post('/api/auth/change-password')
                .send({ currentPassword: 'Old1234!', newPassword: 'New12345!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'password_change',
            }));
        });
    });

    // ========================================================================
    // ADMIN ROUTES — GET /api/auth/users
    // ========================================================================

    describe('GET /api/auth/users', () => {

        it('returns 401 when not authenticated', async () => {
            const app = createTestApp({ authenticated: false });
            const res = await request(app).get('/api/auth/users');
            expect(res.status).toBe(401);
        });

        it('returns 403 when not admin', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: false });
            const res = await request(app).get('/api/auth/users');
            expect(res.status).toBe(403);
        });

        it('returns 403 when no active merchant', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: null });
            const res = await request(app).get('/api/auth/users');
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('No active merchant selected');
        });

        it('returns merchant-scoped user list', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 42 });
            db.query.mockResolvedValueOnce({
                rows: [
                    { id: 1, email: 'admin@test.com', name: 'Admin', role: 'admin', merchant_role: 'admin' },
                    { id: 2, email: 'user@test.com', name: 'User', role: 'user', merchant_role: 'user' },
                ],
            });

            const res = await request(app).get('/api/auth/users');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.users).toHaveLength(2);
            // Verify merchant scoping
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('um.merchant_id = $1'),
                [42]
            );
        });
    });

    // ========================================================================
    // ADMIN ROUTES — POST /api/auth/users
    // ========================================================================

    describe('POST /api/auth/users', () => {

        it('returns 403 when no active merchant', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: null });
            const res = await request(app)
                .post('/api/auth/users')
                .send({ email: 'new@test.com', name: 'New User' });
            expect(res.status).toBe(403);
        });

        it('returns 400 for duplicate email', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // existing user

            const res = await request(app)
                .post('/api/auth/users')
                .send({ email: 'existing@test.com', name: 'Dup' });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/already exists/);
        });

        it('creates user with generated password when none provided', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [] }); // no duplicate
            generateRandomPassword.mockReturnValueOnce('RandPass99!');
            hashPassword.mockResolvedValueOnce('$2b$10$hashed');
            const newUser = { id: 50, email: 'new@test.com', name: 'New', role: 'user', created_at: '2026-01-01' };
            db.transaction.mockImplementation(async (cb) => {
                const fakeClient = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ rows: [newUser] }) // INSERT user
                        .mockResolvedValueOnce({ rows: [] }), // INSERT user_merchants
                };
                return cb(fakeClient);
            });

            const res = await request(app)
                .post('/api/auth/users')
                .send({ email: 'new@test.com', name: 'New' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.generatedPassword).toBe('RandPass99!');
            expect(res.body.user.id).toBe(50);
        });

        it('creates user with provided password (no generated password in response)', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [] });
            hashPassword.mockResolvedValueOnce('$2b$10$hashed');
            const newUser = { id: 51, email: 'new2@test.com', name: 'New2', role: 'admin', created_at: '2026-01-01' };
            db.transaction.mockImplementation(async (cb) => {
                const fakeClient = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ rows: [newUser] })
                        .mockResolvedValueOnce({ rows: [] }),
                };
                return cb(fakeClient);
            });

            const res = await request(app)
                .post('/api/auth/users')
                .send({ email: 'new2@test.com', name: 'New2', role: 'admin', password: 'Explicit1!' });

            expect(res.status).toBe(200);
            expect(res.body.generatedPassword).toBeUndefined();
        });

        it('returns 400 for invalid role', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });

            const res = await request(app)
                .post('/api/auth/users')
                .send({ email: 'new@test.com', role: 'superadmin' });

            expect(res.status).toBe(400);
        });

        it('links new user to admin merchant via transaction', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 7 });
            db.query.mockResolvedValueOnce({ rows: [] });
            hashPassword.mockResolvedValueOnce('$2b$10$h');
            const fakeClient = { query: jest.fn() };
            fakeClient.query
                .mockResolvedValueOnce({ rows: [{ id: 60, email: 'a@b.com', name: 'A', role: 'user', created_at: '' }] })
                .mockResolvedValueOnce({ rows: [] });
            db.transaction.mockImplementation(async (cb) => cb(fakeClient));

            await request(app)
                .post('/api/auth/users')
                .send({ email: 'a@b.com', name: 'A' });

            // Second client query should be the user_merchants INSERT
            expect(fakeClient.query).toHaveBeenCalledWith(
                expect.stringContaining('user_merchants'),
                [60, 7, 'user']
            );
        });
    });

    // ========================================================================
    // ADMIN ROUTES — PUT /api/auth/users/:id
    // ========================================================================

    describe('PUT /api/auth/users/:id', () => {

        it('returns 404 if user not in merchant', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [] }); // user_merchants check

            const res = await request(app)
                .put('/api/auth/users/99')
                .send({ name: 'Updated' });

            expect(res.status).toBe(404);
        });

        it('prevents admin from deactivating themselves', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1, userId: 5 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'admin@test.com' }] });

            const res = await request(app)
                .put('/api/auth/users/5')
                .send({ is_active: false });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/cannot deactivate your own/);
        });

        it('returns 400 when no fields to update', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 2, email: 'u@t.com' }] });

            const res = await request(app)
                .put('/api/auth/users/2')
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/No fields to update/);
        });

        it('updates user name and role', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 2, email: 'u@t.com' }] }); // exists check
            db.query.mockResolvedValueOnce({
                rows: [{ id: 2, email: 'u@t.com', name: 'Updated', role: 'admin', is_active: true }],
            });

            const res = await request(app)
                .put('/api/auth/users/2')
                .send({ name: 'Updated', role: 'admin' });

            expect(res.status).toBe(200);
            expect(res.body.user.name).toBe('Updated');
            expect(res.body.user.role).toBe('admin');
        });

        it('deactivation logs user_deactivated event', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1, userId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 99, email: 'victim@t.com' }] });
            db.query.mockResolvedValueOnce({
                rows: [{ id: 99, email: 'victim@t.com', is_active: false }],
            });

            await request(app)
                .put('/api/auth/users/99')
                .send({ is_active: false });

            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'user_deactivated',
            }));
        });
    });

    // ========================================================================
    // ADMIN ROUTES — POST /api/auth/users/:id/reset-password
    // ========================================================================

    describe('POST /api/auth/users/:id/reset-password', () => {

        it('returns 403 when no active merchant', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: null });
            const res = await request(app).post('/api/auth/users/2/reset-password');
            expect(res.status).toBe(403);
        });

        it('returns 404 if user not in merchant', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app).post('/api/auth/users/99/reset-password');
            expect(res.status).toBe(404);
        });

        it('generates password when none provided', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 2, email: 'u@t.com' }] });
            generateRandomPassword.mockReturnValueOnce('AutoGen1!');
            hashPassword.mockResolvedValueOnce('$2b$10$h');
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

            const res = await request(app).post('/api/auth/users/2/reset-password');

            expect(res.status).toBe(200);
            expect(res.body.generatedPassword).toBe('AutoGen1!');
        });

        it('resets lockout when password is reset', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ id: 2, email: 'u@t.com' }] });
            hashPassword.mockResolvedValueOnce('$2b$10$h');
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app).post('/api/auth/users/2/reset-password');

            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('failed_login_attempts = 0');
            expect(updateCall[0]).toContain('locked_until = NULL');
        });
    });

    // ========================================================================
    // ADMIN ROUTES — POST /api/auth/users/:id/unlock
    // ========================================================================

    describe('POST /api/auth/users/:id/unlock', () => {

        it('returns 404 if user not in merchant', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [] }); // member check

            const res = await request(app).post('/api/auth/users/99/unlock');
            expect(res.status).toBe(404);
        });

        it('unlocks user and resets failed attempts', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ user_id: 5 }] }); // member check
            db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'locked@t.com' }] }); // UPDATE

            const res = await request(app).post('/api/auth/users/5/unlock');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'account_unlocked',
            }));
        });

        it('returns 404 if UPDATE finds no matching user', async () => {
            const app = createTestApp({ authenticated: true, isAdmin: true, activeMerchantId: 1 });
            db.query.mockResolvedValueOnce({ rows: [{ user_id: 5 }] }); // member check passes
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE returns empty

            const res = await request(app).post('/api/auth/users/5/unlock');
            expect(res.status).toBe(404);
        });
    });

    // ========================================================================
    // PUBLIC — POST /api/auth/forgot-password
    // ========================================================================

    describe('POST /api/auth/forgot-password', () => {

        it('returns success even if email not found (anti-enumeration)', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .post('/api/auth/forgot-password')
                .send({ email: 'nobody@test.com' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toMatch(/If an account exists/);
        });

        it('generates token and stores hashed version (SEC-7)', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'user@test.com' }] }); // find user
            db.query.mockResolvedValueOnce({ rows: [] }); // DELETE old tokens
            db.query.mockResolvedValueOnce({ rows: [] }); // INSERT new token

            const res = await request(app)
                .post('/api/auth/forgot-password')
                .send({ email: 'user@test.com' });

            expect(res.status).toBe(200);
            // Verify hashed token is stored, not plaintext
            const insertCall = db.query.mock.calls[2];
            expect(insertCall[0]).toContain('password_reset_tokens');
            const storedToken = insertCall[1][1]; // hashed token
            expect(storedToken).toHaveLength(64); // SHA-256 hex = 64 chars
        });

        it('deletes old tokens before creating new one', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'user@test.com' }] });
            db.query.mockResolvedValueOnce({ rows: [] });
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app)
                .post('/api/auth/forgot-password')
                .send({ email: 'user@test.com' });

            const deleteCall = db.query.mock.calls[1];
            expect(deleteCall[0]).toContain('DELETE FROM password_reset_tokens');
        });

        it('returns 400 for missing email', async () => {
            const app = createTestApp();

            const res = await request(app)
                .post('/api/auth/forgot-password')
                .send({});

            expect(res.status).toBe(400);
        });
    });

    // ========================================================================
    // PUBLIC — POST /api/auth/reset-password
    // ========================================================================

    describe('POST /api/auth/reset-password', () => {

        const validToken = crypto.randomBytes(32).toString('hex');

        it('returns 400 for invalid token format', async () => {
            const app = createTestApp();

            const res = await request(app)
                .post('/api/auth/reset-password')
                .send({ token: 'short', newPassword: 'NewPass123!' });

            expect(res.status).toBe(400);
        });

        it('returns 400 for expired or invalid token', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] }); // token not found
            db.query.mockResolvedValueOnce({ rows: [] }); // exhausted check

            const res = await request(app)
                .post('/api/auth/reset-password')
                .send({ token: validToken, newPassword: 'NewPass123!' });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Invalid or expired/);
        });

        it('succeeds with valid token and resets password', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1, user_id: 5, token: 'hashed',
                    expires_at: new Date(Date.now() + 3600000),
                    attempts_remaining: 5, email: 'user@test.com',
                }],
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // decrement attempts
            hashPassword.mockResolvedValueOnce('$2b$10$newhash');
            db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE user password
            db.query.mockResolvedValueOnce({ rows: [] }); // mark token used

            const res = await request(app)
                .post('/api/auth/reset-password')
                .send({ token: validToken, newPassword: 'NewPass123!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            // Verify password was updated and lockout cleared
            const passwordUpdate = db.query.mock.calls[2];
            expect(passwordUpdate[0]).toContain('failed_login_attempts = 0');
            expect(passwordUpdate[0]).toContain('locked_until = NULL');
        });

        it('decrements attempts_remaining before processing', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 7, user_id: 5, attempts_remaining: 3, email: 'u@t.com',
                }],
            });
            db.query.mockResolvedValueOnce({ rows: [] }); // decrement
            hashPassword.mockResolvedValueOnce('$2b$10$h');
            db.query.mockResolvedValueOnce({ rows: [] }); // update user
            db.query.mockResolvedValueOnce({ rows: [] }); // mark used

            await request(app)
                .post('/api/auth/reset-password')
                .send({ token: validToken, newPassword: 'NewPass123!' });

            const decrementCall = db.query.mock.calls[1];
            expect(decrementCall[0]).toContain('attempts_remaining');
            expect(decrementCall[1]).toEqual([7]);
        });

        it('returns 400 when token attempts exhausted', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] }); // main query (no valid token)
            db.query.mockResolvedValueOnce({
                rows: [{ id: 1, attempts_remaining: 0 }],
            }); // exhausted check

            const res = await request(app)
                .post('/api/auth/reset-password')
                .send({ token: validToken, newPassword: 'NewPass123!' });

            expect(res.status).toBe(400);
        });
    });

    // ========================================================================
    // PUBLIC — GET /api/auth/verify-reset-token
    // ========================================================================

    describe('GET /api/auth/verify-reset-token', () => {

        const validToken = crypto.randomBytes(32).toString('hex');

        it('returns valid:false for invalid token', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            const res = await request(app)
                .get(`/api/auth/verify-reset-token?token=${validToken}`);

            expect(res.status).toBe(200);
            expect(res.body.valid).toBe(false);
        });

        it('returns valid:true with email for valid token', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: 1, email: 'user@test.com',
                    expires_at: new Date(Date.now() + 3600000),
                    attempts_remaining: 5,
                }],
            });

            const res = await request(app)
                .get(`/api/auth/verify-reset-token?token=${validToken}`);

            expect(res.status).toBe(200);
            expect(res.body.valid).toBe(true);
            expect(res.body.email).toBe('user@test.com');
        });

        it('returns 400 for missing token', async () => {
            const app = createTestApp();

            const res = await request(app)
                .get('/api/auth/verify-reset-token');

            expect(res.status).toBe(400);
        });

        it('returns 400 for non-hex token', async () => {
            const app = createTestApp();

            const res = await request(app)
                .get('/api/auth/verify-reset-token?token=not-hex-string-that-is-exactly-64-characters-long-xxxxxxxxxxxxxxxxx');

            expect(res.status).toBe(400);
        });

        it('hashes token before DB lookup (SEC-7)', async () => {
            const app = createTestApp();
            db.query.mockResolvedValueOnce({ rows: [] });

            await request(app)
                .get(`/api/auth/verify-reset-token?token=${validToken}`);

            const expectedHash = crypto.createHash('sha256').update(validToken).digest('hex');
            const queryCall = db.query.mock.calls[0];
            expect(queryCall[1]).toContain(expectedHash);
        });
    });
});
