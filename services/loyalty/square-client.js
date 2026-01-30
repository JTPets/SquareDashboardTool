/**
 * Square API Client for Loyalty Service
 *
 * Centralized Square API client with:
 * - Automatic logging of all API calls
 * - Consistent error handling
 * - Token management
 * - Timeout handling
 */

const db = require('../../utils/database');
const { decryptToken, isEncryptedToken } = require('../../utils/token-encryption');
const { loyaltyLogger } = require('./loyalty-logger');

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';
const SQUARE_API_VERSION = '2025-01-16';
const DEFAULT_TIMEOUT = 15000;

/**
 * Custom error class for Square API errors
 */
class SquareApiError extends Error {
  constructor(message, status, endpoint, details = {}) {
    super(message);
    this.name = 'SquareApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.details = details;
  }
}

/**
 * Fetch with timeout wrapper
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * LoyaltySquareClient - Centralized Square API client for loyalty operations
 */
class LoyaltySquareClient {
  /**
   * @param {number} merchantId - Internal merchant ID
   */
  constructor(merchantId) {
    this.merchantId = merchantId;
    this.accessToken = null;
  }

  /**
   * Initialize the client by fetching the access token
   * @returns {Promise<LoyaltySquareClient>} The initialized client
   */
  async initialize() {
    const tokenResult = await db.query(
      'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
      [this.merchantId]
    );

    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
      throw new SquareApiError(
        'No access token available for merchant',
        401,
        'init',
        { merchantId: this.merchantId }
      );
    }

    const rawToken = tokenResult.rows[0].square_access_token;
    this.accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

