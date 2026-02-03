/**
 * Cart Activity Validators
 *
 * Input validation for cart activity endpoints using express-validator.
 */

const { query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * List cart activity - validate query parameters
 */
const list = [
    query('status')
        .optional()
        .isIn(['pending', 'converted', 'abandoned', 'canceled'])
        .withMessage('Status must be one of: pending, converted, abandoned, canceled'),
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('Start date must be a valid ISO date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('End date must be a valid ISO date'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 200 })
        .withMessage('Limit must be between 1 and 200'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Offset must be a non-negative integer'),
    handleValidationErrors
];

/**
 * Get stats - validate query parameters
 */
const stats = [
    query('days')
        .optional()
        .isInt({ min: 1, max: 365 })
        .withMessage('Days must be between 1 and 365'),
    handleValidationErrors
];

module.exports = {
    list,
    stats
};
