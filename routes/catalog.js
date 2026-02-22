/**
 * Catalog Routes
 *
 * Handles catalog data management:
 * - Locations
 * - Items, variations, categories
 * - Inventory and low stock
 * - Expirations tracking
 * - Catalog audit
 *
 * Endpoints:
 * - GET    /api/locations                     - List store locations
 * - GET    /api/categories                    - List all categories
 * - GET    /api/items                         - List items with optional filtering
 * - GET    /api/variations                    - List variations with optional filtering
 * - GET    /api/variations-with-costs         - List variations with cost/margin info
 * - PATCH  /api/variations/:id/extended       - Update custom fields
 * - PATCH  /api/variations/:id/min-stock      - Update min stock threshold
 * - PATCH  /api/variations/:id/cost           - Update unit cost
 * - POST   /api/variations/bulk-update-extended - Bulk update custom fields
 * - GET    /api/expirations                   - Get expiration data
 * - POST   /api/expirations                   - Save expiration data
 * - POST   /api/expirations/review            - Mark items as reviewed
 * - GET    /api/inventory                     - Get inventory levels
 * - GET    /api/low-stock                     - Get low stock items
 * - GET    /api/deleted-items                 - Get deleted/archived items
 * - GET    /api/catalog-audit                 - Get catalog audit data
 * - POST   /api/catalog-audit/enable-item-at-locations - Enable parent item at all locations
 * - POST   /api/catalog-audit/fix-locations   - Fix location mismatches
 *
 * Note: Business logic is delegated to services/catalog/ (P1-2 service extraction).
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const catalogService = require('../services/catalog');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/catalog');

// ==================== CATALOG ENDPOINTS ====================

/**
 * GET /api/locations
 * Get store locations for the merchant
 */
router.get('/locations', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await catalogService.getLocations(merchantId);
    res.json(result);
}));

/**
 * GET /api/categories
 * Get list of all distinct categories from items
 */
router.get('/categories', requireAuth, requireMerchant, validators.getCategories, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const categories = await catalogService.getCategories(merchantId);
    logger.info('API /api/categories returning', { count: categories.length, merchantId });
    res.json(categories);
}));

/**
 * GET /api/items
 * List all items with optional filtering
 */
router.get('/items', requireAuth, requireMerchant, validators.getItems, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { name, category } = req.query;
    const result = await catalogService.getItems(merchantId, { name, category });
    logger.info('API /api/items returning', { count: result.count, merchantId });
    res.json(result);
}));

/**
 * GET /api/variations
 * List all variations with optional filtering
 */
router.get('/variations', requireAuth, requireMerchant, validators.getVariations, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { item_id, sku, has_cost, search, limit } = req.query;
    const result = await catalogService.getVariations(merchantId, { item_id, sku, has_cost, search, limit });
    res.json(result);
}));

/**
 * GET /api/variations-with-costs
 * Get variations with cost and margin information
 */
router.get('/variations-with-costs', requireAuth, requireMerchant, validators.getVariationsWithCosts, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await catalogService.getVariationsWithCosts(merchantId);
    res.json(result);
}));

/**
 * PATCH /api/variations/:id/extended
 * Update custom fields on a variation
 * Automatically syncs case_pack_quantity to Square if changed
 */
router.patch('/variations/:id/extended', requireAuth, requireMerchant, validators.updateVariationExtended, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.updateExtendedFields(id, merchantId, req.body);

    if (!result.success) {
        return res.status(result.status || 400).json({ error: result.error });
    }

    res.json({
        status: 'success',
        variation: result.variation,
        square_sync: result.square_sync
    });
}));

/**
 * PATCH /api/variations/:id/min-stock
 * Update min stock (inventory alert threshold) and sync to Square
 * Uses location-specific overrides in Square
 */
router.patch('/variations/:id/min-stock', requireAuth, requireMerchant, validators.updateMinStock, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { min_stock, location_id } = req.body;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.updateMinStock(id, merchantId, min_stock, location_id);

    if (!result.success) {
        return res.status(result.status || 400).json({
            error: result.error,
            square_error: result.square_error
        });
    }

    res.json(result);
}));

/**
 * PATCH /api/variations/:id/cost
 * Update unit cost (vendor cost) and sync to Square
 */
router.patch('/variations/:id/cost', requireAuth, requireMerchant, validators.updateCost, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { cost_cents, vendor_id } = req.body;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.updateCost(id, merchantId, cost_cents, vendor_id);

    if (!result.success) {
        const errorResponse = {
            error: result.error,
            square_error: result.square_error
        };
        // Include structured error info for location mismatch
        if (result.code) {
            errorResponse.code = result.code;
            errorResponse.parent_item_id = result.parent_item_id;
            errorResponse.variation_id = result.variation_id;
        }
        return res.status(result.status || 400).json(errorResponse);
    }

    res.json(result);
}));

/**
 * POST /api/variations/bulk-update-extended
 * Bulk update custom fields by SKU
 */
router.post('/variations/bulk-update-extended', requireAuth, requireMerchant, validators.bulkUpdateExtended, asyncHandler(async (req, res) => {
    const updates = req.body;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.bulkUpdateExtendedFields(merchantId, updates);

    if (!result.success) {
        return res.status(result.status || 400).json({ error: result.error });
    }

    res.json({
        status: 'success',
        updated_count: result.updated_count,
        errors: result.errors,
        squarePush: result.squarePush
    });
}));

