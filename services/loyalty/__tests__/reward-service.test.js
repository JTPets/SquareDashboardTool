/**
 * Unit tests for reward-service.js
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    reward: jest.fn(),
    redemption: jest.fn(),
    error: jest.fn(),
  },
}));

const { LoyaltyRewardService } = require('../reward-service');
const db = require('../../../utils/database');
const { loyaltyLogger } = require('../loyalty-logger');

describe('LoyaltyRewardService', () => {
  let service;
  let mockClient;
  let mockTracer;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    db.getClient.mockResolvedValue(mockClient);

    mockTracer = {
      span: jest.fn(),
    };

    service = new LoyaltyRewardService(123, mockTracer);
  });

  describe('constructor', () => {
    test('creates service with merchantId', () => {
      const svc = new LoyaltyRewardService(456);
      expect(svc.merchantId).toBe(456);
      expect(svc.tracer).toBeNull();
    });

    test('accepts optional tracer', () => {
      const svc = new LoyaltyRewardService(456, mockTracer);
      expect(svc.tracer).toBe(mockTracer);
    });
  });

  describe('getCustomerRewards', () => {
    test('returns earned rewards for customer', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            offer_id: 10,
            status: 'earned',
            current_quantity: 5,
            earned_at: '2024-01-15T10:00:00Z',
            redeemed_at: null,
            expires_at: null,
            trace_id: 'trace-123',
            offer_name: 'Buy 5 Get 1 Free',
            reward_type: 'free_item',
            reward_value: 1,
            reward_description: 'One free coffee',
          },
        ],
      });

      const result = await service.getCustomerRewards('cust-456');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 1,
        offerId: 10,
        offerName: 'Buy 5 Get 1 Free',
        status: 'earned',
        progressQuantity: 5,
        rewardType: 'free_item',
        rewardValue: 1,
        rewardDescription: 'One free coffee',
        earnedAt: '2024-01-15T10:00:00Z',
        redeemedAt: null,
        expiresAt: null,
        traceId: 'trace-123',
      });
    });

    test('filters out redeemed rewards by default', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      await service.getCustomerRewards('cust-456');

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'earned'"),
        [123, 'cust-456']
      );
    });

    test('includes redeemed rewards when option set', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      await service.getCustomerRewards('cust-456', { includeRedeemed: true });

      expect(db.query).toHaveBeenCalledWith(
        expect.not.stringContaining("status = 'earned'"),
        [123, 'cust-456']
      );
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getCustomerRewards('cust-456'))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_CUSTOMER_REWARDS_ERROR',
        })
      );
    });
  });

  describe('getRewardById', () => {
    test('returns reward when found', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          offer_id: 10,
          square_customer_id: 'cust-456',
          status: 'earned',
          current_quantity: 5,
          earned_at: '2024-01-15T10:00:00Z',
          redeemed_at: null,
          redemption_order_id: null,
          expires_at: null,
          trace_id: 'trace-123',
          offer_name: 'Test Offer',
          reward_type: 'discount',
          reward_value: 10,
          reward_description: '10% off',
        }],
      });

      const result = await service.getRewardById(1);

      expect(result).toEqual({
        id: 1,
        offerId: 10,
        squareCustomerId: 'cust-456',
        offerName: 'Test Offer',
        status: 'earned',
        progressQuantity: 5,
        rewardType: 'discount',
        rewardValue: 10,
        rewardDescription: '10% off',
        earnedAt: '2024-01-15T10:00:00Z',
        redeemedAt: null,
        redeemedOrderId: null,
        expiresAt: null,
        traceId: 'trace-123',
      });
    });

    test('returns null when not found', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getRewardById(999);

      expect(result).toBeNull();
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getRewardById(1))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_REWARD_BY_ID_ERROR',
        })
      );
    });
  });

  describe('getRedeemableReward', () => {
    test('returns redeemable reward when available', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          status: 'earned',
          earned_at: '2024-01-15T10:00:00Z',
          expires_at: null,
          offer_name: 'Test Offer',
          reward_type: 'free_item',
          reward_value: 1,
          reward_description: 'One free item',
        }],
      });

      const result = await service.getRedeemableReward('cust-456', 10);

      expect(result).toEqual({
        id: 1,
        offerName: 'Test Offer',
        rewardType: 'free_item',
        rewardValue: 1,
        rewardDescription: 'One free item',
        earnedAt: '2024-01-15T10:00:00Z',
        expiresAt: null,
      });
    });

    test('returns null when no redeemable reward', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getRedeemableReward('cust-456', 10);

      expect(result).toBeNull();
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getRedeemableReward('cust-456', 10))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_REDEEMABLE_REWARD_ERROR',
        })
      );
    });
  });

  describe('countEarnedRewards', () => {
    test('returns count of earned rewards', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ count: '3' }],
      });

      const result = await service.countEarnedRewards('cust-456');

      expect(result).toBe(3);
    });

    test('returns 0 when no rewards', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ count: '0' }],
      });

      const result = await service.countEarnedRewards('cust-456');

      expect(result).toBe(0);
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.countEarnedRewards('cust-456'))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'COUNT_EARNED_REWARDS_ERROR',
        })
      );
    });
  });

  describe('getRewardStats', () => {
    test('returns reward statistics', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          available: '5',
          redeemed: '10',
          expired: '2',
          total: '17',
        }],
      });

      const result = await service.getRewardStats('cust-456');

      expect(result).toEqual({
        available: 5,
        redeemed: 10,
        expired: 2,
        total: 17,
      });
    });

    test('returns zeros when no rewards', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          available: null,
          redeemed: null,
          expired: null,
          total: '0',
        }],
      });

      const result = await service.getRewardStats('cust-456');

      expect(result).toEqual({
        available: 0,
        redeemed: 0,
        expired: 0,
        total: 0,
      });
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getRewardStats('cust-456'))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_REWARD_STATS_ERROR',
        })
      );
    });
  });
});
