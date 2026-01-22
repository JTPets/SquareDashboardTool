/**
 * Sync Route Validators
 *
 * Validation middleware for sync endpoints using express-validator.
 */

const { query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * POST /api/sync - Full synchronization
 * No body parameters required
 */
const sync = [
    handleValidationErrors
];

/**
 * POST /api/sync-sales - Sales velocity sync
 * No body parameters required
 */
const syncSales = [
    handleValidationErrors
];

/**
 * POST /api/sync-smart - Smart sync
 * No body parameters required
 */
const syncSmart = [
    handleValidationErrors
];

/**
 * GET /api/sync-history - Get sync history
 */
const syncHistory = [
    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be between 1 and 100'),
    handleValidationErrors
];

/**
 * GET /api/sync-intervals - Get sync intervals
 * No parameters required
 */
const syncIntervals = [
    handleValidationErrors
];

/**
 * GET /api/sync-status - Get sync status
 * No parameters required
 */
const syncStatus = [
    handleValidationErrors
];

module.exports = {
    sync,
    syncSales,
    syncSmart,
    syncHistory,
    syncIntervals,
    syncStatus
};
