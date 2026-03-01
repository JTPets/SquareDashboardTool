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
 * - Hardcoded Square-Version header ('2025-01-16') instead of using config/constants
 * - Phone normalization could be shared with customer-cache-service.searchCachedCustomers
 * - Name search fetches recent customers and filters client-side (no server-side filter)
 */

const logger = require('../../utils/logger');
const { getSquareAccessToken } = require('./shared-utils');
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

    // Get Square access token
    const accessToken = await getSquareAccessToken(merchantId);
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

    const response = await fetch('https://connect.squareup.com/v2/customers/search', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2025-01-16'
        },
        body: JSON.stringify(searchBody)
    });

    if (!response.ok) {
        const errText = await response.text();
        logger.error('Square customer search failed', { status: response.status, error: errText });
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
        error.statusCode = response.status;
        throw error;
    }

    const data = await response.json();
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
