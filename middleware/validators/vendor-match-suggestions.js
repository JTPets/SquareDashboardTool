/**
 * Validators for vendor match suggestion endpoints — BACKLOG-114
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/** GET /api/vendor-match-suggestions */
const listSuggestions = [
    query('status')
        .optional()
        .isIn(['pending', 'approved', 'rejected'])
        .withMessage('status must be pending, approved, or rejected'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 200 })
        .withMessage('limit must be between 1 and 200'),
    query('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('offset must be a non-negative integer'),
    handleValidationErrors
];

/** POST /api/vendor-match-suggestions/:id/approve */
const approveOrReject = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('id must be a positive integer'),
    handleValidationErrors
];

/** POST /api/vendor-match-suggestions/bulk-approve */
const bulkApprove = [
    body('ids')
        .isArray({ min: 1 })
        .withMessage('ids must be a non-empty array'),
    body('ids.*')
        .isInt({ min: 1 })
        .withMessage('each id must be a positive integer'),
    handleValidationErrors
];

module.exports = { listSuggestions, approveOrReject, bulkApprove };
