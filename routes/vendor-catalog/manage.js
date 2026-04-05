const express = require('express');
const router = express.Router();
const vendorCatalog = require('../../services/vendor');
const vendorQuery = require('../../services/vendor/vendor-query-service');
const squareApi = require('../../services/square');
const { bulkCreateSquareItems } = require('../../services/vendor/catalog-create-service');
const { requireAuth } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const validators = require('../../middleware/validators/vendor-catalog');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const logger = require('../../utils/logger');

router.post('/vendor-catalog/push-price-changes', requireAuth, requireMerchant, validators.pushPriceChanges, asyncHandler(async (req, res) => {
    const { priceChanges } = req.body;
    const merchantId = req.merchantContext.id;
    const variationIds = priceChanges.map(c => c.variationId);
    const allVerified = await vendorQuery.verifyVariationsBelongToMerchant(merchantId, variationIds);
    if (!allVerified) {
        return sendError(res, 'One or more variations do not belong to this merchant', 403);
    }
    logger.info('Pushing price changes to Square', { count: priceChanges.length, merchantId });
    const result = await squareApi.batchUpdateVariationPrices(priceChanges, merchantId);
    sendSuccess(res, { updated: result.updated, failed: result.failed, errors: result.errors, details: result.details });
}));

router.post('/vendor-catalog/confirm-links', requireAuth, requireMerchant, validators.confirmLinks, asyncHandler(async (req, res) => {
    const { links } = req.body;
    const merchantId = req.merchantContext.id;
    logger.info('Confirming vendor links from import review', { count: links.length, merchantId });
    const result = await vendorQuery.confirmVendorLinks(merchantId, links);
    sendSuccess(res, { created: result.created, failed: result.failed, errors: result.errors });
}));

router.post('/vendor-catalog/deduplicate', requireAuth, requireMerchant, validators.deduplicate, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const dryRun = req.body.dry_run !== false;
    const result = await vendorCatalog.deduplicateVendorCatalog(merchantId, dryRun);
    logger.info('vendor-catalog deduplicate', { merchantId, dryRun, ...result });
    sendSuccess(res, {
        dry_run: dryRun, found: result.found, products: result.products, removed: result.removed,
        message: dryRun
            ? `Found ${result.found} duplicate rows across ${result.products} products. Run with dry_run: false to remove them.`
            : `Removed ${result.removed} duplicate rows across ${result.products} products.`
    });
}));

router.post('/vendor-catalog/create-items', requireAuth, requireMerchant, validators.createItems, asyncHandler(async (req, res) => {
    const { vendorCatalogIds, tax_ids } = req.body;
    const merchantId = req.merchantContext.id;
    logger.info('Bulk create Square items from vendor catalog', { count: vendorCatalogIds.length, merchantId });
    const options = tax_ids !== undefined ? { tax_ids } : {};
    const result = await bulkCreateSquareItems(vendorCatalogIds, merchantId, options);
    sendSuccess(res, { created: result.created, failed: result.failed, errors: result.errors });
}));

router.post('/vendor-catalog/batches/:batchId/archive', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    if (!batchId) return sendError(res, 'Batch ID is required', 400);
    const archivedCount = await vendorCatalog.archiveImportBatch(batchId, req.merchantContext.id);
    sendSuccess(res, { message: `Archived ${archivedCount} items from batch ${batchId}`, archivedCount });
}));

router.post('/vendor-catalog/batches/:batchId/unarchive', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    if (!batchId) return sendError(res, 'Batch ID is required', 400);
    const unarchivedCount = await vendorCatalog.unarchiveImportBatch(batchId, req.merchantContext.id);
    sendSuccess(res, { message: `Unarchived ${unarchivedCount} items from batch ${batchId}`, unarchivedCount });
}));

router.delete('/vendor-catalog/batches/:batchId', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    if (!batchId) return sendError(res, 'Batch ID is required', 400);
    const deletedCount = await vendorCatalog.deleteImportBatch(batchId, req.merchantContext.id);
    sendSuccess(res, { message: `Permanently deleted ${deletedCount} items from batch ${batchId}`, deletedCount });
}));

module.exports = router;
