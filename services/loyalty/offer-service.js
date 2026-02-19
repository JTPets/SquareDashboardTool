/**
 * Loyalty Offer Service
 *
 * Handles loyalty offer management:
 * - Get active offers for a merchant
 * - Get offers for a specific variation
 * - Validate qualifying variations
 */

const db = require('../../utils/database');
const { loyaltyLogger } = require('./loyalty-logger');
const {
    queryOffersForVariation,
    queryQualifyingVariations,
    queryAllQualifyingVariationIds
} = require('../loyalty-admin/loyalty-queries');

/**
 * LoyaltyOfferService - Manages loyalty offers and qualifying variations
 */
class LoyaltyOfferService {
  /**
   * @param {number} merchantId - Internal merchant ID
   * @param {Object} [tracer] - Optional tracer instance for correlation
   */
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
  }

  /**
   * Get all active offers for the merchant
   * @returns {Promise<Array>} Array of active offers
   */
  async getActiveOffers() {
    try {
      const result = await db.query(`
        SELECT
          lo.id,
          lo.offer_name as name,
          lo.description,
          lo.required_quantity,
          lo.reward_quantity,
          lo.window_months,
          lo.is_active,
          lo.created_at,
          lo.updated_at,
          COUNT(lqv.id) as variation_count
        FROM loyalty_offers lo
        LEFT JOIN loyalty_qualifying_variations lqv ON lo.id = lqv.offer_id
        WHERE lo.merchant_id = $1 AND lo.is_active = TRUE
        GROUP BY lo.id
        ORDER BY lo.offer_name
      `, [this.merchantId]);

      this.tracer?.span('OFFERS_FETCHED', { count: result.rows.length });

      return result.rows;
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_ACTIVE_OFFERS_ERROR',
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Get offers that include a specific variation ID
   * @param {string} variationId - Square catalog variation ID
   * @returns {Promise<Array>} Array of offers that include this variation
   */
  async getOffersForVariation(variationId) {
    try {
      const rows = await queryOffersForVariation(variationId, this.merchantId);

      this.tracer?.span('VARIATION_OFFERS_FETCHED', {
        variationId,
        offerCount: rows.length,
      });

      loyaltyLogger.debug({
        action: 'GET_OFFERS_FOR_VARIATION',
        variationId,
        offerCount: rows.length,
        merchantId: this.merchantId,
      });

      return rows;
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_OFFERS_FOR_VARIATION_ERROR',
        variationId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Check if a variation is qualifying for any offer
   * @param {string} variationId - Square catalog variation ID
   * @returns {Promise<boolean>} True if variation qualifies
   */
  async isQualifyingVariation(variationId) {
    const offers = await this.getOffersForVariation(variationId);
    return offers.length > 0;
  }

  /**
   * Get offer by ID
   * @param {number} offerId - Internal offer ID
   * @returns {Promise<Object|null>} Offer or null if not found
   */
  async getOfferById(offerId) {
    try {
      const result = await db.query(`
        SELECT
          lo.*,
          array_agg(json_build_object(
            'id', lqv.id,
            'variation_id', lqv.variation_id,
            'variation_name', lqv.variation_name,
            'item_name', lqv.item_name
          )) FILTER (WHERE lqv.id IS NOT NULL) as variations
        FROM loyalty_offers lo
        LEFT JOIN loyalty_qualifying_variations lqv ON lo.id = lqv.offer_id
        WHERE lo.id = $1 AND lo.merchant_id = $2
        GROUP BY lo.id
      `, [offerId, this.merchantId]);

      return result.rows[0] || null;
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_OFFER_BY_ID_ERROR',
        offerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Get qualifying variations for an offer
   * @param {number} offerId - Internal offer ID
   * @returns {Promise<Array>} Array of qualifying variations
   */
  async getQualifyingVariations(offerId) {
    try {
      return await queryQualifyingVariations(offerId, this.merchantId);
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_QUALIFYING_VARIATIONS_ERROR',
        offerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }

  /**
   * Get all qualifying variation IDs for merchant (for quick lookup)
   * @returns {Promise<Set<string>>} Set of variation IDs
   */
  async getAllQualifyingVariationIds() {
    try {
      const ids = await queryAllQualifyingVariationIds(this.merchantId);
      return new Set(ids);
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_ALL_QUALIFYING_VARIATION_IDS_ERROR',
        error: error.message,
        merchantId: this.merchantId,
      });
      throw error;
    }
  }
}

module.exports = { LoyaltyOfferService };
