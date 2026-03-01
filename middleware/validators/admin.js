/**
 * Admin Route Validators
 */

const { param, body } = require('express-validator');
const { handleValidationErrors } = require('./index');

const listMerchants = [handleValidationErrors];

const extendTrial = [
    param('merchantId')
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error('merchantId must be a positive integer');
            }
            return true;
        }),
    body('days')
        .exists({ checkNull: true }).withMessage('days is required')
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1 || num > 3650) {
                throw new Error('days must be an integer between 1 and 3650');
            }
            return true;
        }),
    handleValidationErrors
];

const deactivateMerchant = [
    param('merchantId')
        .custom((value) => {
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error('merchantId must be a positive integer');
            }
            return true;
        }),
    handleValidationErrors
];

const listSettings = [handleValidationErrors];

const updateSetting = [
    param('key')
        .trim()
        .notEmpty().withMessage('key is required')
        .isLength({ max: 255 }).withMessage('key cannot exceed 255 characters')
        .matches(/^[a-z0-9_]+$/).withMessage('key must be lowercase alphanumeric with underscores'),
    body('value')
        .exists({ checkNull: true }).withMessage('value is required')
        .isString().withMessage('value must be a string')
        .isLength({ max: 10000 }).withMessage('value cannot exceed 10000 characters'),
    handleValidationErrors
];

module.exports = {
    listMerchants,
    extendTrial,
    deactivateMerchant,
    listSettings,
    updateSetting
};
