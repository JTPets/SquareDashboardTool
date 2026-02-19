/**
 * Square API Client for Loyalty Admin Layer
 *
 * Unified Square HTTP client with 429 rate-limit retry.
 * Replaces services/loyalty/square-client.js (LoyaltySquareClient) for all
 * active callers as part of L-6 (DEDUP-AUDIT) unification.
 *
 * Uses squareApiRequest() from shared-utils.js for the core retry logic,
 * and getSquareAccessToken() for token management.
 */

const { squareApiRequest, getSquareAccessToken, SquareApiError } = require('./shared-utils');

/**
 * SquareApiClient — convenience wrapper around squareApiRequest.
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
     * @returns {Promise<SquareApiClient>}
     */
    async initialize() {
        const token = await getSquareAccessToken(this.merchantId);
        if (!token) {
            throw new SquareApiError(
                'No access token available for merchant',
                401, 'init', { merchantId: this.merchantId }
            );
        }
        this.accessToken = token;
        return this;
    }

    /**
     * Core request — delegates to squareApiRequest with stored token.
     * @param {string} method - HTTP method
     * @param {string} endpoint - API path (e.g. '/customers/{id}')
     * @param {Object|null} body - Request body
     * @param {Object} [opts] - timeout, context, maxRetries
     * @returns {Promise<Object>} Parsed JSON response
     */
    async request(method, endpoint, body = null, opts = {}) {
        if (!this.accessToken) {
            throw new SquareApiError('Client not initialized', 401, endpoint);
        }
        return squareApiRequest(this.accessToken, method, endpoint, body, {
            ...opts,
            merchantId: this.merchantId,
        });
    }

    // ========================================================================
    // Convenience methods (only those used by active callers)
    // ========================================================================

    /**
     * GET /customers/{id}
     * @param {string} customerId
     * @returns {Promise<Object>} Customer object
     */
    async getCustomer(customerId) {
        const data = await this.request('GET', `/customers/${customerId}`, null, {
            context: 'getCustomer', timeout: 10000,
        });
        return data.customer;
    }

    /**
     * GET /loyalty/accounts/{id}
     * @param {string} accountId
     * @returns {Promise<Object>} Loyalty account object
     */
    async getLoyaltyAccount(accountId) {
        const data = await this.request('GET', `/loyalty/accounts/${accountId}`, null, {
            context: 'getLoyaltyAccount', timeout: 10000,
        });
        return data.loyalty_account;
    }

    /**
     * GET /orders/{id}
     * @param {string} orderId
     * @returns {Promise<Object|null>} Order object or null if 404
     */
    async getOrder(orderId) {
        try {
            const data = await this.request('GET', `/orders/${orderId}`, null, {
                context: 'getOrder', timeout: 10000,
            });
            return data.order;
        } catch (error) {
            if (error.status === 404) return null;
            throw error;
        }
    }

    /**
     * POST /customers/groups
     * @param {string} name - Group name
     * @param {string} idempotencyKey
     * @returns {Promise<Object>} Created group
     */
    async createCustomerGroup(name, idempotencyKey) {
        const data = await this.request('POST', '/customers/groups', {
            group: { name },
            idempotency_key: idempotencyKey,
        }, { context: 'createCustomerGroup', timeout: 10000 });
        return data.group;
    }

    /**
     * POST /catalog/batch-upsert
     * @param {Array} objects - Catalog objects to upsert
     * @param {string} idempotencyKey
     * @returns {Promise<Array>} Created/updated objects
     */
    async batchUpsertCatalog(objects, idempotencyKey) {
        const data = await this.request('POST', '/catalog/batch-upsert', {
            idempotency_key: idempotencyKey,
            batches: [{ objects }],
        }, { context: 'batchUpsertCatalog', timeout: 20000 });
        return data.objects || [];
    }

    /**
     * GET /catalog/object/{id}
     * @param {string} objectId
     * @returns {Promise<Object|null>} Catalog object or null if 404
     */
    async getCatalogObject(objectId) {
        try {
            const data = await this.request('GET', `/catalog/object/${objectId}`, null, {
                context: 'getCatalogObject', timeout: 10000,
            });
            return data.object;
        } catch (error) {
            if (error.status === 404) return null;
            throw error;
        }
    }

    /**
     * PUT /customers/{customerId}/groups/{groupId}
     * @param {string} customerId
     * @param {string} groupId
     * @returns {Promise<boolean>}
     */
    async addCustomerToGroup(customerId, groupId) {
        await this.request('PUT', `/customers/${customerId}/groups/${groupId}`, {}, {
            context: 'addCustomerToGroup', timeout: 10000,
        });
        return true;
    }

    /**
     * DELETE /customers/{customerId}/groups/{groupId}
     * @param {string} customerId
     * @param {string} groupId
     * @returns {Promise<boolean>}
     */
    async removeCustomerFromGroup(customerId, groupId) {
        try {
            await this.request('DELETE', `/customers/${customerId}/groups/${groupId}`, null, {
                context: 'removeCustomerFromGroup', timeout: 10000,
            });
            return true;
        } catch (error) {
            if (error.status === 404) return true;
            throw error;
        }
    }
}

module.exports = { SquareApiClient, SquareApiError };
