/**
 * AI Autofill Routes
 *
 * Handles AI-powered catalog content generation:
 * - Get item status/readiness for content generation
 * - Generate descriptions and SEO content via Claude API
 * - Apply generated content to Square catalog
 * - Store/retrieve Claude API key securely per merchant
 *
 * Endpoints:
 * - GET  /api/ai-autofill/status       - Get items grouped by readiness
 * - POST /api/ai-autofill/generate     - Generate content for items
 * - POST /api/ai-autofill/apply        - Apply content to Square
 * - POST /api/ai-autofill/api-key      - Save Claude API key (encrypted)
 * - GET  /api/ai-autofill/api-key/status - Check if API key is stored
 * - DELETE /api/ai-autofill/api-key    - Delete stored API key
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/ai-autofill');
const aiAutofillService = require('../services/ai-autofill-service');
const { batchUpdateCatalogContent } = require('../services/square/api');
const { encryptToken, decryptToken } = require('../utils/token-encryption');

// ============================================================================
// API KEY MANAGEMENT - Secure server-side storage
// ============================================================================

/**
 * POST /api/ai-autofill/api-key
 * Save Claude API key encrypted per merchant
 * The key is never returned to the frontend after storage
 */
router.post('/api-key', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { apiKey } = req.body;

    if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-')) {
        return res.status(400).json({
            success: false,
            error: 'Invalid API key format. Claude API keys start with sk-ant-',
            code: 'INVALID_API_KEY'
        });
    }

    // Encrypt the API key using AES-256-GCM
    const encryptedKey = encryptToken(apiKey);

    // Upsert into merchant_settings
    await db.query(`
        INSERT INTO merchant_settings (merchant_id, claude_api_key_encrypted, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (merchant_id)
        DO UPDATE SET claude_api_key_encrypted = $2, updated_at = NOW()
    `, [merchantId, encryptedKey]);

    logger.info('Claude API key stored for merchant', { merchantId });

    res.json({
        success: true,
        message: 'API key saved securely'
    });
}));

/**
 * GET /api/ai-autofill/api-key/status
 * Check if a Claude API key is stored (without exposing it)
 */
router.get('/api-key/status', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    const result = await db.query(`
        SELECT claude_api_key_encrypted IS NOT NULL as has_key
        FROM merchant_settings
        WHERE merchant_id = $1
    `, [merchantId]);

    const hasKey = result.rows.length > 0 && result.rows[0].has_key === true;

    res.json({
        success: true,
        data: { hasKey }
    });
}));

/**
 * DELETE /api/ai-autofill/api-key
 * Delete stored Claude API key
 */
router.delete('/api-key', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    await db.query(`
        UPDATE merchant_settings
        SET claude_api_key_encrypted = NULL, updated_at = NOW()
        WHERE merchant_id = $1
    `, [merchantId]);

    logger.info('Claude API key deleted for merchant', { merchantId });

    res.json({
        success: true,
        message: 'API key deleted'
    });
}));

/**
 * Helper: Get decrypted API key for merchant
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<string|null>} - Decrypted API key or null
 */
async function getApiKeyForMerchant(merchantId) {
    const result = await db.query(`
        SELECT claude_api_key_encrypted
        FROM merchant_settings
        WHERE merchant_id = $1
    `, [merchantId]);

    if (result.rows.length === 0 || !result.rows[0].claude_api_key_encrypted) {
        return null;
    }

    return decryptToken(result.rows[0].claude_api_key_encrypted);
}

// ============================================================================
// CONTENT GENERATION
// ============================================================================

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
 * Uses server-side stored API key (encrypted per merchant)
 *
 * Body: {
 *   itemIds: string[],
 *   fieldType: 'description' | 'seo_title' | 'seo_description',
 *   context?: string,
 *   keywords?: string[],
 *   tone?: 'professional' | 'friendly' | 'technical'
 * }
 */
router.post('/generate', requireAuth, requireMerchant, validators.generate, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { itemIds, fieldType, context, keywords, tone } = req.body;

    // Get API key from encrypted server-side storage
    const apiKey = await getApiKeyForMerchant(merchantId);
    if (!apiKey) {
        return res.status(400).json({
            success: false,
            error: 'No Claude API key configured. Please save your API key first.',
            code: 'API_KEY_NOT_CONFIGURED'
        });
    }

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
        { context, keywords, tone, storeName: req.merchantContext.businessName },
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
