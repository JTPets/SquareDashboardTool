/**
 * Tests for services/loyalty-admin/audit-service.js
 *
 * Covers: logAuditEvent, getAuditLogs, tenant isolation enforcement.
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const db = require('../../../utils/database');
const { logAuditEvent, getAuditLogs, AuditActions } = require('../../../services/loyalty-admin/audit-service');

const MERCHANT_ID = 1;

describe('audit-service', () => {
    beforeEach(() => jest.clearAllMocks());

    // ========================================================================
    // logAuditEvent
    // ========================================================================

    describe('logAuditEvent', () => {
        test('throws if merchantId is missing', async () => {
            await expect(logAuditEvent({ action: 'TEST' }))
                .rejects.toThrow('merchantId is required');
        });

        test('inserts audit event with all fields', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await logAuditEvent({
                merchantId: MERCHANT_ID,
                action: AuditActions.PURCHASE_RECORDED,
                offerId: 10,
                rewardId: 20,
                purchaseEventId: 30,
                redemptionId: null,
                squareCustomerId: 'cust-1',
                squareOrderId: 'order-1',
                oldState: 'in_progress',
                newState: 'earned',
                oldQuantity: 5,
                newQuantity: 10,
                triggeredBy: 'WEBHOOK',
                userId: 99,
                details: { note: 'test' },
            });

            expect(db.query).toHaveBeenCalledTimes(1);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO loyalty_audit_logs');
            expect(params[0]).toBe(MERCHANT_ID);
            expect(params[1]).toBe('PURCHASE_RECORDED');
            expect(params[2]).toBe(10); // offerId
            expect(params[6]).toBe('cust-1'); // squareCustomerId
            expect(params[12]).toBe('WEBHOOK'); // triggeredBy
            expect(params[14]).toBe('{"note":"test"}'); // details JSON
        });

        test('defaults triggeredBy to SYSTEM', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await logAuditEvent({
                merchantId: MERCHANT_ID,
                action: AuditActions.OFFER_CREATED,
            });

            const params = db.query.mock.calls[0][1];
            expect(params[12]).toBe('SYSTEM');
        });

        test('sets null for optional fields', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await logAuditEvent({
                merchantId: MERCHANT_ID,
                action: AuditActions.OFFER_CREATED,
            });

            const params = db.query.mock.calls[0][1];
            expect(params[2]).toBeNull(); // offerId
            expect(params[3]).toBeNull(); // rewardId
            expect(params[14]).toBeNull(); // details
        });

        test('uses transaction client when provided', async () => {
            const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };

            await logAuditEvent({
                merchantId: MERCHANT_ID,
                action: AuditActions.REWARD_EARNED,
            }, mockClient);

            expect(mockClient.query).toHaveBeenCalledTimes(1);
            expect(db.query).not.toHaveBeenCalled();
        });

        test('does not throw on database error (swallows)', async () => {
            db.query.mockRejectedValue(new Error('DB down'));

            await expect(logAuditEvent({
                merchantId: MERCHANT_ID,
                action: AuditActions.OFFER_CREATED,
            })).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // getAuditLogs
    // ========================================================================

    describe('getAuditLogs', () => {
        test('throws if merchantId is missing', async () => {
            await expect(getAuditLogs(null))
                .rejects.toThrow('merchantId is required');
        });

        test('returns audit log rows with default pagination', async () => {
            const mockRows = [
                { id: 1, action: 'OFFER_CREATED', offer_name: 'Test', user_name: 'admin' },
            ];
            db.query.mockResolvedValue({ rows: mockRows });

            const result = await getAuditLogs(MERCHANT_ID);

            expect(result).toEqual(mockRows);
            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('al.merchant_id = $1');
            expect(sql).toContain('ORDER BY al.created_at DESC');
            expect(params).toEqual([MERCHANT_ID, 100, 0]); // default limit & offset
        });

        test('applies action filter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getAuditLogs(MERCHANT_ID, { action: 'REWARD_EARNED' });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('al.action = $2');
            expect(params[1]).toBe('REWARD_EARNED');
        });

        test('applies customer filter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getAuditLogs(MERCHANT_ID, { squareCustomerId: 'cust-1' });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('al.square_customer_id');
            expect(params).toContain('cust-1');
        });

        test('applies offer filter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getAuditLogs(MERCHANT_ID, { offerId: 5 });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('al.offer_id');
            expect(params).toContain(5);
        });

        test('applies all filters together', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getAuditLogs(MERCHANT_ID, {
                action: 'PURCHASE_RECORDED',
                squareCustomerId: 'cust-1',
                offerId: 3,
                limit: 50,
                offset: 10,
            });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('al.action');
            expect(sql).toContain('al.square_customer_id');
            expect(sql).toContain('al.offer_id');
            expect(params).toEqual([MERCHANT_ID, 'PURCHASE_RECORDED', 'cust-1', 3, 50, 10]);
        });

        test('custom limit and offset', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getAuditLogs(MERCHANT_ID, { limit: 25, offset: 50 });

            const params = db.query.mock.calls[0][1];
            expect(params).toEqual([MERCHANT_ID, 25, 50]);
        });
    });

    // ========================================================================
    // Re-exports
    // ========================================================================

    describe('re-exports', () => {
        test('re-exports AuditActions from constants', () => {
            expect(AuditActions).toBeDefined();
            expect(AuditActions.OFFER_CREATED).toBe('OFFER_CREATED');
        });
    });
});
