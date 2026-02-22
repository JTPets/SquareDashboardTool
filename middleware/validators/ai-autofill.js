/**
 * AI Autofill Route Validators
 *
 * Validation middleware for catalog AI autofill endpoints using express-validator.
 */

const { body, query } = require('express-validator');
const { handleValidationErrors } = require('./index');

// Valid field types for generation
const VALID_FIELD_TYPES = ['description', 'seo_title', 'seo_description'];
const VALID_TONES = ['professional', 'friendly', 'technical'];
const MAX_BATCH_SIZE = 100;

// GET /api/ai-autofill/status
const getStatus = [handleValidationErrors];

// POST /api/ai-autofill/generate
// Note: API key is retrieved from server-side encrypted storage, not from request headers
const generate = [
    body('itemIds')
        .isArray({ min: 1, max: MAX_BATCH_SIZE })
        .withMessage(`itemIds must be an array of 1-${MAX_BATCH_SIZE} items`),
    body('itemIds.*')
        .isString().notEmpty().withMessage('Each itemId must be a non-empty string'),
    body('fieldType')
        .isIn(VALID_FIELD_TYPES)
        .withMessage(`fieldType must be one of: ${VALID_FIELD_TYPES.join(', ')}`),
    body('context')
        .optional()
        .isString()
        .isLength({ max: 500 }).withMessage('context must be 500 characters or less'),
    body('keywords')
        .optional()
        .isArray({ max: 10 }).withMessage('keywords must be an array of up to 10 items'),
    body('keywords.*')
        .optional()
        .isString().trim().isLength({ max: 50 }),
    body('tone')
        .optional()
        .isIn(VALID_TONES)
        .withMessage(`tone must be one of: ${VALID_TONES.join(', ')}`),
    handleValidationErrors
];

// POST /api/ai-autofill/apply
const apply = [
    body('updates')
        .isArray({ min: 1, max: MAX_BATCH_SIZE })
        .withMessage(`updates must be an array of 1-${MAX_BATCH_SIZE} items`),
    body('updates.*.itemId')
        .isString().notEmpty().withMessage('Each update must have a non-empty itemId'),
    body('updates.*.fieldType')
        .isIn(VALID_FIELD_TYPES)
        .withMessage(`fieldType must be one of: ${VALID_FIELD_TYPES.join(', ')}`),
    body('updates.*.value')
        .isString()
        .isLength({ min: 1, max: 5000 }).withMessage('value must be 1-5000 characters'),
    handleValidationErrors
];

module.exports = {
    getStatus,
    generate,
    apply,
    VALID_FIELD_TYPES,
    MAX_BATCH_SIZE
};
