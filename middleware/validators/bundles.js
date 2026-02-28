/**
 * Bundle Route Validators
 *
 * Validates input for bundle CRUD and availability endpoints.
 */

const { query, body, param } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * GET /api/bundles
 */
const getBundles = [
    query('vendor_id')
        .optional()
        .isString()
        .trim()
        .notEmpty()
        .withMessage('vendor_id must be a non-empty string'),
    query('active_only')
        .optional()
        .isBoolean()
        .withMessage('active_only must be a boolean'),
    handleValidationErrors
];

/**
 * POST /api/bundles
 */
const createBundle = [
    body('bundle_variation_id')
        .trim()
        .notEmpty()
        .withMessage('bundle_variation_id is required')
        .isLength({ max: 255 })
        .withMessage('bundle_variation_id must be under 255 characters'),
    body('bundle_item_id')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('bundle_item_id must be under 255 characters'),
    body('bundle_item_name')
        .trim()
        .notEmpty()
        .withMessage('bundle_item_name is required')
        .isLength({ max: 500 })
        .withMessage('bundle_item_name must be under 500 characters'),
    body('bundle_variation_name')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('bundle_variation_name must be under 500 characters'),
    body('bundle_sku')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('bundle_sku must be under 255 characters'),
    body('bundle_cost_cents')
        .isInt({ min: 0 })
        .withMessage('bundle_cost_cents must be a non-negative integer'),
    body('bundle_sell_price_cents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('bundle_sell_price_cents must be a non-negative integer'),
    body('vendor_id')
        .optional()
        .isString()
        .trim()
        .notEmpty()
        .withMessage('vendor_id must be a non-empty string'),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 2000 })
        .withMessage('notes must be under 2000 characters'),
    body('components')
        .isArray({ min: 1 })
        .withMessage('components must be a non-empty array'),
    body('components.*.child_variation_id')
        .trim()
        .notEmpty()
        .withMessage('Each component must have a child_variation_id')
        .isLength({ max: 255 })
        .withMessage('child_variation_id must be under 255 characters'),
    body('components.*.quantity_in_bundle')
        .isInt({ min: 1 })
        .withMessage('quantity_in_bundle must be a positive integer'),
    body('components.*.individual_cost_cents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('individual_cost_cents must be a non-negative integer'),
    handleValidationErrors
];

/**
 * PUT /api/bundles/:id
 */
const updateBundle = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('Bundle id must be a positive integer'),
    body('bundle_cost_cents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('bundle_cost_cents must be a non-negative integer'),
    body('bundle_sell_price_cents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('bundle_sell_price_cents must be a non-negative integer'),
    body('is_active')
        .optional()
        .isBoolean()
        .withMessage('is_active must be a boolean'),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 2000 })
        .withMessage('notes must be under 2000 characters'),
    body('vendor_id')
        .optional()
        .isString()
        .trim()
        .notEmpty()
        .withMessage('vendor_id must be a non-empty string'),
    body('components')
        .optional()
        .isArray({ min: 1 })
        .withMessage('components must be a non-empty array if provided'),
    body('components.*.child_variation_id')
        .trim()
        .notEmpty()
        .withMessage('Each component must have a child_variation_id')
        .isLength({ max: 255 }),
    body('components.*.quantity_in_bundle')
        .isInt({ min: 1 })
        .withMessage('quantity_in_bundle must be a positive integer'),
    body('components.*.individual_cost_cents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('individual_cost_cents must be a non-negative integer'),
    handleValidationErrors
];

/**
 * DELETE /api/bundles/:id
 */
const deleteBundle = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('Bundle id must be a positive integer'),
    handleValidationErrors
];

/**
 * GET /api/bundles/availability
 */
const getAvailability = [
    query('location_id')
        .optional()
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('location_id must be 1-255 characters'),
    handleValidationErrors
];

module.exports = {
    getBundles,
    createBundle,
    updateBundle,
    deleteBundle,
    getAvailability
};
