/**
 * Logs Route Validators
 */

const { query } = require('express-validator');
const { handleValidationErrors } = require('./index');

const list = [
    query('limit').optional().isInt({ min: 0, max: 10000 }),
    handleValidationErrors
];

const errors = [handleValidationErrors];

const download = [handleValidationErrors];

const stats = [handleValidationErrors];

module.exports = {
    list,
    errors,
    download,
    stats
};
