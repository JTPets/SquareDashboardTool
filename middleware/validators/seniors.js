/**
 * Validators for Seniors Discount routes
 */

const { body, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * GET /api/seniors/members
 */
const listMembers = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 500 })
        .withMessage('limit must be between 1 and 500'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('offset must be a non-negative integer'),
    handleValidationErrors,
];

/**
 * GET /api/seniors/audit-log
 */
const listAuditLog = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 500 })
        .withMessage('limit must be between 1 and 500'),
    handleValidationErrors,
];

/**
 * PATCH /api/seniors/config
 */
const updateConfig = [
    body('discount_percent')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('discount_percent must be between 1 and 100'),
    body('min_age')
        .optional()
        .isInt({ min: 1, max: 120 })
        .withMessage('min_age must be between 1 and 120'),
    body('day_of_month')
        .optional()
        .isInt({ min: 1, max: 28 })
        .withMessage('day_of_month must be between 1 and 28'),
    body('is_enabled')
        .optional()
        .isBoolean()
        .withMessage('is_enabled must be a boolean'),
    handleValidationErrors,
];

module.exports = {
    listMembers,
    listAuditLog,
    updateConfig,
};
