/**
 * Delivery Route Validators
 *
 * Input validation for delivery-related endpoints using express-validator.
 * Validates order operations, route management, POD uploads, and settings.
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors, isValidUUID, sanitizeString } = require('./index');

// Helper to validate integer in range (handles JSON number types)
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

/**
 * List orders - validate query parameters
 */
const listOrders = [
    query('status')
        .optional()
        .isString()
        .withMessage('Status must be a string'),
    query('routeDate')
        .optional()
        .isISO8601()
        .withMessage('Route date must be a valid date'),
    query('routeId')
        .optional()
        .custom(isValidUUID)
        .withMessage('Route ID must be a valid UUID'),
    query('dateFrom')
        .optional()
        .isISO8601()
        .withMessage('Date from must be a valid date'),
    query('dateTo')
        .optional()
        .isISO8601()
        .withMessage('Date to must be a valid date'),
    query('includeCompleted')
        .optional()
        .isIn(['true', 'false'])
        .withMessage('Include completed must be true or false'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 500 })
        .withMessage('Limit must be between 1 and 500'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Offset must be a non-negative integer'),
    handleValidationErrors
];

/**
 * Create order - validate body
 */
const createOrder = [
    body('customerName')
        .notEmpty()
        .withMessage('Customer name is required')
        .isString()
        .isLength({ max: 255 })
        .withMessage('Customer name must be 255 characters or less')
        .customSanitizer(sanitizeString),
    body('address')
        .notEmpty()
        .withMessage('Address is required')
        .isString()
        .isLength({ max: 500 })
        .withMessage('Address must be 500 characters or less')
        .customSanitizer(sanitizeString),
    body('phone')
        .optional()
        .isString()
        .isLength({ max: 50 })
        .withMessage('Phone must be 50 characters or less'),
    body('notes')
        .optional()
        .isString()
        .isLength({ max: 2000 })
        .withMessage('Notes must be 2000 characters or less')
        .customSanitizer(sanitizeString),
    handleValidationErrors
];

/**
 * Get single order - validate ID param
 */
const getOrder = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Update order - validate body
 */
const updateOrder = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    body('notes')
        .optional()
        .isString()
        .isLength({ max: 2000 })
        .withMessage('Notes must be 2000 characters or less')
        .customSanitizer(sanitizeString),
    body('phone')
        .optional()
        .isString()
        .isLength({ max: 50 })
        .withMessage('Phone must be 50 characters or less'),
    body('customerName')
        .optional()
        .isString()
        .isLength({ max: 255 })
        .withMessage('Customer name must be 255 characters or less')
        .customSanitizer(sanitizeString),
    body('address')
        .optional()
        .isString()
        .isLength({ max: 500 })
        .withMessage('Address must be 500 characters or less')
        .customSanitizer(sanitizeString),
    handleValidationErrors
];

/**
 * Delete order - validate ID param
 */
const deleteOrder = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Skip order - validate ID param
 */
const skipOrder = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Complete order - validate ID param
 */
const completeOrder = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Update customer note - validate body
 */
const updateCustomerNote = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    body('note')
        .optional({ nullable: true })
        .isString()
        .isLength({ max: 2000 })
        .withMessage('Note must be 2000 characters or less')
        .customSanitizer(sanitizeString),
    handleValidationErrors
];

/**
 * Update order notes - validate body
 */
const updateOrderNotes = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    body('notes')
        .optional({ nullable: true })
        .isString()
        .isLength({ max: 2000 })
        .withMessage('Notes must be 2000 characters or less')
        .customSanitizer(sanitizeString),
    handleValidationErrors
];

/**
 * Upload POD - validate params and body
 */
const uploadPod = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    body('latitude')
        .optional()
        .isFloat({ min: -90, max: 90 })
        .withMessage('Latitude must be between -90 and 90'),
    body('longitude')
        .optional()
        .isFloat({ min: -180, max: 180 })
        .withMessage('Longitude must be between -180 and 180'),
    handleValidationErrors
];

/**
 * Get POD - validate ID param
 */
const getPod = [
    param('id')
        .custom(isValidUUID)
        .withMessage('POD ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Generate route - validate body
 */
const generateRoute = [
    body('routeDate')
        .optional()
        .isISO8601()
        .withMessage('Route date must be a valid date'),
    body('orderIds')
        .optional()
        .isArray()
        .withMessage('Order IDs must be an array'),
    body('orderIds.*')
        .optional()
        .custom(isValidUUID)
        .withMessage('Each order ID must be a valid UUID'),
    body('force')
        .optional()
        .isBoolean()
        .withMessage('Force must be a boolean'),
    handleValidationErrors
];

/**
 * Get active route - validate query
 */
const getActiveRoute = [
    query('routeDate')
        .optional()
        .isISO8601()
        .withMessage('Route date must be a valid date'),
    handleValidationErrors
];

/**
 * Get specific route - validate ID param
 */
const getRoute = [
    param('id')
        .custom(isValidUUID)
        .withMessage('Route ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Finish route - validate body
 */
const finishRoute = [
    body('routeId')
        .optional()
        .custom(isValidUUID)
        .withMessage('Route ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Geocode pending orders - validate body
 */
const geocode = [
    body('limit')
        .optional()
        .custom((value) => isIntInRange(value, 'limit', 1, 100)),
    handleValidationErrors
];

/**
 * Update settings - validate body
 */
const updateSettings = [
    body('startAddress')
        .optional()
        .isString()
        .isLength({ max: 500 })
        .withMessage('Start address must be 500 characters or less')
        .customSanitizer(sanitizeString),
    body('endAddress')
        .optional()
        .isString()
        .isLength({ max: 500 })
        .withMessage('End address must be 500 characters or less')
        .customSanitizer(sanitizeString),
    body('sameDayCutoff')
        .optional()
        .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
        .withMessage('Same day cutoff must be in HH:MM format'),
    body('podRetentionDays')
        .optional()
        .custom((value) => isIntInRange(value, 'podRetentionDays', 1, 365)),
    body('autoIngestReadyOrders')
        .optional()
        .isBoolean()
        .withMessage('Auto ingest ready orders must be a boolean'),
    body('openrouteserviceApiKey')
        .optional()
        .isString()
        .isLength({ max: 255 })
        .withMessage('API key must be 255 characters or less'),
    handleValidationErrors
];

/**
 * Get audit log - validate query
 */
const getAudit = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 500 })
        .withMessage('Limit must be between 1 and 500'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Offset must be a non-negative integer'),
    query('action')
        .optional()
        .isString()
        .isLength({ max: 50 })
        .withMessage('Action must be 50 characters or less'),
    query('orderId')
        .optional()
        .custom(isValidUUID)
        .withMessage('Order ID must be a valid UUID'),
    query('routeId')
        .optional()
        .custom(isValidUUID)
        .withMessage('Route ID must be a valid UUID'),
    handleValidationErrors
];

/**
 * Sync orders from Square - validate body
 */
const syncOrders = [
    body('daysBack')
        .optional()
        .custom((value) => isIntInRange(value, 'daysBack', 1, 30)),
    handleValidationErrors
];

module.exports = {
    listOrders,
    createOrder,
    getOrder,
    updateOrder,
    deleteOrder,
    skipOrder,
    completeOrder,
    updateCustomerNote,
    updateOrderNotes,
    uploadPod,
    getPod,
    generateRoute,
    getActiveRoute,
    getRoute,
    finishRoute,
    geocode,
    updateSettings,
    getAudit,
    syncOrders
};
