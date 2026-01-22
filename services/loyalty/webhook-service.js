/**
 * Loyalty Webhook Service
 *
 * Orchestrates loyalty order processing from Square webhooks:
 * - Process order.completed webhooks
 * - Coordinate customer identification
 * - Determine qualifying purchases
 * - Record purchases and track rewards
 */

const { LoyaltyTracer, generateTraceId } = require('./loyalty-tracer');
const { LoyaltySquareClient } = require('./square-client');
const { LoyaltyCustomerService } = require('./customer-service');
const { LoyaltyOfferService } = require('./offer-service');
const { LoyaltyPurchaseService } = require('./purchase-service');
const { LoyaltyRewardService } = require('./reward-service');
const { loyaltyLogger } = require('./loyalty-logger');

/**
 * LoyaltyWebhookService - Orchestrates webhook processing
 */
class LoyaltyWebhookService {
  /**
   * @param {number} merchantId - Internal merchant ID
   */
  constructor(merchantId) {
    this.merchantId = merchantId;
    this.tracer = new LoyaltyTracer();

    // Initialize services (will be fully initialized in initialize())
    this.squareClient = null;
    this.customerService = null;
    this.offerService = null;
    this.purchaseService = null;
    this.rewardService = null;
  }

  /**
   * Initialize all services
   * @returns {Promise<LoyaltyWebhookService>} This instance for chaining
   */
  async initialize() {
    // Initialize Square client first
    this.squareClient = new LoyaltySquareClient(this.merchantId, this.tracer);
    await this.squareClient.initialize();

    // Initialize other services with shared tracer
    this.customerService = new LoyaltyCustomerService(this.merchantId, this.tracer);
    await this.customerService.initialize();

    this.offerService = new LoyaltyOfferService(this.merchantId, this.tracer);
    this.purchaseService = new LoyaltyPurchaseService(this.merchantId, this.tracer);
    this.rewardService = new LoyaltyRewardService(this.merchantId, this.tracer);

    return this;
  }

  /**
   * Process an order.completed webhook
   * @param {Object} order - Square order object
   * @param {Object} [options] - Processing options
   * @param {string} [options.source] - Source of the event (e.g., 'WEBHOOK', 'BACKFILL')
   * @returns {Promise<Object>} Processing result with trace
   */
  async processOrder(order, options = {}) {
    const { source = 'WEBHOOK' } = options;

    // Start trace for this order
    const traceId = this.tracer.startTrace({
      orderId: order.id,
      merchantId: this.merchantId,
      source,
    });

    try {
      this.tracer.span('ORDER_RECEIVED', {
        lineItemCount: order.line_items?.length || 0,
        state: order.state,
      });

      loyaltyLogger.audit({
        action: 'ORDER_PROCESSING_START',
        orderId: order.id,
        source,
        traceId,
        merchantId: this.merchantId,
      });

      // Step 1: Identify customer
      this.tracer.span('CUSTOMER_LOOKUP_START');
      const customerResult = await this.customerService.identifyCustomerFromOrder(order);

      if (!customerResult.success) {
        this.tracer.span('CUSTOMER_NOT_FOUND', {
          attemptedMethods: customerResult.attemptedMethods,
        });

        const trace = this.tracer.endTrace();

        loyaltyLogger.audit({
          action: 'ORDER_PROCESSING_SKIP_NO_CUSTOMER',
          orderId: order.id,
          traceId,
          trace,
          merchantId: this.merchantId,
        });

        return {
          processed: false,
          reason: 'customer_not_identified',
          orderId: order.id,
          trace,
        };
      }

      const customerId = customerResult.customerId;
      this.tracer.span('CUSTOMER_IDENTIFIED', {
        customerId,
        method: customerResult.method,
      });

      // Step 2: Get active offers and their qualifying variations
      this.tracer.span('OFFERS_LOOKUP_START');
      const offers = await this.offerService.getActiveOffers();

      if (offers.length === 0) {
        this.tracer.span('NO_ACTIVE_OFFERS');

        const trace = this.tracer.endTrace();

        loyaltyLogger.audit({
          action: 'ORDER_PROCESSING_SKIP_NO_OFFERS',
          orderId: order.id,
          customerId,
          traceId,
          trace,
          merchantId: this.merchantId,
        });

        return {
          processed: false,
          reason: 'no_active_offers',
          orderId: order.id,
          customerId,
          trace,
        };
      }

      this.tracer.span('OFFERS_FOUND', { offerCount: offers.length });

      // Get all qualifying variation IDs for quick lookup
      const qualifyingVariationIds = await this.offerService.getAllQualifyingVariationIds();

      // Step 3: Process each line item
      const lineItemResults = [];

      for (const lineItem of (order.line_items || [])) {
        const lineItemResult = await this.processLineItem(
          lineItem,
          order,
          customerId,
          qualifyingVariationIds,
          traceId
        );
        lineItemResults.push(lineItemResult);
      }

      // Step 4: Summarize results
      const qualifyingItems = lineItemResults.filter(r => r.qualifying);
      const purchasesRecorded = lineItemResults.filter(r => r.recorded).length;
      const rewardsEarned = lineItemResults.filter(r => r.rewardEarned).length;

      this.tracer.span('ORDER_PROCESSING_COMPLETE', {
        totalLineItems: lineItemResults.length,
        qualifyingItems: qualifyingItems.length,
        purchasesRecorded,
        rewardsEarned,
      });

      const trace = this.tracer.endTrace();

      loyaltyLogger.audit({
        action: 'ORDER_PROCESSING_COMPLETE',
        orderId: order.id,
        customerId,
        totalLineItems: lineItemResults.length,
        qualifyingItems: qualifyingItems.length,
        purchasesRecorded,
        rewardsEarned,
        traceId,
        duration: trace.duration,
        merchantId: this.merchantId,
      });

      return {
        processed: true,
        orderId: order.id,
        customerId,
        lineItemResults,
        summary: {
          totalLineItems: lineItemResults.length,
          qualifyingItems: qualifyingItems.length,
          purchasesRecorded,
          rewardsEarned,
        },
        trace,
      };

    } catch (error) {
      this.tracer.span('ORDER_PROCESSING_ERROR', {
        error: error.message,
      });

      const trace = this.tracer.endTrace();

      loyaltyLogger.error({
        action: 'ORDER_PROCESSING_ERROR',
        orderId: order.id,
        error: error.message,
        stack: error.stack,
        traceId,
        trace,
        merchantId: this.merchantId,
      });

      throw error;
    }
  }

