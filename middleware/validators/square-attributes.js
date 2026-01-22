/**
 * Square Custom Attributes Route Validators
 *
 * Validates input for Square custom attribute management endpoints
 */

const { body, param } = require('express-validator');
const { handleValidationErrors, validateRequiredString, validateOptionalString } = require('./index');

/**
 * Validate definition key parameter
 */
const validateDefinitionKey = param('key')
    .trim()
    .notEmpty()
    .withMessage('key is required')
    .isLength({ min: 1, max: 60 })
    .withMessage('key must be 1-60 characters')
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('key can only contain letters, numbers, dashes, and underscores');

/**
 * Validate object ID parameter
 */
const validateObjectId = param('objectId')
    .trim()
    .notEmpty()
    .withMessage('objectId is required')
    .isLength({ min: 1, max: 192 })
    .withMessage('objectId must be 1-192 characters');

/**
 * Validate custom attribute definition body
 */
const validateDefinitionBody = [
    body('key')
        .trim()
        .notEmpty()
        .withMessage('key is required')
        .isLength({ min: 1, max: 60 })
        .withMessage('key must be 1-60 characters')
        .matches(/^[a-zA-Z0-9_-]+$/)
        .withMessage('key can only contain letters, numbers, dashes, and underscores'),
    body('name')
        .trim()
        .notEmpty()
        .withMessage('name is required')
        .isLength({ min: 1, max: 255 })
        .withMessage('name must be 1-255 characters'),
    body('type')
        .optional()
        .isIn(['STRING', 'NUMBER', 'SELECTION', 'BOOLEAN'])
        .withMessage('type must be one of: STRING, NUMBER, SELECTION, BOOLEAN'),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('description cannot exceed 500 characters'),
    body('visibility')
        .optional()
        .isIn(['VISIBILITY_HIDDEN', 'VISIBILITY_READ_ONLY', 'VISIBILITY_READ_WRITE_VALUES'])
        .withMessage('visibility must be one of: VISIBILITY_HIDDEN, VISIBILITY_READ_ONLY, VISIBILITY_READ_WRITE_VALUES')
];

/**
 * Validate custom attribute values body
 */
const validateAttributeValuesBody = body()
    .custom((value, { req }) => {
        if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
            throw new Error('customAttributeValues object is required');
        }
        return true;
    });

/**
 * GET /api/square/custom-attributes
 * No specific validation needed beyond auth
 */
const list = [
    handleValidationErrors
];

/**
 * POST /api/square/custom-attributes/init
 * No specific validation needed beyond auth
 */
const init = [
    handleValidationErrors
];

/**
 * POST /api/square/custom-attributes/definition
 */
const createDefinition = [
    ...validateDefinitionBody,
    handleValidationErrors
];

/**
 * DELETE /api/square/custom-attributes/definition/:key
 */
const deleteDefinition = [
    validateDefinitionKey,
    handleValidationErrors
];

/**
 * PUT /api/square/custom-attributes/:objectId
 */
const updateAttributes = [
    validateObjectId,
    validateAttributeValuesBody,
    handleValidationErrors
];

/**
 * POST /api/square/custom-attributes/push/case-pack
 * No specific validation needed beyond auth
 */
const pushCasePack = [
    handleValidationErrors
];

/**
 * POST /api/square/custom-attributes/push/brand
 * No specific validation needed beyond auth
 */
const pushBrand = [
    handleValidationErrors
];

/**
 * POST /api/square/custom-attributes/push/expiry
 * No specific validation needed beyond auth
 */
const pushExpiry = [
    handleValidationErrors
];

/**
 * POST /api/square/custom-attributes/push/all
 * No specific validation needed beyond auth
 */
const pushAll = [
    handleValidationErrors
];

module.exports = {
    list,
    init,
    createDefinition,
    deleteDefinition,
    updateAttributes,
    pushCasePack,
    pushBrand,
    pushExpiry,
    pushAll,
    // Export individual validators for reuse
    validateDefinitionKey,
    validateObjectId,
    validateDefinitionBody,
    validateAttributeValuesBody
};
