/**
 * Catalog Route Validators
 *
 * Validation middleware for catalog endpoints using express-validator.
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');
const db = require('../../utils/database');

// Helper to validate non-negative integer (handles both string and number types from JSON)
const isNonNegativeInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return true;
};

// Helper to validate positive integer (min 1)
const isPositiveInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) {
        throw new Error(`${fieldName} must be a positive integer`);
    }
    return true;
};

/**
 * Core cross-field check: throws if a concrete min/max pair violates min < max.
 *
 * Normalization:
 *   - null / undefined for either side  → pass (nothing to compare)
 *   - stock_alert_max = 0                → treated as NULL (unlimited), pass
 *
 * @param {number|string|null|undefined} rawMin
 * @param {number|string|null|undefined} rawMax
 * @throws {Error} if min >= max after normalization
 * @returns {boolean} true when valid
 */
const assertMinLessThanMax = (rawMin, rawMax) => {
    const min = rawMin === null || rawMin === undefined ? null : Number(rawMin);
    let max = rawMax === null || rawMax === undefined ? null : Number(rawMax);
    // Normalize 0 → null (unlimited)
    if (max === 0) max = null;
    if (max === null || min === null) return true;
    if (min >= max) {
        throw new Error('stock_alert_max must be greater than stock_alert_min');
    }
    return true;
};

/**
 * Cross-field validator: stock_alert_min must be strictly less than stock_alert_max.
 *
 * Only runs when BOTH fields are provided in the request body. Single-field
 * updates (e.g. updating only min) rely on the service-level guard plus the DB
 * CHECK constraint for safety.
 *
 * @throws {Error} if max <= min (triggers express-validator 400 response)
 * @returns {boolean} true when valid
 */
const validateMinMaxConsistency = (req) => {
    const body = req.body || {};
    // Only evaluate if both provided in the same request
    if (body.stock_alert_min === undefined || body.stock_alert_max === undefined) {
        return true;
    }
    return assertMinLessThanMax(body.stock_alert_min, body.stock_alert_max);
};

/**
 * Async cross-field check for the PATCH /min-stock endpoint.
 *
 * The endpoint only accepts `min_stock` (no max field is ever sent), so we
 * fetch the stored variations.stock_alert_max for the merchant+variation and
 * verify the new min is strictly less than it. Skips the DB call when the
 * incoming value can't produce a conflict (null, 0, or negative — validated
 * elsewhere). A missing variation is ignored here; the service layer will
 * return 404.
 *
 * Layered with the existing service-level guard and DB CHECK constraint for
 * defense-in-depth, and mirrors the cross-field behavior on the /extended
 * endpoint.
 *
 * @param {import('express').Request} req
 * @returns {Promise<boolean>} true when valid
 * @throws {Error} 'stock_alert_max must be greater than stock_alert_min'
 */
const validateMinStockAgainstStoredMax = async (req) => {
    const body = req.body || {};
    const rawMin = body.min_stock;
    if (rawMin === undefined || rawMin === null) return true;
    const min = Number(rawMin);
    if (!Number.isFinite(min) || min <= 0) return true;

    const variationId = req.params && req.params.id;
    const merchantId = req.merchantContext && req.merchantContext.id;
    if (!variationId || !merchantId) return true;

    const result = await db.query(
        'SELECT stock_alert_max FROM variations WHERE id = $1 AND merchant_id = $2',
        [variationId, merchantId]
    );
    if (result.rows.length === 0) return true;

    return assertMinLessThanMax(min, result.rows[0].stock_alert_max);
};

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
    query('search').optional().isString().trim().isLength({ min: 2, max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    handleValidationErrors
];

// GET /api/variations-with-costs
const getVariationsWithCosts = [handleValidationErrors];

// PATCH /api/variations/:id/extended
const updateVariationExtended = [
    param('id').isString().notEmpty(),
    body('case_pack_quantity').optional().custom((value) => isNonNegativeInt(value, 'case_pack_quantity')),
    body('stock_alert_min').optional({ nullable: true }).custom((value) => {
        if (value === null) return true;
        return isNonNegativeInt(value, 'stock_alert_min');
    }),
    body('stock_alert_max').optional({ nullable: true }).custom((value) => {
        if (value === null) return true;
        return isNonNegativeInt(value, 'stock_alert_max');
    }),
    body().custom((_value, { req }) => validateMinMaxConsistency(req)),
    body('preferred_stock_level').optional().custom((value) => isNonNegativeInt(value, 'preferred_stock_level')),
    body('shelf_location').optional().isString().trim(),
    body('bin_location').optional().isString().trim(),
    body('reorder_multiple').optional().custom((value) => isPositiveInt(value, 'reorder_multiple')),
    body('discontinued').optional().isBoolean(),
    body('notes').optional().isString(),
    handleValidationErrors
];

// PATCH /api/variations/:id/min-stock
const updateMinStock = [
    param('id').isString().notEmpty(),
    body('min_stock').optional({ nullable: true }).custom((value) => {
        if (value === null) return true;
        return isNonNegativeInt(value, 'min_stock');
    }),
    body('location_id').optional().isString(),
    // Cross-field check: fetch stored stock_alert_max and verify min < max.
    // Endpoint only carries min, so we read max from DB. See
    // validateMinStockAgainstStoredMax for details.
    body().custom(async (_value, { req }) => validateMinStockAgainstStoredMax(req)),
    handleValidationErrors
];

// PATCH /api/variations/:id/cost
const updateCost = [
    param('id').isString().notEmpty(),
    body('cost_cents')
        .exists({ checkNull: true }).withMessage('cost_cents is required')
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 0) {
                throw new Error('cost_cents must be a non-negative integer');
            }
            return true;
        }),
    body('vendor_id').optional({ nullable: true }).isString(),
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

// POST /api/expirations/pull
const pullExpired = [
    body('variation_id').isString().notEmpty(),
    body('all_expired').isBoolean().withMessage('all_expired must be a boolean'),
    body('remaining_quantity').optional({ nullable: true }).custom((value) => {
        if (value === null || value === undefined) return true;
        return isNonNegativeInt(value, 'remaining_quantity');
    }),
    body('new_expiry_date').optional({ nullable: true }).isISO8601(),
    body('reviewed_by').optional().isString().trim(),
    body('notes').optional().isString().trim(),
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

// POST /api/catalog-audit/enable-item-at-locations
const enableItemAtLocations = [
    body('item_id').isString().notEmpty().matches(/^[A-Za-z0-9_-]+$/),
    handleValidationErrors
];

// POST /api/catalog-audit/fix-locations
const fixLocations = [handleValidationErrors];

// POST /api/catalog-audit/fix-inventory-alerts
const fixInventoryAlerts = [handleValidationErrors];

module.exports = {
    assertMinLessThanMax,
    validateMinMaxConsistency,
    validateMinStockAgainstStoredMax,
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
    pullExpired,
    reviewExpirations,
    getInventory,
    getLowStock,
    getDeletedItems,
    getCatalogAudit,
    enableItemAtLocations,
    fixLocations,
    fixInventoryAlerts
};
