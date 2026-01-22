/**
 * Express-validator utilities and common validators
 *
 * This module provides:
 * 1. Common validation middleware
 * 2. Reusable validators for common patterns (IDs, emails, pagination)
 * 3. A handleValidationErrors middleware to standardize error responses
 */

const { validationResult, param, query, body } = require('express-validator');

/**
 * Middleware to handle validation errors
 * Returns 400 with array of error messages if validation fails
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            error: 'Validation failed',
            details: errors.array().map(err => ({
                field: err.path,
                message: err.msg
            }))
        });
    }
    next();
};

// ==================== COMMON VALIDATORS ====================

/**
 * Validate UUID parameter
 * @param {string} paramName - Name of the URL parameter
 */
const validateUUID = (paramName) =>
    param(paramName)
        .isUUID()
        .withMessage(`${paramName} must be a valid UUID`);

/**
 * Validate integer ID parameter
 * @param {string} paramName - Name of the URL parameter
 */
const validateIntId = (paramName) =>
    param(paramName)
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error(`${paramName} must be a positive integer`);
            }
            return true;
        });

/**
 * Validate email
 */
const validateEmail = (fieldName = 'email') =>
    body(fieldName)
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required');

/**
 * Validate optional email
 */
const validateOptionalEmail = (fieldName = 'email') =>
    body(fieldName)
        .optional()
        .isEmail()
        .normalizeEmail()
        .withMessage('Must be a valid email if provided');

/**
 * Validate positive integer in body
 */
const validatePositiveInt = (fieldName, options = {}) =>
    body(fieldName)
        .custom((value) => {
            const num = Number(value);
            const min = options.min || 1;
            const max = options.max;
            if (!Number.isInteger(num) || num < min || (max !== undefined && num > max)) {
                throw new Error(options.message || `${fieldName} must be a positive integer`);
            }
            return true;
        });

/**
 * Validate optional positive integer in body
 */
const validateOptionalPositiveInt = (fieldName, options = {}) =>
    body(fieldName)
        .optional()
        .custom((value) => {
            const num = Number(value);
            const min = options.min || 1;
            const max = options.max;
            if (!Number.isInteger(num) || num < min || (max !== undefined && num > max)) {
                throw new Error(options.message || `${fieldName} must be a positive integer if provided`);
            }
            return true;
        });

/**
 * Validate non-negative currency amount (cents)
 */
const validateCurrencyAmount = (fieldName) =>
    body(fieldName)
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 0) {
                throw new Error(`${fieldName} must be a non-negative integer (cents)`);
            }
            return true;
        });

/**
 * Validate optional currency amount
 */
const validateOptionalCurrencyAmount = (fieldName) =>
    body(fieldName)
        .optional()
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 0) {
                throw new Error(`${fieldName} must be a non-negative integer (cents) if provided`);
            }
            return true;
        });

/**
 * Validate required non-empty string
 */
const validateRequiredString = (fieldName, options = {}) =>
    body(fieldName)
        .trim()
        .notEmpty()
        .withMessage(options.message || `${fieldName} is required`)
        .isLength({ max: options.maxLength || 1000 })
        .withMessage(`${fieldName} cannot exceed ${options.maxLength || 1000} characters`);

/**
 * Validate optional string with max length
 */
const validateOptionalString = (fieldName, options = {}) =>
    body(fieldName)
        .optional()
        .trim()
        .isLength({ max: options.maxLength || 1000 })
        .withMessage(`${fieldName} cannot exceed ${options.maxLength || 1000} characters`);

/**
 * Validate enum value
 */
const validateEnum = (fieldName, allowedValues, options = {}) =>
    body(fieldName)
        .isIn(allowedValues)
        .withMessage(options.message || `${fieldName} must be one of: ${allowedValues.join(', ')}`);

/**
 * Validate optional enum
 */
const validateOptionalEnum = (fieldName, allowedValues, options = {}) =>
    body(fieldName)
        .optional()
        .isIn(allowedValues)
        .withMessage(options.message || `${fieldName} must be one of: ${allowedValues.join(', ')}`);

/**
 * Validate pagination query parameters
 */
