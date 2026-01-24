/**
 * Vendor Catalog Routes
 *
 * Handles vendor management and vendor catalog import/matching:
 * - Vendor listing
 * - CSV/XLSX file import with column mapping
 * - UPC lookup and matching
 * - Import batch management
 * - Price change push to Square
 *
 * Endpoints:
 * - GET    /api/vendors                                  - List vendors
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
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const vendorCatalog = require('../utils/vendor-catalog');
const squareApi = require('../utils/square-api');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/vendor-catalog');

/**
 * GET /api/vendors
 * List all vendors
 */
router.get('/vendors', requireAuth, requireMerchant, validators.getVendors, async (req, res) => {
    try {
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
        res.json({
            count: result.rows.length,
            vendors: result.rows
        });
    } catch (error) {
        logger.error('Get vendors error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/import
 * Import vendor catalog from CSV or XLSX file
 * Expects multipart form data with 'file' field or JSON body with 'data' and 'fileType'
 */
router.post('/vendor-catalog/import', requireAuth, requireMerchant, validators.importCatalog, async (req, res) => {
    try {
        const { data, fileType, fileName, defaultVendorName } = req.body;
        const merchantId = req.merchantContext.id;

        if (!data) {
            return res.status(400).json({
                error: 'Missing file data',
                message: 'Please provide file data in the request body'
            });
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
            res.json({
                success: true,
                message: `Imported ${result.stats.imported} items from vendor catalog`,
                batchId: result.batchId,
                stats: result.stats,
                validationErrors: result.validationErrors,
                fieldMap: result.fieldMap,
                duration: result.duration
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error,
                batchId: result.batchId,
                validationErrors: result.validationErrors
            });
        }
    } catch (error) {
        logger.error('Vendor catalog import error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/preview
 * Preview file contents and get auto-detected column mappings
 */
router.post('/vendor-catalog/preview', requireAuth, requireMerchant, validators.previewFile, async (req, res) => {
    try {
        const { data, fileType, fileName } = req.body;

        if (!data) {
            return res.status(400).json({
                error: 'Missing file data',
                message: 'Please provide file data in the request body'
            });
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

        res.json({
            success: true,
            totalRows: preview.totalRows,
            columns,
            autoMappings,
            sampleValues,
            fieldTypes: preview.fieldTypes
        });

    } catch (error) {
        logger.error('Vendor catalog preview error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/import-mapped
 * Import vendor catalog with explicit column mappings
 * Requires: vendorId (selected vendor), columnMappings
 * Optional: importName (catalog name like "ABC Corp 2025 Price List")
 */
router.post('/vendor-catalog/import-mapped', requireAuth, requireMerchant, validators.importMapped, async (req, res) => {
    try {
        // Accept both 'mappings' (frontend) and 'columnMappings' (API) for compatibility
        const { data, fileType, fileName, columnMappings, mappings, vendorId, vendorName, importName } = req.body;
        const resolvedMappings = columnMappings || mappings;
        const merchantId = req.merchantContext.id;

        if (!data) {
            return res.status(400).json({
                error: 'Missing file data',
                message: 'Please provide file data in the request body'
            });
        }

        if (!vendorId) {
            return res.status(400).json({
                error: 'Missing vendor',
                message: 'Please select a vendor for this import'
            });
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
            res.json({
                success: true,
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
            res.status(400).json({
                success: false,
                error: result.error,
                batchId: result.batchId,
                validationErrors: result.validationErrors,
                fieldMap: result.fieldMap
            });
        }
    } catch (error) {
        logger.error('Vendor catalog import-mapped error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/field-types
 * Get supported field types for column mapping
 */
router.get('/vendor-catalog/field-types', requireAuth, (req, res) => {
    res.json({ fieldTypes: vendorCatalog.FIELD_TYPES });
});

/**
 * GET /api/vendor-catalog
 * Search and list vendor catalog items
 */
router.get('/vendor-catalog', requireAuth, requireMerchant, validators.searchCatalog, async (req, res) => {
    try {
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

        res.json({
            count: items.length,
            items
        });
    } catch (error) {
        logger.error('Vendor catalog search error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/lookup/:upc
 * Quick lookup by UPC - returns all vendor items matching UPC
 */
router.get('/vendor-catalog/lookup/:upc', requireAuth, requireMerchant, validators.lookupUpc, async (req, res) => {
    try {
        const { upc } = req.params;
        const merchantId = req.merchantContext.id;

        if (!upc) {
            return res.status(400).json({ error: 'UPC is required' });
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

        res.json({
            upc,
            vendorItems: items,
            ourCatalogItem: ourItem.rows[0] || null
        });
    } catch (error) {
        logger.error('Vendor catalog lookup error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/batches
 * List import batches with summary stats
 * Query params: include_archived=true to include archived imports
 */
router.get('/vendor-catalog/batches', requireAuth, requireMerchant, validators.getBatches, async (req, res) => {
    try {
        const { include_archived } = req.query;
        const merchantId = req.merchantContext.id;
        const batches = await vendorCatalog.getImportBatches({
            includeArchived: include_archived === 'true',
            merchantId
        });
        res.json({
            count: batches.length,
            batches
        });
    } catch (error) {
        logger.error('Get vendor catalog batches error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/batches/:batchId/archive
 * Archive an import batch (soft delete - keeps for searches)
 */
router.post('/vendor-catalog/batches/:batchId/archive', requireAuth, requireMerchant, validators.batchAction, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const archivedCount = await vendorCatalog.archiveImportBatch(batchId, merchantId);
        res.json({
            success: true,
            message: `Archived ${archivedCount} items from batch ${batchId}`,
            archivedCount
        });
    } catch (error) {
        logger.error('Archive vendor catalog batch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/batches/:batchId/unarchive
 * Unarchive an import batch
 */
router.post('/vendor-catalog/batches/:batchId/unarchive', requireAuth, requireMerchant, validators.batchAction, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const unarchivedCount = await vendorCatalog.unarchiveImportBatch(batchId, merchantId);
        res.json({
            success: true,
            message: `Unarchived ${unarchivedCount} items from batch ${batchId}`,
            unarchivedCount
        });
    } catch (error) {
        logger.error('Unarchive vendor catalog batch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/vendor-catalog/batches/:batchId
 * Permanently delete an import batch
 */
router.delete('/vendor-catalog/batches/:batchId', requireAuth, requireMerchant, validators.batchAction, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ error: 'Batch ID is required' });
        }

        const deletedCount = await vendorCatalog.deleteImportBatch(batchId, merchantId);
        res.json({
            success: true,
            message: `Permanently deleted ${deletedCount} items from batch ${batchId}`,
            deletedCount
        });
    } catch (error) {
        logger.error('Delete vendor catalog batch error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/batches/:batchId/report
 * Regenerate price update report for a previously imported batch
 * Compares stored vendor prices against current catalog prices
 */
router.get('/vendor-catalog/batches/:batchId/report', requireAuth, requireMerchant, validators.batchAction, async (req, res) => {
    try {
        const { batchId } = req.params;
        const merchantId = req.merchantContext.id;

        if (!batchId) {
            return res.status(400).json({ success: false, error: 'Batch ID is required' });
        }

        const report = await vendorCatalog.regeneratePriceReport(batchId, merchantId);

        if (!report.success) {
            return res.status(404).json(report);
        }

        res.json(report);
    } catch (error) {
        logger.error('Regenerate vendor catalog report error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/vendor-catalog/stats
 * Get vendor catalog statistics
 */
router.get('/vendor-catalog/stats', requireAuth, requireMerchant, async (req, res) => {
    try {
        const merchantId = req.merchantContext.id;
        const stats = await vendorCatalog.getStats(merchantId);
        res.json(stats);
    } catch (error) {
        logger.error('Get vendor catalog stats error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/vendor-catalog/push-price-changes
 * Push selected price changes to Square
 * Body: { priceChanges: [{variationId, newPriceCents, currency?}] }
 */
router.post('/vendor-catalog/push-price-changes', requireAuth, requireMerchant, validators.pushPriceChanges, async (req, res) => {
    try {
        const { priceChanges } = req.body;
        const merchantId = req.merchantContext.id;

        if (!priceChanges || !Array.isArray(priceChanges) || priceChanges.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'priceChanges array is required and must not be empty'
            });
        }

        // Validate each price change
        for (const change of priceChanges) {
            if (!change.variationId) {
                return res.status(400).json({
                    success: false,
                    error: 'Each price change must have a variationId'
                });
            }
            if (typeof change.newPriceCents !== 'number' || change.newPriceCents < 0) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid newPriceCents for variation ${change.variationId}`
                });
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
            return res.status(403).json({
                success: false,
                error: 'One or more variations do not belong to this merchant'
            });
        }

        logger.info('Pushing price changes to Square', { count: priceChanges.length, merchantId });

        const result = await squareApi.batchUpdateVariationPrices(priceChanges, merchantId);

        res.json({
            success: result.success,
            updated: result.updated,
            failed: result.failed,
            errors: result.errors,
            details: result.details
        });
    } catch (error) {
        logger.error('Push price changes error', { error: error.message, stack: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
