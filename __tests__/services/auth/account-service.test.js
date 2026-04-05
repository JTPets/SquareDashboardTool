'use strict';

jest.mock('../../../utils/database', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/password', () => ({
    hashPassword: jest.fn().mockResolvedValue('$2b$10$hashed'),
    generateRandomPassword: jest.fn().mockReturnValue('GenPass123!'),
}));
jest.mock('../../../middleware/auth', () => ({
    logAuthEvent: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../../../utils/database');
const { hashPassword, generateRandomPassword } = require('../../../utils/password');
const { logAuthEvent } = require('../../../middleware/auth');
const { listUsers, createUser, updateUser, adminResetPassword, unlockUser } = require('../../../services/auth/account-service');

const MID = 'merchant-1';
const CTX = { ipAddress: '1.2.3.4', userAgent: 'ua' };

beforeEach(() => jest.clearAllMocks());

// ─── listUsers ────────────────────────────────────────────────────────────────

describe('listUsers', () => {
    it('returns rows for the given merchant', async () => {
        const rows = [{ id: 1, email: 'a@t.com' }, { id: 2, email: 'b@t.com' }];
        db.query.mockResolvedValueOnce({ rows });
        const result = await listUsers(MID);
        expect(result).toEqual(rows);
    });

    it('passes merchantId as parameter (multi-tenant isolation)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await listUsers('specific-mid');
        expect(db.query).toHaveBeenCalledWith(
            expect.stringMatching(/JOIN\s+user_merchants/),
            ['specific-mid']
        );
    });

    it('returns empty array when no users', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await listUsers(MID)).toEqual([]);
    });
});

// ─── createUser ───────────────────────────────────────────────────────────────

describe('createUser', () => {
    const CREATE_CTX = { createdByEmail: 'admin@t.com', createdById: 99, ...CTX };

    it('throws 400 if email already exists', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] }); // email check
        await expect(createUser(MID, { email: 'dup@t.com' }, CREATE_CTX))
            .rejects.toMatchObject({ message: 'A user with this email already exists', statusCode: 400 });
    });

    it('normalizes email to lowercase', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // email check
        db.transaction.mockResolvedValueOnce({ id: 1, email: 'user@t.com', name: null, role: 'user', created_at: new Date() });
        await createUser(MID, { email: 'USER@T.COM' }, CREATE_CTX);
        expect(db.query).toHaveBeenCalledWith(expect.any(String), ['user@t.com']);
    });

    it('generates password when none provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.transaction.mockResolvedValueOnce({ id: 1, email: 'u@t.com', name: null, role: 'user', created_at: new Date() });
        const result = await createUser(MID, { email: 'u@t.com' }, CREATE_CTX);
        expect(generateRandomPassword).toHaveBeenCalled();
        expect(result.generatedPassword).toBe('GenPass123!');
    });

    it('does not generate password when one is provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.transaction.mockResolvedValueOnce({ id: 1, email: 'u@t.com', name: null, role: 'user', created_at: new Date() });
        const result = await createUser(MID, { email: 'u@t.com', password: 'Supplied1!' }, CREATE_CTX);
        expect(generateRandomPassword).not.toHaveBeenCalled();
        expect(result.generatedPassword).toBeNull();
    });

    it('hashes password before storing', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.transaction.mockResolvedValueOnce({ id: 1, email: 'u@t.com', name: null, role: 'user', created_at: new Date() });
        await createUser(MID, { email: 'u@t.com', password: 'Plain1!' }, CREATE_CTX);
        expect(hashPassword).toHaveBeenCalledWith('Plain1!');
    });

    it('defaults role to "user" when not provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const newUser = { id: 1, email: 'u@t.com', name: null, role: 'user', created_at: new Date() };
        db.transaction.mockResolvedValueOnce(newUser);
        const result = await createUser(MID, { email: 'u@t.com' }, CREATE_CTX);
        expect(result.user.role).toBe('user');
    });

    it('logs user_created event', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.transaction.mockResolvedValueOnce({ id: 2, email: 'u@t.com', name: null, role: 'user', created_at: new Date() });
        await createUser(MID, { email: 'u@t.com' }, CREATE_CTX);
        expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'user_created' }));
    });
});

