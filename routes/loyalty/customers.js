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
 */

const express = require('express');
const router = express.Router();
const loyaltyService = require('../../utils/loyalty-service');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const validators = require('../../middleware/validators/loyalty');
const { getCustomerOfferProgress, searchCustomers } = require('../../services/loyalty-admin');

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

    const result = await searchCustomers(query, merchantId);
    res.json(result);
}));

module.exports = router;
