/**
 * Min/Max Suppression Route Validators
 *
 * Validates input for:
 *   GET  /api/min-max/suppressed    — items skipped in last cron run
 *   GET  /api/min-max/audit-log     — recent applied min changes
 *   POST /api/min-max/toggle-pin    — pin/unpin a variation from auto-adjustment
 */

const { query, body } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * GET /api/min-max/suppressed
 * No required params.
 */
const getSuppressed = [
    handleValidationErrors
];

/**
 * GET /api/min-max/audit-log
 * Query: limit (1-200, default 50)
 */
const getAuditLog = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 200 })
        .withMessage('limit must be between 1 and 200'),
    handleValidationErrors
];

/**
 * POST /api/min-max/toggle-pin
 * Body: { variationId, locationId, pinned }
 */
const togglePin = [
    body('variationId')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('variationId is required (1-255 chars)'),
    body('locationId')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('locationId is required (1-255 chars)'),
    body('pinned')
        .isBoolean()
        .withMessage('pinned must be true or false'),
    handleValidationErrors
];

module.exports = { getSuppressed, getAuditLog, togglePin };
