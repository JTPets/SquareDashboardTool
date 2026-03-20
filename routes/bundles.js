/**
 * Bundle Routes
 *
 * Thin route layer for bundle CRUD and availability.
 * Business logic lives in services/bundle-service.js.
 *
 * Endpoints:
 * - GET    /api/bundles              - List bundles with components
 * - POST   /api/bundles              - Create a new bundle
 * - PUT    /api/bundles/:id          - Update a bundle
 * - DELETE /api/bundles/:id          - Soft-delete (deactivate) a bundle
 * - GET    /api/bundles/availability  - Calculate assemblable qty per bundle
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/bundles');
const bundleService = require('../services/bundle-service');
const { sendSuccess, sendError } = require('../utils/response-helper');

// ==================== LIST BUNDLES ====================

router.get('/', requireAuth, requireMerchant, validators.getBundles, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await bundleService.listBundles(merchantId, req.query);
    sendSuccess(res, result);
}));

// ==================== BUNDLE AVAILABILITY ====================
// Must be defined BEFORE /:id to avoid route conflict

router.get('/availability', requireAuth, requireMerchant, validators.getAvailability, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await bundleService.calculateAvailability(merchantId, req.query);
    sendSuccess(res, result);
}));

// ==================== CREATE BUNDLE ====================

router.post('/', requireAuth, requireMerchant, validators.createBundle, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const result = await bundleService.createBundle(merchantId, req.body);
    sendSuccess(res, { bundle: result }, 201);
}));

// ==================== UPDATE BUNDLE ====================

router.put('/:id', requireAuth, requireMerchant, validators.updateBundle, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const bundleId = parseInt(req.params.id);
    const result = await bundleService.updateBundle(merchantId, bundleId, req.body);
    sendSuccess(res, { bundle: result });
}));

// ==================== DELETE (SOFT) BUNDLE ====================

router.delete('/:id', requireAuth, requireMerchant, validators.deleteBundle, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const bundleId = parseInt(req.params.id);
    const result = await bundleService.deleteBundle(merchantId, bundleId);

    if (!result) {
        return sendError(res, 'Bundle not found', 404);
    }

    sendSuccess(res, { message: 'Bundle deactivated', bundle: result });
}));

module.exports = router;
