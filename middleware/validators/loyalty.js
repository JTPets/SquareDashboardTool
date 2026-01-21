/**
 * Validators for Loyalty routes
 *
 * SECURITY NOTE: These handle financial loyalty program operations.
 * - Validates offer creation and updates
 * - Validates customer lookups and reward operations
 * - Validates backfill and processing parameters
 */

const { body, query, param } = require('express-validator');
const {
    handleValidationErrors,
    validateIntId,
    validateOptionalString,
    validateOptionalPositiveInt,
    validatePagination,
    validateNonEmptyArray,
    validateOptionalBoolean
} = require('./index');

// ==================== ROUTE-SPECIFIC VALIDATORS ====================

/**
 * GET /api/loyalty/offers
 * List loyalty offers with optional filters
 */
const listOffers = [
    query('activeOnly')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('activeOnly must be true or false'),
    query('brandName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('brandName cannot exceed 255 characters'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/offers
 * Create a new loyalty offer
 */
const createOffer = [
    body('brandName')
        .trim()
        .notEmpty()
        .withMessage('brandName is required')
        .isLength({ max: 255 })
        .withMessage('brandName cannot exceed 255 characters'),
    body('sizeGroup')
        .trim()
        .notEmpty()
        .withMessage('sizeGroup is required')
        .isLength({ max: 100 })
        .withMessage('sizeGroup cannot exceed 100 characters'),
    body('requiredQuantity')
        .isInt({ min: 1, max: 1000 })
        .withMessage('requiredQuantity must be a positive integer (1-1000)'),
    body('offerName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('offerName cannot exceed 255 characters'),
    body('windowMonths')
        .optional()
        .isInt({ min: 1, max: 36 })
        .withMessage('windowMonths must be between 1 and 36'),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('description cannot exceed 1000 characters'),
    body('vendorId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('vendorId must be a positive integer'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/offers/:id
 * Get a single offer
 */
const getOffer = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    handleValidationErrors
];

/**
 * PATCH /api/loyalty/offers/:id
 * Update a loyalty offer
 */
const updateOffer = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    body('offer_name')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('offer_name cannot exceed 255 characters'),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('description cannot exceed 1000 characters'),
    body('is_active')
        .optional()
        .isBoolean()
        .withMessage('is_active must be a boolean'),
    body('window_months')
        .optional()
        .isInt({ min: 1, max: 36 })
        .withMessage('window_months must be between 1 and 36'),
    body('vendor_id')
        .optional({ nullable: true }),
    body('size_group')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('size_group cannot exceed 100 characters'),
    handleValidationErrors
];

/**
 * DELETE /api/loyalty/offers/:id
 * Delete a loyalty offer
 */
const deleteOffer = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/offers/:id/variations
 * Add qualifying variations to an offer
 */
const addVariations = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    body('variations')
        .isArray({ min: 1 })
        .withMessage('variations must be a non-empty array'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/offers/:id/variations
 * Get qualifying variations for an offer
 */
const getOfferVariations = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    handleValidationErrors
];

/**
 * DELETE /api/loyalty/offers/:offerId/variations/:variationId
 * Remove a qualifying variation from an offer
 */
const removeVariation = [
    param('offerId')
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    param('variationId')
        .trim()
        .notEmpty()
        .withMessage('variationId is required'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/customer/:customerId
 * Get loyalty status for a customer
 */
const getCustomer = [
    param('customerId')
        .trim()
        .notEmpty()
        .withMessage('customerId is required'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/customer/:customerId/history
 * Get customer loyalty history
 */
const getCustomerHistory = [
    param('customerId')
        .trim()
        .notEmpty()
        .withMessage('customerId is required'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 500 })
        .withMessage('limit must be between 1 and 500'),
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/customer/:customerId/audit-history
 * Get customer order history for audit
 */
const getCustomerAuditHistory = [
    param('customerId')
        .trim()
        .notEmpty()
        .withMessage('customerId is required'),
    query('days')
        .optional()
        .isInt({ min: 1, max: 365 })
        .withMessage('days must be between 1 and 365'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/customer/:customerId/add-orders
 * Add orders to loyalty tracking
 */
const addOrders = [
    param('customerId')
        .trim()
        .notEmpty()
        .withMessage('customerId is required'),
    body('orderIds')
        .isArray({ min: 1 })
        .withMessage('orderIds must be a non-empty array'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/rewards/:rewardId/redeem
 * Redeem a loyalty reward
 */
const redeemReward = [
    param('rewardId')
        .isInt({ min: 1 })
        .withMessage('rewardId must be a positive integer'),
    body('squareOrderId')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('squareOrderId cannot exceed 255 characters'),
    body('redeemedVariationId')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('redeemedVariationId cannot exceed 255 characters'),
    body('redeemedValueCents')
        .optional()
        .isInt({ min: 0 })
        .withMessage('redeemedValueCents must be a non-negative integer'),
    body('redemptionType')
        .optional()
        .isIn(['manual_admin', 'pos_auto', 'customer_request'])
        .withMessage('redemptionType must be manual_admin, pos_auto, or customer_request'),
    body('adminNotes')
        .optional()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('adminNotes cannot exceed 1000 characters'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/rewards
 * Get rewards with filtering
 */
const listRewards = [
    query('status')
        .optional()
        .isIn(['progress', 'earned', 'redeemed', 'expired', 'revoked'])
        .withMessage('status must be progress, earned, redeemed, expired, or revoked'),
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    query('customerId')
        .optional()
        .trim(),
    ...validatePagination,
    handleValidationErrors
];

/**
 * GET /api/loyalty/redemptions
 * Get redemption history
 */
const listRedemptions = [
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    query('customerId')
        .optional()
        .trim(),
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('startDate must be a valid date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('endDate must be a valid date'),
    ...validatePagination,
    handleValidationErrors
];

/**
 * GET /api/loyalty/audit
 * Get audit log entries
 */
const listAudit = [
    query('action')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('action cannot exceed 100 characters'),
    query('squareCustomerId')
        .optional()
        .trim(),
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    ...validatePagination,
    handleValidationErrors
];

/**
 * PUT /api/loyalty/offers/:id/square-tier
 * Link offer to Square Loyalty tier
 */
const linkSquareTier = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    body('squareRewardTierId')
        .optional({ nullable: true })
        .trim(),
    handleValidationErrors
];

/**
 * POST /api/loyalty/rewards/:id/create-square-reward
 * Create Square Customer Group Discount for reward
 */
const createSquareReward = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    query('force')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('force must be true or false'),
    body('force')
        .optional()
        .isBoolean()
        .withMessage('force must be a boolean'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/rewards/sync-to-pos
 * Bulk sync earned rewards to Square POS
 */
const syncToPOS = [
    query('force')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('force must be true or false'),
    body('force')
        .optional()
        .isBoolean()
        .withMessage('force must be a boolean'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/customers/search
 * Search customers
 */
const searchCustomers = [
    query('q')
        .trim()
        .isLength({ min: 2, max: 255 })
        .withMessage('Search query must be 2-255 characters'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/backfill
 * Backfill loyalty from recent orders
 */
const backfill = [
    body('days')
        .optional()
        .isInt({ min: 1, max: 90 })
        .withMessage('days must be between 1 and 90'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/catchup
 * Run reverse lookup loyalty catchup
 */
const catchup = [
    body('days')
        .optional()
        .isInt({ min: 1, max: 365 })
        .withMessage('days must be between 1 and 365'),
    body('customerIds')
        .optional()
        .isArray()
        .withMessage('customerIds must be an array'),
    body('maxCustomers')
        .optional()
        .isInt({ min: 1, max: 1000 })
        .withMessage('maxCustomers must be between 1 and 1000'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/manual-entry
 * Manual loyalty purchase entry
 */
const manualEntry = [
    body('squareOrderId')
        .trim()
        .notEmpty()
        .withMessage('squareOrderId is required'),
    body('squareCustomerId')
        .trim()
        .notEmpty()
        .withMessage('squareCustomerId is required'),
    body('variationId')
        .trim()
        .notEmpty()
        .withMessage('variationId is required'),
    body('quantity')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('quantity must be between 1 and 100'),
    body('purchasedAt')
        .optional()
        .isISO8601()
        .withMessage('purchasedAt must be a valid date'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/process-order/:orderId
 * Manually process an order for loyalty
 */
const processOrder = [
    param('orderId')
        .trim()
        .notEmpty()
        .withMessage('orderId is required'),
    handleValidationErrors
];

/**
 * PUT /api/loyalty/settings
 * Update loyalty settings
 */
const updateSettings = [
    body()
        .isObject()
        .withMessage('Request body must be an object'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/vendor-receipt/:redemptionId
 * Get vendor receipt
 */
const getVendorReceipt = [
    param('redemptionId')
        .isInt({ min: 1 })
        .withMessage('redemptionId must be a positive integer'),
    query('format')
        .optional()
        .isIn(['html', 'json'])
        .withMessage('format must be html or json'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/redemptions/csv
 * Export redemptions as CSV
 */
const exportRedemptionsCSV = [
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('startDate must be a valid date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('endDate must be a valid date'),
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    query('brandName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('brandName cannot exceed 255 characters'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/audit/csv
 * Export audit log as CSV
 */
const exportAuditCSV = [
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('startDate must be a valid date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('endDate must be a valid date'),
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    query('squareCustomerId')
        .optional()
        .trim(),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/summary/csv
 * Export summary as CSV
 */
const exportSummaryCSV = [
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('startDate must be a valid date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('endDate must be a valid date'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/customers/csv
 * Export customer activity as CSV
 */
const exportCustomersCSV = [
    query('offerId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('offerId must be a positive integer'),
    query('minPurchases')
        .optional()
        .isInt({ min: 1 })
        .withMessage('minPurchases must be a positive integer'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/redemption/:redemptionId
 * Get redemption details
 */
const getRedemptionDetails = [
    param('redemptionId')
        .isInt({ min: 1 })
        .withMessage('redemptionId must be a positive integer'),
    handleValidationErrors
];

module.exports = {
    listOffers,
    createOffer,
    getOffer,
    updateOffer,
    deleteOffer,
    addVariations,
    getOfferVariations,
    removeVariation,
    getCustomer,
    getCustomerHistory,
    getCustomerAuditHistory,
    addOrders,
    redeemReward,
    listRewards,
    listRedemptions,
    listAudit,
    linkSquareTier,
    createSquareReward,
    syncToPOS,
    searchCustomers,
    backfill,
    catchup,
    manualEntry,
    processOrder,
    updateSettings,
    getVendorReceipt,
    exportRedemptionsCSV,
    exportAuditCSV,
    exportSummaryCSV,
    exportCustomersCSV,
    getRedemptionDetails
};
