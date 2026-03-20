/**
 * Analytics Routes
 *
 * Handles sales velocity and reorder suggestions:
 * - Sales velocity data retrieval
 * - Reorder suggestions based on sales velocity and inventory levels
 *
 * Endpoints:
 * - GET /api/sales-velocity       - Get sales velocity data
 * - GET /api/reorder-suggestions  - Calculate reorder suggestions
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/analytics');
const { getReorderSuggestions } = require('../services/catalog/reorder-service');
const { sendSuccess, sendError } = require('../utils/response-helper');

// ==================== SALES VELOCITY ENDPOINTS ====================

/**
 * GET /api/sales-velocity
 * Get sales velocity data
 */
router.get('/sales-velocity', requireAuth, requireMerchant, validators.getVelocity, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
        const { variation_id, location_id, period_days } = req.query;

        // Input validation for period_days
        if (period_days !== undefined) {
            const periodDaysNum = parseInt(period_days);
            const validPeriods = [91, 182, 365];
            if (isNaN(periodDaysNum) || !validPeriods.includes(periodDaysNum)) {
                return sendError(res, 'Invalid period_days parameter', 400);
            }
        }

        let query = `
            SELECT
                sv.*,
                v.sku,
                i.name as item_name,
                v.name as variation_name,
                i.category_name,
                l.name as location_name
            FROM sales_velocity sv
            JOIN variations v ON sv.variation_id = v.id AND v.merchant_id = $1
            JOIN items i ON v.item_id = i.id AND i.merchant_id = $1
            JOIN locations l ON sv.location_id = l.id AND l.merchant_id = $1
            WHERE sv.merchant_id = $1
              AND COALESCE(v.is_deleted, FALSE) = FALSE
              AND COALESCE(i.is_deleted, FALSE) = FALSE
        `;
        const params = [merchantId];

        if (variation_id) {
            params.push(variation_id);
            query += ` AND sv.variation_id = $${params.length}`;
        }

        if (location_id) {
            params.push(location_id);
            query += ` AND sv.location_id = $${params.length}`;
        }

        if (period_days) {
            params.push(parseInt(period_days));
            query += ` AND sv.period_days = $${params.length}`;
        }

        query += ' ORDER BY sv.daily_avg_quantity DESC';

    const result = await db.query(query, params);
    sendSuccess(res, {
        count: result.rows.length,
        sales_velocity: result.rows
    });
}));

// ==================== REORDER SUGGESTIONS ====================

/**
 * GET /api/reorder-suggestions
 * Calculate reorder suggestions based on sales velocity
 */
router.get('/reorder-suggestions', requireAuth, requireMerchant, validators.getReorderSuggestions, asyncHandler(async (req, res) => {
    const result = await getReorderSuggestions({
        merchantId: req.merchantContext.id,
        businessName: req.merchantContext.businessName,
        query: req.query
    });

    // Service returns { error, message } for validation failures
    if (result.error) {
        return sendError(res, result.error, 400);
    }

    sendSuccess(res, result);
}));

module.exports = router;
