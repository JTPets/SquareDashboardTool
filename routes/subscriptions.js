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
 * - POST   /api/subscriptions/cancel          - Cancel subscription
 * - POST   /api/subscriptions/refund          - Process refund (admin)
 * - GET    /api/subscriptions/admin/list      - List subscribers (admin)
 * - GET    /api/subscriptions/admin/plans     - List plans with Square status (admin)
 * - POST   /api/subscriptions/admin/setup-plans - Setup Square plans (super admin)
 * - GET    /api/webhooks/events               - View webhook events (super admin)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../utils/database');
const logger = require('../utils/logger');
const squareApi = require('../services/square');
const { generateIdempotencyKey } = require('../services/square');

// LOGIC CHANGE: extracted hashResetToken to shared utils/hash-utils.js (CQ-6)
const { hashResetToken } = require('../utils/hash-utils');
const subscriptionHandler = require('../utils/subscription-handler');
const { hashPassword, generateRandomPassword } = require('../utils/password');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/require-permission');
const { configureLoginRateLimit, configureSubscriptionRateLimit } = require('../middleware/security');
const validators = require('../middleware/validators/subscriptions');
const asyncHandler = require('../middleware/async-handler');

const promoRateLimit = configureLoginRateLimit();
const subscriptionRateLimit = configureSubscriptionRateLimit();
const subscriptionBridge = require('../services/subscription-bridge');
// LOGIC CHANGE: extracted promo code validation to shared service (BACKLOG-74)
const { validatePromoCode } = require('../services/promo-validation');
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
 * currently active. Returns only whether the code exists — no pricing detail.
 * Used by the pricing page to give feedback before the user reaches subscribe.html.
 */
