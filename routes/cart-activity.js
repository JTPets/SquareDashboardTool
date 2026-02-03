/**
 * Cart Activity Routes
 *
 * Handles cart activity tracking for DRAFT orders from Square Online.
 * Provides read-only access to abandoned cart data and conversion statistics.
 *
 * SECURITY CONSIDERATIONS:
 * - All endpoints require authentication
 * - All endpoints require merchant context (multi-tenant isolation)
 * - Read-only operations (no write endpoints exposed)
 *
 * Endpoints:
 * - GET /api/cart-activity       - List cart activity records
 * - GET /api/cart-activity/stats - Get cart activity statistics
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const cartActivityService = require('../services/cart/cart-activity-service');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/cart-activity');

/**
 * GET /api/cart-activity
 * List cart activity records with optional filters
 *
 * Query params:
 * - status: pending | converted | abandoned | canceled
 * - startDate: ISO date string
 * - endDate: ISO date string
 * - limit: number (default 50, max 200)
 * - offset: number (default 0)
 */
router.get('/',
    requireAuth,
    requireMerchant,
    validators.list,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const {
            status,
            startDate,
            endDate,
            limit = 50,
            offset = 0
        } = req.query;

        const result = await cartActivityService.getList(merchantId, {
            status,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            limit: Math.min(parseInt(limit, 10) || 50, 200),
            offset: parseInt(offset, 10) || 0
        });

        res.json({
            carts: result.carts,
            total: result.total,
            limit: parseInt(limit, 10) || 50,
            offset: parseInt(offset, 10) || 0
        });
    })
);

/**
 * GET /api/cart-activity/stats
 * Get cart activity statistics
 *
 * Query params:
 * - days: number of days to look back (default 7)
 */
router.get('/stats',
    requireAuth,
    requireMerchant,
    validators.stats,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const days = parseInt(req.query.days, 10) || 7;

        const stats = await cartActivityService.getStats(merchantId, days);

        res.json(stats);
    })
);

module.exports = router;
