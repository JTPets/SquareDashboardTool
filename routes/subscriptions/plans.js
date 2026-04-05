const express = require('express');
const router = express.Router();
const subscriptionHandler = require('../../utils/subscription-handler');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');

router.get('/square/payment-config', (req, res) => {
    sendSuccess(res, {
        applicationId: process.env.SQUARE_APPLICATION_ID || null,
        locationId: process.env.SQUARE_LOCATION_ID || null,
        environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
    });
});

router.get('/subscriptions/plans', asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext?.id || req.session?.activeMerchantId;
    if (!merchantId) {
        return sendError(res, 'Merchant context required', 400, 'NO_MERCHANT');
    }
    const plans = await subscriptionHandler.getPlans(merchantId);
    sendSuccess(res, { plans, trialDays: subscriptionHandler.TRIAL_DAYS });
}));

module.exports = router;
