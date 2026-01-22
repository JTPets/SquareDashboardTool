/**
 * Settings Route Validators
 */

const { body } = require('express-validator');
const { handleValidationErrors } = require('./index');

const get = [handleValidationErrors];

const update = [
    body('reorder_safety_days').optional().isInt({ min: 0 }),
    body('default_supply_days').optional().isInt({ min: 0 }),
    body('reorder_priority_urgent_days').optional().isInt({ min: 0 }),
    body('reorder_priority_high_days').optional().isInt({ min: 0 }),
    body('reorder_priority_medium_days').optional().isInt({ min: 0 }),
    body('reorder_priority_low_days').optional().isInt({ min: 0 }),
    body('daily_count_target').optional().isInt({ min: 0 }),
    body('cycle_count_email_enabled').optional().isBoolean(),
    body('cycle_count_report_email').optional().isBoolean(),
    body('low_stock_alerts_enabled').optional().isBoolean(),
    handleValidationErrors
];

const defaults = [handleValidationErrors];

module.exports = {
    get,
    update,
    defaults
};
