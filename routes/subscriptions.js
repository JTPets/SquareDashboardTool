/**
 * Subscription Routes
 *
 * Handles SaaS subscription management including:
 * - Subscription creation with Square Subscriptions API
 * - Promo code validation and application
 * - Subscription status checks
 * - Cancellation and refund processing
 * - Admin subscriber management
 *
 * SECURITY CONSIDERATIONS:
 * - NO credit card data is stored locally
 * - All payment data is held by Square (PCI compliant)
 * - Only Square IDs (customer_id, card_id, subscription_id) are stored
 * - Square handles all recurring billing
 * - Super admin checks for sensitive operations
 *
 * Endpoints:
 * - GET    /api/square/payment-config         - Get Square SDK config
 * - GET    /api/subscriptions/plans           - Get available plans
 * - POST   /api/subscriptions/promo/validate  - Validate promo code
 * - POST   /api/subscriptions/create          - Create subscription
 * - GET    /api/subscriptions/status          - Check subscription status
 * - GET    /api/subscriptions/merchant-status - Status for logged-in merchant
 * - POST   /api/subscriptions/cancel          - Cancel subscription
 * - POST   /api/subscriptions/refund          - Process refund (admin)
 * - GET    /api/subscriptions/admin/list      - List subscribers (admin)
 * - GET    /api/subscriptions/admin/plans     - List plans with Square status (admin)
 * - POST   /api/subscriptions/admin/setup-plans - Setup Square plans (super admin)
 * - GET    /api/webhooks/events               - View webhook events (super admin)
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const logger = require('../utils/logger');
const squareApi = require('../services/square');
const { generateIdempotencyKey } = require('../services/square');
const subscriptionHandler = require('../utils/subscription-handler');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/require-permission');
const requireSuperAdmin = require('../middleware/require-super-admin');
const { configureLoginRateLimit, configureSubscriptionRateLimit } = require('../middleware/security');
const validators = require('../middleware/validators/subscriptions');
const asyncHandler = require('../middleware/async-handler');

const promoRateLimit = configureLoginRateLimit();
const subscriptionRateLimit = configureSubscriptionRateLimit();
const subscriptionBridge = require('../services/subscriptions/subscription-bridge');
// LOGIC CHANGE: extracted promo code validation to shared service (BACKLOG-74)
const { validatePromoCode, checkPublicPromo } = require('../services/subscriptions/promo-validation');
// LOGIC CHANGE: extracted subscription create logic to service (BACKLOG-74 follow-up)
const { createSubscription } = require('../services/subscriptions/subscription-create-service');
const featureRegistry = require('../config/feature-registry');
const { sendSuccess, sendError } = require('../utils/response-helper');

/**
 * GET /api/public/pricing
 * Return module and bundle pricing for the public pricing page.
 * No authentication required.
 */
router.get('/public/pricing', (req, res) => {
    const modules = featureRegistry.getPaidModules().map(m => ({
        key: m.key,
        name: m.name,
        price_cents: m.price_cents,
    }));

    const bundles = Object.values(featureRegistry.bundles).map(b => ({
        key: b.key,
        name: b.name,
        includes: b.includes,
        price_cents: b.price_cents,
    }));

    sendSuccess(res, { modules, bundles });
});

/**
 * GET /api/public/promo/check?code=XXX
 * Lightweight public endpoint: checks whether a platform-owner promo code is
 * currently active. Used by the pricing page to give feedback before subscribe.html.
 */
// LOGIC CHANGE: extracted to checkPublicPromo() in promo-validation.js
router.get('/public/promo/check', promoRateLimit, asyncHandler(async (req, res) => {
    const code = (req.query.code || '').trim();
    if (!code) {
        return sendError(res, 'code is required', 400, 'MISSING_CODE');
    }
    const result = await checkPublicPromo(code);
    sendSuccess(res, result);
}));

/**
 * GET /api/square/payment-config
 * Get Square application ID for Web Payments SDK
 */
router.get('/square/payment-config', (req, res) => {
    sendSuccess(res, {
        applicationId: process.env.SQUARE_APPLICATION_ID || null,
        locationId: process.env.SQUARE_LOCATION_ID || null,
        environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
    });
});

