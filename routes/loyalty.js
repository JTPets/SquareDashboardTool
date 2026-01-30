/**
 * Loyalty Routes
 *
 * Handles the Frequent Buyer Program (loyalty addon):
 * - Loyalty offer management (CRUD)
 * - Qualifying variation assignments
 * - Customer loyalty status and history
 * - Reward tracking and redemption
 * - Square Loyalty integration
 * - Backfill and catchup operations
 * - Loyalty reports and exports
 *
 * BUSINESS RULES:
 * - One offer = one brand + size group (never mix sizes)
 * - Full redemption only (one reward = one free unit)
 * - Rolling window periods (configurable months)
 * - Only explicitly added variations qualify for offers
 *
 * SECURITY CONSIDERATIONS:
 * - All operations require authentication
 * - All operations are merchant-scoped (multi-tenant isolation)
 * - Write operations require write access role
 * - Financial calculations handled by loyaltyService
 *
 * Endpoints: 41 total
 * - Offers: GET, POST, GET/:id, PATCH/:id, DELETE/:id
 * - Variations: POST/:id/variations, GET/:id/variations, DELETE/:offerId/variations/:variationId
 * - Assignments: GET /variations/assignments
 * - Customer: GET/:customerId, GET/:customerId/history, GET/:customerId/rewards
 * - Customer Audit: GET/:customerId/audit-history, POST/:customerId/add-orders
 * - Rewards: GET, POST/:rewardId/redeem
 * - Redemptions: GET
 * - Audit: GET
 * - Stats: GET
 * - Square Integration: GET /square-program, PUT/:id/square-tier, POST/:id/create-square-reward
 * - Sync: POST /rewards/sync-to-pos, GET /rewards/pending-sync
 * - Search: GET /customers/search
 * - Processing: POST /process-order/:orderId, POST /backfill, POST /catchup, POST /manual-entry
 * - Expiration: POST /process-expired
 * - Discounts: GET /discounts/validate, POST /discounts/validate-and-fix
 * - Settings: GET, PUT
 * - Reports: GET /reports/vendor-receipt/:id, GET /reports/redemptions/csv, etc.
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const loyaltyService = require('../utils/loyalty-service');
const loyaltyReports = require('../utils/loyalty-reports');
const { encryptToken, decryptToken, isEncryptedToken } = require('../utils/token-encryption');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/loyalty');

// ==================== OFFER MANAGEMENT ====================

/**
 * GET /api/loyalty/offers
 * List all loyalty offers for the merchant
 */
router.get('/offers', requireAuth, requireMerchant, validators.listOffers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { activeOnly, brandName } = req.query;

    const offers = await loyaltyService.getOffers(merchantId, {
        activeOnly: activeOnly === 'true',
        brandName
    });

    res.json({ offers });
}));

/**
 * POST /api/loyalty/offers
 * Create a new loyalty offer (frequent buyer program)
 * Requires admin role
 */
router.post('/offers', requireAuth, requireMerchant, requireWriteAccess, validators.createOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerName, brandName, sizeGroup, requiredQuantity, windowMonths, description, vendorId } = req.body;

    const offer = await loyaltyService.createOffer({
        merchantId,
        offerName,
        brandName,
        sizeGroup,
        requiredQuantity: parseInt(requiredQuantity),
        windowMonths: windowMonths ? parseInt(windowMonths) : 12,
        description,
        vendorId: vendorId || null,
        createdBy: req.session.user.id
    });

    logger.info('Created loyalty offer', {
        offerId: offer.id,
        brandName,
        sizeGroup,
        merchantId
    });

    res.status(201).json({ offer });
}));

/**
 * GET /api/loyalty/offers/:id
 * Get a single loyalty offer with details
 */
router.get('/offers/:id', requireAuth, requireMerchant, validators.getOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const offer = await loyaltyService.getOfferById(req.params.id, merchantId);

    if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
    }

    // Get qualifying variations
    const variations = await loyaltyService.getQualifyingVariations(req.params.id, merchantId);

    res.json({ offer, variations });
}));

/**
 * PATCH /api/loyalty/offers/:id
 * Update a loyalty offer
 * Note: requiredQuantity cannot be changed to preserve integrity
 */
router.patch('/offers/:id', requireAuth, requireMerchant, requireWriteAccess, validators.updateOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offer_name, description, is_active, window_months, vendor_id, size_group } = req.body;

    const updates = {};
    if (offer_name !== undefined) updates.offer_name = offer_name;
    if (description !== undefined) updates.description = description;
    if (is_active !== undefined) updates.is_active = is_active;
    if (window_months !== undefined && window_months > 0) updates.window_months = parseInt(window_months);
    if (vendor_id !== undefined) updates.vendor_id = vendor_id || null;
    if (size_group !== undefined && size_group.trim()) updates.size_group = size_group.trim();

    const offer = await loyaltyService.updateOffer(
        req.params.id,
        updates,
        merchantId,
        req.session.user.id
    );

    res.json({ offer });
}));

/**
 * DELETE /api/loyalty/offers/:id
 * Delete a loyalty offer (discontinued by vendor)
 * Note: Historical rewards/redemptions are preserved for audit
 */
