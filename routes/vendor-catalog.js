/**
 * Vendor Catalog Routes
 *
 * Handles vendor management and vendor catalog import/matching:
 * - Vendor listing and dashboard
 * - Vendor settings management
 * - CSV/XLSX file import with column mapping
 * - UPC lookup and matching
 * - Import batch management
 * - Price change push to Square
 *
 * Endpoints:
 * - GET    /api/vendors                                  - List vendors
 * - GET    /api/vendor-dashboard                         - Vendor dashboard with stats
 * - PATCH  /api/vendors/:id/settings                     - Update vendor settings
 * - POST   /api/vendor-catalog/import                    - Import vendor catalog
 * - POST   /api/vendor-catalog/preview                   - Preview file and get mappings
 * - POST   /api/vendor-catalog/import-mapped             - Import with column mappings
 * - GET    /api/vendor-catalog/field-types               - Get field types for mapping
 * - GET    /api/vendor-catalog                           - Search vendor catalog items
 * - GET    /api/vendor-catalog/lookup/:upc               - Lookup by UPC
 * - GET    /api/vendor-catalog/batches                   - List import batches
 * - GET    /api/vendor-catalog/batches/:batchId/report   - Regenerate price report for batch
 * - POST   /api/vendor-catalog/batches/:batchId/archive  - Archive batch
 * - POST   /api/vendor-catalog/batches/:batchId/unarchive - Unarchive batch
 * - DELETE /api/vendor-catalog/batches/:batchId          - Delete batch
 * - GET    /api/vendor-catalog/stats                     - Get statistics
 * - POST   /api/vendor-catalog/push-price-changes        - Push prices to Square
 * - POST   /api/vendor-catalog/deduplicate               - Identify/remove duplicate rows (dry-run safe)
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const vendorCatalog = require('../services/vendor');
const squareApi = require('../services/square');
const vendorDashboard = require('../services/vendor-dashboard');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/vendor-catalog');
const asyncHandler = require('../middleware/async-handler');
const { sendSuccess, sendError } = require('../utils/response-helper');

/**
 * GET /api/vendors
 * List all vendors
 */
router.get('/vendors', requireAuth, requireMerchant, validators.getVendors, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { status } = req.query;
    let query = 'SELECT * FROM vendors WHERE merchant_id = $1';
    const params = [merchantId];

    if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
    }

    query += ' ORDER BY name';

    const result = await db.query(query, params);
    sendSuccess(res, {
        count: result.rows.length,
        vendors: result.rows
    });
}));

/**
 * GET /api/vendor-dashboard
 * Returns all vendors with computed stats for the vendor dashboard
 */
router.get('/vendor-dashboard', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await vendorDashboard.getVendorDashboard(merchantId);
    sendSuccess(res, { vendors: result.vendors, global_oos_count: result.global_oos_count });
}));

/**
 * PATCH /api/vendors/:id/settings
 * Update local-only vendor settings (schedule, payment, contact, etc.)
 */
router.patch('/vendors/:id/settings', requireAuth, requireMerchant, validators.updateVendorSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const vendorId = req.params.id;

    const updated = await vendorDashboard.updateVendorSettings(vendorId, merchantId, req.body);

    if (!updated) {
        return sendError(res, 'Vendor not found or does not belong to this merchant', 404);
    }

    sendSuccess(res, { vendor: updated });
}));

/**
 * POST /api/vendor-catalog/import
 * Import vendor catalog from CSV or XLSX file
 * Expects multipart form data with 'file' field or JSON body with 'data' and 'fileType'
 */
