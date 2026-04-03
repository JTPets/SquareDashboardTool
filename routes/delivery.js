/**
 * Delivery Routes
 *
 * Handles delivery order management including:
 * - Order listing, creation, and updates
 * - Proof of delivery (POD) photo uploads
 * - Route optimization and management
 * - Customer info and stats from Square
 * - Delivery settings configuration
 * - Order sync from Square
 *
 * SECURITY CONSIDERATIONS:
 * - All endpoints require authentication
 * - All endpoints require merchant context (multi-tenant isolation)
 * - Rate limiting applied to write operations
 * - Strict rate limiting on geocoding and route generation
 * - File upload validation for POD photos
 *
 * Endpoints:
 * - GET    /api/delivery/orders                    - List delivery orders
 * - POST   /api/delivery/orders                    - Create manual order
 * - GET    /api/delivery/orders/:id                - Get single order
 * - PATCH  /api/delivery/orders/:id                - Update order
 * - DELETE /api/delivery/orders/:id                - Delete manual order
 * - POST   /api/delivery/orders/:id/skip           - Mark order as skipped
 * - POST   /api/delivery/orders/:id/complete       - Mark order as completed
 * - GET    /api/delivery/orders/:id/customer       - Get customer info
 * - PATCH  /api/delivery/orders/:id/customer-note  - Update customer note
 * - PATCH  /api/delivery/orders/:id/notes          - Update order notes
 * - GET    /api/delivery/orders/:id/customer-stats - Get customer stats
 * - POST   /api/delivery/orders/:id/pod            - Upload POD photo
 * - GET    /api/delivery/pod/:id                   - Serve POD photo
 * - POST   /api/delivery/route/generate            - Generate optimized route
 * - GET    /api/delivery/route/active              - Get active route
 * - GET    /api/delivery/route/:id                 - Get specific route
 * - POST   /api/delivery/route/finish              - Finish active route
 * - POST   /api/delivery/geocode                   - Geocode pending orders
 * - GET    /api/delivery/settings                  - Get delivery settings
 * - PUT    /api/delivery/settings                  - Update delivery settings
 * - GET    /api/delivery/audit                     - Get audit log
 * - GET    /api/delivery/stats                     - Get delivery statistics
 * - POST   /api/delivery/sync                      - Sync orders from Square
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../utils/logger');
const deliveryApi = require('../services/delivery');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const { configureDeliveryRateLimit, configureDeliveryStrictRateLimit } = require('../middleware/security');
const { validateUploadedImage } = require('../utils/file-validation');
const validators = require('../middleware/validators/delivery');
const deliveryStats = require('../services/delivery/delivery-stats');
const { sendSuccess, sendError } = require('../utils/response-helper');

// Rate limiters
const deliveryRateLimit = configureDeliveryRateLimit();
const deliveryStrictRateLimit = configureDeliveryStrictRateLimit();

// Configure multer for POD photo uploads
const podUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max
    },
    fileFilter: (req, file, cb) => {
        // Only accept images
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

/**
 * GET /api/delivery/orders
 * List delivery orders with optional filtering
 */
router.get('/orders', requireAuth, requireMerchant, validators.listOrders, asyncHandler(async (req, res) => {
    const { status, routeDate, routeId, dateFrom, dateTo, includeCompleted, limit, offset } = req.query;
    const merchantId = req.merchantContext.id;

    const orders = await deliveryApi.getOrders(merchantId, {
        status: status ? status.split(',') : null,
        routeDate,
        routeId,
        dateFrom,
        dateTo,
        includeCompleted: includeCompleted === 'true',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0
    });

    sendSuccess(res, { orders });
}));

/**
 * POST /api/delivery/orders
 * Create a manual delivery order
 */