router.delete('/offers/:id', requireAuth, requireMerchant, requireWriteAccess, validators.deleteOffer, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await loyaltyService.deleteOffer(
        req.params.id,
        merchantId,
        req.session.user.id
    );

    logger.info('Deleted loyalty offer', {
        offerId: req.params.id,
        offerName: result.offerName,
        hadActiveRewards: result.hadActiveRewards,
        merchantId
    });

    res.json(result);
}));

// ==================== VARIATION MANAGEMENT ====================

/**
 * POST /api/loyalty/offers/:id/variations
 * Add qualifying variations to an offer
 * IMPORTANT: Only explicitly added variations qualify for the offer
 */
router.post('/offers/:id/variations', requireAuth, requireMerchant, requireWriteAccess, validators.addVariations, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { variations } = req.body;

    const added = await loyaltyService.addQualifyingVariations(
        req.params.id,
        variations,
        merchantId,
        req.session.user.id
    );

    logger.info('Added qualifying variations to offer', {
        offerId: req.params.id,
        addedCount: added.length,
        merchantId
    });

    res.json({ added });
}));

/**
 * GET /api/loyalty/offers/:id/variations
 * Get qualifying variations for an offer
 */
router.get('/offers/:id/variations', requireAuth, requireMerchant, validators.getOfferVariations, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const variations = await loyaltyService.getQualifyingVariations(req.params.id, merchantId);
    res.json({ variations });
}));

/**
 * GET /api/loyalty/variations/assignments
 * Get all variation assignments across all offers for this merchant
 * Used by UI to show which variations are already assigned to offers
 */
router.get('/variations/assignments', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await db.query(`
        SELECT qv.variation_id, qv.item_name, qv.variation_name,
               o.id as offer_id, o.offer_name, o.brand_name, o.size_group
        FROM loyalty_qualifying_variations qv
        JOIN loyalty_offers o ON qv.offer_id = o.id
        WHERE qv.merchant_id = $1
          AND qv.is_active = TRUE
          AND o.is_active = TRUE
        ORDER BY o.offer_name, qv.item_name
    `, [merchantId]);

    // Return as a map for easy lookup by variation_id
    const assignments = {};
    for (const row of result.rows) {
        assignments[row.variation_id] = {
            offerId: row.offer_id,
            offerName: row.offer_name,
            brandName: row.brand_name,
            sizeGroup: row.size_group
        };
    }

    res.json({ assignments });
}));

/**
 * DELETE /api/loyalty/offers/:offerId/variations/:variationId
 * Remove a qualifying variation from an offer
 */
router.delete('/offers/:offerId/variations/:variationId', requireAuth, requireMerchant, requireWriteAccess, validators.removeVariation, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, variationId } = req.params;

    const result = await db.query(`
        UPDATE loyalty_qualifying_variations
        SET is_active = FALSE, updated_at = NOW()
        WHERE offer_id = $1 AND variation_id = $2 AND merchant_id = $3
        RETURNING *
    `, [offerId, variationId, merchantId]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Variation not found in offer' });
    }

    await loyaltyService.logAuditEvent({
        merchantId,
        action: 'VARIATION_REMOVED',
        offerId,
        triggeredBy: 'ADMIN',
        userId: req.session.user.id,
        details: { variationId }
    });

    res.json({ success: true });
}));

// ==================== CUSTOMER LOYALTY ====================

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
 * Get 91-day order history for manual loyalty audit
 * Returns orders with qualifying/non-qualifying items analysis
 */
router.get('/customer/:customerId/audit-history', requireAuth, requireMerchant, validators.getCustomerAuditHistory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const customerId = req.params.customerId;
    const days = parseInt(req.query.days) || 91;

    const result = await loyaltyService.getCustomerOrderHistoryForAudit({
        squareCustomerId: customerId,
        merchantId,
        periodDays: days
    });

    res.json(result);
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

// ==================== REWARDS MANAGEMENT ====================

/**
 * POST /api/loyalty/rewards/:rewardId/redeem
 * Redeem a loyalty reward
 * BUSINESS RULE: Full redemption only - one reward = one free unit
 */
router.post('/rewards/:rewardId/redeem', requireAuth, requireMerchant, requireWriteAccess, validators.redeemReward, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { squareOrderId, redeemedVariationId, redeemedValueCents, adminNotes } = req.body;

    const result = await loyaltyService.redeemReward({
        merchantId,
        rewardId: req.params.rewardId,
        squareOrderId,
        redemptionType: req.body.redemptionType || 'manual_admin',
        redeemedVariationId,
        redeemedValueCents: redeemedValueCents ? parseInt(redeemedValueCents) : null,
        redeemedByUserId: req.session.user.id,
        adminNotes
    });

    logger.info('Loyalty reward redeemed', {
        rewardId: req.params.rewardId,
        redemptionId: result.redemption.id,
        merchantId
    });

    res.json(result);
}));

/**
 * GET /api/loyalty/rewards
 * Get rewards with filtering (earned, redeemed, etc.)
 */