router.post('/vendor-catalog/import', requireAuth, requireMerchant, validators.importCatalog, asyncHandler(async (req, res) => {
    const { data, fileType, fileName, defaultVendorName } = req.body;
    const merchantId = req.merchantContext.id;

    if (!data) {
        return sendError(res, 'Missing file data', 400);
    }

    // Determine file type from fileName if not explicitly provided
    let type = fileType;
    if (!type && fileName) {
        type = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    }
    if (!type) {
        type = 'csv'; // Default to CSV
    }

    // Convert base64 to buffer for XLSX, or use string directly for CSV
    let fileData;
    if (type === 'xlsx') {
        fileData = Buffer.from(data, 'base64');
    } else {
        // For CSV, data might be base64 or plain text
        try {
            fileData = Buffer.from(data, 'base64').toString('utf-8');
        } catch {
            fileData = data;
        }
    }

    const result = await vendorCatalog.importVendorCatalog(fileData, type, {
        defaultVendorName: defaultVendorName || null,
        merchantId
    });

    if (result.success) {
        sendSuccess(res, {
            message: `Imported ${result.stats.imported} items from vendor catalog`,
            batchId: result.batchId,
            stats: result.stats,
            validationErrors: result.validationErrors,
            fieldMap: result.fieldMap,
            duration: result.duration
        });
    } else {
        sendError(res, result.error, 400);
    }
}));

/**
 * POST /api/vendor-catalog/preview
 * Preview file contents and get auto-detected column mappings
 */
router.post('/vendor-catalog/preview', requireAuth, requireMerchant, validators.previewFile, asyncHandler(async (req, res) => {
    const { data, fileType, fileName } = req.body;

    if (!data) {
        return sendError(res, 'Missing file data', 400);
    }

    // Determine file type
    let type = fileType;
    if (!type && fileName) {
        type = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    }
    if (!type) {
        type = 'csv';
    }

    // Convert base64 to buffer for XLSX, or use string for CSV
    let fileData;
    if (type === 'xlsx') {
        fileData = Buffer.from(data, 'base64');
    } else {
        try {
            fileData = Buffer.from(data, 'base64').toString('utf-8');
        } catch {
            fileData = data;
        }
    }

    const preview = await vendorCatalog.previewFile(fileData, type);

    // Transform response for frontend compatibility
    const columns = preview.columns.map(c => c.originalHeader);
    const autoMappings = {};
    const sampleValues = {};

    preview.columns.forEach(c => {
        autoMappings[c.originalHeader] = c.suggestedMapping;
        sampleValues[c.originalHeader] = c.sampleValues;
    });

    sendSuccess(res, {
        totalRows: preview.totalRows,
        columns,
        autoMappings,
        sampleValues,
        fieldTypes: preview.fieldTypes
    });
}));

/**
 * POST /api/vendor-catalog/import-mapped
 * Import vendor catalog with explicit column mappings
 * Requires: vendorId (selected vendor), columnMappings
 * Optional: importName (catalog name like "ABC Corp 2025 Price List")
 */
router.post('/vendor-catalog/import-mapped', requireAuth, requireMerchant, validators.importMapped, asyncHandler(async (req, res) => {
    // Accept both 'mappings' (frontend) and 'columnMappings' (API) for compatibility
    const { data, fileType, fileName, columnMappings, mappings, vendorId, vendorName, importName } = req.body;
    const resolvedMappings = columnMappings || mappings;
    const merchantId = req.merchantContext.id;

    if (!data) {
        return sendError(res, 'Missing file data', 400);
    }

    if (!vendorId) {
        return sendError(res, 'Missing vendor', 400);
    }

    // Determine file type
    let type = fileType;
    if (!type && fileName) {
        type = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    }
    if (!type) {
        type = 'csv';
    }

    // Convert base64 to buffer for XLSX, or use string for CSV
    let fileData;
    if (type === 'xlsx') {
        fileData = Buffer.from(data, 'base64');
    } else {
        try {
            fileData = Buffer.from(data, 'base64').toString('utf-8');
        } catch {
            fileData = data;
        }
    }

    const result = await vendorCatalog.importWithMappings(fileData, type, {
        columnMappings: resolvedMappings || {},
        vendorId,
        vendorName: vendorName || 'Unknown Vendor',
        importName: importName || null,
        merchantId
    });

    if (result.success) {
        sendSuccess(res, {
            message: `Imported ${result.stats.imported} items from vendor catalog`,
            batchId: result.batchId,
            stats: result.stats,
            validationErrors: result.validationErrors,
            fieldMap: result.fieldMap,
            duration: result.duration,
            importName: result.importName,
            vendorName: result.vendorName
        });
    } else {
        sendError(res, result.error, 400);
    }
}));

