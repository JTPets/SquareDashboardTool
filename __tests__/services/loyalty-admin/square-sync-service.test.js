/**
 * Tests for square-sync-service.js
 *
 * Validates Square POS sync: linking offers to tiers, reward lookup,
 * bulk sync orchestration, and pending/synced counts.
 */

jest.mock('../../../utils/database', () => ({
    query: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: jest.fn(),
    cleanupSquareCustomerGroupDiscount: jest.fn(),
}));

const { linkOfferToSquareTier, getRewardForSquareSync, syncRewardsToPOS, getPendingSyncCounts } = require('../../../services/loyalty-admin/square-sync-service');
const db = require('../../../utils/database');
const { createSquareCustomerGroupDiscount, cleanupSquareCustomerGroupDiscount } = require('../../../services/loyalty-admin/square-discount-service');

const MERCHANT_ID = 1;

describe('square-sync-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('linkOfferToSquareTier', () => {
        test('throws on missing merchantId', async () => {
            await expect(linkOfferToSquareTier({ offerId: 1, squareRewardTierId: 'tier1' }))
                .rejects.toThrow('merchantId is required');
        });

        test('updates offer and returns result', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, offer_name: 'BCR', square_reward_tier_id: 'tier1' }]
            });

            const result = await linkOfferToSquareTier({
                merchantId: MERCHANT_ID,
                offerId: 1,
                squareRewardTierId: 'tier1'
            });

            expect(result.square_reward_tier_id).toBe('tier1');
            expect(db.query.mock.calls[0][1]).toEqual(['tier1', 1, MERCHANT_ID]);
        });

        test('returns null when offer not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await linkOfferToSquareTier({
                merchantId: MERCHANT_ID,
                offerId: 999,
                squareRewardTierId: 'tier1'
            });

            expect(result).toBeNull();
        });
    });

    describe('getRewardForSquareSync', () => {
        test('throws on missing merchantId', async () => {
            await expect(getRewardForSquareSync({ rewardId: 1 }))
                .rejects.toThrow('merchantId is required');
        });

        test('returns reward with offer_name', async () => {
            db.query.mockResolvedValue({
                rows: [{ id: 1, status: 'earned', offer_name: 'BCR 4lb' }]
            });

            const result = await getRewardForSquareSync({ merchantId: MERCHANT_ID, rewardId: 1 });

            expect(result.offer_name).toBe('BCR 4lb');
        });

        test('returns null when not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await getRewardForSquareSync({ merchantId: MERCHANT_ID, rewardId: 999 });

            expect(result).toBeNull();
        });
    });

    describe('syncRewardsToPOS', () => {
        test('throws on missing merchantId', async () => {
            await expect(syncRewardsToPOS({}))
                .rejects.toThrow('merchantId is required');
        });

        test('returns early when no pending rewards', async () => {
            db.query.mockResolvedValue({ rows: [] });

            const result = await syncRewardsToPOS({ merchantId: MERCHANT_ID });

            expect(result.synced).toBe(0);
            expect(result.message).toContain('already synced');
        });

        test('syncs pending rewards', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: 1, square_customer_id: 'CUST_1', offer_id: 1, offer_name: 'BCR', square_group_id: null, square_discount_id: null },
                    { id: 2, square_customer_id: 'CUST_2', offer_id: 1, offer_name: 'BCR', square_group_id: null, square_discount_id: null }
                ]
            });

            createSquareCustomerGroupDiscount.mockResolvedValue({ success: true });

            const result = await syncRewardsToPOS({ merchantId: MERCHANT_ID });

            expect(result.synced).toBe(2);
            expect(result.total).toBe(2);
            expect(createSquareCustomerGroupDiscount).toHaveBeenCalledTimes(2);
        });

        test('force mode cleans up existing discounts', async () => {
            db.query.mockResolvedValue({
                rows: [{
                    id: 1,
                    square_customer_id: 'CUST_1',
                    offer_id: 1,
                    offer_name: 'BCR',
                    square_group_id: 'existing_group',
                    square_discount_id: 'existing_discount'
                }]
            });

            createSquareCustomerGroupDiscount.mockResolvedValue({ success: true });

            await syncRewardsToPOS({ merchantId: MERCHANT_ID, force: true });

            expect(cleanupSquareCustomerGroupDiscount).toHaveBeenCalledTimes(1);
            expect(createSquareCustomerGroupDiscount).toHaveBeenCalledTimes(1);
        });

        test('continues when individual reward fails', async () => {
            db.query.mockResolvedValue({
                rows: [
                    { id: 1, square_customer_id: 'CUST_1', offer_id: 1, offer_name: 'BCR', square_group_id: null },
                    { id: 2, square_customer_id: 'CUST_2', offer_id: 1, offer_name: 'BCR', square_group_id: null }
                ]
            });

            createSquareCustomerGroupDiscount
                .mockRejectedValueOnce(new Error('Square API error'))
                .mockResolvedValueOnce({ success: true });

            const result = await syncRewardsToPOS({ merchantId: MERCHANT_ID });

            expect(result.synced).toBe(1);
            expect(result.results[0].success).toBe(false);
            expect(result.results[1].success).toBe(true);
        });

        test('non-force mode filters for unsynced only', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await syncRewardsToPOS({ merchantId: MERCHANT_ID, force: false });

            const queryStr = db.query.mock.calls[0][0];
            expect(queryStr).toContain('square_group_id IS NULL');
        });
    });

    describe('getPendingSyncCounts', () => {
        test('throws on missing merchantId', async () => {
            await expect(getPendingSyncCounts(undefined))
                .rejects.toThrow('merchantId is required');
        });

        test('returns pending and synced counts', async () => {
            db.query
                .mockResolvedValueOnce({ rows: [{ count: '3' }] })
                .mockResolvedValueOnce({ rows: [{ count: '12' }] });

            const result = await getPendingSyncCounts(MERCHANT_ID);

            expect(result.pendingCount).toBe(3);
            expect(result.syncedCount).toBe(12);
        });
    });
});
