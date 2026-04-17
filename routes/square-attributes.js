/**
 * Square Custom Attributes Routes
 *
 * Handles custom attribute definition and value management:
 * - List, create, delete custom attribute definitions
 * - Update custom attribute values on catalog objects
 * - Push local data (case pack, brand, expiry) to Square
 *
 * Endpoints:
 * - GET    /api/square/custom-attributes                    - List definitions
 * - POST   /api/square/custom-attributes/init               - Initialize definitions
 * - POST   /api/square/custom-attributes/definition         - Create/update definition
 * - DELETE /api/square/custom-attributes/definition/:key    - Delete definition
 * - PUT    /api/square/custom-attributes/:objectId          - Update object attributes
 * - POST   /api/square/custom-attributes/push/case-pack     - Push case pack data
 * - POST   /api/square/custom-attributes/push/brand         - Push brand data
 * - POST   /api/square/custom-attributes/push/expiry        - Push expiry data
 * - POST   /api/square/custom-attributes/push/all           - Push all data
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const squareApi = require('../services/square');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/square-attributes');
const asyncHandler = require('../middleware/async-handler');
const { sendSuccess, sendError } = require('../utils/response-helper');

/**
 * Attach a human-readable warning to a push result when some variations
 * failed (partial failure). Mutates and returns the result object.
 */
function annotatePartialFailure(result, label) {
    const failed = result?.failedVariations;
    if (Array.isArray(failed) && failed.length > 0) {
        result.warning = `${failed.length} ${label} failed to sync to Square — see failedVariations for details`;
        logger.warn('Custom attribute push completed with partial failures', {
            label, failedCount: failed.length, repairedParents: result.repairedParents || 0
        });
    }
    return result;
}

/**
 * GET /api/square/custom-attributes
 * List all custom attribute definitions from Square
 */
router.get('/square/custom-attributes', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const definitions = await squareApi.listCustomAttributeDefinitions({ merchantId });
    sendSuccess(res, {
        count: definitions.length,
        definitions
    });
}));

/**
 * POST /api/square/custom-attributes/init
 * Initialize custom attribute definitions in Square
 * Creates: case_pack_quantity (NUMBER), brand (STRING)
 */
router.post('/square/custom-attributes/init', requireAuth, requireMerchant, requireWriteAccess, validators.init, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Initializing custom attribute definitions', { merchantId });
    const result = await squareApi.initializeCustomAttributes({ merchantId });
    sendSuccess(res, result);
}));

/**
 * POST /api/square/custom-attributes/definition
 * Create or update a single custom attribute definition
 */
router.post('/square/custom-attributes/definition', requireAuth, requireMerchant, requireWriteAccess, validators.createDefinition, asyncHandler(async (req, res) => {
    const definition = req.body;
    const merchantId = req.merchantContext.id;

    if (!definition.key || !definition.name) {
        return sendError(res, 'key and name are required', 400);
    }

    const result = await squareApi.upsertCustomAttributeDefinition(definition, { merchantId });
    sendSuccess(res, result);
}));

/**
 * DELETE /api/square/custom-attributes/definition/:key
 * Delete a custom attribute definition by key or ID
 * WARNING: This also deletes all values using this definition
 */
router.delete('/square/custom-attributes/definition/:key', requireAuth, requireMerchant, requireWriteAccess, validators.deleteDefinition, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const merchantId = req.merchantContext.id;
    logger.info('Deleting custom attribute definition', { key, merchantId });
    const result = await squareApi.deleteCustomAttributeDefinition(key, { merchantId });
    sendSuccess(res, result);
}));

/**
 * PUT /api/square/custom-attributes/:objectId
 * Update custom attribute values on a single catalog object (item or variation)
 */
router.put('/square/custom-attributes/:objectId', requireAuth, requireMerchant, requireWriteAccess, validators.updateAttributes, asyncHandler(async (req, res) => {
    const { objectId } = req.params;
    const customAttributeValues = req.body;
    const merchantId = req.merchantContext.id;

    if (!customAttributeValues || Object.keys(customAttributeValues).length === 0) {
        return sendError(res, 'customAttributeValues object is required', 400);
    }

    const result = await squareApi.updateCustomAttributeValues(objectId, customAttributeValues, { merchantId });
    sendSuccess(res, result);
}));

/**
 * POST /api/square/custom-attributes/push/case-pack
 * Push all local case_pack_quantity values to Square
 */
router.post('/square/custom-attributes/push/case-pack', requireAuth, requireMerchant, requireWriteAccess, validators.pushCasePack, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Pushing case pack quantities to Square', { merchantId });
    const result = await squareApi.pushCasePackToSquare({ merchantId });
    sendSuccess(res, annotatePartialFailure(result, 'case-pack variations'));
}));

/**
 * POST /api/square/custom-attributes/push/brand
 * Push all local brand assignments to Square
 */
router.post('/square/custom-attributes/push/brand', requireAuth, requireMerchant, requireWriteAccess, validators.pushBrand, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Pushing brand assignments to Square', { merchantId });
    const result = await squareApi.pushBrandsToSquare({ merchantId });
    sendSuccess(res, annotatePartialFailure(result, 'brand items'));
}));

/**
 * POST /api/square/custom-attributes/push/expiry
 * Push all local expiration dates to Square
 */
router.post('/square/custom-attributes/push/expiry', requireAuth, requireMerchant, requireWriteAccess, validators.pushExpiry, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Pushing expiry dates to Square', { merchantId });
    const result = await squareApi.pushExpiryDatesToSquare({ merchantId });
    sendSuccess(res, annotatePartialFailure(result, 'expiry variations'));
}));

/**
 * POST /api/square/custom-attributes/push/all
 * Push all local custom attribute data to Square (case pack, brand, expiry)
 */
router.post('/square/custom-attributes/push/all', requireAuth, requireMerchant, requireWriteAccess, validators.pushAll, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Pushing all custom attributes to Square', { merchantId });

    const results = {
        success: true,
        casePack: null,
        brand: null,
        expiry: null,
        errors: []
    };

    // Push case pack quantities
    try {
        results.casePack = await squareApi.pushCasePackToSquare({ merchantId });
    } catch (error) {
        results.errors.push({ type: 'casePack', error: error.message });
        results.success = false;
    }

    // Push brand assignments
    try {
        results.brand = await squareApi.pushBrandsToSquare({ merchantId });
    } catch (error) {
        results.errors.push({ type: 'brand', error: error.message });
        results.success = false;
    }

    // Push expiry dates
    try {
        results.expiry = await squareApi.pushExpiryDatesToSquare({ merchantId });
    } catch (error) {
        results.errors.push({ type: 'expiry', error: error.message });
        results.success = false;
    }

    // Surface per-variation failures from each sub-push as warnings so the
    // merchant sees partial-failure details instead of silent log-only errors.
    const partialFailures = [];
    for (const [type, sub] of [['casePack', results.casePack], ['brand', results.brand], ['expiry', results.expiry]]) {
        const failed = sub?.failedVariations;
        if (Array.isArray(failed) && failed.length > 0) {
            partialFailures.push({ type, failedCount: failed.length, failedVariations: failed });
        }
    }
    if (partialFailures.length > 0) {
        results.partialFailures = partialFailures;
        results.warning = `Some variations failed to sync — see partialFailures for details`;
        logger.warn('Push-all completed with partial failures', { merchantId, partialFailures });
    }

    sendSuccess(res, results);
}));

module.exports = router;
