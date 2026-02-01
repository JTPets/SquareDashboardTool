/**
 * Loyalty Webhook Service
 *
 * Orchestrates loyalty order processing from Square webhooks:
 * - Process order.completed webhooks
 * - Coordinate customer identification
 * - Determine qualifying purchases
 * - Record purchases and track rewards
 */

const db = require('../../utils/database');
const { LoyaltyTracer } = require('./loyalty-tracer');
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
    // Initialize Square client first (only takes merchantId parameter)
    this.squareClient = new LoyaltySquareClient(this.merchantId);
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

      // Guard: Don't process non-COMPLETED orders (race condition protection)
      if (order.state !== 'COMPLETED') {
        this.tracer.span('ORDER_SKIP_NOT_COMPLETED', {
          state: order.state,
        });

        const trace = this.tracer.endTrace();

        loyaltyLogger.audit({
          action: 'ORDER_PROCESSING_SKIP_STATE',
          orderId: order.id,
          state: order.state,
          reason: 'not_completed',
          traceId,
          trace,
          merchantId: this.merchantId,
        });

        return {
          processed: false,
          reason: 'not_completed',
          orderId: order.id,
          state: order.state,
          trace,
        };
      }

      // Guard: Don't process orders without line items (race condition protection)
      // This can happen when webhook fires before Square populates order data
      if (!order.line_items || order.line_items.length === 0) {
        // For COMPLETED orders with no line items, try re-fetching from Square API
        // This closes the race condition gap immediately instead of waiting for catchup job
        if (order.state === 'COMPLETED') {
          this.tracer.span('ORDER_REFETCH_ATTEMPT', {
            reason: 'completed_but_empty',
          });

          try {
            const freshOrder = await this.squareClient.getOrder(order.id);
            const freshLineItems = freshOrder?.line_items || freshOrder?.lineItems;

            if (freshLineItems && freshLineItems.length > 0) {
              // Got fresh data with line items - use it and continue processing
              order = { ...order, line_items: freshLineItems };
              this.tracer.span('ORDER_REFETCH_SUCCESS', {
                lineItemCount: freshLineItems.length,
              });

              loyaltyLogger.audit({
                action: 'ORDER_REFETCH_SUCCESS',
                orderId: order.id,
                lineItemCount: freshLineItems.length,
                traceId,
                merchantId: this.merchantId,
              });
              // Continue processing with fresh data (don't return)
            } else {
              // Re-fetch still returned no line items - give up
              this.tracer.span('ORDER_SKIP_NO_LINE_ITEMS_AFTER_REFETCH', {
                state: order.state,
              });

              const trace = this.tracer.endTrace();

              loyaltyLogger.audit({
                action: 'ORDER_PROCESSING_SKIP_EMPTY_AFTER_REFETCH',
                orderId: order.id,
                state: order.state,
                reason: 'no_line_items_after_refetch',
                traceId,
                trace,
                merchantId: this.merchantId,
              });

              return {
                processed: false,
                reason: 'no_line_items_after_refetch',
                orderId: order.id,
                state: order.state,
                trace,
              };
            }
          } catch (refetchError) {
            // Re-fetch failed - log and give up
            this.tracer.span('ORDER_REFETCH_FAILED', {
              error: refetchError.message,
            });

            const trace = this.tracer.endTrace();

            loyaltyLogger.error({
              action: 'ORDER_REFETCH_FAILED',
              orderId: order.id,
              error: refetchError.message,
              traceId,
              trace,
              merchantId: this.merchantId,
            });

            return {
              processed: false,
              reason: 'refetch_failed',
              orderId: order.id,
              state: order.state,
              error: refetchError.message,
              trace,
            };
          }
        } else {
          // Non-COMPLETED order with no line items - skip without refetch
          this.tracer.span('ORDER_SKIP_NO_LINE_ITEMS', {
            state: order.state,
          });

          const trace = this.tracer.endTrace();

          loyaltyLogger.audit({
            action: 'ORDER_PROCESSING_SKIP_EMPTY',
            orderId: order.id,
            state: order.state,
            reason: 'no_line_items',
            traceId,
            trace,
            merchantId: this.merchantId,
          });

          return {
            processed: false,
            reason: 'no_line_items',
            orderId: order.id,
            state: order.state,
            trace,
          };
        }
      }

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

      // Cache customer details (phone number, name) for rewards reporting
      // This ensures phone is available when viewing reward progress
      this.tracer.span('CUSTOMER_CACHE_START');
      try {
        await this.customerService.cacheCustomerDetails(customerId);
        this.tracer.span('CUSTOMER_CACHED');
      } catch (err) {
        // Log but don't fail - caching is for reporting, not critical path
        this.tracer.span('CUSTOMER_CACHE_FAILED', { error: err.message });
      }

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

      // Log when order has line items but none qualified - this is normal business flow
      // (only ~45 of 2,700+ variations qualify), not an error condition
      if (qualifyingItems.length === 0 && lineItemResults.length > 0) {
        const skipReasons = {};
        lineItemResults.forEach(r => {
          if (r.reason) {
            skipReasons[r.reason] = (skipReasons[r.reason] || 0) + 1;
          }
        });

        loyaltyLogger.debug({
          action: 'ORDER_ZERO_QUALIFYING_ITEMS',
          orderId: order.id,
          customerId,
          totalLineItems: lineItemResults.length,
          // Include variation IDs for diagnosis (to compare with qualifying set)
          lineItemVariationIds: lineItemResults
            .map(r => r.variationId)
            .filter(Boolean),
          skipReasons,
          traceId,
          merchantId: this.merchantId,
        });

        // Record this order as processed with no qualifying items
        // This prevents the catchup job from reprocessing it every hour
        await this.recordProcessedOrder(order.id, customerId, {
          resultType: 'non_qualifying',
          qualifyingItems: 0,
          totalLineItems: lineItemResults.length,
          traceId,
          source,
        });
      }

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
    // Prefer catalog_object_id (Square's standard field for catalog items)
    // Fall back to variation_id only if catalog_object_id is not available
    const variationId = lineItem.catalog_object_id || lineItem.variation_id;
    const quantity = parseInt(lineItem.quantity, 10) || 0;

    // Log if we had to use fallback (might indicate API version mismatch)
    if (!lineItem.catalog_object_id && lineItem.variation_id) {
      loyaltyLogger.debug({
        action: 'VARIATION_ID_FALLBACK',
        lineItemUid: lineItem.uid,
        variationId: lineItem.variation_id,
        orderId: order.id,
        merchantId: this.merchantId,
      });
    }

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

    // Check if this is a loyalty redemption (should not count toward progress)
    // Only skip $0 items if they have a loyalty-related discount applied
    const totalMoney = lineItem.total_money?.amount || 0;
    if (totalMoney <= 0) {
      // Check if any applied discount is from our loyalty system
      const hasLoyaltyDiscount = lineItem.applied_discounts?.some(discount => {
        const discountName = (discount.name || '').toLowerCase();
        return discountName.includes('loyalty') ||
               discountName.includes('reward') ||
               discountName.includes('free item') ||
               discountName.includes('frequent buyer');
      });

      if (hasLoyaltyDiscount) {
        // This is a loyalty redemption - don't count it
        this.tracer.span('LINE_ITEM_SKIP_LOYALTY_REDEMPTION', {
          variationId,
          name: lineItem.name,
        });

        loyaltyLogger.debug({
          action: 'LINE_ITEM_EVALUATION',
          decision: 'SKIP_LOYALTY_REDEMPTION',
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
          reason: 'loyalty_redemption',
        };
      }

      // $0 item but NOT a loyalty redemption (e.g., promotional discount)
      // Continue processing - this item should still count for loyalty progress
      loyaltyLogger.debug({
        action: 'LINE_ITEM_EVALUATION',
        decision: 'ZERO_PRICE_NOT_LOYALTY',
        variationId,
        itemName: lineItem.name,
        appliedDiscounts: lineItem.applied_discounts?.map(d => d.name),
        orderId: order.id,
        merchantId: this.merchantId,
      });
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

  /**
   * Record an order as processed in the loyalty_processed_orders table
   * This is used to track orders that were evaluated but had no qualifying items,
   * preventing the catchup job from reprocessing them every hour.
   *
   * @param {string} orderId - Square order ID
   * @param {string|null} customerId - Square customer ID (may be null if customer not found)
   * @param {Object} options - Recording options
   * @param {string} options.resultType - Result type: 'qualifying', 'non_qualifying', 'no_customer', 'no_offers'
   * @param {number} options.qualifyingItems - Number of qualifying items
   * @param {number} options.totalLineItems - Total line items in order
   * @param {string} [options.traceId] - Correlation trace ID
   * @param {string} [options.source] - Source of processing (WEBHOOK, CATCHUP_JOB, etc.)
   * @returns {Promise<boolean>} True if recorded, false if already exists
   */
  async recordProcessedOrder(orderId, customerId, options = {}) {
    const {
      resultType = 'non_qualifying',
      qualifyingItems = 0,
      totalLineItems = 0,
      traceId = null,
      source = 'WEBHOOK',
    } = options;

    try {
      // Use ON CONFLICT to handle duplicate order processing gracefully
      // This also benefits the rapid-fire webhook duplicate issue
      const result = await db.query(`
        INSERT INTO loyalty_processed_orders
          (merchant_id, square_order_id, square_customer_id, result_type,
           qualifying_items, total_line_items, trace_id, source, processed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (merchant_id, square_order_id) DO NOTHING
        RETURNING id
      `, [
        this.merchantId,
        orderId,
        customerId,
        resultType,
        qualifyingItems,
        totalLineItems,
        traceId,
        source,
      ]);

      const wasInserted = result.rows.length > 0;

      if (wasInserted) {
        loyaltyLogger.debug({
          action: 'ORDER_MARKED_PROCESSED',
          orderId,
          customerId,
          resultType,
          qualifyingItems,
          totalLineItems,
          merchantId: this.merchantId,
        });
      } else {
        // Order was already recorded - this is the duplicate webhook case
        loyaltyLogger.debug({
          action: 'ORDER_ALREADY_PROCESSED',
          orderId,
          resultType,
          merchantId: this.merchantId,
        });
      }

      return wasInserted;
    } catch (error) {
      // Log but don't fail - this is a best-effort tracking mechanism
      loyaltyLogger.error({
        action: 'RECORD_PROCESSED_ORDER_ERROR',
        orderId,
        error: error.message,
        merchantId: this.merchantId,
      });
      return false;
    }
  }
}

module.exports = { LoyaltyWebhookService };
