/**
 * Merchant Access Middleware Test Suite (Audit 2.6.1)
 *
 * Tests:
 * - Platform owner can access any merchant
 * - Admin with user_merchants row can access their merchant
 * - Admin without user_merchants row gets 403
 * - Invalid merchantId returns 400
 * - Database errors return 500
 */

jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../utils/database', () => ({
    query: jest.fn(),
}));

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { requireMerchantAccess } = require('../../middleware/merchant-access');

function mockReq(merchantId, userId = 1) {
    return {
        params: { merchantId: String(merchantId) },
        session: { user: { id: userId } },
        path: '/api/admin/merchants/' + merchantId + '/extend-trial',
    };
}

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe('requireMerchantAccess', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('allows platform owner to access any merchant', async () => {
        // First query: platform owner check — returns a row
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

        const req = mockReq(99, 1);
        const res = mockRes();
        const next = jest.fn();

        await requireMerchantAccess(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('allows admin with user_merchants association', async () => {
        // First query: platform owner check — no rows
        db.query.mockResolvedValueOnce({ rows: [] });
        // Second query: user_merchants check — has access
        db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

        const req = mockReq(5, 2);
        const res = mockRes();
        const next = jest.fn();

        await requireMerchantAccess(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        // Verify the merchantId and userId were passed correctly
        const accessCall = db.query.mock.calls[1];
        expect(accessCall[1]).toEqual([2, 5]);
    });

    test('returns 403 when admin has no access to merchant', async () => {
        // First query: platform owner check — no rows
        db.query.mockResolvedValueOnce({ rows: [] });
        // Second query: user_merchants check — no access
        db.query.mockResolvedValueOnce({ rows: [] });

        const req = mockReq(99, 3);
        const res = mockRes();
        const next = jest.fn();

        await requireMerchantAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            code: 'FORBIDDEN',
        }));
        expect(logger.warn).toHaveBeenCalledWith('Admin merchant access denied', expect.objectContaining({
            userId: 3,
            targetMerchantId: 99,
        }));
    });

    test('returns 400 for invalid merchantId', async () => {
        const req = {
            params: { merchantId: 'abc' },
            session: { user: { id: 1 } },
            path: '/test',
        };
        const res = mockRes();
        const next = jest.fn();

        await requireMerchantAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            code: 'VALIDATION_ERROR',
        }));
    });

    test('returns 500 on database error', async () => {
        db.query.mockRejectedValueOnce(new Error('Connection refused'));

        const req = mockReq(5, 1);
        const res = mockRes();
        const next = jest.fn();

        await requireMerchantAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(500);
        expect(logger.error).toHaveBeenCalledWith('Merchant access check failed', expect.objectContaining({
            error: 'Connection refused',
        }));
    });

    test('returns 400 for missing merchantId param', async () => {
        const req = {
            params: {},
            session: { user: { id: 1 } },
            path: '/test',
        };
        const res = mockRes();
        const next = jest.fn();

        await requireMerchantAccess(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });
});
