/**
 * AI Autofill Routes
 *
 * Handles AI-powered catalog content generation:
 * - Get item status/readiness for content generation
 * - Generate descriptions and SEO content via Claude API
 * - Apply generated content to Square catalog
 *
 * Endpoints:
 * - GET  /api/ai-autofill/status   - Get items grouped by readiness
 * - POST /api/ai-autofill/generate - Generate content for items
 * - POST /api/ai-autofill/apply    - Apply content to Square
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/ai-autofill');
const aiAutofillService = require('../services/ai-autofill-service');
const { batchUpdateCatalogContent } = require('../services/square/api');

/**
 * GET /api/ai-autofill/status
 * Get all items grouped by their readiness for content generation
 */
router.get('/status', requireAuth, requireMerchant, validators.getStatus, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const grouped = await aiAutofillService.getItemsWithReadiness(merchantId);

    res.json({
        success: true,
        data: grouped
    });
}));

/**
 * POST /api/ai-autofill/generate
 * Generate content for selected items using Claude API
 *
 * Body: {
 *   itemIds: string[],
 *   fieldType: 'description' | 'seo_title' | 'seo_description',
 *   context?: string,
 *   keywords?: string[],
 *   tone?: 'professional' | 'friendly' | 'technical'
 * }
 *
 * Header: x-claude-api-key (required)
 */
router.post('/generate', requireAuth, requireMerchant, validators.generate, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const apiKey = req.headers['x-claude-api-key'];
    const { itemIds, fieldType, context, keywords, tone } = req.body;

    // Fetch full item data
    const items = await aiAutofillService.getItemsForGeneration(merchantId, itemIds);

    if (items.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'No items found with the provided IDs',
            code: 'ITEMS_NOT_FOUND'
        });
    }

    // Validate readiness for the requested field type
    const readiness = aiAutofillService.validateReadiness(items, fieldType);
    if (!readiness.valid) {
        return res.status(400).json({
            success: false,
            error: 'Items are not ready for this field type',
            code: 'ITEMS_NOT_READY',
            details: readiness.errors
        });
    }

    // Generate content
    const results = await aiAutofillService.generateContent(
        items,
        fieldType,
        { context, keywords, tone },
        apiKey
    );

    logger.info('AI Autofill: content generated', {
        merchantId,
        fieldType,
        itemCount: items.length,
        successCount: results.filter(r => r.generated).length
    });

    res.json({
        success: true,
        data: {
            fieldType,
            results
        }
    });
}));

/**
 * POST /api/ai-autofill/apply
 * Apply generated content to Square catalog
 *
 * Body: {
 *   updates: [{ itemId: string, fieldType: string, value: string }]
 * }
 */
router.post('/apply', requireAuth, requireMerchant, validators.apply, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { updates } = req.body;

    // Call Square API to update catalog
    const result = await batchUpdateCatalogContent(merchantId, updates);

    logger.info('AI Autofill: content applied to Square', {
        merchantId,
        totalUpdates: updates.length,
        succeeded: result.succeeded.length,
        failed: result.failed.length
    });

    res.json({
        success: true,
        data: result
    });
}));

module.exports = router;