/**
 * GET /api/subscriptions/plans
 * Get available subscription plans
 */
// LOGIC CHANGE: scope plans to merchant (CRIT-2 audit)
router.get('/subscriptions/plans', asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext?.id || req.session?.activeMerchantId;
    if (!merchantId) {
        return sendError(res, 'Merchant context required', 400, 'NO_MERCHANT');
    }
    const plans = await subscriptionHandler.getPlans(merchantId);
    sendSuccess(res, {
        plans,
        trialDays: subscriptionHandler.TRIAL_DAYS
    });
}));

/**
 * POST /api/subscriptions/promo/validate
 * Validate a promo code and return discount info
 */
// LOGIC CHANGE: rate limit unauthenticated endpoint (security audit 2026-03-10)
// LOGIC CHANGE: scope promo code lookup to merchant (CRIT-2 audit)
// LOGIC CHANGE: uses shared validatePromoCode service (BACKLOG-74)
router.post('/subscriptions/promo/validate', promoRateLimit, validators.validatePromo, asyncHandler(async (req, res) => {
    const { code, plan, priceCents } = req.body;
    const merchantId = req.merchantContext?.id || req.session?.activeMerchantId;
    if (!merchantId) {
        return sendError(res, 'Merchant context required', 400);
    }

    const result = await validatePromoCode({ code, merchantId, plan, priceCents });

    if (!result.valid) {
        return sendSuccess(res, { valid: false, error: result.error });
    }

    const promo = result.promo;
    sendSuccess(res, {
        valid: true,
        code: promo.code,
        description: promo.description,
        discountType: promo.discount_type,
        discountValue: promo.discount_value,
        discountCents: result.discount,
        discountDisplay: promo.discount_type === 'percent'
            ? `${promo.discount_value}% off`
            : `$${(promo.discount_value / 100).toFixed(2)} off`
    });
}));

/**
 * POST /api/subscriptions/create
 * Create a new subscription using Square Subscriptions API
 *
 * SECURITY: No credit card data is stored locally. All payment data is held by Square.
 * We only store Square IDs (customer_id, card_id, subscription_id).
 * Square handles all recurring billing, PCI compliance, and payment processing.
 */
// LOGIC CHANGE: rate limit unauthenticated endpoint (security audit 2026-03-10)
// LOGIC CHANGE: extracted to subscription-create-service.js (BACKLOG-74 follow-up)
router.post('/subscriptions/create', subscriptionRateLimit, validators.createSubscription, asyncHandler(async (req, res) => {
    const { email, businessName, plan, sourceId, promoCode, termsAcceptedAt } = req.body;

    // LOGIC CHANGE: merchant_id required for tenant isolation (CRIT-2 audit)
    const merchantId = req.session?.activeMerchantId || req.merchantContext?.id;
    if (!merchantId) {
        return sendError(res, 'Merchant context required', 400, 'NO_MERCHANT');
    }

    if (!process.env.SQUARE_LOCATION_ID) {
        logger.error('SQUARE_LOCATION_ID not configured', { merchantId });
        return sendError(res, 'Payment system not configured. Please contact support.', 500);
    }

    const existing = await subscriptionHandler.getSubscriberByEmail(email);
    if (existing) {
        return sendError(res, 'An account with this email already exists', 400);
    }

    try {
        const { subscriber, payment, passwordSetupToken } = await createSubscription(merchantId, {
            email, businessName, plan, sourceId, promoCode, termsAcceptedAt
        });

        sendSuccess(res, {
            subscriber: {
                id: subscriber.id,
                email: subscriber.email,
                plan: subscriber.subscription_plan,
                status: subscriber.subscription_status,
                trialEndDate: subscriber.trial_end_date
            },
            payment: payment ? { status: payment.status, receiptUrl: payment.receipt_url } : null,
            passwordSetupToken,
            passwordSetupUrl: passwordSetupToken ? `/set-password.html?token=${passwordSetupToken}` : null
        });
    } catch (err) {
        if (err.statusCode) return sendError(res, err.message, err.statusCode, err.code);
        throw err;
    }
}));

