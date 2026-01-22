/**
 * Cycle Counts Route Validators
 *
 * Validates input for cycle count management endpoints
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * POST /api/cycle-counts/:id/complete
 */
const complete = [
    param('id')
        .trim()
        .notEmpty()
        .withMessage('Item ID is required'),
    body('counted_by')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('counted_by cannot exceed 100 characters'),
    body('is_accurate')
        .optional()
        .isBoolean()
        .withMessage('is_accurate must be a boolean'),
    body('actual_quantity')
        .optional()
        .isInt({ min: 0 })
        .withMessage('actual_quantity must be a non-negative integer'),
    body('expected_quantity')
        .optional()
        .isInt({ min: 0 })
        .withMessage('expected_quantity must be a non-negative integer'),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('notes cannot exceed 500 characters'),
    handleValidationErrors
];

/**
 * POST /api/cycle-counts/:id/sync-to-square
 */
const syncToSquare = [
    param('id')
        .trim()
        .notEmpty()
        .withMessage('Item ID is required'),
    body('actual_quantity')
        .notEmpty()
        .withMessage('actual_quantity is required')
        .isInt({ min: 0 })
        .withMessage('actual_quantity must be a non-negative integer'),
    body('location_id')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('location_id cannot be empty if provided'),
    handleValidationErrors
];

/**
 * POST /api/cycle-counts/send-now
 */
const sendNow = [
    body('skus')
        .isArray({ min: 1 })
        .withMessage('skus must be a non-empty array'),
    body('skus.*')
        .trim()
        .notEmpty()
        .withMessage('Each SKU must be non-empty'),
    body('added_by')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('added_by cannot exceed 100 characters'),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('notes cannot exceed 500 characters'),
    handleValidationErrors
];

/**
 * GET /api/cycle-counts/stats
 */
const getStats = [
    query('days')
        .optional()
        .isInt({ min: 1, max: 365 })
        .withMessage('days must be between 1 and 365'),
    handleValidationErrors
];

/**
 * GET /api/cycle-counts/history
 */
const getHistory = [
    query('date')
        .optional()
        .isDate()
        .withMessage('date must be a valid date (YYYY-MM-DD)'),
    query('start_date')
        .optional()
        .isDate()
        .withMessage('start_date must be a valid date (YYYY-MM-DD)'),
    query('end_date')
        .optional()
        .isDate()
        .withMessage('end_date must be a valid date (YYYY-MM-DD)'),
    handleValidationErrors
];

/**
 * POST /api/cycle-counts/reset
 */
const reset = [
    body('preserve_history')
        .optional()
        .isBoolean()
        .withMessage('preserve_history must be a boolean'),
    handleValidationErrors
];

module.exports = {
    complete,
    syncToSquare,
    sendNow,
    getStats,
    getHistory,
    reset
};