    return this;
  }

  /**
   * Make a request to the Square API with retry logic for rate limiting
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint (without base URL)
   * @param {Object} [body] - Request body for POST/PUT
   * @param {Object} [options] - Additional options
   * @param {number} [options.timeout] - Custom timeout
   * @param {string} [options.context] - Context for logging
   * @param {number} [options.maxRetries] - Max retry attempts for rate limiting (default: 3)
   * @returns {Promise<Object>} Parsed JSON response
   */
  async request(method, endpoint, body = null, options = {}) {
    if (!this.accessToken) {
      throw new SquareApiError('Client not initialized', 401, endpoint);
    }

    const { timeout = DEFAULT_TIMEOUT, context = '', maxRetries = 3 } = options;
    const url = `${SQUARE_API_BASE}${endpoint}`;

    const fetchOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': SQUARE_API_VERSION
      }
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      fetchOptions.body = JSON.stringify(body);
    }

    const startTime = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchWithTimeout(url, fetchOptions, timeout);
        const duration = Date.now() - startTime;

        loyaltyLogger.squareApi({
          endpoint,
          method,
          status: response.status,
          duration,
          success: response.ok,
          merchantId: this.merchantId,
          context,
          attempt,
        });

        // Handle rate limiting with retry
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
          loyaltyLogger.squareApi({
            action: 'RATE_LIMITED',
            category: 'LOYALTY:RETRY',
            endpoint,
            method,
            retryAfter,
            attempt,
            maxRetries,
            merchantId: this.merchantId,
            context,
          });

          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            continue;
          }

          // Max retries exhausted for rate limiting
          throw new SquareApiError(
            `Rate limited after ${maxRetries} attempts`,
            429,
            endpoint,
            { retryAfter, attempts: attempt }
          );
        }

        if (!response.ok) {
          const errorText = await response.text();
          let errorDetails;
          try {
            errorDetails = JSON.parse(errorText);
          } catch {
            errorDetails = { message: errorText };
          }

          throw new SquareApiError(
            `Square API error: ${response.status}`,
            response.status,
            endpoint,
            errorDetails
          );
        }

        const responseData = await response.json();
        return responseData;

      } catch (error) {
        lastError = error;
        const duration = Date.now() - startTime;

        if (error instanceof SquareApiError) {
          // Don't retry non-rate-limit errors
          if (error.status !== 429) {
            loyaltyLogger.error({
              action: 'SQUARE_API_ERROR',
              endpoint,
              method,
              status: error.status,
              duration,
              error: error.message,
              details: error.details,
              merchantId: this.merchantId,
              context,
              attempt,
            });
            throw error;
          }
          // Rate limit error already handled above, this is after max retries
          throw error;
        }

        // Network or other transient error - log and throw
        loyaltyLogger.error({
          action: 'SQUARE_API_ERROR',
          endpoint,
          method,
          duration,
          error: error.message,
          merchantId: this.merchantId,
          context,
          attempt,
        });

        throw new SquareApiError(
          error.message,
          0,
          endpoint,
          { originalError: error.message }
        );
      }
    }

    // Should not reach here, but safety net
    throw lastError || new SquareApiError('Request failed', 0, endpoint);
  }

  /**
   * GET request
   */
  async get(endpoint, options = {}) {
    return this.request('GET', endpoint, null, options);
  }

  /**
   * POST request
   */
  async post(endpoint, body, options = {}) {
    return this.request('POST', endpoint, body, options);
  }

  /**
   * PUT request
   */
  async put(endpoint, body, options = {}) {
    return this.request('PUT', endpoint, body, options);
  }

  /**
   * DELETE request
   */
  async delete(endpoint, options = {}) {
    return this.request('DELETE', endpoint, null, options);
  }

  // ============================================================================
  // Convenience methods for common Square API operations
  // ============================================================================

  /**
   * Get a customer by ID
   * @param {string} customerId - Square customer ID
   * @returns {Promise<Object>} Customer data
   */
  async getCustomer(customerId) {
    const data = await this.get(`/customers/${customerId}`, {
      context: 'getCustomer',
      timeout: 10000,
    });
    return data.customer;
  }

  /**
   * Search customers
   * @param {Object} query - Search query
   * @returns {Promise<Array>} Array of customers
   */
  async searchCustomers(query) {
    const data = await this.post('/customers/search', query, {
      context: 'searchCustomers',
      timeout: 10000,
    });
    return data.customers || [];
  }

  /**
   * Search loyalty events
   * @param {Object} query - Search query
   * @returns {Promise<Array>} Array of loyalty events
   */
  async searchLoyaltyEvents(query) {
    const data = await this.post('/loyalty/events/search', query, {
      context: 'searchLoyaltyEvents',
      timeout: 10000,
    });
    return data.events || [];
  }

  /**
   * Get a loyalty account by ID
   * @param {string} accountId - Loyalty account ID
   * @returns {Promise<Object>} Loyalty account data
   */
  async getLoyaltyAccount(accountId) {
    const data = await this.get(`/loyalty/accounts/${accountId}`, {
      context: 'getLoyaltyAccount',
      timeout: 10000,
    });
    return data.loyalty_account;
  }

  /**
   * Get the main loyalty program
   * @returns {Promise<Object|null>} Loyalty program or null if not configured
   */
  async getLoyaltyProgram() {
    try {
      const data = await this.get('/loyalty/programs/main', {
        context: 'getLoyaltyProgram',
        timeout: 10000,
      });
      return data.program;
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a customer group
   * @param {string} name - Group name
   * @param {string} idempotencyKey - Idempotency key
   * @returns {Promise<Object>} Created group
   */
  async createCustomerGroup(name, idempotencyKey) {
    const data = await this.post('/customers/groups', {
      group: { name },
      idempotency_key: idempotencyKey,
    }, {
      context: 'createCustomerGroup',
      timeout: 10000,
    });
    return data.group;
  }

  /**
   * Delete a customer group
   * @param {string} groupId - Group ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteCustomerGroup(groupId) {
    try {
      await this.delete(`/customers/groups/${groupId}`, {
        context: 'deleteCustomerGroup',
        timeout: 10000,
      });
      return true;
    } catch (error) {
      if (error.status === 404) {
        return true; // Already deleted
      }
      throw error;
    }
  }

  /**
   * Add customer to group
   * @param {string} customerId - Customer ID
   * @param {string} groupId - Group ID
   * @returns {Promise<boolean>} True if added
   */
  async addCustomerToGroup(customerId, groupId) {
    await this.put(`/customers/${customerId}/groups/${groupId}`, {}, {
      context: 'addCustomerToGroup',
      timeout: 10000,
    });
    return true;
  }

  /**
   * Remove customer from group
   * @param {string} customerId - Customer ID
   * @param {string} groupId - Group ID
   * @returns {Promise<boolean>} True if removed
   */
  async removeCustomerFromGroup(customerId, groupId) {
    try {
      await this.delete(`/customers/${customerId}/groups/${groupId}`, {
        context: 'removeCustomerFromGroup',
        timeout: 10000,
      });
      return true;
    } catch (error) {
      if (error.status === 404) {
        return true; // Already removed
      }
      throw error;
    }
  }

  /**
   * Batch upsert catalog objects
   * @param {Array} objects - Catalog objects to upsert
   * @param {string} idempotencyKey - Idempotency key
   * @returns {Promise<Array>} Created/updated objects
   */
  async batchUpsertCatalog(objects, idempotencyKey) {
    const data = await this.post('/catalog/batch-upsert', {
      idempotency_key: idempotencyKey,
      batches: [{ objects }],
    }, {
      context: 'batchUpsertCatalog',
      timeout: 20000,
    });
    return data.objects || [];
  }

  /**
   * Delete a catalog object
   * @param {string} objectId - Catalog object ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteCatalogObject(objectId) {
    try {
      await this.delete(`/catalog/object/${objectId}`, {
        context: 'deleteCatalogObject',
        timeout: 10000,
      });
      return true;
    } catch (error) {
      if (error.status === 404) {
        return true; // Already deleted
      }
      throw error;
    }
  }

  /**
   * Get a catalog object
   * @param {string} objectId - Catalog object ID
   * @returns {Promise<Object|null>} Catalog object or null if not found
   */
  async getCatalogObject(objectId) {
    try {
      const data = await this.get(`/catalog/object/${objectId}`, {
        context: 'getCatalogObject',
        timeout: 10000,
      });
      return data.object;
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Search orders
   * @param {Object} query - Search query
   * @param {Array} locationIds - Location IDs to search
   * @returns {Promise<Object>} Orders and cursor
   */
  async searchOrders(query, locationIds) {
    const data = await this.post('/orders/search', {
      ...query,
      location_ids: locationIds,
    }, {
      context: 'searchOrders',
      timeout: 15000,
    });
    return {
      orders: data.orders || [],
      cursor: data.cursor,
    };
  }

  /**
   * Get an order by ID
   * @param {string} orderId - Order ID
   * @returns {Promise<Object|null>} Order or null if not found
   */
  async getOrder(orderId) {
    try {
      const data = await this.get(`/orders/${orderId}`, {
        context: 'getOrder',
        timeout: 10000,
      });
      return data.order;
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}

module.exports = {
  LoyaltySquareClient,
  SquareApiError,
  SQUARE_API_BASE,
  SQUARE_API_VERSION,
  DEFAULT_TIMEOUT,
};