/**
 * GET /api/subscriptions/status
 * Check subscription status for an email
 */
// LOGIC CHANGE: rate limit + minimal response on unauthenticated status endpoint (CRIT-1 audit)
router.get('/subscriptions/status', subscriptionRateLimit, validators.checkStatus, asyncHandler(async (req, res) => {
    const { email } = req.query;
    // AUDIT-2.3.1: Strip plan_name, plan_id, and business details from public response
    const status = await subscriptionHandler.checkSubscriptionStatus(email);
    sendSuccess(res, {
        active: status.isValid,
        trial: status.status === 'trial',
        expires_at: status.expiresAt || null
    });
}));

/**
 * GET /api/subscriptions/merchant-status
 * Get subscription status for the current logged-in merchant (System A + B combined)
 * Used by the frontend to show trial countdown, upgrade prompts, etc.
 */
// LOGIC CHANGE: extracted to getMerchantStatusSummary() in subscription-bridge.js
router.get('/subscriptions/merchant-status', requireAuth, asyncHandler(async (req, res) => {
    if (!req.merchantContext) {
        return sendError(res, 'No merchant connected', 403, 'NO_MERCHANT');
    }
    const summary = await subscriptionBridge.getMerchantStatusSummary(req.merchantContext);
    sendSuccess(res, summary);
}));

/**
 * POST /api/subscriptions/cancel
 * Cancel a subscription (cancels in both local DB and Square)
 */
// LOGIC CHANGE: Square cancel moved to subscriptionBridge.cancelWithSquare()
router.post('/subscriptions/cancel', requireAuth, validators.cancelSubscription, asyncHandler(async (req, res) => {
    const { email, reason } = req.body;

    const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
    if (!subscriber) {
        return sendError(res, 'Subscriber not found', 404);
    }

    if (subscriber.square_subscription_id) {
        await subscriptionBridge.cancelWithSquare(subscriber.square_subscription_id);
    }

    const updated = await subscriptionHandler.cancelSubscription(subscriber.id, reason);

    // Bridge: cancel merchant subscription in System A if merchant is linked
    const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
    if (merchantId) {
        await subscriptionBridge.cancelMerchantSubscription(subscriber.id, merchantId);
    }

    await subscriptionHandler.logEvent({
        merchantId: subscriber.merchant_id,
        subscriberId: subscriber.id,
        eventType: 'subscription.canceled',
        eventData: {
            reason,
            merchantId,
            square_subscription_id: subscriber.square_subscription_id
        }
    });

    sendSuccess(res, { subscriber: updated });
}));

/**
 * POST /api/subscriptions/refund
 * Process a refund for a subscription payment
 */
router.post('/subscriptions/refund', requireAdmin, validators.processRefund, asyncHandler(async (req, res) => {
    const { email, reason } = req.body;

    const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
    if (!subscriber) {
        return sendError(res, 'Subscriber not found', 404);
    }

    const payments = await subscriptionHandler.getPaymentHistory(subscriber.id, subscriber.merchant_id);
    const lastPayment = payments.find(p => p.status === 'completed' && !p.refunded_at);

    if (!lastPayment) {
        return sendError(res, 'No refundable payment found', 400);
    }

    let squareRefund = null;
    if (lastPayment.square_payment_id) {
        try {
            const refundResponse = await squareApi.makeSquareRequest('/v2/refunds', {
                method: 'POST',
                body: JSON.stringify({
                    idempotency_key: generateIdempotencyKey(`refund-${lastPayment.id}`),
                    payment_id: lastPayment.square_payment_id,
                    amount_money: {
                        amount: lastPayment.amount_cents,
                        currency: lastPayment.currency
                    },
                    reason: reason || '30-day trial refund'
                })
            });

            squareRefund = refundResponse.refund;
        } catch (refundError) {
            logger.error('Square refund failed', {
                error: refundError.message,
                stack: refundError.stack,
                subscriberId: subscriber.id,
                paymentId: lastPayment.id
            });
            return sendError(res, 'Refund processing failed. Please try again or contact support.', 500, 'REFUND_FAILED');
        }
    }

    await subscriptionHandler.processRefund(lastPayment.id, lastPayment.amount_cents, reason || '30-day trial refund', subscriber.merchant_id);
    await subscriptionHandler.cancelSubscription(subscriber.id, 'Refunded');

    await subscriptionHandler.logEvent({
        merchantId: subscriber.merchant_id,
        subscriberId: subscriber.id,
        eventType: 'payment.refunded',
        eventData: { payment_id: lastPayment.id, amount: lastPayment.amount_cents, reason }
    });

    sendSuccess(res, {
        refund: squareRefund,
        message: 'Refund processed successfully'
    });
}));

