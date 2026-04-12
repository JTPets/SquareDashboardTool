/**
 * Customer Search Service
 *
 * Searches customers by phone, email, or name.
 * Checks local cache first, then Square API, merges and deduplicates results.
 *
 * Extracted from routes/loyalty/customers.js (A-11) — moved as-is, no refactoring.
 *
 * OBSERVATION LOG (from extraction):
 * - Uses raw fetch() instead of squareClient SDK (pre-dates SDK standardization)
 * - Phone normalization could be shared with customer-cache-service.searchCachedCustomers
 * - Name search fetches recent customers and filters client-side (no server-side filter)
 */

const logger = require('../../utils/logger');
const { makeSquareRequest, getMerchantToken, SquareApiError } = require('../square/square-client');
const { searchCachedCustomers, cacheCustomerDetails } = require('./customer-cache-service');

/**
 * Search customers by phone number, email, or name.
 * First checks local cache, then Square API if needed.
 *
 * @param {string} query - Raw search query (phone, email, or name)
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @returns {Promise<Object>} Search results with query, searchType, customers, source
 */
async function searchCustomers(query, merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for searchCustomers - tenant isolation required');
    }

    // Normalize phone number - remove spaces, dashes, parentheses
    const normalizedQuery = query.replace(/[\s\-\(\)\.]/g, '');
    const isPhoneSearch = /^\+?\d{7,}$/.test(normalizedQuery);
    const isEmailSearch = query.includes('@');

    // First, search local cache for loyalty customers
    const cachedCustomers = await searchCachedCustomers(query, merchantId);

    // If we found exact matches in cache (especially for phone), return them
    if (cachedCustomers.length > 0 && isPhoneSearch) {
        logger.debug('Returning cached customer results', { query, count: cachedCustomers.length });
        return {
            query,
            searchType: 'phone',
            customers: cachedCustomers,
            source: 'cache'
        };
    }

    // Get Square access token. getMerchantToken throws if the merchant is
    // missing/inactive or has no token configured; the legacy helper returned
    // null for the same cases. Catch the throw to preserve the null-token
    // fallback-to-cache behavior.
    let accessToken = null;
    try {
        accessToken = await getMerchantToken(merchantId);
    } catch (err) {
        logger.debug('No Square access token available', { merchantId, error: err.message });
    }
    if (!accessToken) {
        // No Square token - return cached results only
        if (cachedCustomers.length > 0) {
            return {
                query,
                searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
                customers: cachedCustomers,
                source: 'cache'
            };
        }
        const error = new Error('No Square access token configured');
        error.statusCode = 400;
        throw error;
    }

    let searchFilter = {};

    if (isPhoneSearch) {
        searchFilter = {
            phone_number: {
                exact: normalizedQuery.startsWith('+') ? normalizedQuery : `+1${normalizedQuery}`
            }
        };
    } else if (isEmailSearch) {
        searchFilter = {
            email_address: {
                fuzzy: query
            }
        };
    }

    // Search customers using Square API
    const searchBody = {
        limit: 20
    };

    if (Object.keys(searchFilter).length > 0) {
        searchBody.query = { filter: searchFilter };
    } else {
        // For name searches, get recent customers and filter client-side
        searchBody.query = {
            filter: {},
            sort: {
                field: 'CREATED_AT',
                order: 'DESC'
            }
        };
    }

    let data;
    try {
        data = await makeSquareRequest('/v2/customers/search', {
            method: 'POST',
            accessToken,
            body: JSON.stringify(searchBody),
            timeout: 15000
        });
    } catch (err) {
        const status = err instanceof SquareApiError ? err.status : undefined;
        logger.error('Square customer search failed', { status, error: err.message });
        // Return cached results if Square API fails
        if (cachedCustomers.length > 0) {
            return {
                query,
                searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
                customers: cachedCustomers,
                source: 'cache'
            };
        }
        const error = new Error('Square API error');
        error.statusCode = status || 500;
        throw error;
    }

    const squareCustomers = (data.customers || []).map(c => ({
        id: c.id,
        displayName: [c.given_name, c.family_name].filter(Boolean).join(' ') || c.company_name || 'Unknown',
        givenName: c.given_name || null,
        familyName: c.family_name || null,
        phone: c.phone_number || null,
        email: c.email_address || null,
        companyName: c.company_name || null,
        createdAt: c.created_at
    }));

    // For name searches, filter client-side
    let filteredSquareCustomers = squareCustomers;
    if (!isPhoneSearch && !isEmailSearch) {
        const lowerQuery = query.toLowerCase();
        filteredSquareCustomers = squareCustomers.filter(c =>
            c.displayName?.toLowerCase().includes(lowerQuery) ||
            c.givenName?.toLowerCase().includes(lowerQuery) ||
            c.familyName?.toLowerCase().includes(lowerQuery) ||
            c.phone?.includes(query) ||
            c.email?.toLowerCase().includes(lowerQuery)
        );
    }

    // Cache Square customers for future lookups (async, don't wait)
    for (const customer of filteredSquareCustomers) {
        cacheCustomerDetails(customer, merchantId).catch(err => {
            logger.warn('Failed to cache customer', { error: err.message, customerId: customer.id });
        });
    }

    // Merge cached and Square results, deduplicate by ID
    const seenIds = new Set();
    const mergedCustomers = [];

    // Add Square results first (fresher data)
    for (const c of filteredSquareCustomers) {
        if (!seenIds.has(c.id)) {
            seenIds.add(c.id);
            mergedCustomers.push(c);
        }
    }

    // Add any cached customers not in Square results
    for (const c of cachedCustomers) {
        if (!seenIds.has(c.id)) {
            seenIds.add(c.id);
            mergedCustomers.push(c);
        }
    }

    return {
        query,
        searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
        customers: mergedCustomers,
        source: 'merged'
    };
}

module.exports = {
    searchCustomers
};