router.post('/orders', deliveryRateLimit, requireAuth, requireMerchant, validators.createOrder, asyncHandler(async (req, res) => {
    const { customerName, address, phone, notes } = req.body;
    const merchantId = req.merchantContext.id;

    if (!customerName || !address) {
        return sendError(res, 'Customer name and address are required', 400);
    }

    const order = await deliveryApi.createOrder(merchantId, { customerName, address, phone, notes });

    const coords = await deliveryApi.geocodeAndPatchOrder(merchantId, order.id, address);
    if (coords) {
        order.address_lat = coords.lat;
        order.address_lng = coords.lng;
        order.geocoded_at = new Date();
    }

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_created', order.id, null, {
        manual: true,
        customerName
    }, req.ip, req.get('user-agent'));

    sendSuccess(res, { order }, 201);
}));

/**
 * GET /api/delivery/orders/:id
 * Get a single delivery order
 */
router.get('/orders/:id', requireAuth, requireMerchant, validators.getOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    sendSuccess(res, { order });
}));

/**
 * PATCH /api/delivery/orders/:id
 * Update a delivery order (notes, status)
 */
router.patch('/orders/:id', deliveryRateLimit, requireAuth, requireMerchant, validators.updateOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const updates = {};

    // Only allow updating certain fields
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.phone !== undefined) updates.phone = req.body.phone;
    if (req.body.customerName !== undefined) updates.customerName = req.body.customerName;
    if (req.body.address !== undefined) updates.address = req.body.address;

    const order = await deliveryApi.updateOrder(merchantId, req.params.id, updates);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    if (req.body.address) {
        await deliveryApi.geocodeAndPatchOrder(merchantId, order.id, req.body.address);
    }

    sendSuccess(res, { order });
}));

/**
 * DELETE /api/delivery/orders/:id
 * Delete a manual delivery order (only allowed for manual orders not on route)
 */
router.delete('/orders/:id', deliveryRateLimit, requireAuth, requireMerchant, validators.deleteOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const deleted = await deliveryApi.deleteOrder(merchantId, req.params.id);

    if (!deleted) {
        return sendError(res, 'Cannot delete this order. Only manual orders not yet delivered can be deleted.', 400);
    }

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'order_deleted', req.params.id, null, {}, req.ip, req.get('user-agent'));

    sendSuccess(res, {});
}));

/**
 * POST /api/delivery/orders/:id/skip
 * Mark an order as skipped (driver couldn't deliver)
 */
router.post('/orders/:id/skip', deliveryRateLimit, requireAuth, requireMerchant, validators.skipOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.skipOrder(merchantId, req.params.id, req.session.user.id);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    sendSuccess(res, { order });
}));

/**
 * POST /api/delivery/orders/:id/complete
 * Mark an order as completed and sync to Square
 */
router.post('/orders/:id/complete', deliveryRateLimit, requireAuth, requireMerchant, validators.completeOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    const { squareSynced, squareSyncError } = await deliveryApi.completeDeliveryInSquare(merchantId, order);
    const completedOrder = await deliveryApi.completeOrder(merchantId, req.params.id, req.session.user.id);

    sendSuccess(res, { order: completedOrder, square_synced: squareSynced, square_sync_error: squareSyncError });
}));

/**
 * GET /api/delivery/orders/:id/customer
 * Get customer info and notes from Square
 */
router.get('/orders/:id/customer', requireAuth, requireMerchant, validators.getOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { order, customerData } = await deliveryStats.getCustomerInfo(merchantId, req.params.id);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    sendSuccess(res, customerData);
}));

/**
 * PATCH /api/delivery/orders/:id/customer-note
 * Update customer note (syncs to Square)
 */
router.patch('/orders/:id/customer-note', deliveryRateLimit, requireAuth, requireMerchant, validators.updateCustomerNote, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { note } = req.body;
    const result = await deliveryStats.updateCustomerNote(merchantId, req.params.id, note);

    if (!result.order) {
        return sendError(res, 'Order not found', 404);
    }

    if (result.error) {
        return sendError(res, result.error, 400);
    }

    sendSuccess(res, {
        square_synced: result.squareSynced,
        customer_note: note
    });
}));

