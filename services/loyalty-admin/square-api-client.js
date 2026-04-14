/**
 * Square API Client for Loyalty Admin Layer
 *
 * Thin shim over services/square/square-client.js. Preserves the
 * SquareApiClient class so existing callers (webhook-handlers/loyalty-handler.js,
 * seniors-service.js, customer-details-service.js, etc.) continue to work
 * unchanged while the core HTTP path delegates to the canonical
 * makeSquareRequest implementation.
 *
 * Part of Task 11 of the Square client refactor (see
 * docs/SQUARE_CLIENT_REFACTOR_PLAN.md Section 3 / Task 11).
 *
 * Endpoint note: square-client.js requires the `/v2/...` prefix on every
 * endpoint. All method implementations below include it explicitly.
 *
 * SquareApiError re-export: the class is re-exported from square-client.js
 * so `const { SquareApiError } = require('./square-api-client')` keeps
 * working; the class identity matches the one thrown by makeSquareRequest,
 * allowing `err instanceof SquareApiError` checks to hold.
 */

const { makeSquareRequest, getMerchantToken, SquareApiError } = require('../square/square-client');
const logger = require('../../utils/logger');

/**
 * SquareApiClient — convenience wrapper around makeSquareRequest.
 * Initialize once per merchantId, then call convenience methods.
 */
class SquareApiClient {
    /**
     * @param {number} merchantId - Internal merchant ID
     */
    constructor(merchantId) {
        this.merchantId = merchantId;
        this.accessToken = null;
    }

    /**
     * Initialize the client by fetching the access token.
     * Must be called before any API method.
     *
     * Note: getMerchantToken throws when the merchant/token is missing.
     * We convert that throw into a SquareApiError(401) to preserve the
     * previous contract for this class (which always surfaced a
     * SquareApiError on init failure).
     *
     * @returns {Promise<SquareApiClient>}
     */
    async initialize() {
        try {
            this.accessToken = await getMerchantToken(this.merchantId);
        } catch (err) {
            throw new SquareApiError('No access token available for merchant', {
                status: 401,
                endpoint: 'init',
                details: [{ merchantId: this.merchantId, originalError: err.message }],
                nonRetryable: true,
            });
        }
        return this;
    }

    /**
     * Core request — delegates to makeSquareRequest with stored token.
     * @param {string} method - HTTP method
     * @param {string} endpoint - API path including `/v2/...` prefix
     * @param {Object|null} body - Request body
     * @param {Object} [opts] - timeout
     * @returns {Promise<Object>} Parsed JSON response
     */
    async request(method, endpoint, body = null, opts = {}) {
        if (!this.accessToken) {
            throw new SquareApiError('Client not initialized', {
                status: 401,
                endpoint,
                nonRetryable: true,
            });
        }

        const fetchOpts = {
            accessToken: this.accessToken,
            method,
        };
        if (body !== null && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            fetchOpts.body = JSON.stringify(body);
        }
        if (typeof opts.timeout === 'number') {
            fetchOpts.timeout = opts.timeout;
        }

        return makeSquareRequest(endpoint, fetchOpts);
    }

    // ========================================================================
    // Convenience methods (only those used by active callers)
    // ========================================================================

    /**
     * GET /v2/customers/{id}
     * @param {string} customerId
     * @returns {Promise<Object>} Customer object
     */
    async getCustomer(customerId) {
        const data = await this.request('GET', `/v2/customers/${customerId}`, null, {
            timeout: 10000,
        });
        return data.customer;
    }

    /**
     * GET /v2/loyalty/accounts/{id}
     * @param {string} accountId
     * @returns {Promise<Object>} Loyalty account object
     */
    async getLoyaltyAccount(accountId) {
        const data = await this.request('GET', `/v2/loyalty/accounts/${accountId}`, null, {
            timeout: 10000,
        });
        return data.loyalty_account;
    }

    /**
     * GET /v2/orders/{id}
     * @param {string} orderId
     * @returns {Promise<Object|null>} Order object or null if 404
     */
    async getOrder(orderId) {
        try {
            const data = await this.request('GET', `/v2/orders/${orderId}`, null, {
                timeout: 10000,
            });
            return data.order;
        } catch (error) {
            if (error instanceof SquareApiError && error.status === 404) return null;
            throw error;
        }
    }

