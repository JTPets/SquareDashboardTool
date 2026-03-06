/**
 * Tests for services/loyalty-admin/square-reward-service.js
 *
 * Validates Square reward creation: state transitions, force re-sync,
 * already-synced handling, and delegation to discount services.
 */

jest.mock('../../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/square-sync-service', () => ({
    getRewardForSquareSync: jest.fn(),
}));

jest.mock('../../../services/loyalty-admin/square-discount-service', () => ({
    createSquareCustomerGroupDiscount: jest.fn(),
    cleanupSquareCustomerGroupDiscount: jest.fn(),
}));

const { createSquareReward } = require('../../../services/loyalty-admin/square-reward-service');
const { getRewardForSquareSync } = require('../../../services/loyalty-admin/square-sync-service');
const {
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount
} = require('../../../services/loyalty-admin/square-discount-service');

const MERCHANT_ID = 1;

describe('square-reward-service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('throws on missing merchantId', async () => {
        await expect(createSquareReward({ rewardId: 1 }))
            .rejects.toThrow('merchantId is required');
    });

    test('returns not-found when reward does not exist', async () => {
        getRewardForSquareSync.mockResolvedValue(null);

        const result = await createSquareReward({ merchantId: MERCHANT_ID, rewardId: 999 });

        expect(result.found).toBe(false);
        expect(result.error).toContain('not found');
    });

    test('returns ineligible when reward status is not earned', async () => {
        getRewardForSquareSync.mockResolvedValue({
            id: 1, status: 'redeemed', square_customer_id: 'CUST_1', offer_id: 10
        });

        const result = await createSquareReward({ merchantId: MERCHANT_ID, rewardId: 1 });

        expect(result.found).toBe(true);
        expect(result.eligible).toBe(false);
        expect(result.error).toContain('earned');
    });

    test('returns already-synced without force', async () => {
        getRewardForSquareSync.mockResolvedValue({
            id: 1, status: 'earned', square_customer_id: 'CUST_1', offer_id: 10,
            square_group_id: 'GRP_1', square_discount_id: 'DISC_1'
        });

        const result = await createSquareReward({ merchantId: MERCHANT_ID, rewardId: 1 });

        expect(result.success).toBe(true);
        expect(result.message).toContain('Already synced');
        expect(result.groupId).toBe('GRP_1');
        expect(createSquareCustomerGroupDiscount).not.toHaveBeenCalled();
    });

    test('force re-sync cleans up existing and creates new', async () => {
        getRewardForSquareSync.mockResolvedValue({
            id: 1, status: 'earned', square_customer_id: 'CUST_1', offer_id: 10,
            square_group_id: 'GRP_1', square_discount_id: 'DISC_1'
        });
        cleanupSquareCustomerGroupDiscount.mockResolvedValue({});
        createSquareCustomerGroupDiscount.mockResolvedValue({ success: true, groupId: 'GRP_2' });

        const result = await createSquareReward({ merchantId: MERCHANT_ID, rewardId: 1, force: true });

        expect(cleanupSquareCustomerGroupDiscount).toHaveBeenCalledWith({
            merchantId: MERCHANT_ID,
            squareCustomerId: 'CUST_1',
            internalRewardId: 1
        });
        expect(createSquareCustomerGroupDiscount).toHaveBeenCalledWith({
            merchantId: MERCHANT_ID,
            squareCustomerId: 'CUST_1',
            internalRewardId: 1,
            offerId: 10
        });
        expect(result.found).toBe(true);
        expect(result.eligible).toBe(true);
        expect(result.success).toBe(true);
    });

    test('creates discount for earned reward without existing sync', async () => {
        getRewardForSquareSync.mockResolvedValue({
            id: 2, status: 'earned', square_customer_id: 'CUST_2', offer_id: 20,
            square_group_id: null, square_discount_id: null
        });
        createSquareCustomerGroupDiscount.mockResolvedValue({ success: true, groupId: 'GRP_NEW' });

        const result = await createSquareReward({ merchantId: MERCHANT_ID, rewardId: 2 });

        expect(cleanupSquareCustomerGroupDiscount).not.toHaveBeenCalled();
        expect(createSquareCustomerGroupDiscount).toHaveBeenCalledWith({
            merchantId: MERCHANT_ID,
            squareCustomerId: 'CUST_2',
            internalRewardId: 2,
            offerId: 20
        });
        expect(result.found).toBe(true);
        expect(result.eligible).toBe(true);
        expect(result.success).toBe(true);
    });
});