router.get('/rewards', requireAuth, requireMerchant, validators.listRewards, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { status, offerId, customerId, limit, offset } = req.query;

    let query = `
        SELECT r.*, o.offer_name, o.brand_name, o.size_group,
               lc.phone_number as customer_phone, lc.display_name as customer_name
        FROM loyalty_rewards r
        JOIN loyalty_offers o ON r.offer_id = o.id
        LEFT JOIN loyalty_customers lc ON r.square_customer_id = lc.square_customer_id AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
    `;
    const params = [merchantId];

    if (status) {
        params.push(status);
        query += ` AND r.status = $${params.length}`;
    }

    if (offerId) {
        params.push(offerId);
        query += ` AND r.offer_id = $${params.length}`;
    }

    if (customerId) {
        params.push(customerId);
        query += ` AND r.square_customer_id = $${params.length}`;
    }

    query += ` ORDER BY r.created_at DESC`;

    params.push(parseInt(limit) || 100);
    query += ` LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);

    res.json({ rewards: result.rows });
}));

/**
 * GET /api/loyalty/redemptions
 * Get redemption history with filtering
 */
router.get('/redemptions', requireAuth, requireMerchant, validators.listRedemptions, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, customerId, startDate, endDate, limit, offset } = req.query;

    let query = `
        SELECT rd.*, o.offer_name, o.brand_name, o.size_group,
               lc.phone_number as customer_phone, lc.display_name as customer_name
        FROM loyalty_redemptions rd
        JOIN loyalty_offers o ON rd.offer_id = o.id
        LEFT JOIN loyalty_customers lc ON rd.square_customer_id = lc.square_customer_id AND rd.merchant_id = lc.merchant_id
        WHERE rd.merchant_id = $1
    `;
    const params = [merchantId];

    if (offerId) {
        params.push(offerId);
        query += ` AND rd.offer_id = $${params.length}`;
    }

    if (customerId) {
        params.push(customerId);
        query += ` AND rd.square_customer_id = $${params.length}`;
    }

    if (startDate) {
        params.push(startDate);
        query += ` AND rd.redeemed_at >= $${params.length}`;
    }

    if (endDate) {
        params.push(endDate);
        query += ` AND rd.redeemed_at <= $${params.length}`;
    }

    query += ` ORDER BY rd.redeemed_at DESC`;

    params.push(parseInt(limit) || 100);
    query += ` LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);

    res.json({ redemptions: result.rows });
}));

// ==================== AUDIT & STATS ====================

/**
 * GET /api/loyalty/audit
 * Get loyalty audit log entries
 */
router.get('/audit', requireAuth, requireMerchant, validators.listAudit, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { action, squareCustomerId, offerId, limit, offset } = req.query;

    const entries = await loyaltyService.getAuditLogs(merchantId, {
        action,
        squareCustomerId,
        offerId,
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });

    res.json({ entries });
}));

/**
 * GET /api/loyalty/stats
 * Get loyalty program statistics for dashboard
 */
