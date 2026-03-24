'use strict';

/**
 * Staff Routes Tests — BACKLOG-41
 *
 * Tests access control: owner can invite, manager gets 403 on invite/delete/role-change,
 * clerk gets 403 on list. Also covers happy-path behaviour for each endpoint.
 */

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

jest.mock('../../services/staff', () => ({
    listStaff: jest.fn(),
    inviteStaff: jest.fn(),
    acceptInvitation: jest.fn(),
    removeStaff: jest.fn(),
    changeRole: jest.fn(),
    cancelInvitation: jest.fn(),
}));

jest.mock('../../utils/email-notifier', () => ({
    sendStaffInvitation: jest.fn().mockResolvedValue(undefined),
    enabled: false,
}));

jest.mock('../../middleware/async-handler', () => (fn) => fn);

// requireAuth — pass through for all tests (session is set up per-app)
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    logAuthEvent: jest.fn(),
    getClientIp: jest.fn(() => '127.0.0.1'),
}));

// requireMerchant — pass through (merchantContext set on app)
jest.mock('../../middleware/merchant', () => ({
    requireMerchant: (req, res, next) => {
        if (!req.merchantContext) {
            return res.status(403).json({ success: false, error: 'No merchant connected' });
        }
        next();
    },
    loadMerchantContext: (req, res, next) => next(),
    getSquareClientForMerchant: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const staffService = require('../../services/staff');

/**
 * Build a test Express app with a given merchant role context.
 * @param {string} userRole - 'owner' | 'manager' | 'clerk' | 'readonly'
 * @param {number} userId
 */
function createTestApp(userRole = 'owner', userId = 1) {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));

    // Inject session user
    app.use((req, res, next) => {
        req.session.user = { id: userId, email: `${userRole}@example.com`, role: userRole };
        next();
    });

    // Inject merchant context
    app.use((req, res, next) => {
        req.merchantContext = {
            id: 10,
            businessName: 'Test Pets',
            userRole,
            subscriptionStatus: 'active',
            isSubscriptionValid: true,
            features: ['base']
        };
        next();
    });

    // Use real requirePermission so access-control tests are meaningful
    const { requirePermission } = jest.requireActual('../../middleware/require-permission');
    // Patch hasPermission module so we test with real permission matrix
    app.use((req, res, next) => next()); // no-op placeholder

    // Mount routes
    // We need requirePermission to work with the real permissions config,
    // so unmock it selectively by using jest.requireActual above.
    // However, since the route file imports it directly, we need another approach:
    // Instead, mock requirePermission to delegate to real implementation.
    const staffRoutes = require('../../routes/staff');
    app.use('/api/staff', staffRoutes);

    // Error handler
    app.use((err, req, res, next) => {
        res.status(err.statusCode || 500).json({ success: false, error: err.message, code: err.code });
    });

    return app;
}

// We need requirePermission to use real logic for access control tests.
// Mock it so it reads from req.merchantContext.userRole with the real permission matrix.
jest.mock('../../middleware/require-permission', () => {
    const { hasPermission } = jest.requireActual('../../config/permissions');
    return {
        requirePermission: (feature, level) => (req, res, next) => {
            const role = req.merchantContext?.userRole;
            if (!role) {
                return res.status(403).json({ success: false, error: 'No merchant context', code: 'NO_MERCHANT' });
            }
            if (hasPermission(role, feature, level)) {
                return next();
            }
            return res.status(403).json({ success: false, error: 'Insufficient permissions', code: 'PERMISSION_DENIED' });
        }
    };
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ==================== GET /api/staff ====================

describe('GET /api/staff', () => {
    test('owner can list staff', async () => {
        staffService.listStaff.mockResolvedValue({
            staff: [{ id: 1, email: 'owner@example.com', role: 'owner' }],
            pendingInvitations: []
        });

        const app = createTestApp('owner');
        const res = await request(app).get('/api/staff').expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.staff).toHaveLength(1);
        expect(res.body.pendingInvitations).toHaveLength(0);
    });

    test('manager can list staff (staff:read permission)', async () => {
        staffService.listStaff.mockResolvedValue({ staff: [], pendingInvitations: [] });
        const app = createTestApp('manager');
        const res = await request(app).get('/api/staff').expect(200);
        expect(res.body.success).toBe(true);
    });

    test('clerk gets 403 on list (no staff:read permission)', async () => {
        const app = createTestApp('clerk');
        const res = await request(app).get('/api/staff').expect(403);
        expect(res.body.success).toBe(false);
    });
});

// ==================== POST /api/staff/invite ====================

describe('POST /api/staff/invite', () => {
    test('owner can send invitation', async () => {
        staffService.inviteStaff.mockResolvedValue({
            rawToken: 'rawtoken123',
            email: 'new@example.com',
            role: 'clerk',
            expiresAt: new Date('2026-04-01')
        });

        const app = createTestApp('owner', 1);
        const res = await request(app)
            .post('/api/staff/invite')
            .send({ email: 'new@example.com', role: 'clerk' })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.email).toBe('new@example.com');
        expect(staffService.inviteStaff).toHaveBeenCalledWith({
            merchantId: 10,
            email: 'new@example.com',
            role: 'clerk',
            invitedBy: 1
        });
    });

    test('manager gets 403 on invite (no staff:admin permission)', async () => {
        const app = createTestApp('manager');
        const res = await request(app)
            .post('/api/staff/invite')
            .send({ email: 'x@example.com', role: 'clerk' })
            .expect(403);
        expect(res.body.success).toBe(false);
    });

    test('clerk gets 403 on invite', async () => {
        const app = createTestApp('clerk');
        const res = await request(app)
            .post('/api/staff/invite')
            .send({ email: 'x@example.com', role: 'clerk' })
            .expect(403);
        expect(res.body.success).toBe(false);
    });

    test('returns 400 for invalid role', async () => {
        const app = createTestApp('owner');
        const res = await request(app)
            .post('/api/staff/invite')
            .send({ email: 'x@example.com', role: 'superadmin' })
            .expect(400);
        expect(res.body).toMatchObject({ error: 'Validation failed' });
    });

    test('returns 400 for invalid email', async () => {
        const app = createTestApp('owner');
        const res = await request(app)
            .post('/api/staff/invite')
            .send({ email: 'not-an-email', role: 'clerk' })
            .expect(400);
        expect(res.body).toMatchObject({ error: 'Validation failed' });
    });
});

// ==================== POST /api/staff/accept ====================

describe('POST /api/staff/accept', () => {
    test('accepts invitation with valid token and password', async () => {
        staffService.acceptInvitation.mockResolvedValue({
            email: 'new@example.com',
            role: 'clerk',
            merchantId: 10
        });

        // Use owner app but route has no auth guard — any (even unauthenticated) request works
        const app = createTestApp('owner');
        const res = await request(app)
            .post('/api/staff/accept')
            .send({ token: 'validtoken', password: 'Password1!' })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.email).toBe('new@example.com');
    });

    test('returns 400 for missing token', async () => {
        const app = createTestApp('owner');
        const res = await request(app)
            .post('/api/staff/accept')
            .send({ password: 'Password1!' })
            .expect(400);
        expect(res.body).toMatchObject({ error: 'Validation failed' });
    });
});