// ─── updateUser ───────────────────────────────────────────────────────────────

describe('updateUser', () => {
    const UPDATE_CTX = { actorId: 99, actorEmail: 'admin@t.com', ...CTX };

    it('throws 404 if user not in merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(updateUser(MID, 5, { name: 'New' }, UPDATE_CTX))
            .rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
    });

    it('throws 400 when actor tries to deactivate themselves', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 99, email: 'admin@t.com' }] });
        await expect(updateUser(MID, 99, { is_active: false }, { actorId: 99, actorEmail: 'admin@t.com', ...CTX }))
            .rejects.toMatchObject({ message: 'You cannot deactivate your own account', statusCode: 400 });
    });

    it('throws 400 when no fields provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        await expect(updateUser(MID, 5, {}, UPDATE_CTX))
            .rejects.toMatchObject({ message: 'No fields to update', statusCode: 400 });
    });

    it('returns updated user row on success', async () => {
        const updatedUser = { id: 5, email: 'u@t.com', name: 'New Name', role: 'user', is_active: true };
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] }); // merchant check
        db.query.mockResolvedValueOnce({ rows: [updatedUser] }); // UPDATE
        const result = await updateUser(MID, 5, { name: 'New Name' }, UPDATE_CTX);
        expect(result).toEqual(updatedUser);
    });

    it('logs user_deactivated when is_active set to false', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com', is_active: false }] });
        await updateUser(MID, 5, { is_active: false }, UPDATE_CTX);
        expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'user_deactivated' }));
    });

    it('logs user_updated for non-deactivation changes', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com', name: 'X' }] });
        await updateUser(MID, 5, { name: 'X' }, UPDATE_CTX);
        expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'user_updated' }));
    });
});

// ─── adminResetPassword ───────────────────────────────────────────────────────

describe('adminResetPassword', () => {
    const RESET_CTX = { resetByEmail: 'admin@t.com', resetById: 99, ...CTX };

    it('throws 404 if user not in merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(adminResetPassword(MID, 5, 'NewPass1!', RESET_CTX))
            .rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
    });

    it('generates password when none provided', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
        const result = await adminResetPassword(MID, 5, null, RESET_CTX);
        expect(generateRandomPassword).toHaveBeenCalled();
        expect(result.generatedPassword).toBe('GenPass123!');
    });

    it('uses provided password and returns null generatedPassword', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        db.query.mockResolvedValueOnce({ rows: [] });
        const result = await adminResetPassword(MID, 5, 'Explicit1!', RESET_CTX);
        expect(generateRandomPassword).not.toHaveBeenCalled();
        expect(result.generatedPassword).toBeNull();
    });

    it('clears failed_login_attempts and locked_until in UPDATE', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await adminResetPassword(MID, 5, 'Pass1!', RESET_CTX);
        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toContain('failed_login_attempts = 0');
        expect(updateCall[0]).toContain('locked_until = NULL');
    });

    it('logs password_change event', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        db.query.mockResolvedValueOnce({ rows: [] });
        await adminResetPassword(MID, 5, 'Pass1!', RESET_CTX);
        expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'password_change' }));
    });
});

// ─── unlockUser ───────────────────────────────────────────────────────────────

describe('unlockUser', () => {
    const UNLOCK_CTX = { unlockedByEmail: 'admin@t.com', unlockedById: 99, ...CTX };

    it('throws 404 if user not in merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // memberCheck
        await expect(unlockUser(MID, 5, UNLOCK_CTX))
            .rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
    });

    it('throws 404 if UPDATE returns no rows', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': '1' }] }); // memberCheck passes
        db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE finds nothing
        await expect(unlockUser(MID, 5, UNLOCK_CTX))
            .rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
    });

    it('clears lockout fields and logs account_unlocked', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': '1' }] });
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, email: 'u@t.com' }] });
        await unlockUser(MID, 5, UNLOCK_CTX);
        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toContain('failed_login_attempts = 0');
        expect(updateCall[0]).toContain('locked_until = NULL');
        expect(logAuthEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: 'account_unlocked' }));
    });
});