router.get('/stats', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Get offer counts
    const offerStats = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE is_active = TRUE) as active_offers,
            COUNT(*) as total_offers
        FROM loyalty_offers
        WHERE merchant_id = $1
    `, [merchantId]);

    // Get reward counts by status
    const rewardStats = await db.query(`
        SELECT status, COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
        GROUP BY status
    `, [merchantId]);

    // Get recent activity
    const recentEarned = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status IN ('earned', 'redeemed')
          AND earned_at >= NOW() - INTERVAL '30 days'
    `, [merchantId]);

    const recentRedeemed = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_redemptions
        WHERE merchant_id = $1
          AND redeemed_at >= NOW() - INTERVAL '30 days'
    `, [merchantId]);

    // Get total redemption value
    const totalValue = await db.query(`
        SELECT COALESCE(SUM(redeemed_value_cents), 0) as total_cents
        FROM loyalty_redemptions
        WHERE merchant_id = $1
    `, [merchantId]);

    res.json({
        stats: {
            offers: {
                active: parseInt(offerStats.rows[0]?.active_offers || 0),
                total: parseInt(offerStats.rows[0]?.total_offers || 0)
            },
            rewards: rewardStats.rows.reduce((acc, row) => {
                acc[row.status] = parseInt(row.count);
                return acc;
            }, {}),
            last30Days: {
                earned: parseInt(recentEarned.rows[0]?.count || 0),
                redeemed: parseInt(recentRedeemed.rows[0]?.count || 0)
            },
            totalRedemptionValueCents: parseInt(totalValue.rows[0]?.total_cents || 0)
        }
    });
}));

// ==================== SQUARE LOYALTY INTEGRATION ====================

/**
 * GET /api/loyalty/square-program
 * Get the merchant's Square Loyalty program and available reward tiers
 */
router.get('/square-program', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const program = await loyaltyService.getSquareLoyaltyProgram(merchantId);

    if (!program) {
        return res.json({
            hasProgram: false,
            message: 'No Square Loyalty program found. Set up Square Loyalty in your Square Dashboard first.',
            setupUrl: 'https://squareup.com/dashboard/loyalty'
        });
    }

    // Extract reward tiers for configuration UI
    const rewardTiers = (program.reward_tiers || []).map(tier => ({
        id: tier.id,
        name: tier.name,
        points: tier.points,
        definition: tier.definition
    }));

    res.json({
        hasProgram: true,
        programId: program.id,
        programName: program.terminology?.one || 'Loyalty',
        rewardTiers
    });
}));

/**
 * PUT /api/loyalty/offers/:id/square-tier
 * Link an offer to a Square Loyalty reward tier
 */
router.put('/offers/:id/square-tier', requireAuth, requireMerchant, requireWriteAccess, validators.linkSquareTier, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const offerId = req.params.id;
    const { squareRewardTierId } = req.body;

    // Update the offer with the Square reward tier ID
    const result = await db.query(
        `UPDATE loyalty_offers
         SET square_reward_tier_id = $1, updated_at = NOW()
         WHERE id = $2 AND merchant_id = $3
         RETURNING id, offer_name, square_reward_tier_id`,
        [squareRewardTierId || null, offerId, merchantId]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Offer not found' });
    }

    logger.info('Linked offer to Square Loyalty tier', {
        merchantId,
        offerId,
        squareRewardTierId
    });

    res.json({
        success: true,
        offer: result.rows[0]
    });
}));

/**
 * POST /api/loyalty/rewards/:id/create-square-reward
 * Manually create a Square Customer Group Discount for an earned reward
 * This makes the reward auto-apply at Square POS when customer is identified
 *
 * Query params:
 *   force=true - Delete existing discount and recreate (for fixing broken discounts)
 */
router.post('/rewards/:id/create-square-reward', requireAuth, requireMerchant, requireWriteAccess, validators.createSquareReward, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const rewardId = req.params.id;
    const force = req.query.force === 'true' || req.body.force === true;

    // Get the reward details
    const rewardResult = await db.query(
        `SELECT r.*, o.offer_name
         FROM loyalty_rewards r
         JOIN loyalty_offers o ON r.offer_id = o.id
         WHERE r.id = $1 AND r.merchant_id = $2`,
        [rewardId, merchantId]
    );

    if (rewardResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reward not found' });
    }

    const reward = rewardResult.rows[0];

    if (reward.status !== 'earned') {
        return res.status(400).json({ error: 'Reward must be in "earned" status to sync to POS' });
    }

    // Check if already synced (has Customer Group Discount created)
    if (reward.square_group_id && reward.square_discount_id) {
        if (!force) {
            return res.json({
                success: true,
                message: 'Already synced to Square POS',
                groupId: reward.square_group_id,
                discountId: reward.square_discount_id
            });
        }

        // Force mode: cleanup existing discount first
        logger.info('Force re-sync: cleaning up existing Square discount', {
            rewardId,
            merchantId,
            existingGroupId: reward.square_group_id
        });

        await loyaltyService.cleanupSquareCustomerGroupDiscount({
            merchantId,
            squareCustomerId: reward.square_customer_id,
            internalRewardId: rewardId
        });
    }

    // Create the Square Customer Group Discount
    const result = await loyaltyService.createSquareCustomerGroupDiscount({
        merchantId,
        squareCustomerId: reward.square_customer_id,
        internalRewardId: rewardId,
        offerId: reward.offer_id
    });

    res.json(result);
}));

/**
 * POST /api/loyalty/rewards/sync-to-pos
 * Bulk sync earned rewards to Square POS
 * Creates Customer Group Discounts for earned rewards
 *
 * Query/Body params:
 *   force=true - Re-sync ALL earned rewards (delete and recreate discounts)
 */
router.post('/rewards/sync-to-pos', requireAuth, requireMerchant, requireWriteAccess, validators.syncToPOS, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const force = req.query.force === 'true' || req.body.force === true;

    // Find earned rewards to sync
    // If force=true, get ALL earned rewards; otherwise only those not yet synced
    let query;
    if (force) {
        query = `
            SELECT r.id, r.square_customer_id, r.offer_id, o.offer_name,
                   r.square_group_id, r.square_discount_id
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.merchant_id = $1
              AND r.status = 'earned'
        `;
    } else {
        query = `
            SELECT r.id, r.square_customer_id, r.offer_id, o.offer_name,
                   r.square_group_id, r.square_discount_id
            FROM loyalty_rewards r
            JOIN loyalty_offers o ON r.offer_id = o.id
            WHERE r.merchant_id = $1
              AND r.status = 'earned'
              AND (r.square_group_id IS NULL OR r.square_discount_id IS NULL)
        `;
    }

    const pendingResult = await db.query(query, [merchantId]);
    const pending = pendingResult.rows;

    if (pending.length === 0) {
        return res.json({
            success: true,
            message: force ? 'No earned rewards to re-sync' : 'All earned rewards are already synced to POS',
            synced: 0
        });
    }

    logger.info('Syncing earned rewards to Square POS', {
        merchantId,
        pendingCount: pending.length,
        force
    });

    const results = [];
    for (const reward of pending) {
        try {
            // If force mode and reward has existing Square objects, clean them up first
            if (force && reward.square_group_id) {
                await loyaltyService.cleanupSquareCustomerGroupDiscount({
                    merchantId,
                    squareCustomerId: reward.square_customer_id,
                    internalRewardId: reward.id
                });
            }

            const result = await loyaltyService.createSquareCustomerGroupDiscount({
                merchantId,
                squareCustomerId: reward.square_customer_id,
                internalRewardId: reward.id,
                offerId: reward.offer_id
            });

            results.push({
                rewardId: reward.id,
                offerName: reward.offer_name,
                success: result.success,
                error: result.error || null
            });
        } catch (err) {
            results.push({
                rewardId: reward.id,
                offerName: reward.offer_name,
                success: false,
                error: err.message
            });
        }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info('Finished syncing rewards to POS', {
        merchantId,
        total: pending.length,
        success: successCount,
        force
    });

    res.json({
        success: true,
        message: `Synced ${successCount} of ${pending.length} rewards to Square POS`,
        synced: successCount,
        total: pending.length,
        results
    });
}));

/**
 * GET /api/loyalty/rewards/pending-sync
 * Get count of earned rewards - both pending sync and already synced
 */
router.get('/rewards/pending-sync', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Get count of pending (not yet synced) rewards
    const pendingResult = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND (square_group_id IS NULL OR square_discount_id IS NULL)
    `, [merchantId]);

    // Get count of synced rewards
    const syncedResult = await db.query(`
        SELECT COUNT(*) as count
        FROM loyalty_rewards
        WHERE merchant_id = $1
          AND status = 'earned'
          AND square_group_id IS NOT NULL
          AND square_discount_id IS NOT NULL
    `, [merchantId]);

    res.json({
        pendingCount: parseInt(pendingResult.rows[0].count, 10),
        syncedCount: parseInt(syncedResult.rows[0].count, 10)
    });
}));

