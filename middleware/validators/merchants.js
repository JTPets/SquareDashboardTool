/**
 * Merchant Route Validators
 */

const { body } = require('express-validator');
const { handleValidationErrors } = require('./index');

const list = [handleValidationErrors];

const switch_ = [
    body('merchantId')
        .exists({ checkNull: true }).withMessage('merchantId is required')
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error('merchantId must be a positive integer');
            }
            return true;
        }),
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