/**
 * GET /api/vendor-catalog/field-types
 * Get supported field types for column mapping
 */
router.get('/vendor-catalog/field-types', requireAuth, (req, res) => {
    sendSuccess(res, { fieldTypes: vendorCatalog.FIELD_TYPES });
});

/**
 * GET /api/vendor-catalog
 * Search and list vendor catalog items
 */
router.get('/vendor-catalog', requireAuth, requireMerchant, validators.searchCatalog, asyncHandler(async (req, res) => {
    const { vendor_id, vendor_name, upc, search, matched_only, limit, offset } = req.query;
    const merchantId = req.merchantContext.id;

    const items = await vendorCatalog.searchVendorCatalog({
        vendorId: vendor_id,
        vendorName: vendor_name,
        upc,
        search,
        matchedOnly: matched_only === 'true',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        merchantId
    });

    sendSuccess(res, {
        count: items.length,
        items
    });
}));

/**
 * GET /api/vendor-catalog/lookup/:upc
 * Quick lookup by UPC - returns all vendor items matching UPC
 */
router.get('/vendor-catalog/lookup/:upc', requireAuth, requireMerchant, validators.lookupUpc, asyncHandler(async (req, res) => {
    const { upc } = req.params;
    const merchantId = req.merchantContext.id;

    if (!upc) {
        return sendError(res, 'UPC is required', 400);
    }

    const items = await vendorCatalog.lookupByUPC(upc, merchantId);

    // Also look up our catalog item by UPC
    const ourItem = await db.query(`
        SELECT
            v.id, v.sku, v.name as variation_name, v.upc, v.price_money,
            i.name as item_name, i.category_name,
            vv.unit_cost_money as current_cost_cents,
            vv.vendor_id as current_vendor_id
        FROM variations v
        JOIN items i ON v.item_id = i.id AND i.merchant_id = $2
        LEFT JOIN variation_vendors vv ON v.id = vv.variation_id AND vv.merchant_id = $2
        WHERE v.upc = $1
          AND (v.is_deleted = FALSE OR v.is_deleted IS NULL)
          AND v.merchant_id = $2
        LIMIT 1
    `, [upc, merchantId]);

    sendSuccess(res, {
        upc,
        vendorItems: items,
        ourCatalogItem: ourItem.rows[0] || null
    });
}));

/**
 * GET /api/vendor-catalog/batches
 * List import batches with summary stats
 * Query params: include_archived=true to include archived imports
 */
router.get('/vendor-catalog/batches', requireAuth, requireMerchant, validators.getBatches, asyncHandler(async (req, res) => {
    const { include_archived } = req.query;
    const merchantId = req.merchantContext.id;
    const batches = await vendorCatalog.getImportBatches({
        includeArchived: include_archived === 'true',
        merchantId
    });
    sendSuccess(res, {
        count: batches.length,
        batches
    });
}));

/**
 * POST /api/vendor-catalog/batches/:batchId/archive
 * Archive an import batch (soft delete - keeps for searches)
 */
router.post('/vendor-catalog/batches/:batchId/archive', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const merchantId = req.merchantContext.id;

    if (!batchId) {
        return sendError(res, 'Batch ID is required', 400);
    }

    const archivedCount = await vendorCatalog.archiveImportBatch(batchId, merchantId);
    sendSuccess(res, {
        message: `Archived ${archivedCount} items from batch ${batchId}`,
        archivedCount
    });
}));

/**
 * POST /api/vendor-catalog/batches/:batchId/unarchive
 * Unarchive an import batch
 */
router.post('/vendor-catalog/batches/:batchId/unarchive', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const merchantId = req.merchantContext.id;

    if (!batchId) {
        return sendError(res, 'Batch ID is required', 400);
    }

    const unarchivedCount = await vendorCatalog.unarchiveImportBatch(batchId, merchantId);
    sendSuccess(res, {
        message: `Unarchived ${unarchivedCount} items from batch ${batchId}`,
        unarchivedCount
    });
}));

