/**
 * Loyalty Customer Identification Service
 *
 * Handles customer identification from orders using multiple fallback methods:
 * 1. order.customer_id - Direct customer ID on order
 * 2. tender.customer_id - Customer ID on payment tender
 * 3. Loyalty API - Lookup via loyalty events by order_id
 * 4. Order Rewards - Lookup via Square Loyalty rewards on order
 * 5. Fulfillment Recipient - Search by phone/email from fulfillment
 * 6. Loyalty Discount - Reverse-lookup from order discount catalog_object_id to loyalty_rewards
 *
 * Relocated from services/loyalty/customer-service.js (BACKLOG-31).
 */

const db = require('../../utils/database');
const { loyaltyLogger } = require('../../utils/loyalty-logger');
const { SquareApiClient } = require('./square-api-client');

/**
 * Customer identification result
 * @typedef {Object} CustomerIdentificationResult
 * @property {string|null} customerId - Square customer ID
 * @property {string} method - Identification method used
 * @property {boolean} success - Whether identification was successful
 */

/**
 * LoyaltyCustomerService - Handles customer identification for loyalty tracking
 */
class LoyaltyCustomerService {
  /**
   * @param {number} merchantId - Internal merchant ID
   * @param {Object} [tracer] - Optional tracer instance for correlation
   */
  constructor(merchantId, tracer = null) {
    this.merchantId = merchantId;
    this.tracer = tracer;
    this.squareClient = null;
  }

  /**
   * Initialize the service with Square client
   * @returns {Promise<LoyaltyCustomerService>}
   */
  async initialize() {
    this.squareClient = await new SquareApiClient(this.merchantId).initialize();
    return this;
  }