const validatePagination = [
    query('limit')
        .optional()
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1 || num > 1000) {
                throw new Error('limit must be between 1 and 1000');
            }
            return true;
        }),
    query('offset')
        .optional()
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 0) {
                throw new Error('offset must be a non-negative integer');
            }
            return true;
        })
];

/**
 * Validate date string (ISO format)
 */
const validateDate = (fieldName) =>
    body(fieldName)
        .isISO8601()
        .withMessage(`${fieldName} must be a valid date`);

/**
 * Validate optional date
 */
const validateOptionalDate = (fieldName) =>
    body(fieldName)
        .optional()
        .isISO8601()
        .withMessage(`${fieldName} must be a valid date if provided`);

/**
 * Validate latitude
 */
const validateLatitude = (fieldName = 'latitude') =>
    body(fieldName)
        .optional()
        .isFloat({ min: -90, max: 90 })
        .withMessage(`${fieldName} must be between -90 and 90`);

/**
 * Validate longitude
 */
const validateLongitude = (fieldName = 'longitude') =>
    body(fieldName)
        .optional()
        .isFloat({ min: -180, max: 180 })
        .withMessage(`${fieldName} must be between -180 and 180`);

/**
 * Validate phone number (basic validation)
 */
const validatePhone = (fieldName = 'phone') =>
    body(fieldName)
        .optional()
        .matches(/^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]*$/)
        .withMessage(`${fieldName} must be a valid phone number`);

/**
 * Validate array field is present and non-empty
 */
const validateNonEmptyArray = (fieldName) =>
    body(fieldName)
        .isArray({ min: 1 })
        .withMessage(`${fieldName} must be a non-empty array`);

/**
 * Validate optional array
 */
const validateOptionalArray = (fieldName) =>
    body(fieldName)
        .optional()
        .isArray()
        .withMessage(`${fieldName} must be an array if provided`);

/**
 * Validate boolean
 */
const validateBoolean = (fieldName) =>
    body(fieldName)
        .isBoolean()
        .withMessage(`${fieldName} must be a boolean`);

/**
 * Validate optional boolean
 */
const validateOptionalBoolean = (fieldName) =>
    body(fieldName)
        .optional()
        .isBoolean()
        .withMessage(`${fieldName} must be a boolean if provided`);

/**
 * Validate URL parameter token (alphanumeric, dashes, underscores)
 */
const validateToken = (paramName = 'token') =>
    param(paramName)
        .matches(/^[a-zA-Z0-9_-]{16,128}$/)
        .withMessage(`${paramName} must be a valid token (16-128 alphanumeric characters)`);

/**
 * Validate promo/discount code format
 */
const validatePromoCode = (fieldName = 'code') =>
    body(fieldName)
        .optional()
        .trim()
        .isLength({ min: 1, max: 50 })
        .withMessage('Promo code must be 1-50 characters')
        .matches(/^[A-Za-z0-9_-]+$/)
        .withMessage('Promo code can only contain letters, numbers, dashes, and underscores');

/**
 * Custom validator function for UUID format
 * For use with .custom() in validation chains
 * @param {string} value - Value to validate
 * @returns {boolean} True if valid UUID
 */
const isValidUUID = (value) => {
    if (!value) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(value);
};

/**
 * Sanitize string - trim and remove null bytes
 * For use with .customSanitizer()
 * @param {string} value - Value to sanitize
 * @returns {string} Sanitized string
 */
const sanitizeString = (value) => {
    if (typeof value !== 'string') return value;
    return value.trim().replace(/\0/g, '');
};

module.exports = {
    handleValidationErrors,
    validateUUID,
    validateIntId,
    validateEmail,
    validateOptionalEmail,
    validatePositiveInt,
    validateOptionalPositiveInt,
    validateCurrencyAmount,
    validateOptionalCurrencyAmount,
    validateRequiredString,
    validateOptionalString,
    validateEnum,
    validateOptionalEnum,
    validatePagination,
    validateDate,
    validateOptionalDate,
    validateLatitude,
    validateLongitude,
    validatePhone,
    validateNonEmptyArray,
    validateOptionalArray,
    validateBoolean,
    validateOptionalBoolean,
    validateToken,
    validatePromoCode,
    // Custom validators for use with .custom()
    isValidUUID,
    sanitizeString
};