/**
 * DELETE /api/vendor-catalog/batches/:batchId
 * Permanently delete an import batch
 */
router.delete('/vendor-catalog/batches/:batchId', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const merchantId = req.merchantContext.id;

    if (!batchId) {
        return sendError(res, 'Batch ID is required', 400);
    }

    const deletedCount = await vendorCatalog.deleteImportBatch(batchId, merchantId);
    sendSuccess(res, {
        message: `Permanently deleted ${deletedCount} items from batch ${batchId}`,
        deletedCount
    });
}));

/**
 * GET /api/vendor-catalog/batches/:batchId/report
 * Regenerate price update report for a previously imported batch
 * Compares stored vendor prices against current catalog prices
 */
router.get('/vendor-catalog/batches/:batchId/report', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const merchantId = req.merchantContext.id;

    if (!batchId) {
        return sendError(res, 'Batch ID is required', 400);
    }

    const report = await vendorCatalog.regeneratePriceReport(batchId, merchantId);

    if (!report.success) {
        return sendError(res, report.error || 'Report generation failed', 404);
    }

    sendSuccess(res, report);
}));

/**
 * GET /api/vendor-catalog/stats
 * Get vendor catalog statistics
 */
router.get('/vendor-catalog/stats', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const stats = await vendorCatalog.getStats(merchantId);
    sendSuccess(res, stats);
}));

/**
 * POST /api/vendor-catalog/push-price-changes
 * Push selected price changes to Square
 * Body: { priceChanges: [{variationId, newPriceCents, currency?}] }
 */
router.post('/vendor-catalog/push-price-changes', requireAuth, requireMerchant, validators.pushPriceChanges, asyncHandler(async (req, res) => {
    const { priceChanges } = req.body;
    const merchantId = req.merchantContext.id;

    if (!priceChanges || !Array.isArray(priceChanges) || priceChanges.length === 0) {
        return sendError(res, 'priceChanges array is required and must not be empty', 400);
    }

    // Validate each price change
    for (const change of priceChanges) {
        if (!change.variationId) {
            return sendError(res, 'Each price change must have a variationId', 400);
        }
        if (typeof change.newPriceCents !== 'number' || change.newPriceCents < 0) {
            return sendError(res, `Invalid newPriceCents for variation ${change.variationId}`, 400);
        }
    }

    // Verify all variations belong to this merchant
    const variationIds = priceChanges.map(c => c.variationId);
    const placeholders = variationIds.map((_, i) => `$${i + 1}`).join(',');
    const verifyResult = await db.query(
        `SELECT id FROM variations WHERE id IN (${placeholders}) AND merchant_id = $${variationIds.length + 1}`,
        [...variationIds, merchantId]
    );

    if (verifyResult.rows.length !== variationIds.length) {
        return sendError(res, 'One or more variations do not belong to this merchant', 403);
    }

    logger.info('Pushing price changes to Square', { count: priceChanges.length, merchantId });

    const result = await squareApi.batchUpdateVariationPrices(priceChanges, merchantId);

    sendSuccess(res, {
        updated: result.updated,
        failed: result.failed,
        errors: result.errors,
        details: result.details
    });
}));

/**
 * GET /api/vendor-catalog/merchant-taxes
 * LOGIC CHANGE: Returns available tax configurations for bulk item creation (BACKLOG-88)
 */
router.get('/vendor-catalog/merchant-taxes', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { getMerchantToken, makeSquareRequest } = require('../services/square/square-client');

    try {
        const accessToken = await getMerchantToken(merchantId);
        const data = await makeSquareRequest('/v2/catalog/list?types=TAX', { accessToken });
        const taxes = (data.objects || [])
            .filter(obj => !obj.is_deleted)
            .map(obj => ({
                id: obj.id,
                name: obj.tax_data?.name || 'Unknown Tax',
                percentage: obj.tax_data?.percentage || null,
                enabled: obj.tax_data?.enabled !== false
            }));
        sendSuccess(res, { taxes });
    } catch (error) {
        logger.warn('Failed to fetch merchant taxes', { merchantId, error: error.message });
        sendSuccess(res, { taxes: [] });
    }
}));

