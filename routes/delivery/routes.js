// Delivery route management sub-router: generate, active, specific route, finish, geocode.
const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const deliveryApi = require('../../services/delivery');
const asyncHandler = require('../../middleware/async-handler');
const { configureDeliveryRateLimit, configureDeliveryStrictRateLimit } = require('../../middleware/security');
const validators = require('../../middleware/validators/delivery');
const { requireWriteAccess } = require('../../middleware/auth');
const { sendSuccess, sendError } = require('../../utils/response-helper');

const deliveryRateLimit = configureDeliveryRateLimit();
const deliveryStrictRateLimit = configureDeliveryStrictRateLimit();

router.post('/route/generate', deliveryStrictRateLimit, requireWriteAccess, validators.generateRoute, asyncHandler(async (req, res) => {
    const { routeDate, orderIds, excludeOrderIds, force, startLat, startLng, endLat, endLng } = req.body;
    const route = await deliveryApi.generateRoute(req.merchantContext.id, req.session.user.id, {
        routeDate, orderIds, excludeOrderIds, force,
        startLat: startLat != null ? parseFloat(startLat) : null,
        startLng: startLng != null ? parseFloat(startLng) : null,
        endLat: endLat != null ? parseFloat(endLat) : null,
        endLng: endLng != null ? parseFloat(endLng) : null
    });
    sendSuccess(res, { route }, 201);
}));

router.get('/route/active', validators.getActiveRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    logger.debug('Fetching active delivery route', { merchantId, routeDate: req.query.routeDate });
    const { route, orders } = await deliveryApi.getActiveRouteWithOrders(merchantId, req.query.routeDate);
    sendSuccess(res, { route, orders });
}));

router.get('/route/:id', validators.getRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const route = await deliveryApi.getRouteWithOrders(merchantId, req.params.id);
    if (!route) return sendError(res, 'Route not found', 404);
    sendSuccess(res, { route });
}));

router.post('/route/finish', deliveryRateLimit, requireWriteAccess, validators.finishRoute, asyncHandler(async (req, res) => {
    const result = await deliveryApi.finishRoute(req.merchantContext.id, req.body.routeId || null, req.session.user.id);
    sendSuccess(res, { result });
}));

router.post('/geocode', deliveryStrictRateLimit, requireWriteAccess, validators.geocode, asyncHandler(async (req, res) => {
    const result = await deliveryApi.geocodePendingOrders(req.merchantContext.id, req.body.limit || 10);
    sendSuccess(res, { result });
}));

module.exports = router;
