/**
 * Tests for audit-stats-service.js
 *
 * Validates loyalty stats queries, audit findings, and resolution.
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

const { getLoyaltyStats, getAuditFindings, resolveAuditFinding } = require('../../../services/loyalty-admin/audit-stats-service');
const db = require('../../../utils/database');

const MERCHANT_ID = 1;

describe('audit-stats-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getLoyaltyStats', () => {
        test('throws on missing merchantId', async () => {
            await expect(getLoyaltyStats(undefined))
                .rejects.toThrow('merchantId is required');
        });

        test('returns stats from 5 queries', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ active_offers: '3', total_offers: '5' }] })  // offers
                .mockResolvedValueOnce({ rows: [{ status: 'earned', count: '10' }, { status: 'redeemed', count: '4' }] })  // rewards
                .mockResolvedValueOnce({ rows: [{ count: '6' }] })  // recent earned
                .mockResolvedValueOnce({ rows: [{ count: '2' }] })  // recent redeemed
                .mockResolvedValueOnce({ rows: [{ total_cents: '25000' }] });  // total value

            const result = await getLoyaltyStats(MERCHANT_ID);

            expect(result.offers.active).toBe(3);
            expect(result.offers.total).toBe(5);
            expect(result.rewards.earned).toBe(10);
            expect(result.rewards.redeemed).toBe(4);
            expect(result.last30Days.earned).toBe(6);
            expect(result.last30Days.redeemed).toBe(2);
            expect(result.totalRedemptionValueCents).toBe(25000);
            expect(db.query).toHaveBeenCalledTimes(5);
        });

        test('handles empty results with zeros', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ active_offers: null, total_offers: null }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ count: null }] })
                .mockResolvedValueOnce({ rows: [{ count: null }] })
                .mockResolvedValueOnce({ rows: [{ total_cents: null }] });

            const result = await getLoyaltyStats(MERCHANT_ID);

            expect(result.offers.active).toBe(0);
            expect(result.rewards).toEqual({});
            expect(result.last30Days.earned).toBe(0);
            expect(result.totalRedemptionValueCents).toBe(0);
        });

        test('all queries include merchant_id filter', async () => {
            db.query.mockResolvedValue({ rows: [{ active_offers: '0', total_offers: '0', count: '0', total_cents: '0' }] });

            await getLoyaltyStats(MERCHANT_ID);

            for (const call of db.query.mock.calls) {
                expect(call[0]).toContain('merchant_id = $1');
                expect(call[1]).toContain(MERCHANT_ID);
            }
        });
    });

    describe('getAuditFindings', () => {
        test('throws on missing merchantId', async () => {
            await expect(getAuditFindings({}))
                .rejects.toThrow('merchantId is required');
        });

        test('returns findings with pagination', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ id: 1, issue_type: 'MISSING_REDEMPTION' }] })
                .mockResolvedValueOnce({ rows: [{ total: '5' }] });

            const result = await getAuditFindings({ merchantId: MERCHANT_ID });

            expect(result.findings).toHaveLength(1);
            expect(result.pagination.total).toBe(5);
        });

        test('filters by issueType', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ total: '0' }] });

            await getAuditFindings({ merchantId: MERCHANT_ID, issueType: 'PHANTOM_REWARD' });

            const mainQuery = db.query.mock.calls[0];
            expect(mainQuery[0]).toContain('issue_type = $');
            expect(mainQuery[1]).toContain('PHANTOM_REWARD');
        });

        test('filters by resolved status', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ total: '0' }] });

            await getAuditFindings({ merchantId: MERCHANT_ID, resolved: true });

            const mainQuery = db.query.mock.calls[0];
            expect(mainQuery[0]).toContain('resolved = $2');
            expect(mainQuery[1][1]).toBe(true);
        });
    });

    describe('resolveAuditFinding', () => {
        test('throws on missing merchantId', async () => {
            await expect(resolveAuditFinding({ findingId: 1 }))
                .rejects.toThrow('merchantId is required');
        });

        test('returns resolved finding', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, resolved: true, resolved_at: '2026-01-15T12:00:00Z' }]
            });

            const result = await resolveAuditFinding({ merchantId: MERCHANT_ID, findingId: 1 });

            expect(result.resolved).toBe(true);
        });

        test('returns null when finding not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await resolveAuditFinding({ merchantId: MERCHANT_ID, findingId: 999 });

            expect(result).toBeNull();
        });

        test('includes merchant_id in UPDATE', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 1 }] });

            await resolveAuditFinding({ merchantId: MERCHANT_ID, findingId: 1 });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('merchant_id = $2');
            expect(call[1]).toEqual([1, MERCHANT_ID]);
        });
    });
});