/**
 * PATCH /api/delivery/orders/:id/notes
 * Update order notes (local only - order-specific instructions)
 */
router.patch('/orders/:id/notes', deliveryRateLimit, requireAuth, requireMerchant, validators.updateOrderNotes, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { notes } = req.body;
    const order = await deliveryApi.getOrderById(merchantId, req.params.id);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    await deliveryApi.updateOrder(merchantId, order.id, {
        notes: notes || null
    });

    sendSuccess(res, {
        notes: notes
    });
}));

/**
 * GET /api/delivery/orders/:id/customer-stats
 * Get customer stats: order count, loyalty status, payment status
 */
router.get('/orders/:id/customer-stats', requireAuth, requireMerchant, validators.getOrder, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { order, stats } = await deliveryStats.getCustomerStats(merchantId, req.params.id);

    if (!order) {
        return sendError(res, 'Order not found', 404);
    }

    sendSuccess(res, stats);
}));

/**
 * POST /api/delivery/orders/:id/pod
 * Upload proof of delivery photo
 */
router.post('/orders/:id/pod', deliveryRateLimit, requireAuth, requireMerchant, podUpload.single('photo'), validateUploadedImage('photo'), validators.uploadPod, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    if (!req.file) {
        return sendError(res, 'No photo uploaded', 400);
    }

    const pod = await deliveryApi.savePodPhoto(merchantId, req.params.id, req.file.buffer, {
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
        longitude: req.body.longitude ? parseFloat(req.body.longitude) : null
    });

    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'pod_uploaded', req.params.id, null, {
        podId: pod.id,
        hasGps: !!(req.body.latitude && req.body.longitude)
    }, req.ip, req.get('user-agent'));

    sendSuccess(res, { pod }, 201);
}));

/**
 * GET /api/delivery/pod/:id
 * Serve a POD photo (authenticated)
 */
router.get('/pod/:id', requireAuth, requireMerchant, validators.getPod, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const pod = await deliveryApi.getPodPhoto(merchantId, req.params.id);

    if (!pod) {
        return sendError(res, 'POD not found', 404);
    }

    res.setHeader('Content-Type', pod.mime_type || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${pod.original_filename || 'pod.jpg'}"`);
    res.sendFile(pod.full_path);
}));

/**
 * POST /api/delivery/route/generate
 * Generate an optimized route for pending orders
 */
router.post('/route/generate', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.generateRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { routeDate, orderIds, excludeOrderIds, force, startLat, startLng, endLat, endLng } = req.body;

    const route = await deliveryApi.generateRoute(merchantId, req.session.user.id, {
        routeDate,
        orderIds,
        excludeOrderIds,
        force,
        startLat: startLat != null ? parseFloat(startLat) : null,
        startLng: startLng != null ? parseFloat(startLng) : null,
        endLat: endLat != null ? parseFloat(endLat) : null,
        endLng: endLng != null ? parseFloat(endLng) : null
    });

    sendSuccess(res, { route }, 201);
}));

/**
 * GET /api/delivery/route/active
 * Get today's active route with orders
 */
router.get('/route/active', requireAuth, requireMerchant, validators.getActiveRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { routeDate } = req.query;

    logger.debug('Fetching active delivery route', { merchantId, routeDate });

    const route = await deliveryApi.getActiveRoute(merchantId, routeDate);

    if (!route) {
        return sendSuccess(res, { route: null, orders: [] });
    }

    // Use getRouteWithOrders to get orders with GTIN enrichment
    const routeWithOrders = await deliveryApi.getRouteWithOrders(merchantId, route.id);
    const orders = routeWithOrders?.orders || [];

    logger.debug('Active route fetched', {
        merchantId,
        routeId: route.id,
        orderCount: orders.length,
        ordersWithItems: orders.filter(o => o.square_order_data?.lineItems?.length > 0).length
    });

    sendSuccess(res, { route, orders });
}));