// ==================== DELETE /api/staff/:userId ====================

describe('DELETE /api/staff/:userId', () => {
    test('owner can remove a staff member', async () => {
        staffService.removeStaff.mockResolvedValue(undefined);

        const app = createTestApp('owner', 1);
        const res = await request(app)
            .delete('/api/staff/5')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(staffService.removeStaff).toHaveBeenCalledWith({
            merchantId: 10,
            userId: 5,
            requestingUserId: 1
        });
    });

    test('manager gets 403 on remove', async () => {
        const app = createTestApp('manager');
        const res = await request(app).delete('/api/staff/5').expect(403);
        expect(res.body.success).toBe(false);
    });

    test('returns 400 for invalid userId param', async () => {
        const app = createTestApp('owner');
        const res = await request(app).delete('/api/staff/notanumber').expect(400);
        expect(res.body).toMatchObject({ error: 'Validation failed' });
    });
});

// ==================== DELETE /api/staff/invitations/:id ====================

describe('DELETE /api/staff/invitations/:id', () => {
    test('owner can cancel a pending invitation', async () => {
        staffService.cancelInvitation.mockResolvedValue(undefined);

        const app = createTestApp('owner', 1);
        const res = await request(app)
            .delete('/api/staff/invitations/7')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(staffService.cancelInvitation).toHaveBeenCalledWith({ merchantId: 10, invitationId: 7 });
    });

    test('manager gets 403 on cancel (no staff:admin permission)', async () => {
        const app = createTestApp('manager');
        const res = await request(app).delete('/api/staff/invitations/7').expect(403);
        expect(res.body.success).toBe(false);
    });

    test('returns 404 when invitation not found or belongs to another merchant', async () => {
        const err = Object.assign(new Error('Invitation not found'), { statusCode: 404, code: 'NOT_FOUND' });
        staffService.cancelInvitation.mockRejectedValue(err);

        const app = createTestApp('owner', 1);
        const res = await request(app).delete('/api/staff/invitations/999').expect(404);
        expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
    });

    test('returns 400 for non-integer invitation id', async () => {
        const app = createTestApp('owner');
        const res = await request(app).delete('/api/staff/invitations/notanumber').expect(400);
        expect(res.body).toMatchObject({ error: 'Validation failed' });
    });
});

// ==================== PATCH /api/staff/:userId/role ====================

describe('PATCH /api/staff/:userId/role', () => {
    test('owner can change a role', async () => {
        staffService.changeRole.mockResolvedValue(undefined);

        const app = createTestApp('owner', 1);
        const res = await request(app)
            .patch('/api/staff/5/role')
            .send({ role: 'manager' })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.role).toBe('manager');
        expect(staffService.changeRole).toHaveBeenCalledWith({
            merchantId: 10,
            userId: 5,
            newRole: 'manager',
            changedBy: 1
        });
    });

    test('manager gets 403 on role change (no staff:admin)', async () => {
        const app = createTestApp('manager');
        const res = await request(app)
            .patch('/api/staff/5/role')
            .send({ role: 'clerk' })
            .expect(403);
        expect(res.body.success).toBe(false);
    });

    test('returns 400 for invalid role value', async () => {
        const app = createTestApp('owner');
        const res = await request(app)
            .patch('/api/staff/5/role')
            .send({ role: 'owner' })
            .expect(400);
        expect(res.body).toMatchObject({ error: 'Validation failed' });
    });
});