/**
 * GET /api/subscriptions/admin/list
 * Get all subscribers (admin endpoint)
 */
router.get('/subscriptions/admin/list', requirePermission('subscription', 'admin'), validators.listSubscribers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext?.id;
    if (!merchantId) {
        return sendError(res, 'No merchant connected', 403, 'NO_MERCHANT');
    }
    const { status } = req.query;
    const subscribers = await subscriptionHandler.getAllSubscribers({ merchantId, status });
    const stats = await subscriptionHandler.getSubscriptionStats(merchantId);

    sendSuccess(res, {
        count: subscribers.length,
        subscribers,
        stats
    });
}));

/**
 * GET /api/subscriptions/admin/plans
 * Get subscription plans with Square status (admin endpoint)
 */
router.get('/subscriptions/admin/plans', requirePermission('subscription', 'admin'), asyncHandler(async (req, res) => {
    const squareSubscriptions = require('../utils/square-subscriptions');
    const plans = await squareSubscriptions.listPlans();

    sendSuccess(res, {
        plans,
        squareConfigured: !!process.env.SQUARE_LOCATION_ID
    });
}));

/**
 * POST /api/subscriptions/admin/setup-plans
 * Initialize or update subscription plans in Square (SUPER ADMIN ONLY)
 */
// LOGIC CHANGE: super-admin check extracted to requireSuperAdmin middleware
router.post('/subscriptions/admin/setup-plans', requireAuth, requirePermission('subscription', 'admin'), requireSuperAdmin, asyncHandler(async (req, res) => {
    if (!process.env.SQUARE_LOCATION_ID) {
        return sendError(res, 'SQUARE_LOCATION_ID not configured', 400);
    }

    if (!process.env.SQUARE_ACCESS_TOKEN) {
        return sendError(res, 'SQUARE_ACCESS_TOKEN not configured', 400);
    }

    const squareSubscriptions = require('../utils/square-subscriptions');
    const result = await squareSubscriptions.setupSubscriptionPlans();

    logger.info('Subscription plans setup completed', {
        plans: result.plans.length,
        errors: result.errors.length,
        adminEmail: req.session?.user?.email
    });

    sendSuccess(res, result);
}));

/**
 * GET /api/webhooks/events
 * View recent webhook events (SUPER ADMIN ONLY - cross-tenant debugging)
 */
// LOGIC CHANGE: super-admin check extracted to requireSuperAdmin middleware
router.get('/webhooks/events', requireAuth, requireAdmin, requireSuperAdmin, validators.listWebhookEvents, asyncHandler(async (req, res) => {
    const { limit = 50, status, event_type } = req.query;

    let query = `
        SELECT id, square_event_id, event_type, merchant_id, square_merchant_id,
               status, received_at, processed_at, processing_time_ms,
               error_message, sync_results
        FROM webhook_events
        WHERE 1=1
    `;
    const params = [];

    if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
    }

    if (event_type) {
        params.push(event_type);
        query += ` AND event_type = $${params.length}`;
    }

    params.push(parseInt(limit));
    query += ` ORDER BY received_at DESC LIMIT $${params.length}`;

    const result = await db.query(query, params);

    const stats = await db.query(`
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'completed') as completed,
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
            AVG(processing_time_ms) FILTER (WHERE processing_time_ms IS NOT NULL) as avg_processing_ms
        FROM webhook_events
        WHERE received_at > NOW() - INTERVAL '24 hours'
    `);

    sendSuccess(res, {
        events: result.rows,
        stats: stats.rows[0]
    });
}));

module.exports = router;