router.get('/public/promo/check', promoRateLimit, asyncHandler(async (req, res) => {
    const code = (req.query.code || '').trim();
    if (!code) {
        return sendError(res, 'code is required', 400, 'MISSING_CODE');
    }

    const result = await db.query(`
        SELECT pc.code, pc.description, pc.discount_type, pc.discount_value,
               pc.fixed_price_cents, pc.duration_months
        FROM promo_codes pc
        JOIN merchants m ON m.id = pc.merchant_id
        WHERE UPPER(pc.code) = UPPER($1)
          AND m.subscription_status = 'platform_owner'
          AND pc.is_active = TRUE
          AND (pc.valid_from IS NULL OR pc.valid_from <= NOW())
          AND (pc.valid_until IS NULL OR pc.valid_until >= NOW())
          AND (pc.max_uses IS NULL OR pc.times_used < pc.max_uses)
    `, [code]);

    if (result.rows.length === 0) {
        return sendSuccess(res, { valid: false });
    }

    const promo = result.rows[0];
    let discountDisplay;
    if (promo.discount_type === 'fixed_price') {
        discountDisplay = `$${(promo.fixed_price_cents / 100).toFixed(2)}/mo`;
    } else if (promo.discount_type === 'percent') {
        discountDisplay = `${promo.discount_value}% off`;
    } else {
        discountDisplay = `$${(promo.discount_value / 100).toFixed(2)} off`;
    }

    sendSuccess(res, {
        valid: true,
        code: promo.code,
        description: promo.description,
        discountType: promo.discount_type,
        discountDisplay,
        durationMonths: promo.duration_months || null,
    });
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
router.post('/subscriptions/create', subscriptionRateLimit, validators.createSubscription, asyncHandler(async (req, res) => {
    const { email, businessName, plan, sourceId, promoCode, termsAcceptedAt } = req.body;

    // LOGIC CHANGE: merchant_id required for tenant isolation (CRIT-2 audit)
    const merchantId = req.session?.activeMerchantId || req.merchantContext?.id;
    if (!merchantId) {
        return sendError(res, 'Merchant context required', 400, 'NO_MERCHANT');
    }

    // Verify Square configuration
    const locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) {
        logger.error('SQUARE_LOCATION_ID not configured', { merchantId });
        return sendError(res, 'Payment system not configured. Please contact support.', 500);
    }

    // Check if subscriber already exists
    const existing = await subscriptionHandler.getSubscriberByEmail(email);
    if (existing) {
        return sendError(res, 'An account with this email already exists', 400);
    }

    // Get plan pricing and Square plan variation ID (scoped to merchant)
    const plans = await subscriptionHandler.getPlans(merchantId);
    const selectedPlan = plans.find(p => p.plan_key === plan);
    if (!selectedPlan) {
        return sendError(res, 'Invalid plan selected', 400);
    }

    // Verify Square subscription plan exists
    if (!selectedPlan.square_plan_id) {
        logger.error('Square plan not configured', { plan: plan, merchantId });
        return sendError(res, 'Subscription plan not configured. Please contact support.', 500);
    }

    // LOGIC CHANGE: uses shared validatePromoCode service (BACKLOG-74)
    let promoCodeId = null;
    let discountCents = 0;
    let finalPriceCents = selectedPlan.price_cents;

    if (promoCode) {
        const promoResult = await validatePromoCode({
            code: promoCode,
            merchantId,
            plan,
            priceCents: selectedPlan.price_cents
        });

        if (promoResult.valid) {
            promoCodeId = promoResult.promo.id;
            discountCents = promoResult.discount;
            finalPriceCents = promoResult.finalPrice;

            logger.info('Promo code applied', {
                code: promoResult.promo.code,
                discountCents,
                originalPrice: selectedPlan.price_cents,
                finalPrice: finalPriceCents
            });
        }
    }

    // Create customer and card on file in Square (no card numbers stored locally)
    let squareCustomerId = null;
    let cardId = null;
    let cardBrand = null;
    let cardLastFour = null;

    // Create Square customer
    const customerResponse = await squareApi.makeSquareRequest('/v2/customers', {
        method: 'POST',
        body: JSON.stringify({
            email_address: email,
            company_name: businessName || undefined,
            idempotency_key: generateIdempotencyKey(`customer-${email}`)
        })
    });

    if (!customerResponse.customer) {
        const errorDetail = customerResponse.errors?.[0]?.detail || 'Unknown error';
        logger.error('Square customer creation failed', { error: errorDetail, email, merchantId });
        return sendError(res, 'Account creation failed. Please try again.', 400, 'CUSTOMER_CREATION_FAILED');
    }

    squareCustomerId = customerResponse.customer.id;

    // Create card on file (Square tokenizes the card - we never see card numbers)
    const cardResponse = await squareApi.makeSquareRequest('/v2/cards', {
        method: 'POST',
        body: JSON.stringify({
            source_id: sourceId,
            idempotency_key: generateIdempotencyKey(`card-${email}`),
            card: {
                customer_id: squareCustomerId
            }
        })
    });

    if (!cardResponse.card) {
        const errorDetail = cardResponse.errors?.[0]?.detail || 'Unknown error';
        logger.error('Square card creation failed', { error: errorDetail, customerId: squareCustomerId, merchantId });
        return sendError(res, 'Failed to save payment method. Please check your card details.', 400, 'CARD_CREATION_FAILED');
    }

    cardId = cardResponse.card.id;
    cardBrand = cardResponse.card.card_brand;
    cardLastFour = cardResponse.card.last_4;

    // Create local subscriber record (linked to merchant if session is active)
    const subscriber = await subscriptionHandler.createSubscriber({
        email: email.toLowerCase(),
        businessName,
        plan,
        squareCustomerId,
        cardBrand,
        cardLastFour,
        cardId,
        merchantId
    });

    // Payment & subscription logic
    let paymentResult = null;
    let squareSubscription = null;
    const squareSubscriptions = require('../utils/square-subscriptions');

    if (discountCents > 0 && finalPriceCents > 0) {
        // PROMO CODE: Make first discounted payment manually, then schedule subscription
        try {
            const paymentNote = `Square Dashboard Addon - ${selectedPlan.name} (Promo: -$${(discountCents/100).toFixed(2)})`;

            const paymentResponse = await squareApi.makeSquareRequest('/v2/payments', {
                method: 'POST',
                body: JSON.stringify({
                    source_id: cardId,
                    idempotency_key: generateIdempotencyKey(`payment-${subscriber.id}`),
                    amount_money: {
                        amount: finalPriceCents,
                        // OSS: SaaS billing currency — this is the platform's subscription fee,
                        // not a per-merchant inventory currency. Hardcoded intentionally.
                        currency: 'CAD'
                    },
                    customer_id: squareCustomerId,
                    note: paymentNote
                })
            });

            if (paymentResponse.payment) {
                paymentResult = paymentResponse.payment;

                // Record payment
                await subscriptionHandler.recordPayment({
                    merchantId,
                    subscriberId: subscriber.id,
                    squarePaymentId: paymentResult.id,
                    amountCents: finalPriceCents,
                    currency: 'CAD', // OSS: SaaS billing currency, not per-merchant
                    status: paymentResult.status === 'COMPLETED' ? 'completed' : 'pending',
                    paymentType: 'subscription',
                    receiptUrl: paymentResult.receipt_url
                });
            }

            // Calculate next billing date based on plan
            const nextBillingDate = new Date();
            if (plan === 'annual') {
                nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
            } else {
                nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
            }
            const startDate = nextBillingDate.toISOString().split('T')[0];

            // Create Square subscription starting next billing cycle
            squareSubscription = await squareSubscriptions.createSubscription({
                customerId: squareCustomerId,
                cardId: cardId,
                planVariationId: selectedPlan.square_plan_id,
                locationId: locationId,
                startDate: startDate
            });

        } catch (paymentError) {
            logger.error('Discounted payment failed', {
                error: paymentError.message,
                subscriberId: subscriber?.id,
                amount: finalPriceCents
            });
            return sendError(res, 'Payment failed. Please check your card details and try again.', 400, 'PAYMENT_FAILED');
        }

    } else if (finalPriceCents === 0) {
        // 100% DISCOUNT: Create subscription starting next billing cycle (no immediate payment)
        const nextBillingDate = new Date();
        if (plan === 'annual') {
            nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
        } else {
            nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
        }
        const startDate = nextBillingDate.toISOString().split('T')[0];

        squareSubscription = await squareSubscriptions.createSubscription({
            customerId: squareCustomerId,
            cardId: cardId,
            planVariationId: selectedPlan.square_plan_id,
            locationId: locationId,
            startDate: startDate
        });

        logger.info('Subscription created with 100% promo discount - no payment processed', {
            subscriberId: subscriber.id,
            promoCode,
            nextBillingDate: startDate
        });

    } else {
        // NO PROMO: Create subscription immediately (Square handles first payment)
        try {
            squareSubscription = await squareSubscriptions.createSubscription({
                customerId: squareCustomerId,
                cardId: cardId,
                planVariationId: selectedPlan.square_plan_id,
                locationId: locationId
            });

            logger.info('Square subscription created - first payment handled by Square', {
                subscriberId: subscriber.id,
                squareSubscriptionId: squareSubscription.id
            });

        } catch (subError) {
            logger.error('Subscription creation failed', {
                error: subError.message,
                subscriberId: subscriber?.id,
                customerId: squareCustomerId
            });
            return sendError(res, 'Subscription creation failed. Please try again.', 400, 'SUBSCRIPTION_FAILED');
        }
    }

    // Update subscriber with Square subscription ID
    if (squareSubscription) {
        await db.query(`
            UPDATE subscribers
            SET square_subscription_id = $1, subscription_status = 'active', updated_at = NOW()
            WHERE id = $2
        `, [squareSubscription.id, subscriber.id]);
    }

    // Bridge: activate merchant subscription in System A if merchant is linked
    if (merchantId) {
        await subscriptionBridge.activateMerchantSubscription(subscriber.id, merchantId);
    }

    // Log subscription event
    await subscriptionHandler.logEvent({
        merchantId,
        subscriberId: subscriber.id,
        eventType: 'subscription.created',
        eventData: {
            plan,
            originalAmount: selectedPlan.price_cents,
            discountCents,
            finalAmount: finalPriceCents,
            promoCode: promoCode || null,
            payment_id: paymentResult?.id || null,
            square_subscription_id: squareSubscription?.id || null
        }
    });

    // Record promo code usage
    if (promoCodeId) {
        try {
            await db.query(`
                INSERT INTO promo_code_uses (promo_code_id, subscriber_id, discount_applied_cents)
                VALUES ($1, $2, $3)
            `, [promoCodeId, subscriber.id, discountCents]);

            await db.query(`
                UPDATE promo_codes SET times_used = times_used + 1, updated_at = NOW()
                WHERE id = $1
            `, [promoCodeId]);

            await db.query(`
                UPDATE subscribers SET promo_code_id = $1, discount_applied_cents = $2
                WHERE id = $3
            `, [promoCodeId, discountCents, subscriber.id]);
        } catch (promoError) {
            logger.error('Failed to record promo code usage', { error: promoError.message, merchantId });
        }
    }

    // Create user account so the subscriber can log in
    let passwordSetupToken = null;
    let userId = null;

    try {
        const normalizedEmail = email.toLowerCase().trim();

        const existingUser = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [normalizedEmail]
        );

        if (existingUser.rows.length === 0) {
            const tempPassword = generateRandomPassword();
            const passwordHash = await hashPassword(tempPassword);

            const userResult = await db.query(`
                INSERT INTO users (email, password_hash, name, role, terms_accepted_at)
                VALUES ($1, $2, $3, 'user', $4)
                RETURNING id
            `, [normalizedEmail, passwordHash, businessName || null, termsAcceptedAt]);

            userId = userResult.rows[0].id;

            passwordSetupToken = crypto.randomBytes(32).toString('hex');
            const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

            // Store hashed token (SEC-7: never store plaintext reset tokens)
            await db.query(`
                INSERT INTO password_reset_tokens (user_id, token, expires_at)
                VALUES ($1, $2, $3)
            `, [userId, hashResetToken(passwordSetupToken), tokenExpiry]);

            await db.query(`
                UPDATE subscribers SET user_id = $1 WHERE id = $2
            `, [userId, subscriber.id]);

            logger.info('User account created for subscriber', {
                userId,
                subscriberId: subscriber.id,
                email: normalizedEmail
            });
        } else {
            userId = existingUser.rows[0].id;
            logger.info('User account already exists for subscriber', {
                userId,
                subscriberId: subscriber.id
            });
        }
    } catch (userError) {
        logger.error('Failed to create user account', { error: userError.message, merchantId });
    }

    logger.info('Subscription created', {
        subscriberId: subscriber.id,
        email: subscriber.email,
        plan,
        paymentStatus: paymentResult?.status || 'no_payment'
    });

    sendSuccess(res, {
        subscriber: {
            id: subscriber.id,
            email: subscriber.email,
            plan: subscriber.subscription_plan,
            status: subscriber.subscription_status,
            trialEndDate: subscriber.trial_end_date
        },
        payment: paymentResult ? {
            status: paymentResult.status,
            receiptUrl: paymentResult.receipt_url
        } : null,
        passwordSetupToken: passwordSetupToken,
        passwordSetupUrl: passwordSetupToken ? `/set-password.html?token=${passwordSetupToken}` : null
    });
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
router.get('/subscriptions/merchant-status', requireAuth, asyncHandler(async (req, res) => {
    if (!req.merchantContext) {
        return sendError(res, 'No merchant connected', 403, 'NO_MERCHANT');
    }

    const mc = req.merchantContext;
    const plans = await subscriptionHandler.getPlans(mc.id);

    // Check System B for billing info
    const subscriber = await subscriptionHandler.getSubscriberByMerchantId(mc.id);

    let trialDaysRemaining = null;
    if (mc.subscriptionStatus === 'trial' && mc.trialEndsAt) {
        const now = new Date();
        const trialEnd = new Date(mc.trialEndsAt);
        trialDaysRemaining = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    }

    sendSuccess(res, {
        subscription: {
            status: mc.subscriptionStatus,
            isValid: mc.isSubscriptionValid,
            trialEndsAt: mc.trialEndsAt,
            trialDaysRemaining,
            subscriptionEndsAt: mc.subscriptionEndsAt
        },
        billing: subscriber ? {
            plan: subscriber.subscription_plan,
            priceCents: subscriber.price_cents,
            cardBrand: subscriber.card_brand,
            cardLastFour: subscriber.card_last_four,
            nextBillingDate: subscriber.next_billing_date,
            squareSubscriptionId: subscriber.square_subscription_id
        } : null,
        plans,
        merchantId: mc.id,
        businessName: mc.businessName
    });
}));

/**
 * POST /api/subscriptions/cancel
 * Cancel a subscription (cancels in both local DB and Square)
 */
router.post('/subscriptions/cancel', requireAuth, validators.cancelSubscription, asyncHandler(async (req, res) => {
    const { email, reason } = req.body;

    const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
    if (!subscriber) {
        return sendError(res, 'Subscriber not found', 404);
    }

    // Cancel in Square first (if subscription exists)
    if (subscriber.square_subscription_id) {
        try {
            const squareSubscriptions = require('../utils/square-subscriptions');
            await squareSubscriptions.cancelSubscription(subscriber.square_subscription_id);
            logger.info('Square subscription canceled', {
                subscriberId: subscriber.id,
                squareSubscriptionId: subscriber.square_subscription_id
            });
        } catch (squareError) {
            logger.warn('Failed to cancel Square subscription', {
                error: squareError.message,
                squareSubscriptionId: subscriber.square_subscription_id
            });
        }
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

    sendSuccess(res, {
        subscriber: updated
    });
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
router.post('/subscriptions/admin/setup-plans', requireAuth, requirePermission('subscription', 'admin'), asyncHandler(async (req, res) => {
    // Super-admin check
    const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const userEmail = req.session?.user?.email?.toLowerCase();

    if (!superAdminEmails.includes(userEmail)) {
        logger.warn('Unauthorized attempt to setup subscription plans', { email: userEmail });
        return sendError(res, 'Super admin access required', 403);
    }

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
        adminEmail: userEmail
    });

    sendSuccess(res, result);
}));

/**
 * GET /api/webhooks/events
 * View recent webhook events (SUPER ADMIN ONLY - cross-tenant debugging)
 */
router.get('/webhooks/events', requireAuth, requireAdmin, validators.listWebhookEvents, asyncHandler(async (req, res) => {
    // Super-admin check
    const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const userEmail = req.session?.user?.email?.toLowerCase();

    if (!superAdminEmails.includes(userEmail)) {
        logger.warn('Unauthorized access attempt to webhook events', { email: userEmail });
        return sendError(res, 'Super admin access required', 403);
    }

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
