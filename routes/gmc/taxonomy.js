// GMC taxonomy listing, mapping, and Google fetch endpoints
const router = require('express').Router();
const gmcFeed = require('../../services/gmc/feed-service');
const taxonomyService = require('../../services/gmc/taxonomy-service');
const validators = require('../../middleware/validators/gmc');
const { requireAuth, requireAdmin, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

router.get('/taxonomy', requireAuth, validators.listTaxonomy, asyncHandler(async (req, res) => {
    sendSuccess(res, await taxonomyService.listTaxonomies({ search: req.query.search, limit: req.query.limit }));
}));

router.post('/taxonomy/import', requireAdmin, validators.importTaxonomy, asyncHandler(async (req, res) => {
    sendSuccess(res, { imported: await gmcFeed.importGoogleTaxonomy(req.body.taxonomy) });
}));

router.get('/taxonomy/fetch-google', requireAdmin, asyncHandler(async (req, res) => {
    const { imported } = await taxonomyService.fetchGoogleTaxonomy();
    sendSuccess(res, { imported, message: `Imported ${imported} taxonomy entries` });
}));

router.put('/categories/:categoryId/taxonomy', requireAuth, requireMerchant, requireWriteAccess, validators.mapCategoryTaxonomy, asyncHandler(async (req, res) => {
    const result = await taxonomyService.setMapping(req.merchantContext.id, req.params.categoryId, req.body.google_taxonomy_id);
    if (result?.notFound === 'category') return sendError(res, 'Category not found', 404);
    sendSuccess(res, result.removed ? { message: 'Taxonomy mapping removed' } : {});
}));

router.delete('/categories/:categoryId/taxonomy', requireAuth, requireMerchant, requireWriteAccess, validators.deleteCategoryTaxonomy, asyncHandler(async (req, res) => {
    await taxonomyService.deleteMapping(req.merchantContext.id, req.params.categoryId);
    sendSuccess(res, { message: 'Taxonomy mapping removed' });
}));

router.get('/category-mappings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    sendSuccess(res, await taxonomyService.getMappings(req.merchantContext.id));
}));

router.put('/category-taxonomy', requireAuth, requireMerchant, requireWriteAccess, validators.mapCategoryTaxonomyByName, asyncHandler(async (req, res) => {
    sendSuccess(res, await taxonomyService.setMappingByName(req.merchantContext.id, req.body.category_name, req.body.google_taxonomy_id));
}));

router.delete('/category-taxonomy', requireAuth, requireMerchant, requireWriteAccess, validators.deleteCategoryTaxonomyByName, asyncHandler(async (req, res) => {
    const result = await taxonomyService.deleteMappingByName(req.merchantContext.id, req.body.category_name);
    if (result?.notFound === 'category') return sendError(res, 'Category not found', 404);
    sendSuccess(res, { message: 'Taxonomy mapping removed' });
}));

module.exports = router;
