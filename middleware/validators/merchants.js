/**
 * Merchant Route Validators
 */

const { body } = require('express-validator');
const { handleValidationErrors } = require('./index');

const list = [handleValidationErrors];

const switch_ = [
    body('merchantId').isInt({ min: 1 }).withMessage('merchantId must be a positive integer'),
    handleValidationErrors
];

const context = [handleValidationErrors];

const config = [handleValidationErrors];

module.exports = {
    list,
    switch: switch_,
    context,
    config
};
