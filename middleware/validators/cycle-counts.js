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

// Helper to validate any integer (allows negative — for system quantities like expected_quantity)
const isInteger = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num)) {
        throw new Error(`${fieldName} must be an integer`);
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
        .custom((value) => isInteger(value, 'expected_quantity')),
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

/**
 * POST /api/cycle-counts/generate-category-batch
 */
const generateCategoryBatch = [
    body('type')
        .trim()
        .notEmpty()
        .isIn(['category', 'vendor'])
        .withMessage('type must be "category" or "vendor"'),
    body('id')
        .trim()
        .notEmpty()
        .withMessage('id is required'),
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
 * GET /api/cycle-counts/preview-category-batch
 */
const previewCategoryBatch = [
    query('type')
        .trim()
        .notEmpty()
        .isIn(['category', 'vendor'])
        .withMessage('type must be "category" or "vendor"'),
    query('id')
        .trim()
        .notEmpty()
        .withMessage('id is required'),
    handleValidationErrors
];

/**
 * GET /api/cycle-counts/pinned
 * No query params — uses merchant context
 */
const getPinned = [
    handleValidationErrors
];

/**
 * POST /api/cycle-counts/pinned
 * Add one or more variations to the pinned group (upsert)
 */
const addPinned = [
    body('variations')
        .isArray({ min: 1 })
        .withMessage('variations must be a non-empty array'),
    body('variations.*.variation_id')
        .trim()
        .notEmpty()
        .withMessage('Each variation must have a variation_id'),
    body('variations.*.variation_name')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('variation_name cannot exceed 255 characters'),
    body('variations.*.item_name')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('item_name cannot exceed 255 characters'),
    body('variations.*.sku')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('sku cannot exceed 255 characters'),
    handleValidationErrors
];

/**
 * DELETE /api/cycle-counts/pinned/:variationId
 */
const deletePinned = [
    param('variationId')
        .trim()
        .notEmpty()
        .withMessage('variationId is required'),
    handleValidationErrors
];

/**
 * POST /api/cycle-counts/pinned/send
 * Push all pinned variations to count_queue_priority
 */
const sendPinned = [
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
    generateBatch,
    generateCategoryBatch,
    previewCategoryBatch,
    getPinned,
    addPinned,
    deletePinned,
    sendPinned
};
