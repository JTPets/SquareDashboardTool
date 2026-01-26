/**
 * Driver API Routes
 *
 * PUBLIC endpoints for contract drivers to access delivery routes via shareable tokens.
 * These endpoints require NO authentication - the token validates access.
 *
 * SECURITY CONSIDERATIONS:
 * - Tokens are 64-character hex strings (256-bit entropy)
 * - Tokens have configurable expiration (default 24 hours, max 7 days)
 * - Tokens can be revoked by merchants at any time
 * - All operations are logged for audit trail
 * - Input validation via express-validator
 *
 * Endpoints:
 * - POST   /api/delivery/route/:id/share      - Generate shareable token (authenticated)
 * - GET    /api/delivery/route/:id/token      - Get active token (authenticated)
 * - DELETE /api/delivery/route/:id/token      - Revoke token (authenticated)
 * - GET    /api/driver/:token                 - Get route data (public)
 * - POST   /api/driver/:token/orders/:orderId/complete - Mark order complete (public)
 * - POST   /api/driver/:token/orders/:orderId/skip     - Skip order (public)
 * - POST   /api/driver/:token/orders/:orderId/pod      - Upload POD photo (public)
 * - POST   /api/driver/:token/finish          - Finish route (public)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../utils/logger');
const deliveryApi = require('../utils/delivery-api');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const { validateUploadedImage } = require('../utils/file-validation');
const validators = require('../middleware/validators/driver-api');

// Configure multer for POD photo uploads (memory storage for processing)
const podUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max
        files: 1
    },
    fileFilter: (req, file, cb) => {
        // Only allow images
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// ==================== AUTHENTICATED ENDPOINTS (Merchant-facing) ====================

/**
 * POST /api/delivery/route/:id/share
 * Generate a shareable token URL for a route
 */
router.post('/delivery/route/:id/share', requireAuth, requireMerchant, validators.shareRoute, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const routeId = req.params.id;
    const { expiresInHours } = req.body;

    const token = await deliveryApi.generateRouteToken(merchantId, routeId, req.session.user.id, {
        expiresInHours: expiresInHours || 24
    });

    // Generate the full URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${baseUrl}/driver.html?token=${token.token}`;

    res.json({
        token,
        shareUrl,
        expiresAt: token.expires_at
    });
}));

/**
 * GET /api/delivery/route/:id/token
 * Get active token for a route (if exists)
 */
router.get('/delivery/route/:id/token', requireAuth, requireMerchant, validators.getRouteToken, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const routeId = req.params.id;

    const token = await deliveryApi.getActiveRouteToken(merchantId, routeId);

    if (token) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const shareUrl = `${baseUrl}/driver.html?token=${token.token}`;
        res.json({ token, shareUrl });
    } else {
        res.json({ token: null });
    }
}));

/**
 * DELETE /api/delivery/route/:id/token
 * Revoke active token for a route
 */
router.delete('/delivery/route/:id/token', requireAuth, requireMerchant, validators.revokeRouteToken, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const routeId = req.params.id;

    const token = await deliveryApi.getActiveRouteToken(merchantId, routeId);
    if (token) {
        await deliveryApi.revokeRouteToken(merchantId, token.id);
    }

    res.json({ success: true });
}));

// ==================== PUBLIC ENDPOINTS (Driver-facing, token-based) ====================

/**
 * GET /api/driver/:token
 * PUBLIC: Get route data for contract driver (no auth)
 */
router.get('/driver/:token', validators.getDriverRoute, asyncHandler(async (req, res) => {
    const result = await deliveryApi.getRouteOrdersByToken(req.params.token);

    if (!result) {
        return res.status(404).json({ error: 'Invalid token' });
    }

    if (!result.valid) {
        return res.status(403).json({ error: result.reason || 'Token is no longer valid' });
    }

    // Return only necessary data (hide internal IDs where possible)
    res.json({
        route: {
            date: result.route_date,
            totalStops: result.total_stops,
            distanceKm: result.total_distance_km,
            estimatedMinutes: result.estimated_duration_min,
            merchantName: result.merchant_name
        },
        orders: result.orders.map(o => ({
            id: o.id,
            position: o.route_position,
            customerName: o.customer_name,
            address: o.address,
            phone: o.phone,
            notes: o.notes,
            customerNote: o.customer_note,
            status: o.status,
            hasPod: !!o.pod_photo_path,
            orderData: o.square_order_data
        }))
    });
}));

/**
 * POST /api/driver/:token/orders/:orderId/complete
 * PUBLIC: Mark order as completed (contract driver)
 */
router.post('/driver/:token/orders/:orderId/complete', validators.completeOrder, asyncHandler(async (req, res) => {
    const order = await deliveryApi.completeOrderByToken(req.params.token, req.params.orderId);
    res.json({ success: true, order: { id: order.id, status: order.status } });
}));

/**
 * POST /api/driver/:token/orders/:orderId/skip
 * PUBLIC: Skip order (contract driver)
 */
router.post('/driver/:token/orders/:orderId/skip', validators.skipOrder, asyncHandler(async (req, res) => {
    const order = await deliveryApi.skipOrderByToken(req.params.token, req.params.orderId);
    res.json({ success: true, order: { id: order.id, status: order.status } });
}));

/**
 * POST /api/driver/:token/orders/:orderId/pod
 * PUBLIC: Upload POD photo (contract driver)
 */
router.post('/driver/:token/orders/:orderId/pod', podUpload.single('photo'), validateUploadedImage('photo'), validators.uploadPod, asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No photo uploaded' });
    }

    const metadata = {
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
        longitude: req.body.longitude ? parseFloat(req.body.longitude) : null
    };

    const pod = await deliveryApi.savePodByToken(req.params.token, req.params.orderId, req.file.buffer, metadata);

    res.json({
        success: true,
        pod: { id: pod.id, capturedAt: pod.captured_at }
    });
}));

/**
 * POST /api/driver/:token/finish
 * PUBLIC: Finish route and retire token (contract driver)
 */
router.post('/driver/:token/finish', validators.finishRoute, asyncHandler(async (req, res) => {
    const { driverName, driverNotes } = req.body;

    const result = await deliveryApi.finishRouteByToken(req.params.token, {
        driverName,
        driverNotes
    });

    res.json({
        success: true,
        result,
        message: 'Route completed. Thank you for your deliveries!'
    });
}));

module.exports = router;
