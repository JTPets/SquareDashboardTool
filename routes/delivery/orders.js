// Delivery orders sub-router: CRUD, lifecycle, customer info, and notes.
const express = require('express');
const router = express.Router();
const deliveryApi = require('../../services/delivery');
const deliveryStats = require('../../services/delivery/delivery-stats');
const asyncHandler = require('../../middleware/async-handler');
const { configureDeliveryRateLimit } = require('../../middleware/security');
const validators = require('../../middleware/validators/delivery');
const { requireWriteAccess } = require('../../middleware/auth');
const { sendSuccess, sendError } = require('../../utils/response-helper');

const deliveryRateLimit = configureDeliveryRateLimit();

router.get('/orders', validators.listOrders, asyncHandler(async (req, res) => {
    const { status, routeDate, routeId, dateFrom, dateTo, includeCompleted, limit, offset } = req.query;
    const merchantId = req.merchantContext.id;
    const orders = await deliveryApi.getOrders(merchantId, {
        status: status ? status.split(',') : null,
        routeDate, routeId, dateFrom, dateTo,
        includeCompleted: includeCompleted === 'true',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });
    sendSuccess(res, { orders });
}));

// Create manual order — includes inline geocode + audit (no service fn for this combination yet)
router.post('/orders', deliveryRateLimit, requireWriteAccess, validators.createOrder, asyncHandler(async (req, res) => {
    const { customerName, address, phone, notes } = req.body;
    const merchantId = req.merchantContext.id;
    if (!customerName || !address) return sendError(res, 'Customer name and address are required', 400);
    const order = await deliveryApi.createOrder(merchantId, { customerName, address, phone, notes });
    const coords = await deliveryApi.geocodeAndPatchOrder(merchantId, order.id, address);
    if (coords) { order.address_lat = coords.lat; order.address_lng = coords.lng; order.geocoded_at = new Date(); }
    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_created', order.id, null,
        { manual: true, customerName }, req.ip, req.get('user-agent'));
    sendSuccess(res, { order }, 201);
}));

router.get('/orders/:id', validators.getOrder, asyncHandler(async (req, res) => {
    const order = await deliveryApi.getOrderById(req.merchantContext.id, req.params.id);
    if (!order) return sendError(res, 'Order not found', 404);
    sendSuccess(res, { order });
}));

// Update order — field whitelist + optional re-geocode on address change
router.patch('/orders/:id', deliveryRateLimit, requireWriteAccess, validators.updateOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const updates = {};
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.phone !== undefined) updates.phone = req.body.phone;
    if (req.body.customerName !== undefined) updates.customerName = req.body.customerName;
    if (req.body.address !== undefined) updates.address = req.body.address;
    const order = await deliveryApi.updateOrder(merchantId, req.params.id, updates);
    if (!order) return sendError(res, 'Order not found', 404);
    if (req.body.address) await deliveryApi.geocodeAndPatchOrder(merchantId, order.id, req.body.address);
    sendSuccess(res, { order });
}));

router.delete('/orders/:id', deliveryRateLimit, requireWriteAccess, validators.deleteOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const deleted = await deliveryApi.deleteOrder(merchantId, req.params.id);
    if (!deleted) return sendError(res, 'Cannot delete this order. Only manual orders not yet delivered can be deleted.', 400);
    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_deleted', req.params.id, null, {}, req.ip, req.get('user-agent'));
    sendSuccess(res, {});
}));

router.post('/orders/:id/skip', deliveryRateLimit, requireWriteAccess, validators.skipOrder, asyncHandler(async (req, res) => {
    const order = await deliveryApi.skipOrder(req.merchantContext.id, req.params.id, req.session.user.id);
    if (!order) return sendError(res, 'Order not found', 404);
    sendSuccess(res, { order });
}));

router.post('/orders/:id/complete', deliveryRateLimit, requireWriteAccess, validators.completeOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);
    if (!order) return sendError(res, 'Order not found', 404);
    const { squareSynced, squareSyncError } = await deliveryApi.completeDeliveryInSquare(merchantId, order);
    const completedOrder = await deliveryApi.completeOrder(merchantId, req.params.id, req.session.user.id);
    sendSuccess(res, { order: completedOrder, square_synced: squareSynced, square_sync_error: squareSyncError });
}));

router.get('/orders/:id/customer', validators.getOrder, asyncHandler(async (req, res) => {
    const { order, customerData } = await deliveryStats.getCustomerInfo(req.merchantContext.id, req.params.id);
    if (!order) return sendError(res, 'Order not found', 404);
    sendSuccess(res, customerData);
}));

router.patch('/orders/:id/customer-note', deliveryRateLimit, requireWriteAccess, validators.updateCustomerNote, asyncHandler(async (req, res) => {
    const result = await deliveryStats.updateCustomerNote(req.merchantContext.id, req.params.id, req.body.note);
    if (!result.order) return sendError(res, 'Order not found', 404);
    if (result.error) return sendError(res, result.error, 400);
    sendSuccess(res, { square_synced: result.squareSynced, customer_note: req.body.note });
}));

router.patch('/orders/:id/notes', deliveryRateLimit, requireWriteAccess, validators.updateOrderNotes, asyncHandler(async (req, res) => {
    const result = await deliveryApi.updateOrderNotes(req.merchantContext.id, req.params.id, req.body.notes);
    if (!result) return sendError(res, 'Order not found', 404);
    sendSuccess(res, result);
}));

router.get('/orders/:id/customer-stats', validators.getOrder, asyncHandler(async (req, res) => {
    const { order, stats } = await deliveryStats.getCustomerStats(req.merchantContext.id, req.params.id);
    if (!order) return sendError(res, 'Order not found', 404);
    sendSuccess(res, stats);
}));

module.exports = router;
