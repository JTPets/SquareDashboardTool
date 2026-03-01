/**
 * Loyalty Customer Routes
 *
 * Customer lookup, status, history, and search:
 * - GET /customer/:customerId - Get customer loyalty status
 * - GET /customer/:customerId/profile - Get customer loyalty profile (modern)
 * - GET /customer/:customerId/history - Get loyalty history
 * - GET /customer/:customerId/rewards - Get earned rewards
 * - GET /customer/:customerId/audit-history - Get order history for audit
 * - POST /customer/:customerId/add-orders - Add orders to loyalty tracking
 * - GET /customers/search - Search customers (cache + Square API)
 *
 * OBSERVATION LOG:
 * - GET /customers/search has 160 lines of inline business logic:
 *   token decryption, raw Square API call, phone/email/name detection,
 *   result merging and deduplication. Should be extracted to a
 *   customer-search-service in services/loyalty-admin/.
 * - GET /customers/search uses raw fetch() instead of squareClient SDK
 *   (pre-dates SDK standardization)
 */

const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');
const { decryptToken, isEncryptedToken } = require('../../utils/token-encryption');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');
const { getCustomerOfferProgress } = require('../../services/loyalty-admin');

/**
 * GET /api/loyalty/customer/:customerId
 * Get loyalty status for a specific customer
 */
router.get('/customer/:customerId', requireAuth, requireMerchant, validators.getCustomer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const customerId = req.params.customerId;

    const customerDetails = await loyaltyService.getCustomerDetails(customerId, merchantId);

    if (!customerDetails) {
        return res.status(404).json({ error: 'Customer not found' });
    }

    // Also get their loyalty status
    const loyaltyStatus = await loyaltyService.getCustomerLoyaltyStatus(customerId, merchantId);

    res.json({
        customer: customerDetails,
        loyalty: loyaltyStatus
    });
}));

/**
 * GET /api/loyalty/customer/:customerId/profile
 * Get customer loyalty profile (modern - reads from source of truth)
 * Returns offer progress calculated from purchase_events table
 */
router.get('/customer/:customerId/profile', requireAuth, requireMerchant, validators.getCustomer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const customerId = req.params.customerId;

    // Get customer details from legacy service (for name, phone, email)
    const customerDetails = await loyaltyService.getCustomerDetails(customerId, merchantId);

    // Get offer progress from modern service (source of truth)
    const profile = await getCustomerOfferProgress({
        squareCustomerId: customerId,
        merchantId
    });

    res.json({
        customer: customerDetails,
        offers: profile.offers
    });
}));

/**
 * GET /api/loyalty/customer/:customerId/history
 * Get full loyalty history for a customer
 */
router.get('/customer/:customerId/history', requireAuth, requireMerchant, validators.getCustomerHistory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { limit, offerId } = req.query;

    const history = await loyaltyService.getCustomerLoyaltyHistory(
        req.params.customerId,
        merchantId,
        { limit: parseInt(limit) || 50, offerId }
    );

    res.json(history);
}));

/**
 * GET /api/loyalty/customer/:customerId/rewards
 * Get earned (available) rewards for a customer
 */
router.get('/customer/:customerId/rewards', requireAuth, requireMerchant, validators.getCustomer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const rewards = await loyaltyService.getCustomerEarnedRewards(req.params.customerId, merchantId);
    res.json({ rewards });
}));

/**
 * GET /api/loyalty/customer/:customerId/audit-history
 * Get order history for manual loyalty audit (up to 18 months)
 * Supports chunked loading (startMonthsAgo/endMonthsAgo) or legacy days param
 * Returns orders with qualifying/non-qualifying items analysis
 */
router.get('/customer/:customerId/audit-history', requireAuth, requireMerchant, validators.getCustomerAuditHistory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const customerId = req.params.customerId;

    // Support chunked loading (startMonthsAgo/endMonthsAgo) or legacy days param
    const startMonthsAgo = req.query.startMonthsAgo !== undefined ? parseInt(req.query.startMonthsAgo) : null;
    const endMonthsAgo = req.query.endMonthsAgo !== undefined ? parseInt(req.query.endMonthsAgo) : null;

    // Use chunked params if both provided, otherwise fall back to legacy days param
    if (startMonthsAgo !== null && endMonthsAgo !== null) {
        const result = await loyaltyService.getCustomerOrderHistoryForAudit({
            squareCustomerId: customerId,
            merchantId,
            startMonthsAgo,
            endMonthsAgo
        });
        res.json(result);
    } else {
        // Backward compat: convert days to periodDays
        const days = parseInt(req.query.days) || 91;
        const result = await loyaltyService.getCustomerOrderHistoryForAudit({
            squareCustomerId: customerId,
            merchantId,
            periodDays: days
        });
        res.json(result);
    }
}));

/**
 * POST /api/loyalty/customer/:customerId/add-orders
 * Add selected orders to loyalty tracking (manual backfill for specific customer)
 */
router.post('/customer/:customerId/add-orders', requireAuth, requireMerchant, requireWriteAccess, validators.addOrders, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const customerId = req.params.customerId;
    const { orderIds } = req.body;

    const result = await loyaltyService.addOrdersToLoyaltyTracking({
        squareCustomerId: customerId,
        merchantId,
        orderIds
    });

    res.json({
        success: true,
        ...result
    });
}));

/**
 * GET /api/loyalty/customers/search
 * Search customers by phone number, email, or name
 * First checks local cache, then Square API if needed
 */
router.get('/customers/search', requireAuth, requireMerchant, validators.searchCustomers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const query = req.query.q?.trim();

    // Normalize phone number - remove spaces, dashes, parentheses
    const normalizedQuery = query.replace(/[\s\-\(\)\.]/g, '');
    const isPhoneSearch = /^\+?\d{7,}$/.test(normalizedQuery);
    const isEmailSearch = query.includes('@');

    // First, search local cache for loyalty customers
    const cachedCustomers = await loyaltyService.searchCachedCustomers(query, merchantId);

    // If we found exact matches in cache (especially for phone), return them
    if (cachedCustomers.length > 0 && isPhoneSearch) {
        logger.debug('Returning cached customer results', { query, count: cachedCustomers.length });
        return res.json({
            query,
            searchType: 'phone',
            customers: cachedCustomers,
            source: 'cache'
        });
    }

    // Search Square API for more results
    const tokenResult = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );
    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
        // No Square token - return cached results only
        if (cachedCustomers.length > 0) {
            return res.json({
                query,
                searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
                customers: cachedCustomers,
                source: 'cache'
            });
        }
        return res.status(400).json({ error: 'No Square access token configured' });
    }
    const rawToken = tokenResult.rows[0].square_access_token;
    const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

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
            return res.json({
                query,
                searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
                customers: cachedCustomers,
                source: 'cache'
            });
        }
        return res.status(response.status).json({ error: 'Square API error' });
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
        loyaltyService.cacheCustomerDetails(customer, merchantId).catch(err => {
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

    res.json({
        query,
        searchType: isPhoneSearch ? 'phone' : (isEmailSearch ? 'email' : 'name'),
        customers: mergedCustomers,
        source: 'merged'
    });
}));

module.exports = router;
