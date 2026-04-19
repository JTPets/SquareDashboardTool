const express = require('express');
const router = express.Router();
const vendorDashboard = require('../../services/vendor/vendor-dashboard');
const vendorQuery = require('../../services/vendor/vendor-query-service');
const { requireAuth, requireWriteAccess } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');
const validators = require('../../middleware/validators/vendor-catalog');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

router.get('/vendors', requireAuth, requireMerchant, validators.getVendors, asyncHandler(async (req, res) => {
    const { status } = req.query;
    const vendors = await vendorQuery.listVendors(req.merchantContext.id, status);
    sendSuccess(res, { count: vendors.length, vendors });
}));

router.get('/vendor-dashboard', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const result = await vendorDashboard.getVendorDashboard(req.merchantContext.id);
    sendSuccess(res, { vendors: result.vendors, global_oos_count: result.global_oos_count });
}));

router.patch('/vendors/:id/settings', requireAuth, requireMerchant, requireWriteAccess, validators.updateVendorSettings, asyncHandler(async (req, res) => {
    const updated = await vendorDashboard.updateVendorSettings(
        req.params.id, req.merchantContext.id, req.body
    );
    if (!updated) {
        return sendError(res, 'Vendor not found or does not belong to this merchant', 404);
    }
    sendSuccess(res, { vendor: updated });
}));

router.get('/vendor-catalog/merchant-taxes', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const taxes = await vendorQuery.getMerchantTaxes(req.merchantContext.id);
    sendSuccess(res, { taxes });
}));

module.exports = router;