/**
 * GET /api/delivery/route/:id
 * Get a specific route with orders
 */
router.get('/route/:id', requireAuth, requireMerchant, validators.getRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const routeId = req.params.id;

    logger.debug('Fetching delivery route', { merchantId, routeId });

    const route = await deliveryApi.getRouteWithOrders(merchantId, routeId);

    if (!route) {
        logger.warn('Route not found', { merchantId, routeId });
        return sendError(res, 'Route not found', 404);
    }

    logger.debug('Route fetched successfully', {
        merchantId,
        routeId,
        orderCount: route.orders?.length || 0
    });

    sendSuccess(res, { route });
}));

/**
 * POST /api/delivery/route/finish
 * Finish the active route and roll skipped orders back to pending
 */
router.post('/route/finish', deliveryRateLimit, requireAuth, requireMerchant, validators.finishRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { routeId } = req.body;

    let targetRouteId = routeId;
    if (!targetRouteId) {
        // Get active route for today
        const activeRoute = await deliveryApi.getActiveRoute(merchantId);
        if (!activeRoute) {
            return sendError(res, 'No active route found', 400);
        }
        targetRouteId = activeRoute.id;
    }

    const result = await deliveryApi.finishRoute(merchantId, targetRouteId, req.session.user.id);

    sendSuccess(res, { result });
}));

/**
 * POST /api/delivery/geocode
 * Geocode pending orders that don't have coordinates
 */
router.post('/geocode', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.geocode, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { limit } = req.body;

    const result = await deliveryApi.geocodePendingOrders(merchantId, limit || 10);

    sendSuccess(res, { result });
}));

/**
 * GET /api/delivery/settings
 * Get delivery settings for the merchant
 */
router.get('/settings', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const settings = await deliveryApi.getSettingsWithDefaults(merchantId);
    sendSuccess(res, { settings });
}));

/**
 * PUT /api/delivery/settings
 * Update delivery settings for the merchant
 */
router.put('/settings', deliveryRateLimit, requireAuth, requireMerchant, validators.updateSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const settings = await deliveryApi.updateSettingsWithGeocode(merchantId, req.body);
    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'settings_updated', null, null, {
        startAddress: !!req.body.startAddress,
        endAddress: !!req.body.endAddress
    }, req.ip, req.get('user-agent'));
    sendSuccess(res, { settings });
}));

/**
 * GET /api/delivery/audit
 * Get delivery audit log
 */
router.get('/audit', requireAuth, requireMerchant, validators.getAudit, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { limit, offset, action, orderId, routeId } = req.query;

    const entries = await deliveryApi.getAuditLog(merchantId, {
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        action,
        orderId,
        routeId
    });

    sendSuccess(res, { entries });
}));

/**
 * GET /api/delivery/stats
 * Get delivery statistics for dashboard
 */
router.get('/stats', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const stats = await deliveryStats.getDashboardStats(merchantId);
    sendSuccess(res, { stats });
}));

/**
 * POST /api/delivery/sync
 * Sync open orders from Square that have delivery/shipment fulfillments
 * Use this to backfill orders that were missed while server was offline
 */
router.post('/sync', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.syncOrders, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { daysBack = 7 } = req.body;
    logger.info('Starting delivery order sync from Square', { merchantId, daysBack });
    const result = await deliveryApi.syncSquareOrders(merchantId, daysBack);
    sendSuccess(res, result);
}));

/**
 * POST /api/delivery/backfill-customers
 * Backfill customer data for orders with "Unknown Customer"
 * Looks up customer details from Square API using square_customer_id
 */
router.post('/backfill-customers', deliveryStrictRateLimit, requireAuth, requireMerchant, validators.backfillCustomers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;

    logger.info('Starting customer backfill for delivery orders', { merchantId });

    const result = await deliveryApi.backfillUnknownCustomers(merchantId);

    sendSuccess(res, result);
}));

module.exports = router;
