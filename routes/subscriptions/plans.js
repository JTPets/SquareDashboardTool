const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
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
    let merchantId = req.merchantContext?.id || req.session?.activeMerchantId;
    if (!merchantId) {
        // Unauthenticated request (public pricing page) — use platform owner's plans
        const ownerRow = await db.query(
            `SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1`
        );
        if (ownerRow.rows.length === 0) {
            return sendError(res, 'Plans not available', 503, 'NO_PLANS');
        }
        merchantId = ownerRow.rows[0].id;
    }
    const plans = await subscriptionHandler.getPlans(merchantId);
    sendSuccess(res, { plans, trialDays: subscriptionHandler.TRIAL_DAYS });
}));

module.exports = router;