/**
 * POST /api/vendor-catalog/confirm-links
 * LOGIC CHANGE: Confirm suggested vendor links after import review (BACKLOG-90)
 * Staff reviews suggested links from import and selects which to create.
 * Body: { links: [{ variation_id, vendor_id, vendor_code, cost_cents }] }
 */
router.post('/vendor-catalog/confirm-links', requireAuth, requireMerchant, validators.confirmLinks, asyncHandler(async (req, res) => {
    const { links } = req.body;
    const merchantId = req.merchantContext.id;

    logger.info('Confirming vendor links from import review', { count: links.length, merchantId });

    let created = 0;
    const errors = [];

    for (const link of links) {
        try {
            await db.query(`
                INSERT INTO variation_vendors (variation_id, vendor_id, vendor_code, unit_cost_money, currency, merchant_id, updated_at)
                VALUES ($1, $2, $3, $4, 'CAD', $5, CURRENT_TIMESTAMP)
                ON CONFLICT (variation_id, vendor_id, merchant_id) DO UPDATE SET
                    vendor_code = EXCLUDED.vendor_code,
                    unit_cost_money = EXCLUDED.unit_cost_money,
                    updated_at = CURRENT_TIMESTAMP
            `, [link.variation_id, link.vendor_id, link.vendor_code || null, link.cost_cents || null, merchantId]);
            created++;
        } catch (error) {
            errors.push({ variation_id: link.variation_id, error: error.message });
            logger.error('Failed to create vendor link', { variation_id: link.variation_id, error: error.message, merchantId });
        }
    }

    sendSuccess(res, { created, failed: errors.length, errors });
}));

/**
 * POST /api/vendor-catalog/deduplicate
 * Identify and optionally remove duplicate vendor catalog rows (BACKLOG-112).
 *
 * Duplicates accumulate when the same product is imported under different batch
 * IDs. This endpoint collapses them: keeps the matched row (or newest if none
 * matched), updates it to carry the latest import_batch_id, and deletes the rest.
 *
 * Body: { dry_run: true }   → return counts, no changes
 *       { dry_run: false }  → apply cleanup and return counts
 */
router.post('/vendor-catalog/deduplicate', requireAuth, requireMerchant, validators.deduplicate, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const dryRun = req.body.dry_run !== false; // default to dry_run=true for safety

    const result = await vendorCatalog.deduplicateVendorCatalog(merchantId, dryRun);

    logger.info('vendor-catalog deduplicate', { merchantId, dryRun, ...result });

    sendSuccess(res, {
        dry_run: dryRun,
        found: result.found,
        products: result.products,
        removed: result.removed,
        message: dryRun
            ? `Found ${result.found} duplicate rows across ${result.products} products. Run with dry_run: false to remove them.`
            : `Removed ${result.removed} duplicate rows across ${result.products} products.`
    });
}));

/**
 * POST /api/vendor-catalog/create-items
 * LOGIC CHANGE: bulk create items from vendor catalog
 * Create Square catalog items from unmatched vendor catalog entries
 * Body: { vendorCatalogIds: [1, 2, 3, ...] }
 */
router.post('/vendor-catalog/create-items', requireAuth, requireMerchant, validators.createItems, asyncHandler(async (req, res) => {
    const { vendorCatalogIds, tax_ids } = req.body;
    const merchantId = req.merchantContext.id;

    logger.info('Bulk create Square items from vendor catalog', { count: vendorCatalogIds.length, merchantId });

    const { bulkCreateSquareItems } = require('../services/vendor/catalog-create-service');
    // LOGIC CHANGE: Pass tax_ids if provided (BACKLOG-88)
    const options = {};
    if (tax_ids !== undefined) {
        options.tax_ids = tax_ids;
    }
    const result = await bulkCreateSquareItems(vendorCatalogIds, merchantId, options);

    sendSuccess(res, {
        created: result.created,
        failed: result.failed,
        errors: result.errors
    });
}));

module.exports = router;
