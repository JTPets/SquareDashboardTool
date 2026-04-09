'use strict';

/**
 * Staff Service Tests — BACKLOG-41
 *
 * Tests for staff invitation, acceptance, listing, removal, and role changes.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
    transaction: jest.fn(),
}));

jest.mock('../../../utils/password', () => ({
    hashPassword: jest.fn().mockResolvedValue('$bcrypt$hashed'),
}));

const db = require('../../../utils/database');
const { hashPassword } = require('../../../utils/password');
const staffService = require('../../../services/staff/staff-service');

const MERCHANT_ID = 10;
const USER_ID_OWNER = 1;
const USER_ID_MANAGER = 2;
const USER_ID_CLERK = 3;

// Simulate db.transaction by immediately calling the callback with a mock client
function mockTransaction(client) {
    db.transaction.mockImplementation(async (fn) => fn(client));
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== inviteStaff ====================

describe('inviteStaff', () => {
    test('creates invitation token and stores SHA-256 hash (not plaintext)', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })   // no existing member
            .mockResolvedValueOnce({ rows: [] });   // no pending invite

        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [] })
        };
        mockTransaction(mockClient);

        const result = await staffService.inviteStaff({
            merchantId: MERCHANT_ID,
            email: 'staff@example.com',
            role: 'clerk',
            invitedBy: USER_ID_OWNER
        });

        expect(result.rawToken).toBeDefined();
        expect(result.rawToken.length).toBeGreaterThan(0);
        expect(result.email).toBe('staff@example.com');
        expect(result.role).toBe('clerk');
        expect(result.expiresAt).toBeInstanceOf(Date);

        // Verify token hash (not plaintext) is stored
        const insertCall = mockClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO staff_invitations')
        );
        expect(insertCall).toBeDefined();
        const storedHash = insertCall[1][3]; // 4th param is token_hash
        expect(storedHash).not.toBe(result.rawToken); // hash != plaintext
        expect(storedHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    test('normalizes email to lowercase', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        mockTransaction(mockClient);

        const result = await staffService.inviteStaff({
            merchantId: MERCHANT_ID,
            email: 'Staff@EXAMPLE.COM',
            role: 'manager',
            invitedBy: USER_ID_OWNER
        });

        expect(result.email).toBe('staff@example.com');
    });

    test('rejects invalid role', async () => {
        await expect(staffService.inviteStaff({
            merchantId: MERCHANT_ID,
            email: 'x@x.com',
            role: 'owner',
            invitedBy: USER_ID_OWNER
        })).rejects.toMatchObject({ code: 'INVALID_ROLE', statusCode: 400 });
    });

    test('rejects if email is already an active member', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // existing member

        await expect(staffService.inviteStaff({
            merchantId: MERCHANT_ID,
            email: 'existing@example.com',
            role: 'clerk',
            invitedBy: USER_ID_OWNER
        })).rejects.toMatchObject({ code: 'ALREADY_MEMBER', statusCode: 409 });
    });

    test('rejects if unexpired pending invite exists', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })           // not an existing member
            .mockResolvedValueOnce({ rows: [{ id: 55 }] }); // pending invite

        await expect(staffService.inviteStaff({
            merchantId: MERCHANT_ID,
            email: 'pending@example.com',
            role: 'clerk',
            invitedBy: USER_ID_OWNER
        })).rejects.toMatchObject({ code: 'PENDING_INVITE', statusCode: 409 });
    });
});

// ==================== acceptInvitation ====================

describe('acceptInvitation', () => {
    test('accepts invite for new user — creates user + user_merchants row', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ id: 5, merchant_id: MERCHANT_ID, email: 'new@example.com', role: 'clerk', invited_by: USER_ID_OWNER }] }) // invite found
                .mockResolvedValueOnce({ rows: [] }) // user does not exist
                .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT user RETURNING id
                .mockResolvedValueOnce({ rows: [] }) // INSERT user_merchants
                .mockResolvedValueOnce({ rows: [] }) // UPDATE invitation accepted_at
        };
        mockTransaction(mockClient);

        const result = await staffService.acceptInvitation({
            token: 'abc123token',
            password: 'Password1!'
        });

        expect(result.email).toBe('new@example.com');
        expect(result.role).toBe('clerk');
        expect(hashPassword).toHaveBeenCalledWith('Password1!');

        const insertUserCall = mockClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO users')
        );
        expect(insertUserCall).toBeDefined();

        const insertMemberCall = mockClient.query.mock.calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('INSERT INTO user_merchants')
        );
        expect(insertMemberCall).toBeDefined();
    });

    test('accepts invite for existing user — skips user creation', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ id: 7, merchant_id: MERCHANT_ID, email: 'existing@example.com', role: 'manager', invited_by: USER_ID_OWNER }] })
                .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // user exists
                .mockResolvedValueOnce({ rows: [] }) // INSERT user_merchants
                .mockResolvedValueOnce({ rows: [] }) // UPDATE invitation
        };
        mockTransaction(mockClient);

        const result = await staffService.acceptInvitation({ token: 'tok', password: undefined });

        expect(result.email).toBe('existing@example.com');
        expect(hashPassword).not.toHaveBeenCalled();
    });

    test('rejects invalid or expired token', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [] }) // no invite found
                .mockResolvedValueOnce({ rows: [] }) // diagnostic query — no row with matching hash
        };
        mockTransaction(mockClient);

        await expect(staffService.acceptInvitation({ token: 'bad-token', password: 'Password1!' }))
            .rejects.toMatchObject({ code: 'INVALID_TOKEN', statusCode: 400 });
    });

    test('rejects new user with no password', async () => {
        const mockClient = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ id: 1, merchant_id: MERCHANT_ID, email: 'new@example.com', role: 'clerk', invited_by: 1 }] })
                .mockResolvedValueOnce({ rows: [] }) // user does not exist
        };
        mockTransaction(mockClient);

        await expect(staffService.acceptInvitation({ token: 'valid-token', password: undefined }))
            .rejects.toMatchObject({ code: 'PASSWORD_REQUIRED', statusCode: 400 });
    });
});

// ==================== listStaff ====================

describe('listStaff', () => {
    test('returns staff and pending invitations', async () => {
        const mockStaff = [
            { id: 1, email: 'owner@example.com', role: 'owner', last_active: null },
            { id: 2, email: 'manager@example.com', role: 'manager', last_active: null }
        ];
        const mockInvites = [
            { id: 1, email: 'pending@example.com', role: 'clerk', expires_at: new Date() }
        ];

        db.query
            .mockResolvedValueOnce({ rows: mockStaff })
            .mockResolvedValueOnce({ rows: mockInvites });

        const result = await staffService.listStaff(MERCHANT_ID);

        expect(result.staff).toHaveLength(2);
        expect(result.pendingInvitations).toHaveLength(1);
        expect(result.pendingInvitations[0].email).toBe('pending@example.com');
    });
});

// ==================== removeStaff ====================

describe('removeStaff', () => {
    test('removes a staff member', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ role: 'clerk' }] }) // target is clerk
            .mockResolvedValueOnce({ rows: [] }); // DELETE

        await expect(staffService.removeStaff({
            merchantId: MERCHANT_ID,
            userId: USER_ID_CLERK,
            requestingUserId: USER_ID_OWNER
        })).resolves.toBeUndefined();
    });

    test('cannot remove the owner', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

        await expect(staffService.removeStaff({
            merchantId: MERCHANT_ID,
            userId: USER_ID_OWNER,
            requestingUserId: USER_ID_MANAGER
        })).rejects.toMatchObject({ code: 'CANNOT_REMOVE_OWNER', statusCode: 400 });
    });

    test('cannot remove yourself', async () => {
        await expect(staffService.removeStaff({
            merchantId: MERCHANT_ID,
            userId: USER_ID_MANAGER,
            requestingUserId: USER_ID_MANAGER
        })).rejects.toMatchObject({ code: 'CANNOT_REMOVE_SELF', statusCode: 400 });
    });

    test('returns 404 for non-existent member', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(staffService.removeStaff({
            merchantId: MERCHANT_ID,
            userId: 999,
            requestingUserId: USER_ID_OWNER
        })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });
});

// ==================== changeRole ====================

describe('changeRole', () => {
    test('changes role successfully', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ role: 'clerk' }] })  // target
            .mockResolvedValueOnce({ rows: [{ role: 'owner' }] })  // requestor
            .mockResolvedValueOnce({ rows: [] });                   // UPDATE

        await expect(staffService.changeRole({
            merchantId: MERCHANT_ID,
            userId: USER_ID_CLERK,
            newRole: 'manager',
            changedBy: USER_ID_OWNER
        })).resolves.toBeUndefined();
    });

    test('cannot change own role', async () => {
        await expect(staffService.changeRole({
            merchantId: MERCHANT_ID,
            userId: USER_ID_OWNER,
            newRole: 'clerk',
            changedBy: USER_ID_OWNER
        })).rejects.toMatchObject({ code: 'CANNOT_CHANGE_OWN_ROLE', statusCode: 400 });
    });

    test('cannot change the owner role', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ role: 'owner' }] })  // target is owner
            .mockResolvedValueOnce({ rows: [{ role: 'manager' }] }); // requestor

        await expect(staffService.changeRole({
            merchantId: MERCHANT_ID,
            userId: USER_ID_OWNER,
            newRole: 'clerk',
            changedBy: USER_ID_MANAGER
        })).rejects.toMatchObject({ code: 'CANNOT_CHANGE_OWNER', statusCode: 400 });
    });

    test('non-owner cannot promote to manager', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ role: 'clerk' }] })   // target
            .mockResolvedValueOnce({ rows: [{ role: 'manager' }] }); // requestor (not owner)

        await expect(staffService.changeRole({
            merchantId: MERCHANT_ID,
            userId: USER_ID_CLERK,
            newRole: 'manager',
            changedBy: USER_ID_MANAGER
        })).rejects.toMatchObject({ code: 'OWNER_REQUIRED', statusCode: 403 });
    });

    test('rejects invalid role', async () => {
        await expect(staffService.changeRole({
            merchantId: MERCHANT_ID,
            userId: USER_ID_CLERK,
            newRole: 'superadmin',
            changedBy: USER_ID_OWNER
        })).rejects.toMatchObject({ code: 'INVALID_ROLE', statusCode: 400 });
    });
});

// ==================== cancelInvitation ====================

describe('cancelInvitation', () => {
    test('deletes a pending invitation and resolves', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] }); // DELETE RETURNING id

        await expect(staffService.cancelInvitation({
            merchantId: MERCHANT_ID,
            invitationId: 7
        })).resolves.toBeUndefined();

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM staff_invitations'),
            [7, MERCHANT_ID]
        );
    });

    test('throws NOT_FOUND when invitation does not exist or belongs to another merchant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // no rows deleted

        await expect(staffService.cancelInvitation({
            merchantId: MERCHANT_ID,
            invitationId: 999
        })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    test('cannot cancel an already-accepted invitation (accepted_at IS NULL filter)', async () => {
        // accepted invitation returns 0 rows because of AND accepted_at IS NULL
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(staffService.cancelInvitation({
            merchantId: MERCHANT_ID,
            invitationId: 5
        })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });
});