// ==================== EXPIRATION TRACKING ENDPOINTS ====================

/**
 * GET /api/expirations
 * Get variations with expiration data for expiration tracker
 */
router.get('/expirations', requireAuth, requireMerchant, validators.getExpirations, asyncHandler(async (req, res) => {
    const { expiry, category } = req.query;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.getExpirations(merchantId, { expiry, category });
    logger.info('API /api/expirations returning', { count: result.count });
    res.json(result);
}));

/**
 * POST /api/expirations
 * Save/update expiration data for variations
 */
router.post('/expirations', requireAuth, requireMerchant, validators.saveExpirations, asyncHandler(async (req, res) => {
    const changes = req.body;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.saveExpirations(merchantId, changes);

    if (!result.success && result.status) {
        return res.status(result.status).json({ error: result.error });
    }

    res.json({
        success: true,
        message: result.message,
        squarePush: result.squarePush
    });
}));

/**
 * POST /api/expirations/review
 * Mark items as reviewed (so they don't reappear in review filter)
 * Also syncs reviewed_at timestamp to Square for cross-platform consistency
 */
router.post('/expirations/review', requireAuth, requireMerchant, validators.reviewExpirations, asyncHandler(async (req, res) => {
    const { variation_ids, reviewed_by } = req.body;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.markExpirationsReviewed(merchantId, variation_ids, reviewed_by);

    if (!result.success && result.status) {
        return res.status(result.status).json({ error: result.error });
    }

    res.json({
        success: true,
        message: result.message,
        reviewed_count: result.reviewed_count,
        squarePush: result.squarePush
    });
}));

// ==================== INVENTORY ENDPOINTS ====================

/**
 * GET /api/inventory
 * Get current inventory levels
 */
router.get('/inventory', requireAuth, requireMerchant, validators.getInventory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { location_id, low_stock } = req.query;

    const result = await catalogService.getInventory(merchantId, { location_id, low_stock });
    res.json(result);
}));

/**
 * GET /api/low-stock
 * Get items below minimum stock alert threshold
 */
router.get('/low-stock', requireAuth, requireMerchant, validators.getLowStock, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await catalogService.getLowStock(merchantId);
    res.json(result);
}));

/**
 * GET /api/deleted-items
 * Get soft-deleted AND archived items for cleanup/management
 * Query params:
 *   - age_months: filter to items deleted/archived more than X months ago
 *   - status: 'deleted', 'archived', or 'all' (default: 'all')
 */
router.get('/deleted-items', requireAuth, requireMerchant, validators.getDeletedItems, asyncHandler(async (req, res) => {
    const { age_months, status = 'all' } = req.query;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.getDeletedItems(merchantId, { age_months, status });
    res.json(result);
}));

// ==================== CATALOG AUDIT ENDPOINTS ====================

/**
 * GET /api/catalog-audit
 * Get comprehensive catalog audit data - identifies items with missing/incomplete data
 */
router.get('/catalog-audit', requireAuth, requireMerchant, validators.getCatalogAudit, asyncHandler(async (req, res) => {
    const { location_id, issue_type } = req.query;
    const merchantId = req.merchantContext.id;

    const result = await catalogService.getCatalogAudit(merchantId, { location_id, issue_type });
    res.json(result);
}));

/**
 * POST /api/catalog-audit/enable-item-at-locations
 * Enable a single parent item at all locations (used when cost update fails due to location mismatch)
 *
 * Tenant isolation: merchantId drives the Square access token lookup (getMerchantToken),
 * so the token can only access that merchant's own catalog. No additional ownership check
 * is needed — Square's API enforces that the token cannot read/modify other merchants' objects.
 */
router.post('/catalog-audit/enable-item-at-locations', requireAuth, requireMerchant, validators.enableItemAtLocations, asyncHandler(async (req, res) => {
    const { item_id } = req.body;
    const merchantId = req.merchantContext.id;

    logger.info('Enabling item at all locations from API', { merchantId, itemId: item_id });

    const result = await catalogService.enableItemAtAllLocations(item_id, merchantId);

    if (!result.success) {
        return res.status(result.status || 500).json({
            error: result.error
        });
    }

    res.json(result);
}));

/**
 * POST /api/catalog-audit/fix-locations
 * Fix all location mismatches by setting items/variations to present_at_all_locations = true
 */
router.post('/catalog-audit/fix-locations', requireAuth, requireMerchant, validators.fixLocations, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Starting location mismatch fix from API', { merchantId });

    const result = await catalogService.fixLocationMismatches(merchantId);

    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            itemsFixed: result.itemsFixed,
            variationsFixed: result.variationsFixed,
            details: result.details
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            itemsFixed: result.itemsFixed,
            variationsFixed: result.variationsFixed,
            errors: result.errors,
            details: result.details
        });
    }
}));

/**
 * POST /api/catalog-audit/fix-inventory-alerts
 * Enable LOW_QUANTITY inventory alerts (threshold 0) on all variations with alerts off
 */
router.post('/catalog-audit/fix-inventory-alerts', requireAuth, requireMerchant, validators.fixInventoryAlerts, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Starting inventory alerts fix from API', { merchantId });

    const result = await catalogService.fixInventoryAlerts(merchantId);

    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            variationsFixed: result.variationsFixed,
            totalFound: result.totalFound,
            details: result.details
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            variationsFixed: result.variationsFixed,
            totalFound: result.totalFound,
            errors: result.errors,
            details: result.details
        });
    }
}));

module.exports = router;
