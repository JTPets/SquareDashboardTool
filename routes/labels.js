/**
 * Label Printing Routes
 *
 * Generates ZPL label data for Zebra printers via Browser Print.
 * The server generates ZPL; the client sends it to the local printer.
 *
 * Endpoints:
 * - POST   /api/labels/generate             - Generate ZPL for variations
 * - POST   /api/labels/generate-with-prices  - Generate ZPL with override prices
 * - GET    /api/labels/templates             - List merchant's label templates
 * - PUT    /api/labels/templates/:id/default - Set default template
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/labels');
const asyncHandler = require('../middleware/async-handler');
const zplGenerator = require('../services/label/zpl-generator');

/**
 * POST /api/labels/generate
 * Generate ZPL for a list of variation IDs using current DB prices
 */
router.post('/labels/generate', requireAuth, requireMerchant, validators.generateLabels, asyncHandler(async (req, res) => {
    const { variationIds, templateId, copies } = req.body;
    const merchantId = req.merchantContext.id;

    const result = await zplGenerator.generateLabels(merchantId, variationIds, {
        templateId: templateId || null,
        copies: copies || 1
    });

    res.json({
        success: true,
        zpl: result.zpl,
        labelCount: result.labelCount,
        totalLabels: result.totalLabels,
        template: result.template,
        missingVariations: result.missingVariations
    });
}));

/**
 * POST /api/labels/generate-with-prices
 * Generate ZPL using override prices (for freshly pushed price changes)
 */
router.post('/labels/generate-with-prices', requireAuth, requireMerchant, validators.generateWithPrices, asyncHandler(async (req, res) => {
    const { priceChanges, templateId, copies } = req.body;
    const merchantId = req.merchantContext.id;

    const result = await zplGenerator.generateLabelsWithPrices(merchantId, priceChanges, {
        templateId: templateId || null,
        copies: copies || 1
    });

    res.json({
        success: true,
        zpl: result.zpl,
        labelCount: result.labelCount,
        totalLabels: result.totalLabels,
        template: result.template,
        missingVariations: result.missingVariations
    });
}));

/**
 * GET /api/labels/templates
 * List all label templates for this merchant
 */
router.get('/labels/templates', requireAuth, requireMerchant, validators.getTemplates, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const templates = await zplGenerator.getTemplates(merchantId);

    res.json({
        count: templates.length,
        templates
    });
}));

/**
 * PUT /api/labels/templates/:id/default
 * Set a template as the default for this merchant
 */
router.put('/labels/templates/:id/default', requireAuth, requireMerchant, validators.setDefault, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const templateId = parseInt(req.params.id);

    const updated = await zplGenerator.setDefaultTemplate(merchantId, templateId);

    if (!updated) {
        return res.status(404).json({
            success: false,
            error: 'Template not found'
        });
    }

    logger.info('Default label template updated', { merchantId, templateId });

    res.json({
        success: true,
        message: `Template "${updated.name}" set as default`
    });
}));

module.exports = router;
