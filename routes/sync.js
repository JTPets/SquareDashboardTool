// Sync routes — thin callers only. All logic lives in services/square/sync-orchestrator.js

const express = require('express');
const router = express.Router();
const squareApi = require('../services/square');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const validators = require('../middleware/validators/sync');
const asyncHandler = require('../middleware/async-handler');
const { sendSuccess } = require('../utils/response-helper');
const logger = require('../utils/logger');
const { runSmartSync, isSyncNeeded, getSyncHistory, getSyncStatus, loggedSync } = require('../services/square/sync-orchestrator');

router.post('/sync', requireAuth, requireMerchant, requireWriteAccess, validators.sync, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Full sync requested', { merchantId });
    const summary = await squareApi.fullSync(merchantId);

    let gmcFeedResult = null;
    try {
        const gmcFeedModule = require('../services/gmc/feed-service');
        gmcFeedResult = await gmcFeedModule.generateFeed();
        logger.info('GMC feed generated successfully', { products: gmcFeedResult.stats.total, feedUrl: gmcFeedResult.feedUrl });
    } catch (gmcError) {
        logger.error('GMC feed generation failed (non-blocking)', { error: gmcError.message, merchantId });
        gmcFeedResult = { error: gmcError.message };
    }

    sendSuccess(res, {
        status: summary.success ? 'success' : 'partial',
        summary: {
            locations: summary.locations,
            vendors: summary.vendors,
            items: summary.catalog.items || 0,
            variations: summary.catalog.variations || 0,
            categories: summary.catalog.categories || 0,
            images: summary.catalog.images || 0,
            variation_vendors: summary.catalog.variationVendors || 0,
            inventory_records: summary.inventory,
            sales_velocity_91d: summary.salesVelocity['91d'] || 0,
            sales_velocity_182d: summary.salesVelocity['182d'] || 0,
            sales_velocity_365d: summary.salesVelocity['365d'] || 0,
            gmc_feed: gmcFeedResult ? { products: gmcFeedResult.stats?.total || 0, feedUrl: gmcFeedResult.feedUrl, error: gmcFeedResult.error } : null
        },
        errors: summary.errors
    });
}));

router.post('/sync-sales', requireAuth, requireMerchant, requireWriteAccess, validators.syncSales, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Sales velocity sync requested (optimized)', { merchantId });
    const results = await squareApi.syncSalesVelocityAllPeriods(merchantId);
    sendSuccess(res, { status: 'success', periods: [91, 182, 365], variations_updated: results, optimization: 'single_fetch' });
}));

router.post('/sync-smart', requireAuth, requireMerchant, requireWriteAccess, validators.syncSmart, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Smart sync requested', { merchantId });
    const result = await runSmartSync({ merchantId });
    sendSuccess(res, result);
}));

router.get('/sync-history', requireAuth, requireMerchant, validators.syncHistory, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const limit = parseInt(req.query.limit) || 20;
    const data = await getSyncHistory(merchantId, { limit });
    sendSuccess(res, data);
}));

router.get('/sync-intervals', requireAuth, requireMerchant, validators.syncIntervals, asyncHandler(async (req, res) => {
    sendSuccess(res, {
        intervals: {
            catalog:    parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS    || '3'),
            locations:  parseInt(process.env.SYNC_LOCATIONS_INTERVAL_HOURS  || '3'),
            vendors:    parseInt(process.env.SYNC_VENDORS_INTERVAL_HOURS    || '24'),
            inventory:  parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS  || '3'),
            sales_91d:  parseInt(process.env.SYNC_SALES_91D_INTERVAL_HOURS  || '3'),
            sales_182d: parseInt(process.env.SYNC_SALES_182D_INTERVAL_HOURS || '24'),
            sales_365d: parseInt(process.env.SYNC_SALES_365D_INTERVAL_HOURS || '168'),
            gmc: process.env.GMC_SYNC_CRON_SCHEDULE || null
        },
        cronSchedule: process.env.SYNC_CRON_SCHEDULE || '0 * * * *'
    });
}));

router.get('/sync-status', requireAuth, requireMerchant, validators.syncStatus, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const status = await getSyncStatus(merchantId);
    sendSuccess(res, status);
}));

module.exports = router;
// Re-export for backward compat with server.js (cron) — import from sync-orchestrator directly going forward
module.exports.runSmartSync = runSmartSync;
module.exports.isSyncNeeded = isSyncNeeded;
module.exports.loggedSync = loggedSync;
