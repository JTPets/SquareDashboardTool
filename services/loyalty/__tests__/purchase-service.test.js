/**
 * Unit tests for purchase-service.js
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    purchase: jest.fn(),
    reward: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { LoyaltyPurchaseService } = require('../purchase-service');
const db = require('../../../utils/database');
const { loyaltyLogger } = require('../loyalty-logger');

describe('LoyaltyPurchaseService', () => {
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

    service = new LoyaltyPurchaseService(123, mockTracer);
  });

  describe('constructor', () => {
    test('creates service with merchantId', () => {
      const svc = new LoyaltyPurchaseService(456);
      expect(svc.merchantId).toBe(456);
      expect(svc.tracer).toBeNull();
    });

    test('accepts optional tracer', () => {
      const svc = new LoyaltyPurchaseService(456, mockTracer);
      expect(svc.tracer).toBe(mockTracer);
    });
  });

  describe('recordPurchase', () => {
    const basePurchaseData = {
      squareOrderId: 'order-123',
      squareCustomerId: 'cust-456',
      variationId: 'var-789',
      quantity: 2,
      unitPriceCents: 500,
      purchasedAt: '2024-01-15T10:00:00Z',
      traceId: 'trace-abc',
    };

    test('returns duplicate when order+variation already recorded via ON CONFLICT', async () => {
      // Has qualifying offer
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Test Offer',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      // Transaction queries
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates query
        .mockResolvedValueOnce({ rows: [] }) // INSERT returns empty (duplicate via ON CONFLICT)
        .mockResolvedValueOnce({}); // COMMIT

      const result = await service.recordPurchase(basePurchaseData);

      expect(result.recorded).toBe(false);
      expect(result.results[0]).toEqual(
        expect.objectContaining({
          recorded: false,
          reason: 'duplicate',
          offerId: 10,
        })
      );
      expect(mockTracer.span).toHaveBeenCalledWith('PURCHASE_DUPLICATE', {
        squareOrderId: 'order-123',
        variationId: 'var-789',
        offerId: 10,
      });
      expect(loyaltyLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PURCHASE_ALREADY_RECORDED',
        })
      );
    });

    test('returns no_qualifying_offer when variation has no active offers', async () => {
      // No qualifying offers
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.recordPurchase(basePurchaseData);

      expect(result).toEqual({
        recorded: false,
        reason: 'no_qualifying_offer',
      });
      expect(mockTracer.span).toHaveBeenCalledWith('PURCHASE_NO_OFFER', {
        variationId: 'var-789',
      });
    });

    test('records purchase for qualifying offer', async () => {
      // Has qualifying offer
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Buy 5 Get 1 Free',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      // Transaction queries
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates (first purchase)
        .mockResolvedValueOnce({ rows: [{ id: 1001 }] }) // INSERT purchase event
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window result in updateRewardProgress
        .mockResolvedValueOnce({ rows: [{ total_quantity: '3' }] }) // Progress query
        .mockResolvedValueOnce({}); // COMMIT

      const result = await service.recordPurchase(basePurchaseData);

      expect(result.recorded).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual(
        expect.objectContaining({
          recorded: true,
          purchaseEventId: 1001,
          offerId: 10,
          offerName: 'Buy 5 Get 1 Free',
        })
      );
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('calculates totalPriceCents when not provided', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Test Offer',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates
        .mockResolvedValueOnce({ rows: [{ id: 1001 }] }) // INSERT
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window result
        .mockResolvedValueOnce({ rows: [{ total_quantity: '2' }] }) // Progress
        .mockResolvedValueOnce({}); // COMMIT

      await service.recordPurchase({
        ...basePurchaseData,
        totalPriceCents: undefined,
      });

      // Verify the INSERT was called with calculated total (500 * 2 = 1000)
      const insertCall = mockClient.query.mock.calls.find(
        call => call[0].includes('INSERT INTO loyalty_purchase_events')
      );
      expect(insertCall[1]).toContain(1000); // totalPriceCents
    });

    test('rolls back transaction on error', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Test Offer',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates
        .mockRejectedValueOnce(new Error('Insert failed')); // INSERT fails

      await expect(service.recordPurchase(basePurchaseData))
        .rejects.toThrow('Insert failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PURCHASE_RECORD_ERROR',
        })
      );
    });

    test('creates reward when threshold reached', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Buy 5 Get 1 Free',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates (first purchase)
        .mockResolvedValueOnce({ rows: [{ id: 1001 }] }) // INSERT purchase
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window result in updateRewardProgress
        .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] }) // Progress = 5 (meets threshold)
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window dates for reward in createOrUpdateReward
        .mockResolvedValueOnce({ rows: [] }) // No existing in_progress reward
        .mockResolvedValueOnce({ rows: [] }) // No existing earned reward
        .mockResolvedValueOnce({ rows: [{ id: 2001 }] }) // New reward created
        .mockResolvedValueOnce({ rows: [{ id: 'evt-1', quantity: 5, cumulative_qty: 5 }] }) // Lock purchases - returns 5 units, meets required_quantity=5, no split needed
        .mockResolvedValueOnce({ rows: [{ remaining_count: '0', remaining_qty: '0' }] }) // Check remaining
        .mockResolvedValueOnce({}); // COMMIT

      const result = await service.recordPurchase(basePurchaseData);

      expect(result.results[0].progress.rewardEarned).toBe(true);
      expect(mockTracer.span).toHaveBeenCalledWith('REWARD_CREATED', {
        rewardId: 2001,
        status: 'earned',
      });
    });

    test('records purchase for multiple qualifying offers', async () => {
      db.query.mockResolvedValueOnce({
        rows: [
          { offer_id: 10, offer_name: 'Offer 1', required_quantity: 5, window_months: 12 },
          { offer_id: 20, offer_name: 'Offer 2', required_quantity: 10, window_months: 6 },
        ],
      });

      // First offer transaction
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates
        .mockResolvedValueOnce({ rows: [{ id: 1001 }] }) // INSERT
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window result
        .mockResolvedValueOnce({ rows: [{ total_quantity: '2' }] }) // Progress
        .mockResolvedValueOnce({}); // COMMIT

      // Second offer transaction - need new client
      const mockClient2 = {
        query: jest.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // Existing window dates
          .mockResolvedValueOnce({ rows: [{ id: 1002 }] }) // INSERT
          .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2024-07-15' }] }) // Window result
          .mockResolvedValueOnce({ rows: [{ total_quantity: '2' }] }) // Progress
          .mockResolvedValueOnce({}), // COMMIT
        release: jest.fn(),
      };

      db.getClient
        .mockResolvedValueOnce(mockClient)
        .mockResolvedValueOnce(mockClient2);

      const result = await service.recordPurchase(basePurchaseData);

      expect(result.recorded).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].offerId).toBe(10);
      expect(result.results[1].offerId).toBe(20);
    });
  });

  describe('getPurchaseHistory', () => {
    test('returns purchase history for customer and offer', async () => {
      const mockHistory = [
        {
          id: 1,
          square_order_id: 'order-1',
          variation_id: 'var-1',
          quantity: 2,
          unit_price_cents: 500,
          total_price_cents: 1000,
          purchased_at: '2024-01-15T10:00:00Z',
          variation_name: 'Large Coffee',
          item_name: 'Coffee',
        },
        {
          id: 2,
          square_order_id: 'order-2',
          variation_id: 'var-1',
          quantity: 1,
          unit_price_cents: 500,
          total_price_cents: 500,
          purchased_at: '2024-01-14T10:00:00Z',
          variation_name: 'Large Coffee',
          item_name: 'Coffee',
        },
      ];

      db.query.mockResolvedValueOnce({ rows: mockHistory });

      const result = await service.getPurchaseHistory('cust-123', 10);

      expect(result).toEqual(mockHistory);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM loyalty_purchase_events'),
        [123, 10, 'cust-123', 50]
      );
    });

    test('respects limit option', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      await service.getPurchaseHistory('cust-123', 10, { limit: 25 });

      expect(db.query).toHaveBeenCalledWith(
        expect.any(String),
        [123, 10, 'cust-123', 25]
      );
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getPurchaseHistory('cust-123', 10))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_PURCHASE_HISTORY_ERROR',
        })
      );
    });
  });

  describe('getCurrentProgress', () => {
    test('returns progress information', async () => {
      // Offer query
      db.query.mockResolvedValueOnce({
        rows: [{ required_quantity: 5, window_months: 6 }],
      });
      // Window dates query
      db.query.mockResolvedValueOnce({
        rows: [{ window_start: '2024-01-15', window_end: '2024-07-15' }],
      });
      // Progress query
      db.query.mockResolvedValueOnce({
        rows: [{ total_quantity: '3' }],
      });

      const result = await service.getCurrentProgress('cust-123', 10);

      expect(result).toEqual({
        currentProgress: 3,
        requiredQuantity: 5,
        remaining: 2,
        percentComplete: 60,
        windowStart: '2024-01-15',
        windowEnd: '2024-07-15',
        windowMonths: 6,
      });
    });

    test('returns null when offer not found', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getCurrentProgress('cust-123', 999);

      expect(result).toBeNull();
    });

    test('handles progress exceeding requirement', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ required_quantity: 5, window_months: 12 }],
      });
      // Window dates query
      db.query.mockResolvedValueOnce({
        rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }],
      });
      db.query.mockResolvedValueOnce({
        rows: [{ total_quantity: '7' }],
      });

      const result = await service.getCurrentProgress('cust-123', 10);

      expect(result.currentProgress).toBe(7);
      expect(result.remaining).toBe(0);
      expect(result.percentComplete).toBe(100); // Capped at 100
    });

    test('returns zero progress when no purchases exist', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ required_quantity: 5, window_months: 12 }],
      });
      // Window dates query - no purchases
      db.query.mockResolvedValueOnce({
        rows: [{ window_start: null, window_end: null }],
      });

      const result = await service.getCurrentProgress('cust-123', 10);

      expect(result.currentProgress).toBe(0);
      expect(result.remaining).toBe(5);
      expect(result.percentComplete).toBe(0);
      expect(result.windowStart).toBeNull();
      expect(result.windowEnd).toBeNull();
      expect(result.windowMonths).toBe(12);
    });

    test('throws and logs error on failure', async () => {
      db.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getCurrentProgress('cust-123', 10))
        .rejects.toThrow('Query failed');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_CURRENT_PROGRESS_ERROR',
        })
      );
    });
  });

  describe('updateRewardProgress (via recordPurchase)', () => {
    test('updates existing in_progress reward to earned', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Test',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates
        .mockResolvedValueOnce({ rows: [{ id: 1001 }] }) // INSERT purchase
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window result in updateRewardProgress
        .mockResolvedValueOnce({ rows: [{ total_quantity: '5' }] }) // Progress = threshold
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window dates for reward
        .mockResolvedValueOnce({ rows: [{ id: 500, status: 'in_progress' }] }) // Existing in_progress reward
        .mockResolvedValueOnce({}) // UPDATE reward to earned
        .mockResolvedValueOnce({ rows: [{ id: 'evt-1', quantity: 5, cumulative_qty: 5 }] }) // Lock purchases - returns 5 units, meets required_quantity=5, no split needed
        .mockResolvedValueOnce({ rows: [{ remaining_count: '0', remaining_qty: '0' }] }) // Check remaining
        .mockResolvedValueOnce({}); // COMMIT

      await service.recordPurchase({
        squareOrderId: 'order-123',
        squareCustomerId: 'cust-456',
        variationId: 'var-789',
        quantity: 1,
        unitPriceCents: 500,
        purchasedAt: '2024-01-15T10:00:00Z',
      });

      expect(mockTracer.span).toHaveBeenCalledWith('REWARD_EARNED', {
        rewardId: 500,
      });
      expect(loyaltyLogger.reward).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REWARD_EARNED',
          rewardId: 500,
        })
      );
    });

    test('skips reward creation if earned reward already exists', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{
          offer_id: 10,
          offer_name: 'Test',
          required_quantity: 5,
          window_months: 12,
        }],
      });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Existing window dates
        .mockResolvedValueOnce({ rows: [{ id: 1001 }] }) // INSERT purchase
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window result in updateRewardProgress
        .mockResolvedValueOnce({ rows: [{ total_quantity: '6' }] }) // Progress > threshold
        .mockResolvedValueOnce({ rows: [{ window_start: '2024-01-15', window_end: '2025-01-15' }] }) // Window dates for reward
        .mockResolvedValueOnce({ rows: [] }) // No in_progress reward
        .mockResolvedValueOnce({ rows: [{ id: 600 }] }) // Existing earned reward (unredeemed)
        .mockResolvedValueOnce({}); // COMMIT

      const result = await service.recordPurchase({
        squareOrderId: 'order-123',
        squareCustomerId: 'cust-456',
        variationId: 'var-789',
        quantity: 1,
        unitPriceCents: 500,
        purchasedAt: '2024-01-15T10:00:00Z',
      });

      expect(result.results[0].progress.rewardEarned).toBe(true);
      // Should not have called REWARD_CREATED since one already existed
      expect(mockTracer.span).not.toHaveBeenCalledWith('REWARD_CREATED', expect.anything());
    });
  });
});
