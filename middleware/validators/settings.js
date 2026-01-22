/**
 * Settings Route Validators
 */

const { body } = require('express-validator');
const { handleValidationErrors } = require('./index');

// Helper to validate non-negative integer (handles both string and number types from JSON)
const isNonNegativeInt = (value, fieldName) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return true;
};

const get = [handleValidationErrors];

const update = [
    body('reorder_safety_days').optional().custom((value) => isNonNegativeInt(value, 'reorder_safety_days')),
    body('default_supply_days').optional().custom((value) => isNonNegativeInt(value, 'default_supply_days')),
    body('reorder_priority_urgent_days').optional().custom((value) => isNonNegativeInt(value, 'reorder_priority_urgent_days')),
    body('reorder_priority_high_days').optional().custom((value) => isNonNegativeInt(value, 'reorder_priority_high_days')),
    body('reorder_priority_medium_days').optional().custom((value) => isNonNegativeInt(value, 'reorder_priority_medium_days')),
    body('reorder_priority_low_days').optional().custom((value) => isNonNegativeInt(value, 'reorder_priority_low_days')),
    body('daily_count_target').optional().custom((value) => isNonNegativeInt(value, 'daily_count_target')),
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
