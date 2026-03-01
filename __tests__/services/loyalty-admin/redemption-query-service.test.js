/**
 * Tests for redemption-query-service.js
 *
 * Validates redemption queries, reward listing, and vendor credit updates.
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

const { getRedemptions, getRewards, updateVendorCreditStatus } = require('../../../services/loyalty-admin/redemption-query-service');
const db = require('../../../utils/database');

const MERCHANT_ID = 1;

describe('redemption-query-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getRedemptions', () => {
        test('throws on missing merchantId', async () => {
            await expect(getRedemptions({}))
                .rejects.toThrow('merchantId is required');
        });

        test('queries with merchant_id and redeemed status', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRedemptions({ merchantId: MERCHANT_ID });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('merchant_id = $1');
            expect(call[0]).toContain("status = 'redeemed'");
            expect(call[1][0]).toBe(MERCHANT_ID);
        });

        test('applies offerId filter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRedemptions({ merchantId: MERCHANT_ID, offerId: 5 });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('r.offer_id = $2');
            expect(call[1]).toContain(5);
        });

        test('applies customerId filter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRedemptions({ merchantId: MERCHANT_ID, customerId: 'CUST_1' });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('r.square_customer_id = $2');
        });

        test('applies date range filters', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRedemptions({
                merchantId: MERCHANT_ID,
                startDate: '2026-01-01',
                endDate: '2026-01-31'
            });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('r.redeemed_at >= $2');
            expect(call[0]).toContain('r.redeemed_at <= $3');
        });

        test('applies limit and offset', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRedemptions({ merchantId: MERCHANT_ID, limit: 50, offset: 10 });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('LIMIT');
            expect(call[0]).toContain('OFFSET');
            expect(call[1]).toContain(50);
            expect(call[1]).toContain(10);
        });

        test('includes LATERAL JOIN for purchase event info', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRedemptions({ merchantId: MERCHANT_ID });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('LEFT JOIN LATERAL');
            expect(call[0]).toContain('loyalty_purchase_events');
        });

        test('returns rows from query result', async () => {
            const mockRows = [{ id: 1, offer_name: 'BCR' }, { id: 2, offer_name: 'Smack' }];
            db.query.mockResolvedValue({ rows: mockRows });

            const result = await getRedemptions({ merchantId: MERCHANT_ID });

            expect(result).toEqual(mockRows);
        });
    });

    describe('getRewards', () => {
        test('throws on missing merchantId', async () => {
            await expect(getRewards({}))
                .rejects.toThrow('merchantId is required');
        });

        test('queries all rewards for merchant', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRewards({ merchantId: MERCHANT_ID });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('merchant_id = $1');
            expect(call[1][0]).toBe(MERCHANT_ID);
        });

        test('applies status filter', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRewards({ merchantId: MERCHANT_ID, status: 'earned' });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('r.status = $2');
            expect(call[1]).toContain('earned');
        });

        test('applies all filters', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await getRewards({
                merchantId: MERCHANT_ID,
                status: 'earned',
                offerId: 3,
                customerId: 'CUST_1'
            });

            const call = db.query.mock.calls[0];
            expect(call[0]).toContain('r.status = $2');
            expect(call[0]).toContain('r.offer_id = $3');
            expect(call[0]).toContain('r.square_customer_id = $4');
        });
    });

    describe('updateVendorCreditStatus', () => {
        test('throws on missing merchantId', async () => {
            await expect(updateVendorCreditStatus({ rewardId: 1, status: 'SUBMITTED' }))
                .rejects.toThrow('merchantId is required');
        });

        test('throws when reward not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await expect(updateVendorCreditStatus({
                merchantId: MERCHANT_ID,
                rewardId: 999,
                status: 'SUBMITTED'
            })).rejects.toThrow('Reward not found');
        });

        test('throws when reward is not redeemed', async () => {
            db.query.mockResolvedValue({ rows: [{ id: 1, status: 'earned', vendor_credit_status: null }] });

            await expect(updateVendorCreditStatus({
                merchantId: MERCHANT_ID,
                rewardId: 1,
                status: 'SUBMITTED'
            })).rejects.toThrow('Only redeemed rewards');
        });

        test('sets submitted timestamp for SUBMITTED status', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ id: 1, status: 'redeemed', vendor_credit_status: null }] })
                .mockResolvedValueOnce({ rows: [{ id: 1, vendor_credit_status: 'SUBMITTED' }] });

            const result = await updateVendorCreditStatus({
                merchantId: MERCHANT_ID,
                rewardId: 1,
                status: 'SUBMITTED',
                notes: 'Sent to vendor'
            });

            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('vendor_credit_submitted_at = NOW()');
            expect(result.vendor_credit_status).toBe('SUBMITTED');
        });

        test('sets resolved timestamp for CREDITED status', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ id: 1, status: 'redeemed', vendor_credit_status: 'SUBMITTED' }] })
                .mockResolvedValueOnce({ rows: [{ id: 1, vendor_credit_status: 'CREDITED' }] });

            await updateVendorCreditStatus({
                merchantId: MERCHANT_ID,
                rewardId: 1,
                status: 'CREDITED'
            });

            const updateCall = db.query.mock.calls[1];
            expect(updateCall[0]).toContain('vendor_credit_resolved_at = NOW()');
        });
    });
});
