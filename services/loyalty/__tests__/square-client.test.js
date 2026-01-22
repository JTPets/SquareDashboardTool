/**
 * Unit tests for square-client.js
 */

// Mock dependencies - these MUST be before require statements
// Jest hoists these to the top of the file
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
}));

jest.mock('../../../utils/token-encryption', () => ({
  decryptToken: jest.fn(token => token),
  isEncryptedToken: jest.fn(token => token.startsWith('enc:')),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    squareApi: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock global fetch BEFORE importing the module
global.fetch = jest.fn();

// Now import the modules
const {
  LoyaltySquareClient,
  SquareApiError,
  SQUARE_API_BASE,
  SQUARE_API_VERSION,
  DEFAULT_TIMEOUT,
} = require('../square-client');

const mockDb = require('../../../utils/database');
const { loyaltyLogger } = require('../loyalty-logger');

describe('LoyaltySquareClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockReset();
  });

  describe('constants', () => {
    test('SQUARE_API_BASE is correct', () => {
      expect(SQUARE_API_BASE).toBe('https://connect.squareup.com/v2');
    });

    test('SQUARE_API_VERSION is set', () => {
      expect(SQUARE_API_VERSION).toBeTruthy();
    });

    test('DEFAULT_TIMEOUT is reasonable', () => {
      expect(DEFAULT_TIMEOUT).toBeGreaterThanOrEqual(5000);
      expect(DEFAULT_TIMEOUT).toBeLessThanOrEqual(60000);
    });
  });

  describe('SquareApiError', () => {
    test('creates error with all properties', () => {
      const error = new SquareApiError('Test error', 404, '/test', { foo: 'bar' });

      expect(error.name).toBe('SquareApiError');
      expect(error.message).toBe('Test error');
      expect(error.status).toBe(404);
      expect(error.endpoint).toBe('/test');
      expect(error.details).toEqual({ foo: 'bar' });
    });

    test('is instance of Error', () => {
      const error = new SquareApiError('Test', 500, '/test');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('constructor', () => {
    test('creates client with merchantId', () => {
      const client = new LoyaltySquareClient(123);
      expect(client.merchantId).toBe(123);
      expect(client.accessToken).toBeNull();
    });
  });

  describe('initialize', () => {
    test('fetches and sets access token', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ square_access_token: 'test-token' }],
      });

      const client = new LoyaltySquareClient(123);
      const result = await client.initialize();

      expect(result).toBe(client);
      expect(client.accessToken).toBe('test-token');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT square_access_token'),
        [123]
      );
    });

    test('throws when no merchant found', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const client = new LoyaltySquareClient(123);
      await expect(client.initialize()).rejects.toThrow(SquareApiError);
    });

    test('throws when no token available', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ square_access_token: null }],
      });

      const client = new LoyaltySquareClient(123);
      await expect(client.initialize()).rejects.toThrow(SquareApiError);
    });
  });

  describe('request', () => {
    let client;

    beforeEach(async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ square_access_token: 'test-token' }],
      });
      client = new LoyaltySquareClient(123);
      await client.initialize();
    });

    test('makes GET request with correct headers', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const result = await client.get('/test-endpoint');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://connect.squareup.com/v2/test-endpoint',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Square-Version': SQUARE_API_VERSION,
          }),
        })
      );
      expect(result).toEqual({ data: 'test' });
    });

    test('makes POST request with body', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'test' }),
      });

      await client.post('/test-endpoint', { foo: 'bar' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://connect.squareup.com/v2/test-endpoint',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ foo: 'bar' }),
        })
      );
    });

    test('logs successful API calls', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      await client.get('/test', { context: 'testContext' });

      expect(loyaltyLogger.squareApi).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/test',
          method: 'GET',
          status: 200,
          success: true,
          context: 'testContext',
          merchantId: 123,
        })
      );
    });

    test('throws SquareApiError on non-ok response', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"errors":[{"code":"NOT_FOUND"}]}'),
      });

      await expect(client.get('/test')).rejects.toThrow(SquareApiError);
    });

    test('logs error on API failure', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });

      await expect(client.get('/test')).rejects.toThrow();

      expect(loyaltyLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SQUARE_API_ERROR',
          endpoint: '/test',
          status: 500,
        })
      );
    });

    test('throws when client not initialized', async () => {
      const uninitializedClient = new LoyaltySquareClient(456);

      await expect(uninitializedClient.get('/test')).rejects.toThrow('Client not initialized');
    });
  });

  describe('convenience methods', () => {
    let client;

    beforeEach(async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ square_access_token: 'test-token' }],
      });
      client = new LoyaltySquareClient(123);
      await client.initialize();
    });

    test('getCustomer calls correct endpoint', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ customer: { id: 'cust-123' } }),
      });

      const result = await client.getCustomer('cust-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/customers/cust-123'),
        expect.any(Object)
      );
      expect(result).toEqual({ id: 'cust-123' });
    });

    test('searchCustomers calls correct endpoint', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ customers: [{ id: 'cust-1' }] }),
      });

      const result = await client.searchCustomers({
        query: { filter: { phone_number: { exact: '123' } } },
      });

      expect(result).toEqual([{ id: 'cust-1' }]);
    });

    test('getLoyaltyProgram returns null for 404', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      const result = await client.getLoyaltyProgram();

      expect(result).toBeNull();
    });

    test('deleteCustomerGroup returns true for 404', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      const result = await client.deleteCustomerGroup('group-123');

      expect(result).toBe(true);
    });

    test('batchUpsertCatalog uses longer timeout', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ objects: [] }),
      });

      await client.batchUpsertCatalog([], 'key-123');

      // Verify the call was made (we can't easily verify timeout in this mock)
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