  /**
   * Process a single line item
   * @private
   */
  async processLineItem(lineItem, order, customerId, qualifyingVariationIds, traceId) {
    const variationId = lineItem.catalog_object_id || lineItem.variation_id;
    const quantity = parseInt(lineItem.quantity) || 0;

    // Skip if no variation ID
    if (!variationId) {
      this.tracer.span('LINE_ITEM_SKIP_NO_VARIATION', {
        lineItemUid: lineItem.uid,
        name: lineItem.name,
      });
      return {
        lineItemUid: lineItem.uid,
        name: lineItem.name,
        qualifying: false,
        reason: 'no_variation_id',
      };
    }

    // Skip if quantity is 0 or negative
    if (quantity <= 0) {
      this.tracer.span('LINE_ITEM_SKIP_ZERO_QUANTITY', {
        variationId,
        quantity,
      });
      return {
        lineItemUid: lineItem.uid,
        variationId,
        name: lineItem.name,
        qualifying: false,
        reason: 'zero_quantity',
      };
    }

    // Skip if price is 0 (likely a free item / reward)
    const totalMoney = lineItem.total_money?.amount || 0;
    if (totalMoney <= 0) {
      this.tracer.span('LINE_ITEM_SKIP_FREE', {
        variationId,
        name: lineItem.name,
      });

      loyaltyLogger.debug({
        action: 'LINE_ITEM_EVALUATION',
        decision: 'SKIP_FREE',
        variationId,
        itemName: lineItem.name,
        orderId: order.id,
        merchantId: this.merchantId,
      });

      return {
        lineItemUid: lineItem.uid,
        variationId,
        name: lineItem.name,
        qualifying: false,
        reason: 'free_item',
      };
    }

    // Check if variation qualifies
    if (!qualifyingVariationIds.has(variationId)) {
      this.tracer.span('LINE_ITEM_SKIP_NOT_QUALIFYING', {
        variationId,
        name: lineItem.name,
      });

      loyaltyLogger.debug({
        action: 'LINE_ITEM_EVALUATION',
        decision: 'SKIP_NOT_QUALIFYING',
        variationId,
        itemName: lineItem.name,
        orderId: order.id,
        merchantId: this.merchantId,
      });

      return {
        lineItemUid: lineItem.uid,
        variationId,
        name: lineItem.name,
        qualifying: false,
        reason: 'not_qualifying_variation',
      };
    }

    // Record the qualifying purchase
    this.tracer.span('LINE_ITEM_QUALIFYING', {
      variationId,
      name: lineItem.name,
      quantity,
      totalCents: totalMoney,
    });

    loyaltyLogger.debug({
      action: 'LINE_ITEM_EVALUATION',
      decision: 'QUALIFIES',
      variationId,
      itemName: lineItem.name,
      quantity,
      orderId: order.id,
      merchantId: this.merchantId,
    });

    try {
      const purchaseResult = await this.purchaseService.recordPurchase({
        squareOrderId: order.id,
        squareCustomerId: customerId,
        variationId,
        quantity,
        unitPriceCents: Math.round(totalMoney / quantity),
        totalPriceCents: totalMoney,
        purchasedAt: order.created_at || new Date().toISOString(),
        traceId,
      });

      // Check if any rewards were earned
      let rewardEarned = false;
      if (purchaseResult.recorded && purchaseResult.results) {
        rewardEarned = purchaseResult.results.some(r => r.progress?.rewardEarned);
      }

      return {
        lineItemUid: lineItem.uid,
        variationId,
        name: lineItem.name,
        quantity,
        totalCents: totalMoney,
        qualifying: true,
        recorded: purchaseResult.recorded,
        rewardEarned,
        purchaseResult,
      };

    } catch (error) {
      this.tracer.span('LINE_ITEM_RECORD_ERROR', {
        variationId,
        error: error.message,
      });

      loyaltyLogger.error({
        action: 'LINE_ITEM_RECORD_ERROR',
        variationId,
        itemName: lineItem.name,
        orderId: order.id,
        error: error.message,
        merchantId: this.merchantId,
      });

      return {
        lineItemUid: lineItem.uid,
        variationId,
        name: lineItem.name,
        qualifying: true,
        recorded: false,
        error: error.message,
      };
    }
  }

  /**
   * Get order processing trace by order ID
   * Useful for debugging "what happened to this order?"
   * @param {string} orderId - Square order ID
   * @returns {Promise<Object|null>} Trace information or null
   */
  async getOrderTrace(orderId) {
    // This would query the database for stored trace information
    // For now, just log and return null - implementation depends on
    // whether traces are persisted to database
    loyaltyLogger.debug({
      action: 'GET_ORDER_TRACE',
      orderId,
      merchantId: this.merchantId,
    });

    return null;
  }

  /**
   * Get current tracer instance (for testing/debugging)
   * @returns {LoyaltyTracer} The tracer instance
   */
  getTracer() {
    return this.tracer;
  }
}

module.exports = { LoyaltyWebhookService };