    /**
     * POST /v2/customers/groups
     * @param {string} name - Group name
     * @param {string} idempotencyKey
     * @returns {Promise<Object>} Created group
     */
    async createCustomerGroup(name, idempotencyKey) {
        const data = await this.request('POST', '/v2/customers/groups', {
            group: { name },
            idempotency_key: idempotencyKey,
        }, { timeout: 10000 });
        return data.group;
    }

    /**
     * POST /v2/catalog/batch-upsert
     * @param {Array} objects - Catalog objects to upsert
     * @param {string} idempotencyKey
     * @returns {Promise<Array>} Created/updated objects
     */
    async batchUpsertCatalog(objects, idempotencyKey) {
        const data = await this.request('POST', '/v2/catalog/batch-upsert', {
            idempotency_key: idempotencyKey,
            batches: [{ objects }],
        }, { timeout: 20000 });
        return data.objects || [];
    }

    /**
     * GET /v2/catalog/object/{id}
     * @param {string} objectId
     * @returns {Promise<Object|null>} Catalog object or null if 404
     */
    async getCatalogObject(objectId) {
        try {
            const data = await this.request('GET', `/v2/catalog/object/${objectId}`, null, {
                timeout: 10000,
            });
            return data.object;
        } catch (error) {
            if (error instanceof SquareApiError && error.status === 404) return null;
            throw error;
        }
    }

    /**
     * PUT /v2/customers/{customerId}/groups/{groupId}
     * @param {string} customerId
     * @param {string} groupId
     * @returns {Promise<boolean>}
     */
    async addCustomerToGroup(customerId, groupId) {
        await this.request('PUT', `/v2/customers/${customerId}/groups/${groupId}`, {}, {
            timeout: 10000,
        });
        return true;
    }

    /**
     * DELETE /v2/customers/{customerId}/groups/{groupId}
     * @param {string} customerId
     * @param {string} groupId
     * @returns {Promise<boolean>}
     */
    async removeCustomerFromGroup(customerId, groupId) {
        try {
            await this.request('DELETE', `/v2/customers/${customerId}/groups/${groupId}`, null, {
                timeout: 10000,
            });
            return true;
        } catch (error) {
            if (error instanceof SquareApiError && error.status === 404) return true;
            throw error;
        }
    }

    /**
     * POST /v2/loyalty/events/search (paginated)
     * Fetches all pages of results using Square's cursor-based pagination.
     * Safety guard: max 20 pages to prevent runaway loops.
     *
     * @param {Object} query - Search query with filter criteria
     * @returns {Promise<Array>} Array of all loyalty events across all pages
     */
    async searchLoyaltyEvents(query) {
        const MAX_PAGES = 20;
        const allEvents = [];
        let cursor = null;
        let page = 0;

        do {
            const requestBody = cursor ? { ...query, cursor } : { ...query };
            const data = await this.request('POST', '/v2/loyalty/events/search', requestBody, {
                timeout: 10000,
            });
            allEvents.push(...(data.events || []));
            cursor = data.cursor || null;
            page++;

            if (page >= MAX_PAGES && cursor) {
                logger.error('searchLoyaltyEvents hit max pagination limit', {
                    merchantId: this.merchantId,
                    pages: page,
                    totalEvents: allEvents.length,
                    maxPages: MAX_PAGES
                });
                break;
            }
        } while (cursor);

        return allEvents;
    }

    /**
     * POST /v2/customers/search (paginated)
     * Fetches all pages of results using Square's cursor-based pagination.
     * Safety guard: max 20 pages to prevent runaway loops.
     *
     * @param {Object} query - Search query with filter criteria
     * @returns {Promise<Array>} Array of all customers across all pages
     */
    async searchCustomers(query) {
        const MAX_PAGES = 20;
        const allCustomers = [];
        let cursor = null;
        let page = 0;

        do {
            const requestBody = cursor ? { ...query, cursor } : { ...query };
            const data = await this.request('POST', '/v2/customers/search', requestBody, {
                timeout: 10000,
            });
            allCustomers.push(...(data.customers || []));
            cursor = data.cursor || null;
            page++;

            if (page >= MAX_PAGES && cursor) {
                logger.error('searchCustomers hit max pagination limit', {
                    merchantId: this.merchantId,
                    pages: page,
                    totalCustomers: allCustomers.length,
                    maxPages: MAX_PAGES
                });
                break;
            }
        } while (cursor);

        return allCustomers;
    }
}

module.exports = { SquareApiClient, SquareApiError };
