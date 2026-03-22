'use strict';

/**
 * Tests for userRole loading in loadMerchantContext
 *
 * Validates:
 * - userRole is correctly loaded from user_merchants.role
 * - platform_owner subscription overrides userRole to 'owner'
 * - missing/null role defaults to 'user'
 */

// Mock database
jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// Mock token encryption
jest.mock('../../utils/token-encryption', () => ({
    decryptToken: jest.fn(() => 'decrypted-token'),
}));

// Mock square-token
jest.mock('../../utils/square-token', () => ({
    refreshMerchantToken: jest.fn(),
}));

// Mock Square SDK
jest.mock('square', () => ({
    SquareClient: jest.fn(() => ({})),
    SquareEnvironment: { Sandbox: 'sandbox', Production: 'production' },
}));

const db = require('../../utils/database');
const { loadMerchantContext } = require('../../middleware/merchant');

function mockRequest(options = {}) {
    return {
        session: options.session || { user: { id: 1 }, activeMerchantId: 1 },
        path: options.path || '/api/test',
        ...options,
    };
}

function mockResponse() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

// Helper to set up db.query mock for merchant context loading
function setupMerchantQuery(overrides = {}) {
    const defaults = {
        id: 1,
        square_merchant_id: 'sq-123',
        business_name: 'Test Store',
        business_email: 'test@example.com',
        subscription_status: 'active',
        trial_ends_at: null,
        subscription_ends_at: null,
        timezone: 'America/Toronto',
        currency: 'CAD',
        locale: 'en-CA',
        settings: {},
        last_sync_at: null,
        square_token_expires_at: null,
        user_role: 'manager',
    };

    const row = { ...defaults, ...overrides };

    db.query.mockImplementation((sql) => {
        if (sql.includes('merchant_features')) {
            return { rows: [] };
        }
        return { rows: [row] };
    });
}

describe('loadMerchantContext — userRole', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('attaches userRole from user_merchants.role', async () => {
        setupMerchantQuery({ user_role: 'manager' });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.merchantContext).toBeDefined();
        expect(req.merchantContext.userRole).toBe('manager');
    });

    test('attaches clerk role correctly', async () => {
        setupMerchantQuery({ user_role: 'clerk' });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(req.merchantContext.userRole).toBe('clerk');
    });

    test('attaches owner role correctly', async () => {
        setupMerchantQuery({ user_role: 'owner' });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(req.merchantContext.userRole).toBe('owner');
    });

    test('platform_owner subscription overrides userRole to owner', async () => {
        setupMerchantQuery({
            user_role: 'clerk',
            subscription_status: 'platform_owner',
        });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(req.merchantContext.userRole).toBe('owner');
        expect(req.merchantContext.subscriptionStatus).toBe('platform_owner');
    });

    test('null role defaults to "user" for backward compat', async () => {
        setupMerchantQuery({ user_role: null });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(req.merchantContext.userRole).toBe('user');
    });

    test('undefined role defaults to "user" for backward compat', async () => {
        setupMerchantQuery({ user_role: undefined });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(req.merchantContext.userRole).toBe('user');
    });

    test('readonly role is attached correctly', async () => {
        setupMerchantQuery({ user_role: 'readonly' });

        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(req.merchantContext.userRole).toBe('readonly');
    });

    test('skips loading when no authenticated user', async () => {
        const req = mockRequest({ session: null });
        const res = mockResponse();
        const next = jest.fn();

        await loadMerchantContext(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.merchantContext).toBeUndefined();
    });
});