// ==================== ORDER PROCESSING ====================

/**
 * POST /api/loyalty/process-order/:orderId
 * Manually fetch and process a specific Square order for loyalty
 * Useful for testing/debugging when webhooks aren't working
 */
router.post('/process-order/:orderId', requireAuth, requireMerchant, requireWriteAccess, validators.processOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const squareOrderId = req.params.orderId;

    logger.info('Manually processing order for loyalty', { squareOrderId, merchantId });

    // Get and decrypt access token
    const tokenResult = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );
    if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
        return res.status(400).json({ error: 'No Square access token configured for this merchant' });
    }
    const rawToken = tokenResult.rows[0].square_access_token;
    const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

    // Fetch the order from Square using raw API
    const orderResponse = await fetch(`https://connect.squareup.com/v2/orders/${squareOrderId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-18'
        }
    });

    if (!orderResponse.ok) {
        const errText = await orderResponse.text();
        const merchantId = req.merchantContext?.id;
        logger.error('Square API error in loyalty order lookup', {
            status: orderResponse.status,
            error: errText,
            merchantId,
            squareOrderId
        });
        return res.status(502).json({
            success: false,
            error: 'Unable to retrieve order details. Please try again.',
            code: 'EXTERNAL_API_ERROR'
        });
    }

    const orderData = await orderResponse.json();
    const order = orderData.order;

    if (!order) {
        return res.status(404).json({ error: 'Order not found in Square' });
    }

    // Fetch customer details if customer_id exists
    let customerDetails = null;
    if (order.customer_id) {
        customerDetails = await loyaltyService.getCustomerDetails(order.customer_id, merchantId);
    }

    // Return diagnostic info about the order
    const diagnostics = {
        orderId: order.id,
        customerId: order.customer_id || null,
        hasCustomer: !!order.customer_id,
        customerDetails,
        state: order.state,
        createdAt: order.created_at,
        lineItems: (order.line_items || []).map(li => ({
            name: li.name,
            quantity: li.quantity,
            catalogObjectId: li.catalog_object_id,
            variationName: li.variation_name
        }))
    };

    if (!order.customer_id) {
        return res.json({
            processed: false,
            reason: 'Order has no customer ID attached',
            diagnostics,
            tip: 'The sale must have a customer attached in Square POS before payment'
        });
    }

    // Process the order for loyalty (use snake_case since we're using raw API response)
    const loyaltyResult = await loyaltyService.processOrderForLoyalty(order, merchantId);

    res.json({
        processed: loyaltyResult.processed,
        result: loyaltyResult,
        diagnostics
    });
}));

/**
 * POST /api/loyalty/backfill
 * Fetch recent orders from Square and process them for loyalty
 * Useful for catching up on orders that weren't processed via webhook
 */
router.post('/backfill', requireAuth, requireMerchant, requireWriteAccess, validators.backfill, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { days = 7 } = req.body; // Default to last 7 days

        logger.info('Starting loyalty backfill', { merchantId, days });

        // Get location IDs
        const locationsResult = await db.query(
            'SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1',
            [merchantId]
        );
        const locationIds = locationsResult.rows.map(r => r.id);

        if (locationIds.length === 0) {
            return res.json({ error: 'No active locations found', processed: 0 });
        }

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        // Get and decrypt access token
        const tokenResult = await db.query(
            'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
            [merchantId]
        );
        if (tokenResult.rows.length === 0 || !tokenResult.rows[0].square_access_token) {
            return res.status(400).json({ error: 'No Square access token configured for this merchant' });
        }
        const rawToken = tokenResult.rows[0].square_access_token;
        const accessToken = isEncryptedToken(rawToken) ? decryptToken(rawToken) : rawToken;

        let cursor = null;
        let ordersProcessed = 0;
        let ordersWithCustomer = 0;
        let ordersWithQualifyingItems = 0;
        let loyaltyPurchasesRecorded = 0;
        const results = [];
        const diagnostics = { sampleOrdersWithoutCustomer: [], sampleVariationIds: [] };

        // Get qualifying variation IDs for comparison
        const qualifyingResult = await db.query(
            `SELECT DISTINCT qv.variation_id
             FROM loyalty_qualifying_variations qv
             JOIN loyalty_offers lo ON qv.offer_id = lo.id
             WHERE lo.merchant_id = $1 AND lo.is_active = TRUE`,
            [merchantId]
        );
        const qualifyingVariationIds = new Set(qualifyingResult.rows.map(r => r.variation_id));

        // Pre-fetch ALL loyalty events once at the start
        logger.info('Pre-fetching loyalty events for batch processing', { merchantId, days });
        const prefetchedLoyalty = await loyaltyService.prefetchRecentLoyaltyEvents(merchantId, days);
        logger.info('Pre-fetch complete', {
            merchantId,
            eventsFound: prefetchedLoyalty.events.length,
            accountsMapped: Object.keys(prefetchedLoyalty.loyaltyAccounts).length
        });

        let customersFoundViaPrefetch = 0;

        // Use raw Square API
        do {
            const requestBody = {
                location_ids: locationIds,
                query: {
                    filter: {
                        state_filter: {
                            states: ['COMPLETED']
                        },
                        date_time_filter: {
                            closed_at: {
                                start_at: startDate.toISOString(),
                                end_at: endDate.toISOString()
                            }
                        }
                    }
                },
                limit: 50
            };

            if (cursor) {
                requestBody.cursor = cursor;
            }

            const response = await fetch('https://connect.squareup.com/v2/orders/search', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': '2024-01-18'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Square API error: ${response.status} - ${errText}`);
            }

            const data = await response.json();
            const orders = data.orders || [];

            // Process each order for loyalty
            for (const order of orders) {
                ordersProcessed++;

                // Collect sample variation IDs from orders for diagnostics
                const orderVariationIds = (order.line_items || [])
                    .map(li => li.catalog_object_id)
                    .filter(Boolean);
                if (diagnostics.sampleVariationIds.length < 10) {
                    orderVariationIds.forEach(vid => {
                        if (!diagnostics.sampleVariationIds.includes(vid)) {
                            diagnostics.sampleVariationIds.push(vid);
                        }
                    });
                }

                // Check if order has qualifying items (for diagnostics)
                const hasQualifyingItem = orderVariationIds.some(vid => qualifyingVariationIds.has(vid));
                if (hasQualifyingItem) {
                    ordersWithQualifyingItems++;
                }

                // Track orders with direct customer_id
                if (order.customer_id) {
                    ordersWithCustomer++;
                }

                // Skip orders without qualifying items
                if (!hasQualifyingItem) {
                    continue;
                }

                try {
                    // If order has no customer_id, try to find one from prefetched loyalty data
                    let customerId = order.customer_id;
                    if (!customerId && order.tenders) {
                        for (const tender of order.tenders) {
                            if (tender.customer_id) {
                                customerId = tender.customer_id;
                                break;
                            }
                        }
                    }
                    if (!customerId) {
                        customerId = loyaltyService.findCustomerFromPrefetchedEvents(
                            order.id,
                            prefetchedLoyalty
                        );
                        if (customerId) {
                            customersFoundViaPrefetch++;
                        }
                    }

                    // Skip if still no customer after prefetch lookup
                    if (!customerId) {
                        if (diagnostics.sampleOrdersWithoutCustomer.length < 3) {
                            diagnostics.sampleOrdersWithoutCustomer.push({
                                orderId: order.id,
                                createdAt: order.created_at,
                                hasQualifyingItem
                            });
                        }
                        continue;
                    }

                    // Transform to camelCase for loyaltyService
                    const orderForLoyalty = {
                        id: order.id,
                        customer_id: customerId,
                        customerId: customerId,
                        state: order.state,
                        created_at: order.created_at,
                        location_id: order.location_id,
                        line_items: order.line_items,
                        lineItems: (order.line_items || []).map(li => ({
                            ...li,
                            catalogObjectId: li.catalog_object_id,
                            quantity: li.quantity,
                            name: li.name
                        }))
                    };

                    const loyaltyResult = await loyaltyService.processOrderForLoyalty(orderForLoyalty, merchantId);
                    if (loyaltyResult.processed && loyaltyResult.purchasesRecorded.length > 0) {
                        loyaltyPurchasesRecorded += loyaltyResult.purchasesRecorded.length;
                        results.push({
                            orderId: order.id,
                            customerId: loyaltyResult.customerId,
                            customerSource: order.customer_id ? 'order' : 'loyalty_prefetch',
                            purchasesRecorded: loyaltyResult.purchasesRecorded.length
                        });
                    }
                } catch (err) {
                    logger.warn('Failed to process order for loyalty during backfill', {
                        orderId: order.id,
                        error: err.message
                    });
                }
            }

            cursor = data.cursor;
        } while (cursor);

        logger.info('Loyalty backfill complete', {
            merchantId,
            days,
            ordersProcessed,
            ordersWithQualifyingItems,
            customersFoundViaPrefetch,
            loyaltyPurchasesRecorded
        });

        res.json({
            success: true,
            ordersProcessed,
            ordersWithCustomer,
            ordersWithQualifyingItems,
            customersFoundViaPrefetch,
            loyaltyPurchasesRecorded,
            results,
            diagnostics: {
                qualifyingVariationIdsConfigured: Array.from(qualifyingVariationIds),
                sampleVariationIdsInOrders: diagnostics.sampleVariationIds,
                sampleOrdersWithoutCustomer: diagnostics.sampleOrdersWithoutCustomer,
                prefetchedLoyaltyEvents: prefetchedLoyalty.events.length,
                prefetchedLoyaltyAccounts: Object.keys(prefetchedLoyalty.loyaltyAccounts).length
            }
        });
}));

