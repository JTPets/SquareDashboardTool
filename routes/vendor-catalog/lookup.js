const express = require('express');
const router = express.Router();
const vendorCatalog = require('../../services/vendor');
const vendorQuery = require('../../services/vendor/vendor-query-service');
const { requireAuth } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const validators = require('../../middleware/validators/vendor-catalog');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

router.get('/vendor-catalog', requireAuth, requireMerchant, validators.searchCatalog, asyncHandler(async (req, res) => {
    const { vendor_id, vendor_name, upc, search, matched_only, limit, offset } = req.query;
    const items = await vendorCatalog.searchVendorCatalog({
        vendorId: vendor_id, vendorName: vendor_name, upc, search,
        matchedOnly: matched_only === 'true',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        merchantId: req.merchantContext.id
    });
    sendSuccess(res, { count: items.length, items });
}));

router.get('/vendor-catalog/lookup/:upc', requireAuth, requireMerchant, validators.lookupUpc, asyncHandler(async (req, res) => {
    const { upc } = req.params;
    if (!upc) return sendError(res, 'UPC is required', 400);
    const merchantId = req.merchantContext.id;
    const [vendorItems, ourCatalogItem] = await Promise.all([
        vendorCatalog.lookupByUPC(upc, merchantId),
        vendorQuery.lookupOurItemByUPC(merchantId, upc)
    ]);
    sendSuccess(res, { upc, vendorItems, ourCatalogItem });
}));

router.get('/vendor-catalog/batches', requireAuth, requireMerchant, validators.getBatches, asyncHandler(async (req, res) => {
    const batches = await vendorCatalog.getImportBatches({
        includeArchived: req.query.include_archived === 'true',
        merchantId: req.merchantContext.id
    });
    sendSuccess(res, { count: batches.length, batches });
}));

router.get('/vendor-catalog/batches/:batchId/report', requireAuth, requireMerchant, validators.batchAction, asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    if (!batchId) return sendError(res, 'Batch ID is required', 400);
    const report = await vendorCatalog.regeneratePriceReport(batchId, req.merchantContext.id);
    if (!report.success) return sendError(res, report.error || 'Report generation failed', 404);
    sendSuccess(res, report);
}));

module.exports = router;
