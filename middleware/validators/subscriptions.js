/**
 * Validators for Subscription routes
 *
 * SECURITY NOTE: These handle payment processing operations.
 * - No credit card data stored locally (Square handles all PCI compliance)
 * - Only Square IDs (customer_id, card_id, subscription_id) are stored
 */

const { body, query, param } = require('express-validator');
const {
    handleValidationErrors,
    validateEmail,
    validateOptionalString,
    validateCurrencyAmount,
    validatePromoCode
} = require('./index');

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
 * POST /api/subscriptions/promo/validate
 * Validate a promo code
 */
const validatePromo = [
    body('code')
        .trim()
        .notEmpty()
        .withMessage('Promo code is required'),
    body('plan')
        .optional()
        .isIn(['monthly', 'annual'])
        .withMessage('plan must be monthly or annual'),
    body('priceCents')
        .optional()
        .custom((value) => isNonNegativeInt(value, 'priceCents')),
    handleValidationErrors
];

/**
 * POST /api/subscriptions/create
 * Create a new subscription
 */
const createSubscription = [
    validateEmail('email'),
    body('businessName')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('Business name cannot exceed 255 characters'),
    body('plan')
        .isIn(['monthly', 'annual'])
        .withMessage('plan must be monthly or annual'),
    body('sourceId')
        .trim()
        .notEmpty()
        .withMessage('Payment source is required'),
    body('promoCode')
        .optional()
        .trim()
        .isLength({ max: 50 })
        .withMessage('Promo code cannot exceed 50 characters'),
    body('termsAcceptedAt')
        .notEmpty()
        .withMessage('Terms of Service must be accepted'),
    handleValidationErrors
];

/**
 * GET /api/subscriptions/status
 * Check subscription status
 */
const checkStatus = [
    query('email')
        .trim()
        .notEmpty()
        .isEmail()
        .withMessage('Valid email is required'),
    handleValidationErrors
];

/**
 * POST /api/subscriptions/cancel
 * Cancel a subscription
 */
const cancelSubscription = [
    validateEmail('email'),
    validateOptionalString('reason', { maxLength: 1000 }),
    handleValidationErrors
];

/**
 * POST /api/subscriptions/refund
 * Process a refund (admin only)
 */
const processRefund = [
    validateEmail('email'),
    validateOptionalString('reason', { maxLength: 1000 }),
    handleValidationErrors
];

/**
 * GET /api/subscriptions/admin/list
 * List all subscribers (admin)
 */
const listSubscribers = [
    query('status')
        .optional()
        .isIn(['active', 'canceled', 'expired', 'trial'])
        .withMessage('status must be one of: active, canceled, expired, trial'),
    handleValidationErrors
];

/**
 * GET /api/webhooks/events
 * View webhook events (super admin)
 */
const listWebhookEvents = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 500 })
        .withMessage('limit must be between 1 and 500'),
    query('status')
        .optional()
        .isIn(['completed', 'failed', 'skipped', 'pending'])
        .withMessage('status must be one of: completed, failed, skipped, pending'),
    query('event_type')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('event_type cannot exceed 100 characters'),
    handleValidationErrors
];

module.exports = {
    validatePromo,
    createSubscription,
    checkStatus,
    cancelSubscription,
    processRefund,
    listSubscribers,
    listWebhookEvents
};
