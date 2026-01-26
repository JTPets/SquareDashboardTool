/**
 * Cycle Counts Route Validators
 *
 * Validates input for cycle count management endpoints
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

// Helper to validate non-negative integer (handles JSON number types)
const isNonNegativeInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return true;
};

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
        .custom((value) => isNonNegativeInt(value, 'actual_quantity')),
    body('expected_quantity')
        .optional()
        .custom((value) => isNonNegativeInt(value, 'expected_quantity')),
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
        .exists({ checkNull: true })
        .withMessage('actual_quantity is required')
        .custom((value) => isNonNegativeInt(value, 'actual_quantity')),
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

/**
 * POST /api/cycle-counts/email-report
 * No body params required - uses merchant context
 * Validator documents API contract for consistency
 */
const emailReport = [
    handleValidationErrors
];

/**
 * POST /api/cycle-counts/generate-batch
 * No body params required - uses merchant context
 * Validator documents API contract for consistency
 */
const generateBatch = [
    handleValidationErrors
];

module.exports = {
    complete,
    syncToSquare,
    sendNow,
    getStats,
    getHistory,
    reset,
    emailReport,
    generateBatch
};
