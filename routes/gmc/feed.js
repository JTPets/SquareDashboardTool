// GMC feed, token, and local-inventory endpoints
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const gmcFeed = require('../../services/gmc/feed-service');
const validators = require('../../middleware/validators/gmc');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const { configureSensitiveOperationRateLimit } = require('../../middleware/security');
const asyncHandler = require('../../middleware/async-handler');
const { getLocationById } = require('../../services/catalog/location-service');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const { parseBasicAuth } = require('../../utils/basic-auth');

const sensitiveOperationRateLimit = configureSensitiveOperationRateLimit();

// Resolve merchantId from token (query param or Basic Auth) or session.
// Returns: merchantId | null (bad token) | undefined (no auth)
async function resolveFeedMerchant(req) {
    let token = req.query.token;
    if (!token) { const a = parseBasicAuth(req); if (a?.password) token = a.password; }
    if (token) {
        const r = await db.query('SELECT id FROM merchants WHERE gmc_feed_token = $1 AND is_active = TRUE', [token]);
        return r.rows.length ? r.rows[0].id : null;
    }
    return (req.session?.user && req.merchantContext?.id) ? req.merchantContext.id : undefined;
}

function rejectFeedAuth(res, invalidToken) {
    res.setHeader('WWW-Authenticate', 'Basic realm="GMC Feed"');
    return sendError(res, invalidToken
        ? 'Invalid or expired feed token'
        : 'Authentication required. Use ?token=<feed_token> or HTTP Basic Auth.', 401);
}

router.get('/feed', requireAuth, requireMerchant, validators.getFeed, asyncHandler(async (req, res) => {
    const { location_id, include_products } = req.query;
    const { products, stats, settings } = await gmcFeed.generateFeedData({
        locationId: location_id, includeProducts: include_products === 'true', merchantId: req.merchantContext.id
    });
    sendSuccess(res, { stats, settings, products });
}));

router.get('/feed.tsv', asyncHandler(async (req, res) => {
    const merchantId = await resolveFeedMerchant(req);
    if (merchantId == null) return rejectFeedAuth(res, merchantId === null);
    const { products } = await gmcFeed.generateFeedData({ locationId: req.query.location_id, merchantId });
    const tsvContent = gmcFeed.generateTsvContent(products);
    res.setHeader('Content-Type', 'text/tab-separated-values');
    res.setHeader('Content-Disposition', 'attachment; filename="gmc-feed.tsv"');
    res.send(tsvContent);
}));

router.get('/feed-url', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const r = await db.query('SELECT gmc_feed_token FROM merchants WHERE id = $1', [req.merchantContext.id]);
    if (!r.rows[0]?.gmc_feed_token) return sendError(res, 'Feed token not found. Please contact support.', 404);
    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
    sendSuccess(res, { feedUrl: `${baseUrl}/api/gmc/feed.tsv?token=${r.rows[0].gmc_feed_token}`, token: r.rows[0].gmc_feed_token, instructions: 'Use this URL in Google Merchant Center as your product feed URL. Keep the token secret.' });
}));

router.post('/regenerate-token', sensitiveOperationRateLimit, requireAuth, requireMerchant, requireWriteAccess, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const newToken = crypto.randomBytes(32).toString('hex');
    await db.query('UPDATE merchants SET gmc_feed_token = $1, updated_at = NOW() WHERE id = $2', [newToken, merchantId]);
    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
    logger.info('GMC feed token regenerated', { merchantId });
    sendSuccess(res, { feedUrl: `${baseUrl}/api/gmc/feed.tsv?token=${newToken}`, token: newToken, warning: 'Your previous feed URL is now invalid. Update Google Merchant Center with the new URL.' });
}));

router.get('/local-inventory-feed-url', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const r = await db.query('SELECT gmc_feed_token FROM merchants WHERE id = $1', [req.merchantContext.id]);
    if (!r.rows[0]?.gmc_feed_token) return sendError(res, 'Feed token not found. Please contact support.', 404);
    const baseUrl = process.env.BASE_URL || `https://${req.get('host')}`;
    sendSuccess(res, { feedUrl: `${baseUrl}/api/gmc/local-inventory-feed.tsv?token=${r.rows[0].gmc_feed_token}`, token: r.rows[0].gmc_feed_token, instructions: 'Use this URL in Google Merchant Center for local inventory. Keep the token secret.' });
}));

router.get('/local-inventory-feed', requireAuth, requireMerchant, validators.getLocalInventoryFeed, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    if (!await getLocationById(merchantId, req.query.location_id)) return sendError(res, 'Location not found', 404);
    const feedData = await gmcFeed.generateLocalInventoryFeed({ merchantId, locationId: req.query.location_id });
    sendSuccess(res, { items: feedData.items, location: feedData.location, stats: feedData.stats });
}));

router.get('/local-inventory-feed.tsv', asyncHandler(async (req, res) => {
    const merchantId = await resolveFeedMerchant(req);
    if (merchantId == null) return rejectFeedAuth(res, merchantId === null);
    const locsResult = await db.query(`
        SELECT gls.location_id, gls.google_store_code FROM gmc_location_settings gls
        WHERE gls.merchant_id = $1 AND gls.enabled = TRUE
          AND gls.google_store_code IS NOT NULL AND gls.google_store_code != ''
    `, [merchantId]);
    if (!locsResult.rows.length) return sendError(res, 'No enabled locations with store codes found. Configure location settings first.', 400);
    let allItems = [];
    for (const loc of locsResult.rows) {
        try {
            const { items } = await gmcFeed.generateLocalInventoryFeed({ merchantId, locationId: loc.location_id });
            allItems = allItems.concat(items);
        } catch (err) {
            logger.warn('Skipping location in combined feed', { merchantId, locationId: loc.location_id, error: err.message });
        }
    }
    const tsvContent = gmcFeed.generateLocalInventoryTsvContent(allItems);
    res.setHeader('Content-Type', 'text/tab-separated-values');
    res.setHeader('Content-Disposition', 'attachment; filename="local-inventory-feed.tsv"');
    res.send(tsvContent);
}));

module.exports = router;
