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

// Helper to validate positive integer in range (handles JSON number types)
const isIntInRange = (value, fieldName, min, max) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < min || (max !== undefined && num > max)) {
        if (max !== undefined) {
            throw new Error(`${fieldName} must be between ${min} and ${max}`);
        }
        throw new Error(`${fieldName} must be a positive integer`);
    }
    return true;
};

// Helper to validate non-negative integer (handles JSON number types)
const isNonNegativeInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return true;
};

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
        .custom((value) => isIntInRange(value, 'requiredQuantity', 1, 1000)),
    body('offerName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('offerName cannot exceed 255 characters'),
    body('windowMonths')
        .optional()
        .custom((value) => isIntInRange(value, 'windowMonths', 1, 36)),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('description cannot exceed 1000 characters'),
    body('vendorId')
        .optional()
        .custom((value) => isIntInRange(value, 'vendorId', 1)),
    handleValidationErrors
];

/**
 * GET /api/loyalty/offers/:id
 * Get a single offer
 */
const getOffer = [
    param('id')
        .isUUID()
        .withMessage('id must be a valid UUID'),
    handleValidationErrors
];

/**
 * PATCH /api/loyalty/offers/:id
 * Update a loyalty offer
 */
const updateOffer = [
    param('id')
        .isUUID()
        .withMessage('id must be a valid UUID'),
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
        .custom((value) => isIntInRange(value, 'window_months', 1, 36)),
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
        .isUUID()
        .withMessage('id must be a valid UUID'),
    handleValidationErrors
];

/**
 * POST /api/loyalty/offers/:id/variations
 * Add qualifying variations to an offer
 */
const addVariations = [
    param('id')
        .isUUID()
        .withMessage('id must be a valid UUID'),
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
        .isUUID()
        .withMessage('id must be a valid UUID'),
    handleValidationErrors
];

/**
 * DELETE /api/loyalty/offers/:offerId/variations/:variationId
 * Remove a qualifying variation from an offer
 */
const removeVariation = [
    param('offerId')
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
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
        .isUUID()
        .withMessage('rewardId must be a valid UUID'),
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
        .custom((value) => isNonNegativeInt(value, 'redeemedValueCents')),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
    ...validatePagination,
    handleValidationErrors
];

/**
 * PUT /api/loyalty/offers/:id/square-tier
 * Link offer to Square Loyalty tier
 */
const linkSquareTier = [
    param('id')
        .isUUID()
        .withMessage('id must be a valid UUID'),
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
        .isUUID()
        .withMessage('id must be a valid UUID'),
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
        .custom((value) => isIntInRange(value, 'days', 1, 90)),
    handleValidationErrors
];

/**
 * POST /api/loyalty/catchup
 * Run reverse lookup loyalty catchup
 */
const catchup = [
    body('days')
        .optional()
        .custom((value) => isIntInRange(value, 'days', 1, 365)),
    body('customerIds')
        .optional()
        .isArray()
        .withMessage('customerIds must be an array'),
    body('maxCustomers')
        .optional()
        .custom((value) => isIntInRange(value, 'maxCustomers', 1, 1000)),
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
        .custom((value) => isIntInRange(value, 'quantity', 1, 100)),
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
 * GET /api/loyalty/reports/vendor-receipt/:rewardId
 * Get vendor receipt
 */
const getVendorReceipt = [
    param('rewardId')
        .isUUID()
        .withMessage('rewardId must be a valid UUID'),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
    query('minPurchases')
        .optional()
        .isInt({ min: 1 })
        .withMessage('minPurchases must be a positive integer'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/redemption/:rewardId
 * Get redemption details
 */
const getRedemptionDetails = [
    param('rewardId')
        .isUUID()
        .withMessage('rewardId must be a valid UUID'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/reports/brand-redemptions
 * Get brand redemption report (filterable by date range, offer, brand)
 */
const getBrandRedemptions = [
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
        .isUUID()
        .withMessage('offerId must be a valid UUID'),
    query('brandName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('brandName cannot exceed 255 characters'),
    query('format')
        .optional()
        .isIn(['json', 'html', 'csv'])
        .withMessage('format must be json, html, or csv'),
    handleValidationErrors
];

/**
 * GET /api/loyalty/audit-findings
 * List unresolved audit findings (orphaned rewards)
 */
const listAuditFindings = [
    query('resolved')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('resolved must be true or false'),
    query('issueType')
        .optional()
        .isIn(['MISSING_REDEMPTION', 'PHANTOM_REWARD', 'DOUBLE_REDEMPTION'])
        .withMessage('issueType must be MISSING_REDEMPTION, PHANTOM_REWARD, or DOUBLE_REDEMPTION'),
    ...validatePagination,
    handleValidationErrors
];

/**
 * POST /api/loyalty/audit-findings/resolve/:id
 * Mark an audit finding as resolved
 */
const resolveAuditFinding = [
    param('id')
        .isUUID()
        .withMessage('id must be a valid UUID'),
    handleValidationErrors
];

/**
 * PATCH /api/loyalty/rewards/:rewardId/vendor-credit
 * Update vendor credit submission status
 */
const updateVendorCredit = [
    param('rewardId')
        .isUUID()
        .withMessage('rewardId must be a valid UUID'),
    body('status')
        .trim()
        .notEmpty()
        .withMessage('status is required')
        .isIn(['SUBMITTED', 'CREDITED', 'DENIED'])
        .withMessage('status must be SUBMITTED, CREDITED, or DENIED'),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('notes cannot exceed 1000 characters'),
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
    getRedemptionDetails,
    getBrandRedemptions,
    listAuditFindings,
    resolveAuditFinding,
    updateVendorCredit
};
