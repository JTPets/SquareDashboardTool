/**
 * Unit tests for offer-service.js
 */

// Mock dependencies
jest.mock('../../../utils/database', () => ({
  query: jest.fn(),
}));

jest.mock('../loyalty-logger', () => ({
  loyaltyLogger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

const { LoyaltyOfferService } = require('../offer-service');
const mockDb = require('../../../utils/database');
const { loyaltyLogger } = require('../loyalty-logger');

describe('LoyaltyOfferService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LoyaltyOfferService(123);
  });

  describe('constructor', () => {
    test('creates service with merchantId', () => {
      expect(service.merchantId).toBe(123);
      expect(service.tracer).toBeNull();
    });

    test('accepts optional tracer', () => {
      const mockTracer = { span: jest.fn() };
      const svc = new LoyaltyOfferService(123, mockTracer);
      expect(svc.tracer).toBe(mockTracer);
    });
  });

  describe('getActiveOffers', () => {
    test('returns active offers with variation counts', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          {
            id: 1,
            name: 'Buy 10 Get 1 Free',
            required_quantity: 10,
            variation_count: '5',
          },
          {
            id: 2,
            name: 'Buy 5 Get 1 Free',
            required_quantity: 5,
            variation_count: '3',
          },
        ],
      });

      const offers = await service.getActiveOffers();

      expect(offers).toHaveLength(2);
      expect(offers[0].name).toBe('Buy 10 Get 1 Free');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('is_active = TRUE'),
        [123]
      );
    });

    test('returns empty array when no active offers', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const offers = await service.getActiveOffers();

      expect(offers).toEqual([]);
    });

    test('throws error on database failure', async () => {
      mockDb.query.mockRejectedValue(new Error('DB Error'));

      await expect(service.getActiveOffers()).rejects.toThrow('DB Error');
      expect(loyaltyLogger.error).toHaveBeenCalled();
    });

    test('adds span when tracer is provided', async () => {
      const mockTracer = { span: jest.fn() };
      service = new LoyaltyOfferService(123, mockTracer);
      mockDb.query.mockResolvedValue({ rows: [{ id: 1 }] });

      await service.getActiveOffers();

      expect(mockTracer.span).toHaveBeenCalledWith('OFFERS_FETCHED', { count: 1 });
    });
  });

  describe('getOffersForVariation', () => {
    test('returns offers that include the variation', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          {
            id: 1,
            name: 'Coffee Loyalty',
            variation_id: 'VAR-123',
            variation_name: 'Large',
          },
        ],
      });

      const offers = await service.getOffersForVariation('VAR-123');

      expect(offers).toHaveLength(1);
      expect(offers[0].variation_id).toBe('VAR-123');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('lqv.variation_id = $2'),
        [123, 'VAR-123']
      );
    });

    test('returns empty array when variation not in any offer', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const offers = await service.getOffersForVariation('VAR-UNKNOWN');

      expect(offers).toEqual([]);
    });

    test('logs debug message', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      await service.getOffersForVariation('VAR-123');

      expect(loyaltyLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GET_OFFERS_FOR_VARIATION',
          variationId: 'VAR-123',
        })
      );
    });
  });

  describe('isQualifyingVariation', () => {
    test('returns true when variation qualifies', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ id: 1, variation_id: 'VAR-123' }],
      });

      const result = await service.isQualifyingVariation('VAR-123');

      expect(result).toBe(true);
    });

    test('returns false when variation does not qualify', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const result = await service.isQualifyingVariation('VAR-UNKNOWN');

      expect(result).toBe(false);
    });
  });

  describe('getOfferById', () => {
    test('returns offer with variations', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          id: 1,
          name: 'Test Offer',
          required_quantity: 10,
          variations: [
            { id: 1, variation_id: 'VAR-1', variation_name: 'Small' },
          ],
        }],
      });

      const offer = await service.getOfferById(1);

      expect(offer.id).toBe(1);
      expect(offer.name).toBe('Test Offer');
      expect(offer.variations).toHaveLength(1);
    });

    test('returns null when offer not found', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const offer = await service.getOfferById(999);

      expect(offer).toBeNull();
    });

    test('enforces merchant isolation', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      await service.getOfferById(1);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('lo.merchant_id = $2'),
        [1, 123]
      );
    });
  });

  describe('getQualifyingVariations', () => {
    test('returns variations for offer', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { id: 1, variation_id: 'VAR-1', variation_name: 'Small', item_name: 'Coffee' },
          { id: 2, variation_id: 'VAR-2', variation_name: 'Large', item_name: 'Coffee' },
        ],
      });

      const variations = await service.getQualifyingVariations(1);

      expect(variations).toHaveLength(2);
      expect(variations[0].variation_id).toBe('VAR-1');
    });
  });

  describe('getAllQualifyingVariationIds', () => {
    test('returns set of variation IDs', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { variation_id: 'VAR-1' },
          { variation_id: 'VAR-2' },
          { variation_id: 'VAR-3' },
        ],
      });

      const ids = await service.getAllQualifyingVariationIds();

      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(3);
      expect(ids.has('VAR-1')).toBe(true);
      expect(ids.has('VAR-2')).toBe(true);
      expect(ids.has('VAR-3')).toBe(true);
    });

    test('returns empty set when no qualifying variations', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });

      const ids = await service.getAllQualifyingVariationIds();

      expect(ids.size).toBe(0);
    });
  });
});