/**
 * POST /api/loyalty/catchup
 * Run "reverse lookup" loyalty catchup for known customers
 */
router.post('/catchup', requireAuth, requireMerchant, requireWriteAccess, validators.catchup, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { days = 30, customerIds = null, maxCustomers = 100 } = req.body;

    logger.info('Starting loyalty catchup via API', { merchantId, days, maxCustomers });

    const result = await loyaltyService.runLoyaltyCatchup({
        merchantId,
        customerIds,
        periodDays: days,
        maxCustomers
    });

    res.json({
        success: true,
        ...result
    });
}));

/**
 * POST /api/loyalty/refresh-customers
 * Refresh customer details for rewards with missing phone numbers
 * Fetches customer data from Square and updates the cache
 */
router.post('/refresh-customers', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Find all unique customer IDs with rewards but no phone in cache
    const missingResult = await db.query(`
        SELECT DISTINCT r.square_customer_id
        FROM loyalty_rewards r
        LEFT JOIN loyalty_customers lc
            ON r.square_customer_id = lc.square_customer_id
            AND r.merchant_id = lc.merchant_id
        WHERE r.merchant_id = $1
          AND (lc.phone_number IS NULL OR lc.square_customer_id IS NULL)
    `, [merchantId]);

    const customerIds = missingResult.rows.map(r => r.square_customer_id);

    if (customerIds.length === 0) {
        return res.json({ success: true, message: 'No customers with missing phone data', refreshed: 0 });
    }

    logger.info('Refreshing customer data for rewards', { merchantId, count: customerIds.length });

    let refreshed = 0;
    let failed = 0;
    const errors = [];

    // Fetch each customer from Square and cache (with throttling)
    for (const customerId of customerIds) {
        try {
            const customer = await loyaltyService.getCustomerDetails(customerId, merchantId);
            if (customer) {
                refreshed++;
                logger.debug('Refreshed customer', { customerId, phone: customer.phone ? 'yes' : 'no' });
            } else {
                failed++;
                errors.push({ customerId, error: 'Customer not found in Square' });
            }
        } catch (err) {
            failed++;
            errors.push({ customerId, error: err.message });
        }

        // Throttle to avoid rate limiting (100ms between requests)
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('Customer refresh complete', { merchantId, refreshed, failed });

    res.json({
        success: true,
        total: customerIds.length,
        refreshed,
        failed,
        errors: errors.length > 0 ? errors : undefined
    });
}));

