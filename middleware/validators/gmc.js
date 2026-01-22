/**
 * Validators for GMC (Google Merchant Center) routes
 *
 * SECURITY NOTE: These handle:
 * - Feed token management (sensitive operation)
 * - External data feed generation
 * - Google taxonomy mappings
 * - Location settings for multi-location inventory
 */

const { body, query, param } = require('express-validator');
const {
    handleValidationErrors,
    validateOptionalString,
    validateOptionalPositiveInt,
    validatePagination
} = require('./index');

// Helper to validate positive integer (handles JSON number types)
const isPositiveInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) {
        throw new Error(`${fieldName} must be a positive integer`);
    }
    return true;
};

// ==================== ROUTE-SPECIFIC VALIDATORS ====================

/**
 * GET /api/gmc/feed
 * Generate GMC feed data
 */
const getFeed = [
    query('location_id')
        .optional()
        .trim(),
    query('include_products')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('include_products must be true or false'),
    handleValidationErrors
];

/**
 * PUT /api/gmc/settings
 * Update GMC feed settings
 */
const updateSettings = [
    body('settings')
        .isObject()
        .withMessage('settings object is required'),
    handleValidationErrors
];

/**
 * POST /api/gmc/brands/import
 * Import brands from array
 */
const importBrands = [
    body('brands')
        .isArray({ min: 1 })
        .withMessage('brands must be a non-empty array'),
    handleValidationErrors
];

/**
 * POST /api/gmc/brands
 * Create a new brand
 */
const createBrand = [
    body('name')
        .trim()
        .notEmpty()
        .withMessage('Brand name is required')
        .isLength({ max: 255 })
        .withMessage('Brand name cannot exceed 255 characters'),
    body('logo_url')
        .optional()
        .trim()
        .isURL()
        .withMessage('logo_url must be a valid URL'),
    body('website')
        .optional()
        .trim()
        .isURL()
        .withMessage('website must be a valid URL'),
    handleValidationErrors
];

/**
 * PUT /api/gmc/items/:itemId/brand
 * Assign brand to item
 */
const assignItemBrand = [
    param('itemId')
        .trim()
        .notEmpty()
        .withMessage('itemId is required'),
    body('brand_id')
        .optional({ nullable: true })
        .custom((value) => {
            if (value === null) return true;
            return isPositiveInt(value, 'brand_id');
        }),
    handleValidationErrors
];

/**
 * POST /api/gmc/brands/auto-detect
 * Auto-detect brands from item names
 */
const autoDetectBrands = [
    body('brands')
        .isArray({ min: 1 })
        .withMessage('brands must be a non-empty array of brand names'),
    handleValidationErrors
];

/**
 * POST /api/gmc/brands/bulk-assign
 * Bulk assign brands to items
 */
const bulkAssignBrands = [
    body('assignments')
        .isArray({ min: 1 })
        .withMessage('assignments must be a non-empty array'),
    body('assignments.*.item_id')
        .trim()
        .notEmpty()
        .withMessage('Each assignment must have an item_id'),
    body('assignments.*.brand_id')
        .custom((value) => isPositiveInt(value, 'brand_id')),
    handleValidationErrors
];

/**
 * GET /api/gmc/taxonomy
 * List Google taxonomy categories
 */
const listTaxonomy = [
    query('search')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('search cannot exceed 255 characters'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 1000 })
        .withMessage('limit must be between 1 and 1000'),
    handleValidationErrors
];

/**
 * POST /api/gmc/taxonomy/import
 * Import Google taxonomy
 */
const importTaxonomy = [
    body('taxonomy')
        .isArray({ min: 1 })
        .withMessage('taxonomy must be a non-empty array'),
    handleValidationErrors
];

/**
 * PUT /api/gmc/categories/:categoryId/taxonomy
 * Map category to Google taxonomy
 */
const mapCategoryTaxonomy = [
    param('categoryId')
        .trim()
        .notEmpty()
        .withMessage('categoryId is required'),
    body('google_taxonomy_id')
        .optional({ nullable: true })
        .custom((value) => {
            if (value === null) return true;
            return isPositiveInt(value, 'google_taxonomy_id');
        }),
    handleValidationErrors
];

/**
 * DELETE /api/gmc/categories/:categoryId/taxonomy
 * Remove category taxonomy mapping
 */
const deleteCategoryTaxonomy = [
    param('categoryId')
        .trim()
        .notEmpty()
        .withMessage('categoryId is required'),
    handleValidationErrors
];

/**
 * PUT /api/gmc/category-taxonomy
 * Map category by name to Google taxonomy
 */
const mapCategoryTaxonomyByName = [
    body('category_name')
        .trim()
        .notEmpty()
        .withMessage('category_name is required')
        .isLength({ max: 255 })
        .withMessage('category_name cannot exceed 255 characters'),
    body('google_taxonomy_id')
        .exists({ checkNull: true }).withMessage('google_taxonomy_id is required')
        .custom((value) => isPositiveInt(value, 'google_taxonomy_id')),
    handleValidationErrors
];

/**
 * DELETE /api/gmc/category-taxonomy
 * Remove category taxonomy mapping by name
 */
const deleteCategoryTaxonomyByName = [
    body('category_name')
        .trim()
        .notEmpty()
        .withMessage('category_name is required'),
    handleValidationErrors
];

/**
 * PUT /api/gmc/location-settings/:locationId
 * Update location GMC settings
 */
const updateLocationSettings = [
    param('locationId')
        .trim()
        .notEmpty()
        .withMessage('locationId is required'),
    body('google_store_code')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('google_store_code cannot exceed 100 characters'),
    body('enabled')
        .optional()
        .isBoolean()
        .withMessage('enabled must be a boolean'),
    handleValidationErrors
];

/**
 * GET /api/gmc/local-inventory-feed
 * Get local inventory feed (requires location_id)
 */
const getLocalInventoryFeed = [
    query('location_id')
        .trim()
        .notEmpty()
        .withMessage('location_id is required'),
    handleValidationErrors
];

/**
 * PUT /api/gmc/api-settings
 * Save GMC API settings
 */
const updateApiSettings = [
    body('settings')
        .isObject()
        .withMessage('settings object is required'),
    handleValidationErrors
];

/**
 * GET /api/gmc/api/sync-history
 * Get sync history
 */
const getSyncHistory = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('limit must be between 1 and 100'),
    handleValidationErrors
];

module.exports = {
    getFeed,
    updateSettings,
    importBrands,
    createBrand,
    assignItemBrand,
    autoDetectBrands,
    bulkAssignBrands,
    listTaxonomy,
    importTaxonomy,
    mapCategoryTaxonomy,
    deleteCategoryTaxonomy,
    mapCategoryTaxonomyByName,
    deleteCategoryTaxonomyByName,
    updateLocationSettings,
    getLocalInventoryFeed,
    updateApiSettings,
    getSyncHistory
};
