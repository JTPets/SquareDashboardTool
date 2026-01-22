/**
 * Expiry Discounts Route Validators
 *
 * Validates input for expiry discount management endpoints
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors, validateIntId, validateOptionalPositiveInt, validateOptionalBoolean, validateOptionalString } = require('./index');

// Helper to validate non-negative integer (handles JSON number types)
const isNonNegativeInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return true;
};

// Helper to validate integer within range (handles JSON number types)
const isIntInRange = (value, fieldName, min, max) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < min || num > max) {
        throw new Error(`${fieldName} must be between ${min} and ${max}`);
    }
    return true;
};

/**
 * PATCH /api/expiry-discounts/tiers/:id
 */
const updateTier = [
    validateIntId('id'),
    body('tier_name')
        .optional()
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('tier_name must be 1-100 characters'),
    body('min_days_to_expiry')
        .optional()
        .custom((value) => isNonNegativeInt(value, 'min_days_to_expiry')),
    body('max_days_to_expiry')
        .optional()
        .custom((value) => isNonNegativeInt(value, 'max_days_to_expiry')),
    body('discount_percent')
        .optional()
        .custom((value) => isIntInRange(value, 'discount_percent', 0, 100)),
    body('is_auto_apply')
        .optional()
        .isBoolean()
        .withMessage('is_auto_apply must be a boolean'),
    body('requires_review')
        .optional()
        .isBoolean()
        .withMessage('requires_review must be a boolean'),
    body('color_code')
        .optional()
        .matches(/^#[0-9A-Fa-f]{6}$/)
        .withMessage('color_code must be a valid hex color (e.g., #FF5733)'),
    body('priority')
        .optional()
        .custom((value) => isIntInRange(value, 'priority', 0, 100)),
    body('is_active')
        .optional()
        .isBoolean()
        .withMessage('is_active must be a boolean'),
    handleValidationErrors
];

/**
 * GET /api/expiry-discounts/variations
 */
const getVariations = [
    query('tier_code')
        .optional()
        .trim()
        .isLength({ min: 1, max: 50 })
        .withMessage('tier_code must be 1-50 characters'),
    query('needs_pull')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('needs_pull must be true or false'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 1000 })
        .withMessage('limit must be between 1 and 1000'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('offset must be a non-negative integer'),
    handleValidationErrors
];

/**
 * POST /api/expiry-discounts/evaluate
 */
const evaluate = [
    body('dry_run')
        .optional()
        .isBoolean()
        .withMessage('dry_run must be a boolean'),
    handleValidationErrors
];

/**
 * POST /api/expiry-discounts/apply
 */
const apply = [
    body('dry_run')
        .optional()
        .isBoolean()
        .withMessage('dry_run must be a boolean'),
    handleValidationErrors
];

/**
 * POST /api/expiry-discounts/run
 */
const run = [
    body('dry_run')
        .optional()
        .isBoolean()
        .withMessage('dry_run must be a boolean'),
    handleValidationErrors
];

/**
 * GET /api/expiry-discounts/audit-log
 */
const getAuditLog = [
    query('variation_id')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('variation_id cannot be empty if provided'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 1000 })
        .withMessage('limit must be between 1 and 1000'),
    handleValidationErrors
];

/**
 * PATCH /api/expiry-discounts/settings
 */
const updateSettings = [
    body()
        .isObject()
        .withMessage('Request body must be an object'),
    handleValidationErrors
];

module.exports = {
    updateTier,
    getVariations,
    evaluate,
    apply,
    run,
    getAuditLog,
    updateSettings
};
