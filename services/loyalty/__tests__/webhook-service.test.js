/**
 * Unit tests for webhook-service.js
 */

// Mock dependencies before imports
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    audit: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../square-client', () => ({
  LoyaltySquareClient: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('../customer-service', () => ({
  LoyaltyCustomerService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue({}),
    identifyCustomerFromOrder: jest.fn(),
  })),
}));

jest.mock('../offer-service', () => ({
  LoyaltyOfferService: jest.fn().mockImplementation(() => ({
    getActiveOffers: jest.fn(),
    getAllQualifyingVariationIds: jest.fn(),
  })),
}));

jest.mock('../purchase-service', () => ({
  LoyaltyPurchaseService: jest.fn().mockImplementation(() => ({
    recordPurchase: jest.fn(),
  })),
}));

jest.mock('../reward-service', () => ({
  LoyaltyRewardService: jest.fn().mockImplementation(() => ({})),
}));

const { LoyaltyWebhookService } = require('../webhook-service');
const { LoyaltyCustomerService } = require('../customer-service');
const { LoyaltyOfferService } = require('../offer-service');
const { LoyaltyPurchaseService } = require('../purchase-service');
const { loyaltyLogger } = require('../loyalty-logger');

describe('LoyaltyWebhookService', () => {
  let service;
  let mockCustomerService;
  let mockOfferService;
  let mockPurchaseService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create mock service instances
    mockCustomerService = {
      initialize: jest.fn().mockResolvedValue({}),
      identifyCustomerFromOrder: jest.fn(),
    };

    mockOfferService = {
      getActiveOffers: jest.fn(),
      getAllQualifyingVariationIds: jest.fn(),
    };

    mockPurchaseService = {
      recordPurchase: jest.fn(),
    };

    // Mock the constructors to return our mocks
    LoyaltyCustomerService.mockImplementation(() => mockCustomerService);
    LoyaltyOfferService.mockImplementation(() => mockOfferService);
    LoyaltyPurchaseService.mockImplementation(() => mockPurchaseService);

    service = new LoyaltyWebhookService(123);
    await service.initialize();
  });

  describe('constructor', () => {
    test('creates service with merchantId', () => {
      const svc = new LoyaltyWebhookService(456);
      expect(svc.merchantId).toBe(456);
      expect(svc.tracer).toBeTruthy();
    });
  });

  describe('initialize', () => {
    test('initializes all services', async () => {
      const svc = new LoyaltyWebhookService(789);
      await svc.initialize();

      expect(svc.customerService).toBeDefined();
      expect(svc.offerService).toBeDefined();
      expect(svc.purchaseService).toBeDefined();
      expect(svc.rewardService).toBeDefined();
    });
  });

  describe('processOrder', () => {
    const baseOrder = {
      id: 'ORDER-123',
      state: 'COMPLETED',
      created_at: '2024-01-15T10:00:00Z',
      line_items: [
        {
          uid: 'line-1',
          name: 'Large Coffee',
          catalog_object_id: 'VAR-001',
          quantity: '2',
          total_money: { amount: 1000, currency: 'USD' },
        },
      ],
    };

    test('returns failure when customer not identified', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: false,
        customerId: null,
        method: 'NONE',
      });

      const result = await service.processOrder(baseOrder);

      expect(result.processed).toBe(false);
      expect(result.reason).toBe('customer_not_identified');
      expect(result.trace).toBeDefined();
      expect(loyaltyLogger.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_PROCESSING_SKIP_NO_CUSTOMER',
        })
      );
    });

    test('returns failure when no active offers', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([]);

      const result = await service.processOrder(baseOrder);

      expect(result.processed).toBe(false);
      expect(result.reason).toBe('no_active_offers');
      expect(result.customerId).toBe('CUST-456');
    });

    test('processes order successfully with qualifying items', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([
        { id: 10, name: 'Buy 5 Get 1 Free' },
      ]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001'])
      );
      mockPurchaseService.recordPurchase.mockResolvedValue({
        recorded: true,
        results: [
          { offerId: 10, progress: { currentProgress: 3, rewardEarned: false } },
        ],
      });

      const result = await service.processOrder(baseOrder);

      expect(result.processed).toBe(true);
      expect(result.customerId).toBe('CUST-456');
      expect(result.summary.qualifyingItems).toBe(1);
      expect(result.summary.purchasesRecorded).toBe(1);
      expect(loyaltyLogger.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_PROCESSING_COMPLETE',
        })
      );
    });

    test('tracks reward earned', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([
        { id: 10, name: 'Buy 5 Get 1 Free' },
      ]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001'])
      );
      mockPurchaseService.recordPurchase.mockResolvedValue({
        recorded: true,
        results: [
          { offerId: 10, progress: { currentProgress: 5, rewardEarned: true } },
        ],
      });

      const result = await service.processOrder(baseOrder);

      expect(result.summary.rewardsEarned).toBe(1);
    });

    test('skips line items with no variation ID', async () => {
      const orderWithNoVariation = {
        ...baseOrder,
        line_items: [
          { uid: 'line-1', name: 'Custom Item', quantity: '1', total_money: { amount: 500 } },
        ],
      };

      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(new Set());

      const result = await service.processOrder(orderWithNoVariation);

      expect(result.lineItemResults[0].qualifying).toBe(false);
      expect(result.lineItemResults[0].reason).toBe('no_variation_id');
    });

    test('skips line items with zero quantity', async () => {
      const orderWithZeroQty = {
        ...baseOrder,
        line_items: [
          {
            uid: 'line-1',
            catalog_object_id: 'VAR-001',
            quantity: '0',
            total_money: { amount: 0 },
          },
        ],
      };

      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001'])
      );

      const result = await service.processOrder(orderWithZeroQty);

      expect(result.lineItemResults[0].qualifying).toBe(false);
      expect(result.lineItemResults[0].reason).toBe('zero_quantity');
    });

    test('skips free items (zero price)', async () => {
      const orderWithFreeItem = {
        ...baseOrder,
        line_items: [
          {
            uid: 'line-1',
            name: 'Free Coffee',
            catalog_object_id: 'VAR-001',
            quantity: '1',
            total_money: { amount: 0 },
          },
        ],
      };

      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001'])
      );

      const result = await service.processOrder(orderWithFreeItem);

      expect(result.lineItemResults[0].qualifying).toBe(false);
      expect(result.lineItemResults[0].reason).toBe('free_item');
      expect(loyaltyLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LINE_ITEM_EVALUATION',
          decision: 'SKIP_FREE',
        })
      );
    });

    test('skips non-qualifying variations', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-OTHER']) // VAR-001 not in set
      );

      const result = await service.processOrder(baseOrder);

      expect(result.lineItemResults[0].qualifying).toBe(false);
      expect(result.lineItemResults[0].reason).toBe('not_qualifying_variation');
    });

    test('handles purchase recording error gracefully', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001'])
      );
      mockPurchaseService.recordPurchase.mockRejectedValue(
        new Error('Database error')
      );

      const result = await service.processOrder(baseOrder);

      expect(result.lineItemResults[0].qualifying).toBe(true);
      expect(result.lineItemResults[0].recorded).toBe(false);
      expect(result.lineItemResults[0].error).toBe('Database error');
      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LINE_ITEM_RECORD_ERROR',
        })
      );
    });

    test('processes multiple line items', async () => {
      const multiItemOrder = {
        ...baseOrder,
        line_items: [
          {
            uid: 'line-1',
            name: 'Large Coffee',
            catalog_object_id: 'VAR-001',
            quantity: '1',
            total_money: { amount: 500 },
          },
          {
            uid: 'line-2',
            name: 'Small Tea',
            catalog_object_id: 'VAR-002',
            quantity: '2',
            total_money: { amount: 400 },
          },
          {
            uid: 'line-3',
            name: 'Bagel',
            catalog_object_id: 'VAR-003',
            quantity: '1',
            total_money: { amount: 300 },
          },
        ],
      };

      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001', 'VAR-002']) // VAR-003 not qualifying
      );
      mockPurchaseService.recordPurchase.mockResolvedValue({
        recorded: true,
        results: [{ offerId: 10, progress: { rewardEarned: false } }],
      });

      const result = await service.processOrder(multiItemOrder);

      expect(result.lineItemResults).toHaveLength(3);
      expect(result.summary.totalLineItems).toBe(3);
      expect(result.summary.qualifyingItems).toBe(2);
      expect(result.summary.purchasesRecorded).toBe(2);
    });

    test('includes trace in result', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: true,
        customerId: 'CUST-456',
        method: 'ORDER_CUSTOMER_ID',
      });
      mockOfferService.getActiveOffers.mockResolvedValue([{ id: 10 }]);
      mockOfferService.getAllQualifyingVariationIds.mockResolvedValue(
        new Set(['VAR-001'])
      );
      mockPurchaseService.recordPurchase.mockResolvedValue({
        recorded: true,
        results: [],
      });

      const result = await service.processOrder(baseOrder);

      expect(result.trace).toBeDefined();
      expect(result.trace.id).toBeTruthy();
      expect(result.trace.duration).toBeGreaterThanOrEqual(0);
      expect(result.trace.spans.length).toBeGreaterThan(0);
    });

    test('handles overall processing error', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockRejectedValue(
        new Error('Service unavailable')
      );

      await expect(service.processOrder(baseOrder))
        .rejects.toThrow('Service unavailable');

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_PROCESSING_ERROR',
        })
      );
    });

    test('uses source option for tracing', async () => {
      mockCustomerService.identifyCustomerFromOrder.mockResolvedValue({
        success: false,
      });

      const result = await service.processOrder(baseOrder, { source: 'BACKFILL' });

      expect(result.trace.context.source).toBe('BACKFILL');
    });
  });

  describe('getTracer', () => {
    test('returns tracer instance', () => {
      const tracer = service.getTracer();
      expect(tracer).toBeDefined();
      expect(typeof tracer.startTrace).toBe('function');
    });
  });
});
