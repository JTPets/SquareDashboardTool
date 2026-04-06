const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const squareApi = require('../../services/square');
const { generateIdempotencyKey } = require('../../services/square');
const subscriptionHandler = require('../../utils/subscription-handler');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/require-permission');
const requireSuperAdmin = require('../../middleware/require-super-admin');
const validators = require('../../middleware/validators/subscriptions');
const asyncHandler = require('../../middleware/async-handler');
const { sendSuccess, sendError } = require('../../utils/response-helper');
const pricingService = require('../../services/pricing-service');
const featureRegistry = require('../../config/feature-registry');

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
                    amount_money: { amount: lastPayment.amount_cents, currency: lastPayment.currency },
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
    sendSuccess(res, { refund: squareRefund, message: 'Refund processed successfully' });
}));

router.get('/subscriptions/admin/list', requirePermission('subscription', 'admin'), validators.listSubscribers, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext?.id;
    if (!merchantId) {
        return sendError(res, 'No merchant connected', 403, 'NO_MERCHANT');
    }
    const { status, search, limit, offset } = req.query;
    const data = await subscriptionHandler.getAllSubscribers({ merchantId, status, search, limit, offset });
    const stats = await subscriptionHandler.getSubscriptionStats(merchantId);
    sendSuccess(res, { count: data.rows.length, total: data.total, subscribers: data.rows, stats });
}));

router.get('/subscriptions/admin/plans', requirePermission('subscription', 'admin'), asyncHandler(async (req, res) => {
    const squareSubscriptions = require('../../utils/square-subscriptions');
    const plans = await squareSubscriptions.listPlans();
    sendSuccess(res, { plans, squareConfigured: !!process.env.SQUARE_LOCATION_ID });
}));

router.post('/subscriptions/admin/setup-plans', requireAuth, requirePermission('subscription', 'admin'), requireSuperAdmin, asyncHandler(async (req, res) => {
    if (!process.env.SQUARE_LOCATION_ID) {
        return sendError(res, 'SQUARE_LOCATION_ID not configured', 400);
    }
    if (!process.env.SQUARE_ACCESS_TOKEN) {
        return sendError(res, 'SQUARE_ACCESS_TOKEN not configured', 400);
    }
    const squareSubscriptions = require('../../utils/square-subscriptions');
    const result = await squareSubscriptions.setupSubscriptionPlans();
    logger.info('Subscription plans setup completed', {
        plans: result.plans.length,
        errors: result.errors.length,
        adminEmail: req.session?.user?.email
    });
    sendSuccess(res, result);
}));

// ==================== ADMIN PRICING ENDPOINTS ====================
// All require super-admin. DB is source of truth; these are the only write paths.

/**
 * GET /api/admin/pricing
 * Returns all module prices and platform plan prices from DB.
 */
router.get('/admin/pricing', requirePermission('subscription', 'admin'), requireSuperAdmin, asyncHandler(async (req, res) => {
    const [modules, plans] = await Promise.all([
        pricingService.getAllModulePricing(),
        pricingService.getPlatformPlanPricing(),
    ]);
    sendSuccess(res, { modules, plans });
}));

/**
 * PUT /api/admin/pricing/modules/:key
 * Update a module's price (writes to module_pricing table).
 */
router.put('/admin/pricing/modules/:key', requirePermission('subscription', 'admin'), requireSuperAdmin, validators.updatePricingItem, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { price_cents } = req.body;

    const known = featureRegistry.modules[key];
    if (!known) {
        return sendError(res, `Unknown module key: ${key}`, 404, 'NOT_FOUND');
    }

    await pricingService.updateModulePrice(key, price_cents);

    logger.info('Admin updated module price', {
        moduleKey: key,
        price_cents,
        adminEmail: req.session?.user?.email
    });
    sendSuccess(res, { key, price_cents });
}));

/**
 * PUT /api/admin/pricing/plans/:key
 * Update a platform subscription plan price (writes to subscription_plans for platform owner).
 */
router.put('/admin/pricing/plans/:key', requirePermission('subscription', 'admin'), requireSuperAdmin, validators.updatePricingItem, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { price_cents } = req.body;

    const known = featureRegistry.publicPlans[key];
    if (!known) {
        return sendError(res, `Unknown plan key: ${key}`, 404, 'NOT_FOUND');
    }

    const updated = await pricingService.updatePlatformPlanPrice(key, price_cents);

    logger.info('Admin updated plan price', {
        planKey: key,
        price_cents,
        adminEmail: req.session?.user?.email
    });
    sendSuccess(res, updated);
}));

module.exports = router;
