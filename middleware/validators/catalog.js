/**
 * Catalog Route Validators
 *
 * Validation middleware for catalog endpoints using express-validator.
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

// GET /api/categories
const getCategories = [handleValidationErrors];

// GET /api/items
const getItems = [
    query('name').optional().isString().trim(),
    query('category').optional().isString().trim(),
    handleValidationErrors
];

// GET /api/variations
const getVariations = [
    query('item_id').optional().isString(),
    query('sku').optional().isString().trim(),
    query('has_cost').optional().isIn(['true', 'false']),
    handleValidationErrors
];

// GET /api/variations-with-costs
const getVariationsWithCosts = [handleValidationErrors];

// PATCH /api/variations/:id/extended
const updateVariationExtended = [
    param('id').isString().notEmpty(),
    body('case_pack_quantity').optional().isInt({ min: 0 }),
    body('stock_alert_min').optional().isInt({ min: 0 }),
    body('stock_alert_max').optional().isInt({ min: 0 }),
    body('preferred_stock_level').optional().isInt({ min: 0 }),
    body('shelf_location').optional().isString().trim(),
    body('bin_location').optional().isString().trim(),
    body('reorder_multiple').optional().isInt({ min: 1 }),
    body('discontinued').optional().isBoolean(),
    body('notes').optional().isString(),
    handleValidationErrors
];

// PATCH /api/variations/:id/min-stock
const updateMinStock = [
    param('id').isString().notEmpty(),
    body('min_stock').optional({ nullable: true }).isInt({ min: 0 }),
    body('location_id').optional().isString(),
    handleValidationErrors
];

// PATCH /api/variations/:id/cost
const updateCost = [
    param('id').isString().notEmpty(),
    body('cost_cents').isInt({ min: 0 }).withMessage('cost_cents must be a non-negative integer'),
    body('vendor_id').optional().isString(),
    handleValidationErrors
];

// POST /api/variations/bulk-update-extended
const bulkUpdateExtended = [
    body().isArray().withMessage('Request body must be an array'),
    body('*.sku').isString().notEmpty().withMessage('Each item must have a sku'),
    handleValidationErrors
];

// GET /api/expirations
const getExpirations = [
    query('expiry').optional().isString(),
    query('category').optional().isString().trim(),
    handleValidationErrors
];

// POST /api/expirations
const saveExpirations = [
    body().isArray().withMessage('Expected array of changes'),
    body('*.variation_id').isString().notEmpty(),
    body('*.expiration_date').optional({ nullable: true }).isISO8601(),
    body('*.does_not_expire').optional().isBoolean(),
    handleValidationErrors
];

// POST /api/expirations/review
const reviewExpirations = [
    body('variation_ids').isArray({ min: 1 }).withMessage('Expected array of variation_ids'),
    body('variation_ids.*').isString().notEmpty(),
    body('reviewed_by').optional().isString().trim(),
    handleValidationErrors
];

// GET /api/inventory
const getInventory = [
    query('location_id').optional().isString(),
    query('low_stock').optional().isIn(['true', 'false']),
    handleValidationErrors
];

// GET /api/low-stock
const getLowStock = [handleValidationErrors];

// GET /api/deleted-items
const getDeletedItems = [
    query('age_months').optional().isInt({ min: 1, max: 120 }),
    query('status').optional().isIn(['deleted', 'archived', 'all']),
    handleValidationErrors
];

// GET /api/catalog-audit
const getCatalogAudit = [
    query('location_id').optional().matches(/^[A-Za-z0-9_-]+$/),
    query('issue_type').optional().isString(),
    handleValidationErrors
];

// POST /api/catalog-audit/fix-locations
const fixLocations = [handleValidationErrors];

module.exports = {
    getCategories,
    getItems,
    getVariations,
    getVariationsWithCosts,
    updateVariationExtended,
    updateMinStock,
    updateCost,
    bulkUpdateExtended,
    getExpirations,
    saveExpirations,
    reviewExpirations,
    getInventory,
    getLowStock,
    getDeletedItems,
    getCatalogAudit,
    fixLocations
};
