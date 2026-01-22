/**
 * Google OAuth Route Validators
 *
 * Validates input for Google OAuth endpoints
 */

const { query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * GET /api/google/status
 * No additional validation needed - uses merchant context from middleware
 */
const status = [
    handleValidationErrors
];

/**
 * GET /api/google/auth
 * No additional validation needed - uses merchant context from middleware
 */
const auth = [
    handleValidationErrors
];

/**
 * GET /api/google/callback
 * Validates OAuth callback query parameters
 */
const callback = [
    query('code')
        .optional()
        .trim()
        .isLength({ min: 1, max: 2000 })
        .withMessage('code must be 1-2000 characters'),
    query('state')
        .optional()
        .trim()
        .isLength({ min: 1, max: 1000 })
        .withMessage('state must be 1-1000 characters'),
    query('error')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('error must be 500 characters or less'),
    handleValidationErrors
];

/**
 * POST /api/google/disconnect
 * No additional validation needed - uses merchant context from middleware
 */
const disconnect = [
    handleValidationErrors
];

module.exports = {
    status,
    auth,
    callback,
    disconnect
};
