/**
 * Unit tests for customer-service.js
 */

// Mock dependencies
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    customer: jest.fn(),
    error: jest.fn(),
    squareApi: jest.fn(),
  },
}));

jest.mock('../square-client', () => ({
  LoyaltySquareClient: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue({
      searchLoyaltyEvents: jest.fn(),
      getLoyaltyAccount: jest.fn(),
      searchCustomers: jest.fn(),
      getCustomer: jest.fn(),
    }),
    searchLoyaltyEvents: jest.fn(),
    getLoyaltyAccount: jest.fn(),
    searchCustomers: jest.fn(),
    getCustomer: jest.fn(),
  })),
}));

const { LoyaltyCustomerService } = require('../customer-service');
const { LoyaltySquareClient } = require('../square-client');
const { loyaltyLogger } = require('../loyalty-logger');

describe('LoyaltyCustomerService', () => {
  let service;
  let mockSquareClient;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create mock Square client methods
    mockSquareClient = {
      initialize: jest.fn().mockReturnThis(),
      searchLoyaltyEvents: jest.fn().mockResolvedValue([]),
      getLoyaltyAccount: jest.fn(),
      searchCustomers: jest.fn().mockResolvedValue([]),
      getCustomer: jest.fn(),
    };

    // Mock the LoyaltySquareClient constructor to return our mock
    LoyaltySquareClient.mockImplementation(() => mockSquareClient);

    service = new LoyaltyCustomerService(123);
    await service.initialize();
  });

  describe('constructor', () => {
    test('creates service with merchantId', () => {
      const svc = new LoyaltyCustomerService(456);
      expect(svc.merchantId).toBe(456);
      expect(svc.squareClient).toBeNull();
    });

    test('accepts optional tracer', () => {
      const mockTracer = { span: jest.fn() };
      const svc = new LoyaltyCustomerService(456, mockTracer);
      expect(svc.tracer).toBe(mockTracer);
    });
  });

  describe('initialize', () => {
    test('initializes Square client', async () => {
      const svc = new LoyaltyCustomerService(789);
      const result = await svc.initialize();

      expect(result).toBe(svc);
      expect(svc.squareClient).toBe(mockSquareClient);
    });
  });

  describe('identifyCustomerFromOrder', () => {
    describe('Method 1: order.customer_id', () => {
      test('returns customer_id from order', async () => {
        const order = {
          id: 'order-123',
          customer_id: 'cust-456',
        };

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
          customerId: 'cust-456',
          method: 'ORDER_CUSTOMER_ID',
          success: true,
        });
        expect(loyaltyLogger.customer).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'CUSTOMER_LOOKUP_SUCCESS',
            method: 'ORDER_CUSTOMER_ID',
            customerId: 'cust-456',
          })
        );
      });
    });

    describe('Method 2: tender.customer_id', () => {
      test('returns customer_id from tender', async () => {
        const order = {
          id: 'order-123',
          tenders: [
            { id: 'tender-1', customer_id: 'cust-789' },
          ],
        };

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
          customerId: 'cust-789',
          method: 'TENDER_CUSTOMER_ID',
          success: true,
        });
      });

      test('skips tenders without customer_id', async () => {
        const order = {
          id: 'order-123',
          tenders: [
            { id: 'tender-1' },
            { id: 'tender-2', customer_id: 'cust-abc' },
          ],
        };

        const result = await service.identifyCustomerFromOrder(order);

        expect(result.customerId).toBe('cust-abc');
        expect(result.method).toBe('TENDER_CUSTOMER_ID');
      });
    });

    describe('Method 3: Loyalty API', () => {
      test('returns customer from loyalty events', async () => {
        const order = { id: 'order-123', tenders: [] };

        mockSquareClient.searchLoyaltyEvents.mockResolvedValue([
          { loyalty_account_id: 'loyalty-acct-1' },
        ]);
        mockSquareClient.getLoyaltyAccount.mockResolvedValue({
          customer_id: 'cust-from-loyalty',
        });

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
          customerId: 'cust-from-loyalty',
          method: 'LOYALTY_API',
          success: true,
        });
      });

      test('continues to next method if no loyalty events', async () => {
        const order = { id: 'order-123', tenders: [] };

        mockSquareClient.searchLoyaltyEvents.mockResolvedValue([]);

        const result = await service.identifyCustomerFromOrder(order);

        expect(result.success).toBe(false);
      });
    });

    describe('Method 5: Fulfillment Recipient', () => {
      test('returns customer from phone search', async () => {
        const order = {
          id: 'order-123',
          tenders: [],
          fulfillments: [
            {
              pickup_details: {
                recipient: {
                  phone_number: '+1555555555',
                },
              },
            },
          ],
        };

        mockSquareClient.searchCustomers.mockResolvedValue([
          { id: 'cust-by-phone' },
        ]);

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
          customerId: 'cust-by-phone',
          method: 'FULFILLMENT_RECIPIENT',
          success: true,
        });
      });

      test('returns customer from email search', async () => {
        const order = {
          id: 'order-123',
          tenders: [],
          fulfillments: [
            {
              shipment_details: {
                recipient: {
                  email_address: 'test@example.com',
                },
              },
            },
          ],
        };

        mockSquareClient.searchCustomers.mockResolvedValue([
          { id: 'cust-by-email' },
        ]);

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
          customerId: 'cust-by-email',
          method: 'FULFILLMENT_RECIPIENT',
          success: true,
        });
      });
    });

    describe('No customer found', () => {
      test('returns failure when no identification method succeeds', async () => {
        const order = { id: 'order-123' };

        const result = await service.identifyCustomerFromOrder(order);

        expect(result).toEqual({
          customerId: null,
          method: 'NONE',
          success: false,
        });

        expect(loyaltyLogger.customer).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'CUSTOMER_NOT_IDENTIFIED',
            attemptedMethods: expect.arrayContaining([
              'ORDER_CUSTOMER_ID',
              'TENDER_CUSTOMER_ID',
              'LOYALTY_API',
            ]),
          })
        );
      });
    });
  });

  describe('getCustomerDetails', () => {
    test('returns formatted customer details', async () => {
      mockSquareClient.getCustomer.mockResolvedValue({
        id: 'cust-123',
        given_name: 'John',
        family_name: 'Doe',
        email_address: 'john@example.com',
        phone_number: '+1555555555',
        created_at: '2024-01-01',
        updated_at: '2024-01-02',
      });

      const result = await service.getCustomerDetails('cust-123');

      expect(result).toEqual({
        id: 'cust-123',
        givenName: 'John',
        familyName: 'Doe',
        displayName: 'John Doe',
        email: 'john@example.com',
        phone: '+1555555555',
        companyName: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      });
    });

    test('returns null on error', async () => {
      mockSquareClient.getCustomer.mockRejectedValue(new Error('API Error'));

      const result = await service.getCustomerDetails('cust-123');

      expect(result).toBeNull();
      expect(loyaltyLogger.error).toHaveBeenCalled();
    });
  });
});
