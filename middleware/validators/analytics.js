/**
 * Analytics Route Validators
 *
 * Validates input for analytics endpoints (sales velocity, reorder suggestions)
 */

const { query } = require('express-validator');
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
    handleValidationErrors
];

module.exports = {
    getVelocity,
    getReorderSuggestions
};
