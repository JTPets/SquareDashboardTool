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

const testEmail = [handleValidationErrors];

const createPromoCode = [
    body('code')
        .trim()
        .notEmpty().withMessage('code is required')
        .isLength({ min: 3, max: 50 }).withMessage('code must be 3–50 characters')
        .matches(/^[A-Za-z0-9_-]+$/).withMessage('code may only contain letters, numbers, hyphens, and underscores'),
    body('discount_type')
        .notEmpty().withMessage('discount_type is required')
        .isIn(['percent', 'fixed', 'fixed_price']).withMessage('discount_type must be percent, fixed, or fixed_price'),
    body('discount_value')
        .custom((value, { req }) => {
            if (req.body.discount_type === 'fixed_price') return true; // not required
            const num = Number(value);
            if (!Number.isFinite(num) || num < 0) {
                throw new Error('discount_value must be a non-negative number');
            }
            return true;
        }),
    body('fixed_price_cents')
        .optional()
        .custom((value) => {
            if (value === undefined || value === null || value === '') return true;
            const num = Number(value);
            if (!Number.isInteger(num) || num < 0) {
                throw new Error('fixed_price_cents must be a non-negative integer');
            }
            return true;
        }),
    body('duration_months')
        .optional()
        .custom((value) => {
            if (value === undefined || value === null || value === '') return true;
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error('duration_months must be a positive integer');
            }
            return true;
        }),
    body('max_uses')
        .optional()
        .custom((value) => {
            if (value === undefined || value === null || value === '') return true;
            const num = Number(value);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error('max_uses must be a positive integer');
            }
            return true;
        }),
    body('valid_until')
        .optional()
        .isISO8601().withMessage('valid_until must be a valid ISO 8601 date'),
    body('description')
        .optional()
        .isString().withMessage('description must be a string')
        .isLength({ max: 500 }).withMessage('description cannot exceed 500 characters'),
    body('notes')
        .optional()
        .isString().withMessage('notes must be a string')
        .isLength({ max: 1000 }).withMessage('notes cannot exceed 1000 characters'),
    handleValidationErrors
];

module.exports = {
    listMerchants,
    extendTrial,
    deactivateMerchant,
    listSettings,
    updateSetting,
    testEmail,
    createPromoCode
};
