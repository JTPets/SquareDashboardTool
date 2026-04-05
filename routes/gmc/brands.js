// GMC brand management endpoints
const router = require('express').Router();
const gmcFeed = require('../../services/gmc/feed-service');
const brandService = require('../../services/gmc/brand-service');
const validators = require('../../middleware/validators/gmc');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

router.get('/brands', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    sendSuccess(res, await brandService.listBrands(req.merchantContext.id));
}));

router.post('/brands/import', requireAuth, requireMerchant, requireWriteAccess, validators.importBrands, asyncHandler(async (req, res) => {
    const imported = await gmcFeed.importBrands(req.body.brands, req.merchantContext.id);
    sendSuccess(res, { imported });
}));

router.post('/brands', requireAuth, requireMerchant, requireWriteAccess, validators.createBrand, asyncHandler(async (req, res) => {
    const { name, logo_url, website } = req.body;
    sendSuccess(res, await brandService.createBrand(req.merchantContext.id, { name, logo_url, website }));
}));

router.put('/items/:itemId/brand', requireAuth, requireMerchant, requireWriteAccess, validators.assignItemBrand, asyncHandler(async (req, res) => {
    const result = await brandService.assignItemBrand(req.merchantContext.id, req.params.itemId, req.body.brand_id);
    if (result.notFound === 'item') return sendError(res, 'Item not found', 404);
    if (result.notFound === 'brand') return sendError(res, 'Brand not found', 404);
    sendSuccess(res, result);
}));

router.post('/brands/auto-detect', requireAuth, requireMerchant, requireWriteAccess, validators.autoDetectBrands, asyncHandler(async (req, res) => {
    const result = await brandService.autoDetectBrands(req.merchantContext.id, req.body.brands);
    if (!result) return sendError(res, 'No valid brand names provided', 400);
    sendSuccess(res, result);
}));

router.post('/brands/bulk-assign', requireAuth, requireMerchant, requireWriteAccess, validators.bulkAssignBrands, asyncHandler(async (req, res) => {
    sendSuccess(res, await brandService.bulkAssignBrands(req.merchantContext.id, req.body.assignments));
}));

module.exports = router;
