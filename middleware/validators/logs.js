/**
 * Logs Route Validators
 */

const { query } = require('express-validator');
const { handleValidationErrors } = require('./index');

const dateParam = query('date')
    .optional()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('date must be in YYYY-MM-DD format');

const list = [
    query('limit').optional().isInt({ min: 0, max: 10000 }),
    dateParam,
    handleValidationErrors
];

const errors = [
    query('limit').optional().isInt({ min: 0, max: 10000 }),
    dateParam,
    handleValidationErrors
];

const download = [handleValidationErrors];

const stats = [handleValidationErrors];

const dates = [handleValidationErrors];

module.exports = {
    list,
    errors,
    download,
    stats,
    dates
};