/**
 * POST /api/loyalty/manual-entry
 * Manually record a loyalty purchase for orders where customer wasn't attached
 */
router.post('/manual-entry', requireAuth, requireMerchant, requireWriteAccess, validators.manualEntry, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { squareOrderId, squareCustomerId, variationId, quantity, purchasedAt } = req.body;

    const qty = parseInt(quantity) || 1;

    logger.info('Manual loyalty entry', {
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty
    });

    // Process the purchase using the loyalty service
    const result = await loyaltyService.processQualifyingPurchase({
        merchantId,
        squareOrderId,
        squareCustomerId,
        variationId,
        quantity: qty,
        unitPriceCents: 0,  // Unknown for manual entry
        purchasedAt: purchasedAt || new Date(),
        squareLocationId: null,
        customerSource: 'manual'
    });

    if (!result.processed) {
        return res.status(400).json({
            success: false,
            reason: result.reason,
            message: result.reason === 'variation_not_qualifying'
                ? 'This variation is not configured as a qualifying item for any loyalty offer'
                : result.reason === 'already_processed'
                ? 'This purchase has already been recorded'
                : 'Could not process this purchase'
        });
    }

    res.json({
        success: true,
        purchaseEvent: result.purchaseEvent,
        reward: result.reward,
        message: `Recorded ${qty} purchase(s). Progress: ${result.reward.currentQuantity}/${result.reward.requiredQuantity}`
    });
}));

/**
 * POST /api/loyalty/process-expired
 * Process expired window entries (run periodically or on-demand)
 */
