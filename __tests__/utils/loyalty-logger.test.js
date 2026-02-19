/**
 * Unit tests for utils/loyalty-logger.js
 * Migrated from services/loyalty/__tests__/loyalty-logger.test.js (BACKLOG-31)
 */

const { loyaltyLogger } = require('../../utils/loyalty-logger');

// Mock the logger module
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockLogger = require('../../utils/logger');

describe('loyaltyLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('all log methods are defined', () => {
    test('purchase method exists and is a function', () => {
      expect(typeof loyaltyLogger.purchase).toBe('function');
    });

    test('reward method exists and is a function', () => {
      expect(typeof loyaltyLogger.reward).toBe('function');
    });

    test('redemption method exists and is a function', () => {
      expect(typeof loyaltyLogger.redemption).toBe('function');
    });

    test('squareApi method exists and is a function', () => {
      expect(typeof loyaltyLogger.squareApi).toBe('function');
    });

    test('customer method exists and is a function', () => {
      expect(typeof loyaltyLogger.customer).toBe('function');
    });

    test('error method exists and is a function', () => {
      expect(typeof loyaltyLogger.error).toBe('function');
    });

    test('debug method exists and is a function', () => {
      expect(typeof loyaltyLogger.debug).toBe('function');
    });

    test('audit method exists and is a function', () => {
      expect(typeof loyaltyLogger.audit).toBe('function');
    });

    test('perf method exists and is a function', () => {
      expect(typeof loyaltyLogger.perf).toBe('function');
    });
  });

  describe('purchase logging', () => {
    test('logs with correct prefix and data', () => {
      const testData = {
        orderId: 'order-123',
        customerId: 'cust-456',
        quantity: 2,
        merchantId: 'merchant-789'
      };

      loyaltyLogger.purchase(testData);

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:PURCHASE]',
        expect.objectContaining({
          category: 'LOYALTY:PURCHASE',
          orderId: 'order-123',
          customerId: 'cust-456',
          quantity: 2,
          merchantId: 'merchant-789',
          timestamp: expect.any(String)
        })
      );
    });
  });

  describe('reward logging', () => {
    test('logs reward events with correct prefix', () => {
      const testData = {
        rewardId: 123,
        status: 'earned',
        customerId: 'cust-456',
        offerId: 789
      };

      loyaltyLogger.reward(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:REWARD]',
        expect.objectContaining({
          category: 'LOYALTY:REWARD',
          rewardId: 123,
          status: 'earned'
        })
      );
    });
  });

  describe('redemption logging', () => {
    test('logs redemption events with correct prefix', () => {
      const testData = {
        rewardId: 123,
        redemptionType: 'MANUAL',
        userId: 'user-456'
      };

      loyaltyLogger.redemption(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:REDEMPTION]',
        expect.objectContaining({
          category: 'LOYALTY:REDEMPTION',
          rewardId: 123,
          redemptionType: 'MANUAL'
        })
      );
    });
  });

  describe('squareApi logging', () => {
    test('logs Square API calls with timing', () => {
      const testData = {
        endpoint: '/customers/123',
        method: 'GET',
        status: 200,
        duration: 150,
        success: true,
        merchantId: 'merchant-789'
      };

      loyaltyLogger.squareApi(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:SQUARE_API]',
        expect.objectContaining({
          category: 'LOYALTY:SQUARE_API',
          endpoint: '/customers/123',
          method: 'GET',
          status: 200,
          duration: 150,
          success: true
        })
      );
    });
  });

  describe('customer logging', () => {
    test('logs customer identification attempts', () => {
      const testData = {
        action: 'CUSTOMER_LOOKUP_ATTEMPT',
        orderId: 'order-123',
        method: 'ORDER_CUSTOMER_ID',
        merchantId: 'merchant-789'
      };

      loyaltyLogger.customer(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:CUSTOMER]',
        expect.objectContaining({
          category: 'LOYALTY:CUSTOMER',
          action: 'CUSTOMER_LOOKUP_ATTEMPT',
          method: 'ORDER_CUSTOMER_ID'
        })
      );
    });

    test('logs successful customer identification', () => {
      const testData = {
        action: 'CUSTOMER_LOOKUP_SUCCESS',
        orderId: 'order-123',
        method: 'TENDER_CUSTOMER_ID',
        customerId: 'cust-456'
      };

      loyaltyLogger.customer(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:CUSTOMER]',
        expect.objectContaining({
          category: 'LOYALTY:CUSTOMER',
          action: 'CUSTOMER_LOOKUP_SUCCESS',
          customerId: 'cust-456'
        })
      );
    });
  });

  describe('error logging', () => {
    test('logs errors with correct level', () => {
      const testData = {
        action: 'SQUARE_API_ERROR',
        error: 'Connection timeout',
        endpoint: '/customers/123',
        merchantId: 'merchant-789'
      };

      loyaltyLogger.error(testData);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[LOYALTY:ERROR]',
        expect.objectContaining({
          category: 'LOYALTY:ERROR',
          action: 'SQUARE_API_ERROR',
          error: 'Connection timeout'
        })
      );
    });
  });

  describe('debug logging', () => {
    test('logs debug info with correct level', () => {
      const testData = {
        action: 'LINE_ITEM_EVALUATION',
        orderId: 'order-123',
        lineItemId: 'li-1',
        decision: 'QUALIFIES'
      };

      loyaltyLogger.debug(testData);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[LOYALTY:DEBUG]',
        expect.objectContaining({
          category: 'LOYALTY:DEBUG',
          action: 'LINE_ITEM_EVALUATION',
          decision: 'QUALIFIES'
        })
      );
    });
  });

  describe('audit logging', () => {
    test('logs audit events', () => {
      const testData = {
        action: 'OFFER_CREATED',
        userId: 'user-123',
        offerId: 456,
        merchantId: 'merchant-789'
      };

      loyaltyLogger.audit(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:AUDIT]',
        expect.objectContaining({
          category: 'LOYALTY:AUDIT',
          action: 'OFFER_CREATED'
        })
      );
    });
  });

  describe('perf logging', () => {
    test('logs performance metrics', () => {
      const testData = {
        operation: 'processOrderForLoyalty',
        duration: 250,
        lineItemCount: 5,
        merchantId: 'merchant-789'
      };

      loyaltyLogger.perf(testData);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[LOYALTY:PERF]',
        expect.objectContaining({
          category: 'LOYALTY:PERF',
          operation: 'processOrderForLoyalty',
          duration: 250
        })
      );
    });
  });

  describe('timestamp inclusion', () => {
    test('all log methods include timestamp', () => {
      loyaltyLogger.purchase({ orderId: '123' });
      loyaltyLogger.reward({ rewardId: 1 });
      loyaltyLogger.redemption({ rewardId: 1 });
      loyaltyLogger.squareApi({ endpoint: '/test' });
      loyaltyLogger.customer({ customerId: '123' });
      loyaltyLogger.error({ error: 'test' });
      loyaltyLogger.debug({ action: 'test' });
      loyaltyLogger.audit({ action: 'test' });
      loyaltyLogger.perf({ operation: 'test' });

      // Check all info calls have timestamp
      mockLogger.info.mock.calls.forEach(call => {
        expect(call[1]).toHaveProperty('timestamp');
        expect(typeof call[1].timestamp).toBe('string');
      });

      // Check error calls have timestamp
      mockLogger.error.mock.calls.forEach(call => {
        expect(call[1]).toHaveProperty('timestamp');
      });

      // Check debug calls have timestamp
      mockLogger.debug.mock.calls.forEach(call => {
        expect(call[1]).toHaveProperty('timestamp');
      });
    });
  });
});
