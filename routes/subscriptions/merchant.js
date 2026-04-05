const express = require('express');
const router = express.Router();
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const subscriptionHandler = require('../../utils/subscription-handler');
const { requireAuth } = require('../../middleware/auth');
const { configureLoginRateLimit, configureSubscriptionRateLimit } = require('../../middleware/security');
const validators = require('../../middleware/validators/subscriptions');
const asyncHandler = require('../../middleware/async-handler');
const subscriptionBridge = require('../../services/subscriptions/subscription-bridge');
const { validatePromoCode } = require('../../services/subscriptions/promo-validation');
const { createSubscription } = require('../../services/subscriptions/subscription-create-service');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const promoRateLimit = configureLoginRateLimit();
const subscriptionRateLimit = configureSubscriptionRateLimit();

router.post('/subscriptions/promo/validate', promoRateLimit, validators.validatePromo, asyncHandler(async (req, res) => {
    const { code, plan, priceCents } = req.body;
    let merchantId = req.merchantContext?.id || req.session?.activeMerchantId;
    if (!merchantId) {
        // Public checkout (unauthenticated) — validate against platform owner's promo codes
        const ownerRow = await db.query(
            `SELECT id FROM merchants WHERE subscription_status = 'platform_owner' LIMIT 1`
        );
        if (ownerRow.rows.length === 0) return sendError(res, 'Service unavailable', 503, 'NO_PLATFORM');
        merchantId = ownerRow.rows[0].id;
    }
    const result = await validatePromoCode({ code, merchantId, plan, priceCents });
    if (!result.valid) return sendSuccess(res, { valid: false, error: result.error });
    const promo = result.promo;
    const pct = promo.discount_type === 'percent';
    sendSuccess(res, {
        valid: true, code: promo.code, description: promo.description,
        discountType: promo.discount_type, discountValue: promo.discount_value,
        discountCents: result.discount,
        discountDisplay: pct ? `${promo.discount_value}% off` : `$${(promo.discount_value / 100).toFixed(2)} off`
    });
}));

router.post('/subscriptions/create', subscriptionRateLimit, validators.createSubscription, asyncHandler(async (req, res) => {
    const { email, businessName, plan, sourceId, promoCode, termsAcceptedAt } = req.body;
    // For public signups, merchantId is null — createSubscription resolves plans from platform owner
    const merchantId = req.session?.activeMerchantId || req.merchantContext?.id || null;
    if (!process.env.SQUARE_LOCATION_ID) {
        logger.error('SQUARE_LOCATION_ID not configured');
        return sendError(res, 'Payment system not configured. Please contact support.', 500);
    }
    const existing = await subscriptionHandler.getSubscriberByEmail(email);
    if (existing) return sendError(res, 'An account with this email already exists', 400);
    try {
        const { subscriber, payment, passwordSetupToken } = await createSubscription(merchantId, {
            email, businessName, plan, sourceId, promoCode, termsAcceptedAt
        });
        sendSuccess(res, {
            subscriber: { id: subscriber.id, email: subscriber.email, plan: subscriber.subscription_plan, status: subscriber.subscription_status, trialEndDate: subscriber.trial_end_date },
            payment: payment ? { status: payment.status, receiptUrl: payment.receipt_url } : null,
            passwordSetupToken,
            passwordSetupUrl: passwordSetupToken ? `/set-password.html?token=${passwordSetupToken}` : null
        });
    } catch (err) {
        if (err.statusCode) return sendError(res, err.message, err.statusCode, err.code);
        throw err;
    }
}));

router.get('/subscriptions/status', subscriptionRateLimit, validators.checkStatus, asyncHandler(async (req, res) => {
    const { email } = req.query;
    const status = await subscriptionHandler.checkSubscriptionStatus(email);
    sendSuccess(res, { active: status.isValid, trial: status.status === 'trial', expires_at: status.expiresAt || null });
}));

router.get('/subscriptions/merchant-status', requireAuth, asyncHandler(async (req, res) => {
    if (!req.merchantContext) return sendError(res, 'No merchant connected', 403, 'NO_MERCHANT');
    const summary = await subscriptionBridge.getMerchantStatusSummary(req.merchantContext);
    sendSuccess(res, summary);
}));

router.post('/subscriptions/cancel', requireAuth, validators.cancelSubscription, asyncHandler(async (req, res) => {
    const { email, reason } = req.body;
    const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
    if (!subscriber) return sendError(res, 'Subscriber not found', 404);
    if (subscriber.square_subscription_id) {
        await subscriptionBridge.cancelWithSquare(subscriber.square_subscription_id);
    }
    const updated = await subscriptionHandler.cancelSubscription(subscriber.id, reason);
    const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
    if (merchantId) await subscriptionBridge.cancelMerchantSubscription(subscriber.id, merchantId);
    await subscriptionHandler.logEvent({ merchantId: subscriber.merchant_id, subscriberId: subscriber.id,
        eventType: 'subscription.canceled',
        eventData: { reason, merchantId, square_subscription_id: subscriber.square_subscription_id } });
    sendSuccess(res, { subscriber: updated });
}));

module.exports = router;
