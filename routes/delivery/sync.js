// Delivery sync sub-router: Square order sync, customer backfill, audit log, and stats.
const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const deliveryApi = require('../../services/delivery');
const deliveryStats = require('../../services/delivery/delivery-stats');
const asyncHandler = require('../../middleware/async-handler');
const { configureDeliveryStrictRateLimit } = require('../../middleware/security');
const validators = require('../../middleware/validators/delivery');
const { requireWriteAccess } = require('../../middleware/auth');
const { sendSuccess } = require('../../utils/response-helper');

const deliveryStrictRateLimit = configureDeliveryStrictRateLimit();

router.post('/sync', deliveryStrictRateLimit, requireWriteAccess, validators.syncOrders, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { daysBack = 7 } = req.body;
    logger.info('Starting delivery order sync from Square', { merchantId, daysBack });
    const result = await deliveryApi.syncSquareOrders(merchantId, daysBack);
    sendSuccess(res, result);
}));

router.post('/backfill-customers', deliveryStrictRateLimit, requireWriteAccess, validators.backfillCustomers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.info('Starting customer backfill for delivery orders', { merchantId });
    const result = await deliveryApi.backfillUnknownCustomers(merchantId);
    sendSuccess(res, result);
}));

router.get('/audit', validators.getAudit, asyncHandler(async (req, res) => {
    const { limit, offset, action, orderId, routeId } = req.query;
    const entries = await deliveryApi.getAuditLog(req.merchantContext.id, {
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        action, orderId, routeId
    });
    sendSuccess(res, { entries });
}));

router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await deliveryStats.getDashboardStats(req.merchantContext.id);
    sendSuccess(res, { stats });
}));

module.exports = router;
