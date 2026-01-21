/**
 * Validators for Purchase Order routes
 *
 * SECURITY NOTE: Financial operations - extra validation required.
 * All monetary values are in cents to avoid floating point issues.
 */

const { body, param, query } = require('express-validator');
const {
    handleValidationErrors,
    validateIntId,
    validateOptionalString,
    validateCurrencyAmount,
    validateNonEmptyArray,
    validateOptionalArray,
    validateOptionalPositiveInt
} = require('./index');

// ==================== ROUTE-SPECIFIC VALIDATORS ====================

/**
 * POST /api/purchase-orders
 * Create a new purchase order
 */
const createPurchaseOrder = [
    body('vendor_id')
        .isInt({ min: 1 })
        .withMessage('vendor_id must be a positive integer'),
    body('location_id')
        .isInt({ min: 1 })
        .withMessage('location_id must be a positive integer'),
    body('items')
        .isArray({ min: 1 })
        .withMessage('items must be a non-empty array'),
    body('items.*.variation_id')
        .isInt({ min: 1 })
        .withMessage('Each item must have a valid variation_id'),
    body('items.*.quantity_ordered')
        .isInt({ min: 1 })
        .withMessage('Each item must have a positive quantity_ordered'),
    body('items.*.unit_cost_cents')
        .isInt({ min: 0 })
        .withMessage('Each item must have a non-negative unit_cost_cents'),
    validateOptionalPositiveInt('supply_days_override', { min: 1, max: 365 }),
    validateOptionalString('notes', { maxLength: 2000 }),
    validateOptionalString('created_by', { maxLength: 255 }),
    handleValidationErrors
];

/**
 * GET /api/purchase-orders
 * List purchase orders with filtering
 */
const listPurchaseOrders = [
    query('status')
        .optional()
        .isIn(['DRAFT', 'SUBMITTED', 'PARTIAL', 'RECEIVED', 'CANCELLED'])
        .withMessage('status must be one of: DRAFT, SUBMITTED, PARTIAL, RECEIVED, CANCELLED'),
    query('vendor_id')
        .optional()
        .isInt({ min: 1 })
        .withMessage('vendor_id must be a positive integer'),
    handleValidationErrors
];

/**
 * GET /api/purchase-orders/:id
 * Get single purchase order
 */
const getPurchaseOrder = [
    validateIntId('id'),
    handleValidationErrors
];

/**
 * PATCH /api/purchase-orders/:id
 * Update a draft purchase order
 */
const updatePurchaseOrder = [
    validateIntId('id'),
    validateOptionalPositiveInt('supply_days_override', { min: 1, max: 365 }),
    validateOptionalString('notes', { maxLength: 2000 }),
    body('items')
        .optional()
        .isArray()
        .withMessage('items must be an array if provided'),
    body('items.*.variation_id')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Each item must have a valid variation_id'),
    body('items.*.quantity_ordered')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Each item must have a positive quantity_ordered'),
    body('items.*.unit_cost_cents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Each item must have a non-negative unit_cost_cents'),
    handleValidationErrors
];

/**
 * POST /api/purchase-orders/:id/submit
 * Submit a purchase order
 */
const submitPurchaseOrder = [
    validateIntId('id'),
    handleValidationErrors
];

/**
 * POST /api/purchase-orders/:id/receive
 * Record received quantities for PO items
 */
const receivePurchaseOrder = [
    validateIntId('id'),
    body('items')
        .isArray({ min: 1 })
        .withMessage('items must be a non-empty array'),
    body('items.*.id')
        .isInt({ min: 1 })
        .withMessage('Each item must have a valid id'),
    body('items.*.received_quantity')
        .isInt({ min: 0 })
        .withMessage('Each item must have a non-negative received_quantity'),
    handleValidationErrors
];

/**
 * DELETE /api/purchase-orders/:id
 * Delete a draft purchase order
 */
const deletePurchaseOrder = [
    validateIntId('id'),
    handleValidationErrors
];

/**
 * GET /api/purchase-orders/:po_number/export-csv
 * Export a purchase order as CSV
 */
const exportPurchaseOrderCsv = [
    param('po_number')
        .matches(/^PO-\d{8}-\d{3}$/)
        .withMessage('po_number must be in format PO-YYYYMMDD-XXX'),
    handleValidationErrors
];

/**
 * GET /api/purchase-orders/:po_number/export-xlsx
 * Export a purchase order as Excel file
 */
const exportPurchaseOrderXlsx = [
    param('po_number')
        .matches(/^PO-\d{8}-\d{3}$/)
        .withMessage('po_number must be in format PO-YYYYMMDD-XXX'),
    handleValidationErrors
];

module.exports = {
    createPurchaseOrder,
    listPurchaseOrders,
    getPurchaseOrder,
    updatePurchaseOrder,
    submitPurchaseOrder,
    receivePurchaseOrder,
    deletePurchaseOrder,
    exportPurchaseOrderCsv,
    exportPurchaseOrderXlsx
};
