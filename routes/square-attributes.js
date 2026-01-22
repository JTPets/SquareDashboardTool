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
const squareApi = require('../utils/square-api');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/square-attributes');

/**
 * GET /api/square/custom-attributes
 * List all custom attribute definitions from Square
 */
router.get('/square/custom-attributes', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const definitions = await squareApi.listCustomAttributeDefinitions({ merchantId });
        res.json({
            success: true,
            count: definitions.length,
            definitions
        });
    } catch (error) {
        logger.error('List custom attributes error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/init
 * Initialize custom attribute definitions in Square
 * Creates: case_pack_quantity (NUMBER), brand (STRING)
 */
router.post('/square/custom-attributes/init', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Initializing custom attribute definitions', { merchantId });
        const result = await squareApi.initializeCustomAttributes({ merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Init custom attributes error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/definition
 * Create or update a single custom attribute definition
 */
router.post('/square/custom-attributes/definition', requireAuth, requireMerchant, validators.createDefinition, async (req, res) => {
    try {
        const definition = req.body;
        const merchantId = req.merchantContext.id;

        if (!definition.key || !definition.name) {
            return res.status(400).json({ error: 'key and name are required' });
        }

        const result = await squareApi.upsertCustomAttributeDefinition(definition, { merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Create custom attribute definition error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/square/custom-attributes/definition/:key
 * Delete a custom attribute definition by key or ID
 * WARNING: This also deletes all values using this definition
 */
router.delete('/square/custom-attributes/definition/:key', requireAuth, requireMerchant, validators.deleteDefinition, async (req, res) => {
    try {
        const { key } = req.params;
        const merchantId = req.merchantContext.id;
        logger.info('Deleting custom attribute definition', { key, merchantId });
        const result = await squareApi.deleteCustomAttributeDefinition(key, { merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Delete custom attribute definition error', { error: error.message, key: req.params.key });
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/square/custom-attributes/:objectId
 * Update custom attribute values on a single catalog object (item or variation)
 */
router.put('/square/custom-attributes/:objectId', requireAuth, requireMerchant, validators.updateAttributes, async (req, res) => {
    try {
        const { objectId } = req.params;
        const customAttributeValues = req.body;
        const merchantId = req.merchantContext.id;

        if (!customAttributeValues || Object.keys(customAttributeValues).length === 0) {
            return res.status(400).json({ error: 'customAttributeValues object is required' });
        }

        const result = await squareApi.updateCustomAttributeValues(objectId, customAttributeValues, { merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Update custom attribute values error', { error: error.message, objectId: req.params.objectId });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/case-pack
 * Push all local case_pack_quantity values to Square
 */
router.post('/square/custom-attributes/push/case-pack', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing case pack quantities to Square', { merchantId });
        const result = await squareApi.pushCasePackToSquare({ merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Push case pack error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/brand
 * Push all local brand assignments to Square
 */
router.post('/square/custom-attributes/push/brand', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing brand assignments to Square', { merchantId });
        const result = await squareApi.pushBrandsToSquare({ merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Push brands error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/expiry
 * Push all local expiration dates to Square
 */
router.post('/square/custom-attributes/push/expiry', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        logger.info('Pushing expiry dates to Square', { merchantId });
        const result = await squareApi.pushExpiryDatesToSquare({ merchantId });
        res.json(result);
    } catch (error) {
        logger.error('Push expiry dates error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/square/custom-attributes/push/all
 * Push all local custom attribute data to Square (case pack, brand, expiry)
 */
router.post('/square/custom-attributes/push/all', requireAuth, requireMerchant, async (req, res) => {
    try {
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

        res.json(results);
    } catch (error) {
        logger.error('Push all custom attributes error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
