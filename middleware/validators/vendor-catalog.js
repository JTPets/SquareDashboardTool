/**
 * Vendor Catalog Route Validators
 *
 * Validates input for vendor and vendor catalog endpoints
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors, validateOptionalString } = require('./index');

// Helper to validate non-negative integer (handles JSON number types)
const isNonNegativeInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return true;
};

/**
 * GET /api/vendors
 */
const getVendors = [
    query('status')
        .optional()
        .customSanitizer(value => value ? value.toUpperCase() : value)
        .isIn(['ACTIVE', 'INACTIVE', 'PENDING'])
        .withMessage('status must be one of: ACTIVE, INACTIVE, PENDING'),
    handleValidationErrors
];

/**
 * POST /api/vendor-catalog/import
 */
const importCatalog = [
    body('data')
        .notEmpty()
        .withMessage('File data is required'),
    body('fileType')
        .optional()
        .isIn(['csv', 'xlsx'])
        .withMessage('fileType must be csv or xlsx'),
    body('fileName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('fileName cannot exceed 255 characters'),
    body('defaultVendorName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('defaultVendorName cannot exceed 255 characters'),
    handleValidationErrors
];

/**
 * POST /api/vendor-catalog/preview
 */
const previewFile = [
    body('data')
        .notEmpty()
        .withMessage('File data is required'),
    body('fileType')
        .optional()
        .isIn(['csv', 'xlsx'])
        .withMessage('fileType must be csv or xlsx'),
    body('fileName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('fileName cannot exceed 255 characters'),
    handleValidationErrors
];

/**
 * POST /api/vendor-catalog/import-mapped
 */
const importMapped = [
    body('data')
        .notEmpty()
        .withMessage('File data is required'),
    body('vendorId')
        .notEmpty()
        .withMessage('vendorId is required'),
    body('fileType')
        .optional()
        .isIn(['csv', 'xlsx'])
        .withMessage('fileType must be csv or xlsx'),
    body('fileName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('fileName cannot exceed 255 characters'),
    body('columnMappings')
        .optional()
        .isObject()
        .withMessage('columnMappings must be an object'),
    body('mappings')
        .optional()
        .isObject()
        .withMessage('mappings must be an object'),
    body('vendorName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('vendorName cannot exceed 255 characters'),
    body('importName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('importName cannot exceed 255 characters'),
    handleValidationErrors
];

/**
 * GET /api/vendor-catalog
 */
const searchCatalog = [
    query('vendor_id')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('vendor_id cannot be empty if provided'),
    query('vendor_name')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('vendor_name cannot exceed 255 characters'),
    query('upc')
        .optional()
        .trim()
        .isLength({ max: 50 })
        .withMessage('upc cannot exceed 50 characters'),
    query('search')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('search cannot exceed 255 characters'),
    query('matched_only')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('matched_only must be true or false'),
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
 * GET /api/vendor-catalog/lookup/:upc
 */
const lookupUpc = [
    param('upc')
        .trim()
        .notEmpty()
        .withMessage('UPC is required')
        .isLength({ max: 50 })
        .withMessage('UPC cannot exceed 50 characters'),
    handleValidationErrors
];

/**
 * GET /api/vendor-catalog/batches
 */
const getBatches = [
    query('include_archived')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('include_archived must be true or false'),
    handleValidationErrors
];

/**
 * POST/DELETE /api/vendor-catalog/batches/:batchId/*
 */
const batchAction = [
    param('batchId')
        .trim()
        .notEmpty()
        .withMessage('Batch ID is required'),
    handleValidationErrors
];

/**
 * PATCH /api/vendors/:id/settings
 */
const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const VALID_PAYMENT_METHODS = ['Credit Card', 'Invoice', 'E-Transfer', 'COD', 'N/A'];

const updateVendorSettings = [
    param('id')
        .trim()
        .notEmpty()
        .withMessage('Vendor ID is required'),
    body('schedule_type')
        .optional()
        .isIn(['fixed', 'anytime'])
        .withMessage('schedule_type must be fixed or anytime'),
    body('order_day')
        .optional({ values: 'null' })
        .isIn(VALID_DAYS)
        .withMessage(`order_day must be one of: ${VALID_DAYS.join(', ')}`),
    body('receive_day')
        .optional({ values: 'null' })
        .isIn(VALID_DAYS)
        .withMessage(`receive_day must be one of: ${VALID_DAYS.join(', ')}`),
    body('lead_time_days')
        .optional()
        .custom((value) => isNonNegativeInt(value, 'lead_time_days')),
    body('minimum_order_amount')
        .optional()
        .custom((value) => isNonNegativeInt(value, 'minimum_order_amount')),
    body('payment_method')
        .optional({ values: 'null' })
        .isIn(VALID_PAYMENT_METHODS)
        .withMessage(`payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`),
    body('payment_terms')
        .optional({ values: 'null' })
        .trim()
        .isLength({ max: 100 })
        .withMessage('payment_terms cannot exceed 100 characters'),
    body('contact_email')
        .optional({ values: 'null' })
        .trim()
        .isLength({ max: 255 })
        .withMessage('contact_email cannot exceed 255 characters'),
    body('order_method')
        .optional({ values: 'null' })
        .trim()
        .isLength({ max: 50 })
        .withMessage('order_method cannot exceed 50 characters'),
    body('default_supply_days')
        .optional()
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error('default_supply_days must be a positive integer');
            }
            return true;
        }),
    body('notes')
        .optional({ values: 'null' })
        .trim()
        .isLength({ max: 2000 })
        .withMessage('notes cannot exceed 2000 characters'),
    // Cross-field validation: if schedule_type = 'fixed', order_day and receive_day are required
    body().custom((value) => {
        if (value.schedule_type === 'fixed') {
            if (!value.order_day) {
                throw new Error('order_day is required when schedule_type is fixed');
            }
            if (!value.receive_day) {
                throw new Error('receive_day is required when schedule_type is fixed');
            }
        }
        return true;
    }),
    handleValidationErrors
];

/**
 * POST /api/vendor-catalog/push-price-changes
 */
const pushPriceChanges = [
    body('priceChanges')
        .isArray({ min: 1 })
        .withMessage('priceChanges must be a non-empty array'),
    body('priceChanges.*.variationId')
        .notEmpty()
        .withMessage('Each price change must have a variationId'),
    body('priceChanges.*.newPriceCents')
        .custom((value) => isNonNegativeInt(value, 'newPriceCents')),
    body('priceChanges.*.currency')
        .optional()
        .isLength({ min: 3, max: 3 })
        .withMessage('currency must be a 3-letter code'),
    handleValidationErrors
];

module.exports = {
    getVendors,
    importCatalog,
    previewFile,
    importMapped,
    searchCatalog,
    lookupUpc,
    getBatches,
    batchAction,
    pushPriceChanges,
    updateVendorSettings
};
