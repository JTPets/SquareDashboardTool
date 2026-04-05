// GMC settings, location settings, and Merchant Center API endpoints
const router = require('express').Router();
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const gmcFeed = require('../../services/gmc/feed-service');
const gmcApi = require('../../services/gmc/merchant-service');
const validators = require('../../middleware/validators/gmc');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const asyncHandler = require('../../middleware/async-handler');
const { getLocationById } = require('../../services/catalog/location-service');
const { sendSuccess, sendError } = require('../../utils/response-helper');

router.get('/settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    sendSuccess(res, { settings: await gmcFeed.getSettings(req.merchantContext.id) });
}));

router.put('/settings', requireAuth, requireMerchant, requireWriteAccess, validators.updateSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    await gmcFeed.saveSettings(merchantId, req.body.settings);
    sendSuccess(res, { settings: await gmcFeed.getSettings(merchantId) });
}));

router.get('/location-settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await db.query(`
        SELECT l.id AS location_id, l.name AS location_name, l.address AS location_address, l.active,
               COALESCE(gls.google_store_code, '') AS google_store_code,
               COALESCE(gls.enabled, true) AS enabled
        FROM locations l
        LEFT JOIN gmc_location_settings gls ON l.id = gls.location_id AND gls.merchant_id = $1
        WHERE l.merchant_id = $1
        ORDER BY l.name
    `, [merchantId]);
    sendSuccess(res, { locations: result.rows });
}));

router.put('/location-settings/:locationId', requireAuth, requireMerchant, requireWriteAccess, validators.updateLocationSettings, asyncHandler(async (req, res) => {
    const { locationId } = req.params;
    const merchantId = req.merchantContext.id;
    const location = await getLocationById(merchantId, locationId);
    if (!location) return sendError(res, 'Location not found', 404);
    await gmcFeed.saveLocationSettings(merchantId, locationId, { google_store_code: req.body.google_store_code, enabled: req.body.enabled });
    sendSuccess(res, { message: 'Location settings updated' });
}));

router.get('/api-settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    sendSuccess(res, { settings: await gmcApi.getGmcApiSettings(req.merchantContext.id) });
}));

router.put('/api-settings', requireAuth, requireMerchant, requireWriteAccess, validators.updateApiSettings, asyncHandler(async (req, res) => {
    await gmcApi.saveGmcApiSettings(req.merchantContext.id, req.body.settings);
    sendSuccess(res, { message: 'GMC API settings saved' });
}));

router.post('/api/test-connection', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    sendSuccess(res, await gmcApi.testConnection(req.merchantContext.id));
}));

router.get('/api/data-source-info', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const settings = await gmcApi.getGmcApiSettings(merchantId);
    if (!settings.gmc_merchant_id || !settings.gmc_data_source_id) {
        return sendError(res, 'GMC Merchant ID and Data Source ID must be configured', 400);
    }
    const dataSourceInfo = await gmcApi.getDataSourceInfo(merchantId, settings.gmc_merchant_id, settings.gmc_data_source_id);
    sendSuccess(res, { dataSource: dataSourceInfo, settings });
}));

router.post('/api/sync-products', requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    sendSuccess(res, { message: 'Sync started. Check Sync History for progress.', async: true });
    gmcApi.syncProductCatalog(merchantId).catch(err => {
        logger.error('Background GMC product sync error', { error: err.message, stack: err.stack, merchantId });
    });
}));

router.get('/api/sync-status', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    sendSuccess(res, { status: await gmcApi.getLastSyncStatus(req.merchantContext.id) });
}));

router.get('/api/sync-history', requireAuth, requireMerchant, validators.getSyncHistory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    sendSuccess(res, { history: await gmcApi.getSyncHistory(merchantId, parseInt(req.query.limit, 10) || 20) });
}));

router.post('/api/register-developer', requireAuth, requireMerchant, requireWriteAccess, validators.registerDeveloper, asyncHandler(async (req, res) => {
    const result = await gmcApi.registerDeveloper(req.merchantContext.id, req.body.email);
    if (!result.success) return sendError(res, result.error, 400, 'REGISTRATION_FAILED');
    sendSuccess(res, result);
}));

module.exports = router;