  /**
   * Identify customer from an order using multiple fallback methods
   * @param {Object} order - Square order object
   * @returns {Promise<CustomerIdentificationResult>}
   */
  async identifyCustomerFromOrder(order) {
    const orderId = order.id;

    // Method 1: Direct customer_id on order
    if (order.customer_id) {
      this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'ORDER_CUSTOMER_ID' });
      loyaltyLogger.customer({
        action: 'CUSTOMER_LOOKUP_SUCCESS',
        orderId,
        method: 'ORDER_CUSTOMER_ID',
        customerId: order.customer_id,
        merchantId: this.merchantId,
      });
      return {
        customerId: order.customer_id,
        method: 'ORDER_CUSTOMER_ID',
        success: true,
      };
    }

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_ATTEMPT',
      orderId,
      method: 'ORDER_CUSTOMER_ID',
      success: false,
      merchantId: this.merchantId,
    });

    // Method 2: Check tenders for customer_id
    const tenderResult = await this.identifyFromTenders(order);
    if (tenderResult.success) {
      return tenderResult;
    }

    // Method 3: Lookup via Loyalty API
    const loyaltyResult = await this.identifyFromLoyaltyEvents(order);
    if (loyaltyResult.success) {
      return loyaltyResult;
    }

    // Method 4: Lookup from order rewards
    const rewardsResult = await this.identifyFromOrderRewards(order);
    if (rewardsResult.success) {
      return rewardsResult;
    }

    // Method 5: Lookup from fulfillment recipient
    const fulfillmentResult = await this.identifyFromFulfillmentRecipient(order);
    if (fulfillmentResult.success) {
      return fulfillmentResult;
    }

    // Method 6: Reverse-lookup from loyalty discount on order
    // If the order has a discount matching our loyalty_rewards catalog objects,
    // we can derive the customer from the reward record (local DB, no API calls)
    const discountResult = await this.identifyFromLoyaltyDiscount(order);
    if (discountResult.success) {
      return discountResult;
    }

    // No customer found
    this.tracer?.span('CUSTOMER_NOT_IDENTIFIED');
    loyaltyLogger.customer({
      action: 'CUSTOMER_NOT_IDENTIFIED',
      orderId,
      attemptedMethods: [
        'ORDER_CUSTOMER_ID',
        'TENDER_CUSTOMER_ID',
        'LOYALTY_API',
        'ORDER_REWARDS',
        'FULFILLMENT_RECIPIENT',
        'LOYALTY_DISCOUNT',
      ],
      merchantId: this.merchantId,
    });

    return {
      customerId: null,
      method: 'NONE',
      success: false,
    };
  }

  /**
   * Method 2: Identify customer from payment tenders
   * @private
   */
  async identifyFromTenders(order) {
    const orderId = order.id;

    if (!order.tenders || order.tenders.length === 0) {
      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_SKIPPED',
        orderId,
        method: 'TENDER_CUSTOMER_ID',
        reason: 'no_tenders',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'TENDER_CUSTOMER_ID', success: false };
    }

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_ATTEMPT',
      orderId,
      method: 'TENDER_CUSTOMER_ID',
      tenderCount: order.tenders.length,
      merchantId: this.merchantId,
    });

    for (const tender of order.tenders) {
      if (tender.customer_id) {
        this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'TENDER_CUSTOMER_ID' });
        loyaltyLogger.customer({
          action: 'CUSTOMER_LOOKUP_SUCCESS',
          orderId,
          method: 'TENDER_CUSTOMER_ID',
          customerId: tender.customer_id,
          merchantId: this.merchantId,
        });
        return {
          customerId: tender.customer_id,
          method: 'TENDER_CUSTOMER_ID',
          success: true,
        };
      }
    }

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_FAILED',
      orderId,
      method: 'TENDER_CUSTOMER_ID',
      reason: 'no_customer_id_on_tenders',
      merchantId: this.merchantId,
    });

    return { customerId: null, method: 'TENDER_CUSTOMER_ID', success: false };
  }

  /**
   * Method 3: Identify customer from loyalty events
   * @private
   */
  async identifyFromLoyaltyEvents(order) {
    const orderId = order.id;

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_ATTEMPT',
      orderId,
      method: 'LOYALTY_API',
      merchantId: this.merchantId,
    });

    try {
      // Search for loyalty events by order_id
      const events = await this.squareClient.searchLoyaltyEvents({
        query: {
          filter: {
            order_filter: {
              order_id: orderId,
            },
          },
        },
        limit: 10,
      });

      if (events.length === 0) {
        loyaltyLogger.debug({
          action: 'CUSTOMER_LOOKUP_FAILED',
          orderId,
          method: 'LOYALTY_API',
          reason: 'no_loyalty_events_found',
          merchantId: this.merchantId,
        });
        return { customerId: null, method: 'LOYALTY_API', success: false };
      }

      // Get loyalty account to find customer_id
      const loyaltyAccountId = events[0].loyalty_account_id;
      if (!loyaltyAccountId) {
        return { customerId: null, method: 'LOYALTY_API', success: false };
      }

      const loyaltyAccount = await this.squareClient.getLoyaltyAccount(loyaltyAccountId);
      const customerId = loyaltyAccount?.customer_id;

      if (customerId) {
        this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'LOYALTY_API' });
        loyaltyLogger.customer({
          action: 'CUSTOMER_LOOKUP_SUCCESS',
          orderId,
          method: 'LOYALTY_API',
          customerId,
          loyaltyAccountId,
          merchantId: this.merchantId,
        });
        return {
          customerId,
          method: 'LOYALTY_API',
          success: true,
        };
      }

      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_FAILED',
        orderId,
        method: 'LOYALTY_API',
        reason: 'no_customer_id_on_loyalty_account',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'LOYALTY_API', success: false };

    } catch (error) {
      loyaltyLogger.error({
        action: 'CUSTOMER_LOOKUP_ERROR',
        orderId,
        method: 'LOYALTY_API',
        error: error.message,
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'LOYALTY_API', success: false };
    }
  }

  /**
   * Method 4: Identify customer from order rewards
   * @private
   */
  async identifyFromOrderRewards(order) {
    const orderId = order.id;
    const rewards = order.rewards || [];

    if (rewards.length === 0) {
      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_SKIPPED',
        orderId,
        method: 'ORDER_REWARDS',
        reason: 'no_rewards_on_order',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'ORDER_REWARDS', success: false };
    }

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_ATTEMPT',
      orderId,
      method: 'ORDER_REWARDS',
      rewardCount: rewards.length,
      merchantId: this.merchantId,
    });

    try {
      // First try to find via loyalty events for this order
      const events = await this.squareClient.searchLoyaltyEvents({
        query: {
          filter: {
            order_filter: {
              order_id: orderId,
            },
          },
        },
        limit: 10,
      });

      for (const event of events) {
        if (event.loyalty_account_id) {
          const loyaltyAccount = await this.squareClient.getLoyaltyAccount(event.loyalty_account_id);
          const customerId = loyaltyAccount?.customer_id;

          if (customerId) {
            this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'ORDER_REWARDS' });
            loyaltyLogger.customer({
              action: 'CUSTOMER_LOOKUP_SUCCESS',
              orderId,
              method: 'ORDER_REWARDS',
              customerId,
              merchantId: this.merchantId,
            });
            return {
              customerId,
              method: 'ORDER_REWARDS',
              success: true,
            };
          }

          // Throttle API calls to avoid rate limits
          await new Promise(r => setTimeout(r, 100));
        }
      }

      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_FAILED',
        orderId,
        method: 'ORDER_REWARDS',
        reason: 'no_customer_from_rewards',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'ORDER_REWARDS', success: false };

    } catch (error) {
      loyaltyLogger.error({
        action: 'CUSTOMER_LOOKUP_ERROR',
        orderId,
        method: 'ORDER_REWARDS',
        error: error.message,
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'ORDER_REWARDS', success: false };
    }
  }

  /**
   * Method 5: Identify customer from fulfillment recipient
   * @private
   */
  async identifyFromFulfillmentRecipient(order) {
    const orderId = order.id;
    const fulfillments = order.fulfillments || [];

    // Extract phone/email from fulfillments
    let phoneNumber = null;
    let emailAddress = null;

    for (const fulfillment of fulfillments) {
      const recipient = fulfillment.pickup_details?.recipient ||
                       fulfillment.shipment_details?.recipient ||
                       fulfillment.delivery_details?.recipient;

      if (recipient) {
        if (!phoneNumber && recipient.phone_number) {
          phoneNumber = recipient.phone_number;
        }
        if (!emailAddress && recipient.email_address) {
          emailAddress = recipient.email_address;
        }
      }
    }

    if (!phoneNumber && !emailAddress) {
      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_SKIPPED',
        orderId,
        method: 'FULFILLMENT_RECIPIENT',
        reason: 'no_contact_info',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'FULFILLMENT_RECIPIENT', success: false };
    }

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_ATTEMPT',
      orderId,
      method: 'FULFILLMENT_RECIPIENT',
      hasPhone: !!phoneNumber,
      hasEmail: !!emailAddress,
      merchantId: this.merchantId,
    });

    try {
      // Try phone first (more reliable)
      if (phoneNumber) {
        const normalizedPhone = phoneNumber.replace(/[^\d+]/g, '');
        const customers = await this.squareClient.searchCustomers({
          query: {
            filter: {
              phone_number: {
                exact: normalizedPhone,
              },
            },
          },
          limit: 1,
        });

        if (customers.length > 0) {
          const customerId = customers[0].id;
          this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'FULFILLMENT_PHONE' });
          loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_SUCCESS',
            orderId,
            method: 'FULFILLMENT_RECIPIENT',
            subMethod: 'phone',
            customerId,
            merchantId: this.merchantId,
          });
          return {
            customerId,
            method: 'FULFILLMENT_RECIPIENT',
            success: true,
          };
        }
      }

      // Fallback to email
      if (emailAddress) {
        const customers = await this.squareClient.searchCustomers({
          query: {
            filter: {
              email_address: {
                exact: emailAddress.toLowerCase(),
              },
            },
          },
          limit: 1,
        });

        if (customers.length > 0) {
          const customerId = customers[0].id;
          this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'FULFILLMENT_EMAIL' });
          loyaltyLogger.customer({
            action: 'CUSTOMER_LOOKUP_SUCCESS',
            orderId,
            method: 'FULFILLMENT_RECIPIENT',
            subMethod: 'email',
            customerId,
            merchantId: this.merchantId,
          });
          return {
            customerId,
            method: 'FULFILLMENT_RECIPIENT',
            success: true,
          };
        }
      }

      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_FAILED',
        orderId,
        method: 'FULFILLMENT_RECIPIENT',
        reason: 'no_customer_match',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'FULFILLMENT_RECIPIENT', success: false };

    } catch (error) {
      loyaltyLogger.error({
        action: 'CUSTOMER_LOOKUP_ERROR',
        orderId,
        method: 'FULFILLMENT_RECIPIENT',
        error: error.message,
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'FULFILLMENT_RECIPIENT', success: false };
    }
  }

  /**
   * Method 6: Identify customer from loyalty discount on order
   * If order has a discount with catalog_object_id matching our loyalty_rewards,
   * derive the customer from the reward record. Local DB query only.
   * @private
   */
  async identifyFromLoyaltyDiscount(order) {
    const orderId = order.id;
    const discounts = order.discounts || [];

    if (discounts.length === 0) {
      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_SKIPPED',
        orderId,
        method: 'LOYALTY_DISCOUNT',
        reason: 'no_discounts_on_order',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'LOYALTY_DISCOUNT', success: false };
    }

    loyaltyLogger.debug({
      action: 'CUSTOMER_LOOKUP_ATTEMPT',
      orderId,
      method: 'LOYALTY_DISCOUNT',
      discountCount: discounts.length,
      merchantId: this.merchantId,
    });

    // Collect catalog_object_ids from order discounts
    // Handle both snake_case (webhook) and camelCase (SDK) field names
    const catalogObjectIds = discounts
      .map(d => d.catalog_object_id || d.catalogObjectId)
      .filter(Boolean);

    if (catalogObjectIds.length === 0) {
      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_FAILED',
        orderId,
        method: 'LOYALTY_DISCOUNT',
        reason: 'no_catalog_discount_ids',
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'LOYALTY_DISCOUNT', success: false };
    }

    try {
      // Check if any discount matches our loyalty rewards
      const rewardResult = await db.query(`
        SELECT r.square_customer_id, r.id as reward_id, o.offer_name
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        WHERE r.merchant_id = $1
          AND (r.square_discount_id = ANY($2) OR r.square_pricing_rule_id = ANY($2))
          AND r.status = 'earned'
        LIMIT 1
      `, [this.merchantId, catalogObjectIds]);

      if (rewardResult.rows.length > 0) {
        const { square_customer_id, reward_id, offer_name } = rewardResult.rows[0];
        this.tracer?.span('CUSTOMER_IDENTIFIED', { method: 'LOYALTY_DISCOUNT' });
        loyaltyLogger.customer({
          action: 'CUSTOMER_LOOKUP_SUCCESS',
          orderId,
          method: 'LOYALTY_DISCOUNT',
          customerId: square_customer_id,
          rewardId: reward_id,
          offerName: offer_name,
          merchantId: this.merchantId,
        });
        return {
          customerId: square_customer_id,
          method: 'LOYALTY_DISCOUNT',
          success: true,
        };
      }

      loyaltyLogger.debug({
        action: 'CUSTOMER_LOOKUP_FAILED',
        orderId,
        method: 'LOYALTY_DISCOUNT',
        reason: 'no_matching_reward',
        catalogObjectIds,
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'LOYALTY_DISCOUNT', success: false };

    } catch (error) {
      loyaltyLogger.error({
        action: 'CUSTOMER_LOOKUP_ERROR',
        orderId,
        method: 'LOYALTY_DISCOUNT',
        error: error.message,
        merchantId: this.merchantId,
      });
      return { customerId: null, method: 'LOYALTY_DISCOUNT', success: false };
    }
  }

  /**
   * Get customer details by ID
   * @param {string} customerId - Square customer ID
   * @returns {Promise<Object|null>}
   */
  async getCustomerDetails(customerId) {
    try {
      const customer = await this.squareClient.getCustomer(customerId);
      return {
        id: customer.id,
        givenName: customer.given_name || null,
        familyName: customer.family_name || null,
        displayName: [customer.given_name, customer.family_name]
          .filter(Boolean).join(' ') || customer.company_name || null,
        email: customer.email_address || null,
        phone: customer.phone_number || null,
        companyName: customer.company_name || null,
        createdAt: customer.created_at,
        updatedAt: customer.updated_at,
      };
    } catch (error) {
      loyaltyLogger.error({
        action: 'GET_CUSTOMER_DETAILS_ERROR',
        customerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      return null;
    }
  }

  /**
   * Cache customer details to loyalty_customers table
   * Ensures phone number is available in rewards reporting
   * @param {string} customerId - Square customer ID
   * @returns {Promise<Object|null>} Customer details or null if not found
   */
  async cacheCustomerDetails(customerId) {
    try {
      // First check if already cached with phone number
      const cached = await db.query(`
        SELECT phone_number FROM loyalty_customers
        WHERE merchant_id = $1 AND square_customer_id = $2
      `, [this.merchantId, customerId]);

      if (cached.rows.length > 0 && cached.rows[0].phone_number) {
        // Already cached with phone, no need to fetch again
        return { id: customerId, phone: cached.rows[0].phone_number, cached: true };
      }

      // Fetch from Square API
      const customer = await this.getCustomerDetails(customerId);
      if (!customer) {
        return null;
      }

      // Cache to database
      await db.query(`
        INSERT INTO loyalty_customers (
          merchant_id, square_customer_id, given_name, family_name,
          display_name, phone_number, email_address, company_name,
          last_updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (merchant_id, square_customer_id) DO UPDATE SET
          given_name = COALESCE(EXCLUDED.given_name, loyalty_customers.given_name),
          family_name = COALESCE(EXCLUDED.family_name, loyalty_customers.family_name),
          display_name = COALESCE(EXCLUDED.display_name, loyalty_customers.display_name),
          phone_number = COALESCE(EXCLUDED.phone_number, loyalty_customers.phone_number),
          email_address = COALESCE(EXCLUDED.email_address, loyalty_customers.email_address),
          company_name = COALESCE(EXCLUDED.company_name, loyalty_customers.company_name),
          last_updated_at = NOW()
      `, [
        this.merchantId,
        customer.id,
        customer.givenName,
        customer.familyName,
        customer.displayName,
        customer.phone,
        customer.email,
        customer.companyName,
      ]);

      loyaltyLogger.customer({
        action: 'CUSTOMER_CACHED',
        customerId,
        hasPhone: !!customer.phone,
        merchantId: this.merchantId,
      });

      return customer;
    } catch (error) {
      loyaltyLogger.error({
        action: 'CACHE_CUSTOMER_ERROR',
        customerId,
        error: error.message,
        merchantId: this.merchantId,
      });
      return null;
    }
  }
}

module.exports = { LoyaltyCustomerService };
