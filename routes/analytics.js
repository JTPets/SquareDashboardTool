/**
 * Analytics Routes
 *
 * Handles sales velocity, reorder suggestions, and auto min/max recommendations:
 * - GET /api/sales-velocity             - Get sales velocity data
 * - GET /api/reorder-suggestions        - Calculate reorder suggestions
 * - GET /api/min-max/recommendations    - Generate min stock recommendations (dry run)
 * - POST /api/min-max/apply             - Apply selected recommendations
 * - GET /api/min-max/history            - Audit log of applied changes (paginated, filterable)
 * - POST /api/min-max/pin               - Pin/unpin a variation from auto-adjustment
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/analytics');
const { getReorderSuggestions } = require('../services/catalog/reorder-service');
const autoMinMax = require('../services/inventory/auto-min-max-service');
const { sendSuccess, sendError, sendPaginated } = require('../utils/response-helper');

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

// ==================== AUTO MIN/MAX RECOMMENDATIONS ====================

/**
 * GET /api/min-max/recommendations
 * Returns all current min-stock recommendations for the merchant (dry run — no changes applied).
 * Items with recommendedMin=null are warnings (e.g. possible supplier issue or skipped).
 */
router.get('/min-max/recommendations',
    requireAuth, requireMerchant, validators.getRecommendations,
    asyncHandler(async (req, res) => {
        const recommendations = await autoMinMax.generateRecommendations(req.merchantContext.id);
        sendSuccess(res, { count: recommendations.length, recommendations });
    })
);

/**
 * POST /api/min-max/apply
 * Applies selected recommendations (all-or-nothing transaction).
 * Body: { recommendations: [{ variationId, locationId, newMin }] }
 * Skips entries where newMin is null (supplier-issue warnings).
 */
router.post('/min-max/apply',
    requireAuth, requireMerchant, requireWriteAccess, validators.applyRecommendations,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const incoming = req.body.recommendations;

        // Filter out supplier-issue warnings (newMin=null) — those cannot be applied
        const applicable = incoming.filter(r => r.newMin !== null && r.newMin !== undefined);
        if (applicable.length === 0) {
            return sendError(res, 'No applicable recommendations to apply', 400);
        }

        const result = await autoMinMax.applyAllRecommendations(merchantId, applicable);
        sendSuccess(res, result);
    })
);

/**
 * GET /api/min-max/history
 * Paginated audit log of applied min-stock changes.
 * Query: limit (default 50, max 200), offset (default 0),
 *        startDate (ISO date), endDate (ISO date), rule (enum)
 */
router.get('/min-max/history',
    requireAuth, requireMerchant, validators.getHistory,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const { startDate, endDate, rule } = req.query;

        const result = await autoMinMax.getHistory(merchantId, { startDate, endDate, rule, limit, offset });
        sendPaginated(res, result);
    })
);

/**
 * POST /api/min-max/pin
 * Pin or unpin a variation from weekly auto-adjustment.
 * Body: { variationId, locationId, pinned: true|false }
 */
router.post('/min-max/pin',
    requireAuth, requireMerchant, requireWriteAccess, validators.pinVariation,
    asyncHandler(async (req, res) => {
        const merchantId = req.merchantContext.id;
        const { variationId, locationId, pinned } = req.body;
        const result = await autoMinMax.pinVariation(merchantId, variationId, locationId, pinned);
        sendSuccess(res, result);
    })
);

module.exports = router;
