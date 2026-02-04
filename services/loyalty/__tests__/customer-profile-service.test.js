/**
 * Unit tests for customer-profile-service.js
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

const { getCustomerOfferProgress } = require('../customer-profile-service');
const db = require('../../../utils/database');
const { loyaltyLogger } = require('../loyalty-logger');

describe('getCustomerOfferProgress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parameter validation', () => {
    test('throws error when merchantId is missing', async () => {
      await expect(
        getCustomerOfferProgress({ squareCustomerId: 'cust-123' })
      ).rejects.toThrow('merchantId is required');
    });

    test('throws error when squareCustomerId is missing', async () => {
      await expect(
        getCustomerOfferProgress({ merchantId: 1 })
      ).rejects.toThrow('squareCustomerId is required');
    });
  });

  describe('customer with no purchases', () => {
    test('returns all active offers with 0 progress', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          {
            offer_id: 1,
            offer_name: 'Smack Cat Food Buy 8 Get 1',
            brand_name: 'Smack',
            size_group: '1.5kg',
            required_quantity: 8,
            window_months: 12,
            current_quantity: 0,
            window_start_date: null,
            window_end_date: null,
            has_earned_reward: false,
            earned_reward_id: null,
            total_lifetime_purchases: 0,
            total_rewards_earned: 0,
            total_rewards_redeemed: 0,
            last_purchase_at: null,
          },
          {
            offer_id: 2,
            offer_name: 'Acana Dog Food Buy 10 Get 1',
            brand_name: 'Acana',
            size_group: '11.4kg',
            required_quantity: 10,
            window_months: 12,
            current_quantity: 0,
            window_start_date: null,
            window_end_date: null,
            has_earned_reward: false,
            earned_reward_id: null,
            total_lifetime_purchases: 0,
            total_rewards_earned: 0,
            total_rewards_redeemed: 0,
            last_purchase_at: null,
          },
        ],
      });

      const result = await getCustomerOfferProgress({
        squareCustomerId: 'cust-new',
        merchantId: 1,
      });

      expect(result.squareCustomerId).toBe('cust-new');
      expect(result.offers).toHaveLength(2);
      expect(result.offers[0].current_quantity).toBe(0);
      expect(result.offers[0].required_quantity).toBe(8);
      expect(result.offers[1].current_quantity).toBe(0);
      expect(result.offers[1].required_quantity).toBe(10);

      // Verify query was called with correct parameters
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM loyalty_offers o'),
        [1, 'cust-new']
      );
    });
  });

  describe('customer with purchase_events', () => {
    test('shows correct progress from purchase events', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          {
            offer_id: 1,
            offer_name: 'Smack Cat Food Buy 8 Get 1',
            brand_name: 'Smack',
            size_group: '1.5kg',
            required_quantity: 8,
            window_months: 12,
            current_quantity: 3,
            window_start_date: '2024-01-15',
            window_end_date: '2025-01-15',
            has_earned_reward: false,
            earned_reward_id: null,
            total_lifetime_purchases: 3,
            total_rewards_earned: 0,
            total_rewards_redeemed: 0,
            last_purchase_at: '2024-03-20T10:00:00Z',
          },
        ],
      });

      const result = await getCustomerOfferProgress({
        squareCustomerId: 'cust-123',
        merchantId: 1,
      });

      expect(result.offers[0].current_quantity).toBe(3);
      expect(result.offers[0].required_quantity).toBe(8);
      expect(result.offers[0].window_end_date).toBe('2025-01-15');
      expect(result.offers[0].has_earned_reward).toBe(false);
    });
  });

  describe('customer with earned reward', () => {
    test('has_earned_reward is true when reward exists', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          {
            offer_id: 1,
            offer_name: 'Smack Cat Food Buy 8 Get 1',
            brand_name: 'Smack',
            size_group: '1.5kg',
            required_quantity: 8,
            window_months: 12,
            current_quantity: 0,
            window_start_date: '2024-01-15',
            window_end_date: '2025-01-15',
            has_earned_reward: true,
            earned_reward_id: 456,
            total_lifetime_purchases: 8,
            total_rewards_earned: 1,
            total_rewards_redeemed: 0,
            last_purchase_at: '2024-06-01T10:00:00Z',
          },
        ],
      });

      const result = await getCustomerOfferProgress({
        squareCustomerId: 'cust-with-reward',
        merchantId: 1,
      });

      expect(result.offers[0].has_earned_reward).toBe(true);
      expect(result.offers[0].earned_reward_id).toBe(456);
      expect(result.offers[0].current_quantity).toBe(0);
    });
  });

  describe('customer with redeemed rewards', () => {
    test('tracks redeemed reward counts', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          {
            offer_id: 1,
            offer_name: 'Smack Cat Food Buy 8 Get 1',
            brand_name: 'Smack',
            size_group: '1.5kg',
            required_quantity: 8,
            window_months: 12,
            current_quantity: 2,
            window_start_date: '2024-06-01',
            window_end_date: '2025-06-01',
            has_earned_reward: false,
            earned_reward_id: null,
            total_lifetime_purchases: 18,
            total_rewards_earned: 2,
            total_rewards_redeemed: 2,
            last_purchase_at: '2024-08-01T10:00:00Z',
          },
        ],
      });

      const result = await getCustomerOfferProgress({
        squareCustomerId: 'cust-loyal',
        merchantId: 1,
      });

      expect(result.offers[0].total_rewards_earned).toBe(2);
      expect(result.offers[0].total_rewards_redeemed).toBe(2);
      expect(result.offers[0].total_lifetime_purchases).toBe(18);
    });
  });

  describe('expired window purchases', () => {
    test('expired window purchases are not counted in current_quantity', async () => {
      // The SQL query filters out expired windows, so the mock should reflect
      // what the database would return (0 for expired windows)
      db.query.mockResolvedValueOnce({
        rows: [
          {
            offer_id: 1,
            offer_name: 'Smack Cat Food Buy 8 Get 1',
            brand_name: 'Smack',
            size_group: '1.5kg',
            required_quantity: 8,
            window_months: 12,
            current_quantity: 0, // Expired purchases not counted
            window_start_date: '2022-01-15',
            window_end_date: '2023-01-15', // Expired
            has_earned_reward: false,
            earned_reward_id: null,
            total_lifetime_purchases: 5, // Lifetime still tracked
            total_rewards_earned: 0,
            total_rewards_redeemed: 0,
            last_purchase_at: '2022-06-01T10:00:00Z',
          },
        ],
      });

      const result = await getCustomerOfferProgress({
        squareCustomerId: 'cust-expired',
        merchantId: 1,
      });

      expect(result.offers[0].current_quantity).toBe(0);
      expect(result.offers[0].total_lifetime_purchases).toBe(5);
    });
  });

  describe('multi-tenant isolation', () => {
    test('query filters by merchantId', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      await getCustomerOfferProgress({
        squareCustomerId: 'cust-123',
        merchantId: 42,
      });

      // Verify merchantId is the first parameter
      expect(db.query).toHaveBeenCalledWith(
        expect.any(String),
        [42, 'cust-123']
      );

      // Verify the query includes merchant_id filter
      const queryCall = db.query.mock.calls[0];
      expect(queryCall[0]).toContain('WHERE o.merchant_id = $1');
    });
  });

  describe('logging', () => {
    test('logs profile load with debug level', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          {
            offer_id: 1,
            offer_name: 'Test Offer',
            brand_name: 'Test',
            size_group: '1kg',
            required_quantity: 5,
            window_months: 12,
            current_quantity: 2,
            window_start_date: null,
            window_end_date: null,
            has_earned_reward: false,
            earned_reward_id: null,
            total_lifetime_purchases: 2,
            total_rewards_earned: 0,
            total_rewards_redeemed: 0,
            last_purchase_at: null,
          },
        ],
      });

      await getCustomerOfferProgress({
        squareCustomerId: 'cust-123',
        merchantId: 1,
      });

      expect(loyaltyLogger.debug).toHaveBeenCalledWith({
        action: 'CUSTOMER_PROFILE_LOADED',
        squareCustomerId: 'cust-123',
        merchantId: 1,
        offerCount: 1,
        offersWithProgress: 1,
      });
    });
  });
});
