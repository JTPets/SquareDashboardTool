// Delivery settings sub-router: get and update merchant delivery configuration.
const express = require('express');
const router = express.Router();
const deliveryApi = require('../../services/delivery');
const asyncHandler = require('../../middleware/async-handler');
const { configureDeliveryRateLimit } = require('../../middleware/security');
const validators = require('../../middleware/validators/delivery');
const { sendSuccess } = require('../../utils/response-helper');

const deliveryRateLimit = configureDeliveryRateLimit();

router.get('/settings', asyncHandler(async (req, res) => {
    const settings = await deliveryApi.getSettingsWithDefaults(req.merchantContext.id);
    sendSuccess(res, { settings });
}));

router.put('/settings', deliveryRateLimit, validators.updateSettings, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const settings = await deliveryApi.updateSettingsWithGeocode(merchantId, req.body);
    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'settings_updated', null, null,
        { startAddress: !!req.body.startAddress, endAddress: !!req.body.endAddress }, req.ip, req.get('user-agent'));
    sendSuccess(res, { settings });
}));

module.exports = router;
