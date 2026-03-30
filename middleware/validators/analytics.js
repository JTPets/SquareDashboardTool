/**
 * Analytics Route Validators
 *
 * Validates input for analytics endpoints (sales velocity, reorder suggestions,
 * and auto min/max stock recommendations)
 */

const { query, body } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * GET /api/sales-velocity
 */
const getVelocity = [
    query('variation_id')
        .optional()
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('variation_id must be 1-255 characters'),
    query('location_id')
        .optional()
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('location_id must be 1-255 characters'),
    query('period_days')
        .optional()
        .isInt()
        .withMessage('period_days must be an integer')
        .isIn(['91', '182', '365'])
        .withMessage('period_days must be one of: 91, 182, 365'),
    handleValidationErrors
];

/**
 * GET /api/reorder-suggestions
 */
const getReorderSuggestions = [
    query('vendor_id')
        .optional()
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('vendor_id must be 1-255 characters'),
    query('supply_days')
        .optional()
        .isInt({ min: 1, max: 365 })
        .withMessage('supply_days must be a number between 1 and 365'),
    query('location_id')
        .optional()
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('location_id must be 1-255 characters'),
    query('min_cost')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('min_cost must be a positive number'),
    query('include_other')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('include_other must be true or false'),
    handleValidationErrors
];

/**
 * GET /api/min-max/recommendations
 * No required params — returns all current recommendations for the merchant.
 */
const getRecommendations = [
    handleValidationErrors
];

/**
 * POST /api/min-max/apply
 * Body: { recommendations: [{ variationId, locationId, newMin }] }
 */
const applyRecommendations = [
    body('recommendations')
        .isArray({ min: 1 })
        .withMessage('recommendations must be a non-empty array'),
    body('recommendations.*.variationId')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('each recommendation must have a valid variationId (1-255 chars)'),
    body('recommendations.*.locationId')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('each recommendation must have a valid locationId (1-255 chars)'),
    body('recommendations.*.newMin')
        .isInt({ min: 0 })
        .withMessage('each recommendation must have a newMin >= 0'),
    handleValidationErrors
];

/**
 * GET /api/min-max/history
 * Query: limit (1-200, default 50), offset (>= 0, default 0),
 *        startDate (ISO date), endDate (ISO date), rule (enum)
 */
const getHistory = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 200 })
        .withMessage('limit must be between 1 and 200'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('offset must be >= 0'),
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('startDate must be a valid ISO 8601 date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('endDate must be a valid ISO 8601 date'),
    query('rule')
        .optional()
        .isIn(['OVERSTOCKED', 'SOLDOUT_FAST_MOVER', 'EXPIRING', 'MANUAL_APPLY', 'CRON_AUTO'])
        .withMessage('rule must be one of: OVERSTOCKED, SOLDOUT_FAST_MOVER, EXPIRING, MANUAL_APPLY, CRON_AUTO'),
    handleValidationErrors
];

/**
 * POST /api/min-max/pin
 * Body: { variationId, locationId, pinned }
 */
const pinVariation = [
    body('variationId')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('variationId is required (1-255 chars)'),
    body('locationId')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('locationId is required (1-255 chars)'),
    body('pinned')
        .isBoolean()
        .withMessage('pinned must be true or false'),
    handleValidationErrors
];

module.exports = {
    getVelocity,
    getReorderSuggestions,
    getRecommendations,
    applyRecommendations,
    getHistory,
    pinVariation
};
