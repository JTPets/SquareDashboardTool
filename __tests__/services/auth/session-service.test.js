'use strict';

jest.mock('../../../utils/database', () => ({ query: jest.fn() }));
jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));
jest.mock('../../../utils/password', () => ({
    verifyPassword: jest.fn(),
    hashPassword: jest.fn().mockResolvedValue('$2b$10$hashed'),
}));
jest.mock('../../../middleware/auth', () => ({
    logAuthEvent: jest.fn().mockResolvedValue(undefined),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));

const db = require('../../../utils/database');
const { verifyPassword } = require('../../../utils/password');
const { logAuthEvent } = require('../../../middleware/auth');
const { loginUser, logoutUser } = require('../../../services/auth/session-service');

const CTX = { ipAddress: '1.2.3.4', userAgent: 'test-agent' };

function makeReq() {
    return {
        headers: { 'user-agent': 'test-agent' },
        session: {
            user: null,
            regenerate: jest.fn((cb) => cb(null)),
            save: jest.fn((cb) => cb(null)),
        },
    };
}

describe('session-service', () => {
    beforeEach(() => jest.clearAllMocks());

    // ─── loginUser ────────────────────────────────────────────────────────────

    describe('loginUser', () => {
        it('throws 401 with generic message for unknown email (anti-enumeration)', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(loginUser('nobody@test.com', 'Pass1!', makeReq(), CTX))
                .rejects.toMatchObject({ message: 'Invalid email or password', statusCode: 401 });
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'login_failed',
                details: { reason: 'user_not_found' },
            }));
        });

        it('throws 401 for inactive account', async () => {
            db.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'u@t.com', is_active: false }] });
            await expect(loginUser('u@t.com', 'Pass1!', makeReq(), CTX))
                .rejects.toMatchObject({ message: 'This account has been deactivated', statusCode: 401 });
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({
                eventType: 'login_failed',
                details: { reason: 'account_inactive' },
            }));
        });

        it('throws 401 with remaining-time message for locked account', async () => {
            const locked = new Date(Date.now() + 20 * 60 * 1000);
            db.query.mockResolvedValueOnce({ rows: [{
                id: 1, email: 'u@t.com', is_active: true,
                locked_until: locked.toISOString(),
            }] });
            await expect(loginUser('u@t.com', 'Pass1!', makeReq(), CTX))
                .rejects.toMatchObject({ message: expect.stringMatching(/Account is locked/), statusCode: 401 });
        });

        it('throws same 401 generic message for wrong password (anti-enumeration)', async () => {
            db.query.mockResolvedValueOnce({ rows: [{
                id: 5, email: 'u@t.com', is_active: true, locked_until: null,
                password_hash: '$2b$', failed_login_attempts: 1,
            }] });
            verifyPassword.mockResolvedValueOnce(false);
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(loginUser('u@t.com', 'Wrong!', makeReq(), CTX))
                .rejects.toMatchObject({ message: 'Invalid email or password', statusCode: 401 });
        });

        it('increments failed_login_attempts on wrong password', async () => {
            db.query.mockResolvedValueOnce({ rows: [{
                id: 5, email: 'u@t.com', is_active: true, locked_until: null,
                password_hash: '$2b$', failed_login_attempts: 2,
            }] });
            verifyPassword.mockResolvedValueOnce(false);
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(loginUser('u@t.com', 'Wrong!', makeReq(), CTX)).rejects.toBeDefined();
            const updateCall = db.query.mock.calls[1];
            expect(updateCall[1][0]).toBe(3); // newFailedAttempts = 2+1
            expect(updateCall[1][1]).toBeNull(); // no lockout yet
        });

        it('locks account and throws specific message after MAX_FAILED_ATTEMPTS', async () => {
            db.query.mockResolvedValueOnce({ rows: [{
                id: 5, email: 'u@t.com', is_active: true, locked_until: null,
                password_hash: '$2b$', failed_login_attempts: 4,
            }] });
            verifyPassword.mockResolvedValueOnce(false);
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(loginUser('u@t.com', 'Wrong!', makeReq(), CTX))
                .rejects.toMatchObject({ message: expect.stringMatching(/Too many failed attempts/), statusCode: 401 });
            const updateCall = db.query.mock.calls[1];
            expect(updateCall[1][0]).toBe(5);           // newFailedAttempts
            expect(updateCall[1][1]).toBeInstanceOf(Date); // lockUntil set
        });

        it('returns user data and regenerates session on success', async () => {
            db.query.mockResolvedValueOnce({ rows: [{
                id: 10, email: 'u@t.com', name: 'User', role: 'user',
                is_active: true, locked_until: null,
                password_hash: '$2b$', failed_login_attempts: 0,
            }] });
            verifyPassword.mockResolvedValueOnce(true);
            db.query.mockResolvedValueOnce({ rows: [] }); // reset attempts
            const req = makeReq();
            const result = await loginUser('u@t.com', 'GoodPass1!', req, CTX);
            expect(result).toEqual({ user: { id: 10, email: 'u@t.com', name: 'User', role: 'user' } });
            expect(req.session.regenerate).toHaveBeenCalled();
            expect(req.session.save).toHaveBeenCalled();
            expect(req.session.user).toEqual({ id: 10, email: 'u@t.com', name: 'User', role: 'user' });
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'login_success' }));
        });

        it('normalizes email to lowercase before DB lookup', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });
            await expect(loginUser('USER@TEST.COM', 'Pass!', makeReq(), CTX)).rejects.toBeDefined();
            expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SELECT'), ['user@test.com']);
        });

        it('allows login after lockout period has expired', async () => {
            const expired = new Date(Date.now() - 5 * 60 * 1000);
            db.query.mockResolvedValueOnce({ rows: [{
                id: 1, email: 'u@t.com', name: 'User', role: 'user',
                is_active: true, locked_until: expired.toISOString(),
                password_hash: '$2b$', failed_login_attempts: 5,
            }] });
            verifyPassword.mockResolvedValueOnce(true);
            db.query.mockResolvedValueOnce({ rows: [] });
            const result = await loginUser('u@t.com', 'GoodPass1!', makeReq(), CTX);
            expect(result.user.id).toBe(1);
        });

        it('throws 500 if session.regenerate fails', async () => {
            db.query.mockResolvedValueOnce({ rows: [{
                id: 1, email: 'u@t.com', name: 'U', role: 'user',
                is_active: true, locked_until: null,
                password_hash: '$2b$', failed_login_attempts: 0,
            }] });
            verifyPassword.mockResolvedValueOnce(true);
            db.query.mockResolvedValueOnce({ rows: [] });
            const req = makeReq();
            req.session.regenerate = jest.fn((cb) => cb(new Error('store failure')));
            await expect(loginUser('u@t.com', 'GoodPass1!', req, CTX))
                .rejects.toMatchObject({ message: 'Login failed. Please try again.', statusCode: 500 });
        });
    });

    // ─── logoutUser ───────────────────────────────────────────────────────────

    describe('logoutUser', () => {
        it('logs logout event and destroys session', async () => {
            const req = {
                headers: { 'user-agent': 'ua' },
                session: {
                    user: { id: 1, email: 'u@t.com' },
                    activeMerchantId: 'mid-1',
                    destroy: jest.fn((cb) => cb(null)),
                },
            };
            await logoutUser(req, CTX);
            expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'logout' }));
            expect(req.session.destroy).toHaveBeenCalled();
        });

        it('destroys session without logging for anonymous user', async () => {
            const req = {
                headers: {},
                session: {
                    user: undefined,
                    destroy: jest.fn((cb) => cb(null)),
                },
            };
            await logoutUser(req, { ipAddress: '1.2.3.4', userAgent: '' });
            expect(logAuthEvent).not.toHaveBeenCalled();
            expect(req.session.destroy).toHaveBeenCalled();
        });

        it('resolves even when session.destroy calls back with an error', async () => {
            const req = {
                headers: {},
                session: {
                    user: undefined,
                    destroy: jest.fn((cb) => cb(new Error('store error'))),
                },
            };
            await expect(logoutUser(req, CTX)).resolves.toBeUndefined();
        });
    });
});
