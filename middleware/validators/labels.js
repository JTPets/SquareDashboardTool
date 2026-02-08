/**
 * Label Printing Route Validators
 *
 * Validates input for label generation and template management endpoints
 */

const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

/**
 * POST /api/labels/generate
 */
const generateLabels = [
    body('variationIds')
        .isArray({ min: 1, max: 500 })
        .withMessage('variationIds must be an array of 1-500 items'),
    body('variationIds.*')
        .isString()
        .notEmpty()
        .withMessage('Each variationId must be a non-empty string'),
    body('templateId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('templateId must be a positive integer'),
    body('copies')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('copies must be between 1 and 100'),
    handleValidationErrors
];

/**
 * POST /api/labels/generate-with-prices
 */
const generateWithPrices = [
    body('priceChanges')
        .isArray({ min: 1, max: 500 })
        .withMessage('priceChanges must be an array of 1-500 items'),
    body('priceChanges.*.variationId')
        .notEmpty()
        .withMessage('Each price change must have a variationId'),
    body('priceChanges.*.newPriceCents')
        .isInt({ min: 0 })
        .withMessage('newPriceCents must be a non-negative integer'),
    body('templateId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('templateId must be a positive integer'),
    body('copies')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('copies must be between 1 and 100'),
    handleValidationErrors
];

/**
 * GET /api/labels/templates
 */
const getTemplates = [
    handleValidationErrors
];

/**
 * PUT /api/labels/templates/:id/default
 */
const setDefault = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('Template ID must be a positive integer'),
    handleValidationErrors
];

module.exports = {
    generateLabels,
    generateWithPrices,
    getTemplates,
    setDefault
};