router.post('/process-expired', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Process expired window entries (purchases that aged out)
    const windowResult = await loyaltyService.processExpiredWindowEntries(merchantId);

    // Also process expired earned rewards
    const earnedResult = await loyaltyService.processExpiredEarnedRewards(merchantId);

    logger.info('Processed expired loyalty entries', {
        merchantId,
        windowEntriesProcessed: windowResult.processedCount,
        earnedRewardsRevoked: earnedResult.processedCount
    });

    res.json({
        windowEntries: windowResult,
        expiredEarnedRewards: earnedResult
    });
}));

// ==================== DISCOUNT VALIDATION ====================

/**
 * GET /api/loyalty/discounts/validate
 * Validate earned rewards discounts against Square
 */
router.get('/discounts/validate', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await loyaltyService.validateEarnedRewardsDiscounts({
        merchantId,
        fixIssues: false
    });

    res.json(result);
}));

/**
 * POST /api/loyalty/discounts/validate-and-fix
 * Validate earned rewards discounts and fix any issues found
 */
router.post('/discounts/validate-and-fix', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await loyaltyService.validateEarnedRewardsDiscounts({
        merchantId,
        fixIssues: true
    });

    logger.info('Validated and fixed discount issues', {
        merchantId,
        totalEarned: result.totalEarned,
        validated: result.validated,
        issues: result.issues.length,
        fixed: result.fixed.length
    });

    res.json(result);
}));

// ==================== SETTINGS ====================

/**
 * GET /api/loyalty/settings
 * Get loyalty settings for the merchant
 */
router.get('/settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    // Ensure default settings exist
    await loyaltyService.initializeDefaultSettings(merchantId);

    const result = await db.query(`
        SELECT setting_key, setting_value, description
        FROM loyalty_settings
        WHERE merchant_id = $1
    `, [merchantId]);

    const settings = result.rows.reduce((acc, row) => {
        acc[row.setting_key] = row.setting_value;
        return acc;
    }, {});

    res.json({ settings });
}));

/**
 * PUT /api/loyalty/settings
 * Update loyalty settings
 */
router.put('/settings', requireAuth, requireMerchant, requireWriteAccess, validators.updateSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const updates = req.body;

    for (const [key, value] of Object.entries(updates)) {
        await loyaltyService.updateSetting(key, String(value), merchantId);
    }

    logger.info('Updated loyalty settings', { merchantId, keys: Object.keys(updates) });

    res.json({ success: true });
}));

// ==================== REPORTS ====================

/**
 * GET /api/loyalty/reports/vendor-receipt/:redemptionId
 * Generate vendor receipt for a specific redemption (HTML/PDF)
 */
router.get('/reports/vendor-receipt/:redemptionId', requireAuth, requireMerchant, validators.getVendorReceipt, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { format = 'html' } = req.query;

    const receipt = await loyaltyReports.generateVendorReceipt(req.params.redemptionId, merchantId);

    if (format === 'html') {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `inline; filename="${receipt.filename}"`);
        return res.send(receipt.html);
    }

    // Return data for client-side PDF generation or other processing
    res.json({
        html: receipt.html,
        data: receipt.data,
        filename: receipt.filename
    });
}));

/**
 * GET /api/loyalty/reports/redemptions/csv
 * Export redemptions as CSV
 */
router.get('/reports/redemptions/csv', requireAuth, requireMerchant, validators.exportRedemptionsCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate, offerId, brandName } = req.query;

    const result = await loyaltyReports.generateRedemptionsCSV(merchantId, {
        startDate,
        endDate,
        offerId,
        brandName
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/audit/csv
 * Export detailed audit log as CSV
 */
router.get('/reports/audit/csv', requireAuth, requireMerchant, validators.exportAuditCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate, offerId, squareCustomerId } = req.query;

    const result = await loyaltyReports.generateAuditCSV(merchantId, {
        startDate,
        endDate,
        offerId,
        squareCustomerId
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/summary/csv
 * Export summary by brand/offer as CSV
 */
router.get('/reports/summary/csv', requireAuth, requireMerchant, validators.exportSummaryCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { startDate, endDate } = req.query;

    const result = await loyaltyReports.generateSummaryCSV(merchantId, {
        startDate,
        endDate
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/customers/csv
 * Export customer activity as CSV
 */
router.get('/reports/customers/csv', requireAuth, requireMerchant, validators.exportCustomersCSV, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { offerId, minPurchases } = req.query;

    const result = await loyaltyReports.generateCustomerActivityCSV(merchantId, {
        offerId,
        minPurchases: minPurchases ? parseInt(minPurchases) : 1
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.csv);
}));

/**
 * GET /api/loyalty/reports/redemption/:redemptionId
 * Get full redemption details with all contributing transactions
 */
router.get('/reports/redemption/:redemptionId', requireAuth, requireMerchant, validators.getRedemptionDetails, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const details = await loyaltyReports.getRedemptionDetails(req.params.redemptionId, merchantId);

    if (!details) {
        return res.status(404).json({ error: 'Redemption not found' });
    }

    res.json({ redemption: details });
}));

module.exports = router;
