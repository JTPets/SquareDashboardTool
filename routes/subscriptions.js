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
const squareApi = require('../utils/square-api');
const subscriptionHandler = require('../utils/subscription-handler');
const { hashPassword, generateRandomPassword } = require('../utils/password');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const validators = require('../middleware/validators/subscriptions');

/**
 * GET /api/square/payment-config
 * Get Square application ID for Web Payments SDK
 */
router.get('/square/payment-config', (req, res) => {
    res.json({
        applicationId: process.env.SQUARE_APPLICATION_ID || null,
        locationId: process.env.SQUARE_LOCATION_ID || null,
        environment: process.env.SQUARE_ENVIRONMENT || 'sandbox'
    });
});

/**
 * GET /api/subscriptions/plans
 * Get available subscription plans
 */
router.get('/subscriptions/plans', async (req, res) => {
    try {
        const plans = await subscriptionHandler.getPlans();
        res.json({
            success: true,
            plans,
            trialDays: subscriptionHandler.TRIAL_DAYS
        });
    } catch (error) {
        logger.error('Get plans error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/promo/validate
 * Validate a promo code and return discount info
 */
router.post('/subscriptions/promo/validate', validators.validatePromo, async (req, res) => {
    try {
        const { code, plan, priceCents } = req.body;

        // Look up the promo code
        const result = await db.query(`
            SELECT * FROM promo_codes
            WHERE UPPER(code) = UPPER($1)
              AND is_active = TRUE
              AND (valid_from IS NULL OR valid_from <= NOW())
              AND (valid_until IS NULL OR valid_until >= NOW())
              AND (max_uses IS NULL OR times_used < max_uses)
        `, [code.trim()]);

        if (result.rows.length === 0) {
            return res.json({ valid: false, error: 'Invalid or expired promo code' });
        }

        const promo = result.rows[0];

        // Check plan restriction
        if (promo.applies_to_plans && promo.applies_to_plans.length > 0 && plan) {
            if (!promo.applies_to_plans.includes(plan)) {
                return res.json({ valid: false, error: 'This code does not apply to the selected plan' });
            }
        }

        // Check minimum purchase
        if (promo.min_purchase_cents && priceCents && priceCents < promo.min_purchase_cents) {
            return res.json({
                valid: false,
                error: `Minimum purchase of $${(promo.min_purchase_cents / 100).toFixed(2)} required`
            });
        }

        // Calculate discount
        let discountCents = 0;
        if (promo.discount_type === 'percent') {
            discountCents = Math.floor((priceCents || 0) * promo.discount_value / 100);
        } else {
            discountCents = promo.discount_value;
        }

        // Don't let discount exceed price
        if (priceCents && discountCents > priceCents) {
            discountCents = priceCents;
        }

        res.json({
            valid: true,
            code: promo.code,
            description: promo.description,
            discountType: promo.discount_type,
            discountValue: promo.discount_value,
            discountCents,
            discountDisplay: promo.discount_type === 'percent'
                ? `${promo.discount_value}% off`
                : `$${(promo.discount_value / 100).toFixed(2)} off`
        });

    } catch (error) {
        logger.error('Promo code validation error', { error: error.message, stack: error.stack });
        res.status(500).json({ valid: false, error: 'Failed to validate promo code' });
    }
});

/**
 * POST /api/subscriptions/create
 * Create a new subscription using Square Subscriptions API
 *
 * SECURITY: No credit card data is stored locally. All payment data is held by Square.
 * We only store Square IDs (customer_id, card_id, subscription_id).
 * Square handles all recurring billing, PCI compliance, and payment processing.
 */
router.post('/subscriptions/create', validators.createSubscription, async (req, res) => {
    try {
        const { email, businessName, plan, sourceId, promoCode, termsAcceptedAt } = req.body;

        // Verify Square configuration
        const locationId = process.env.SQUARE_LOCATION_ID;
        if (!locationId) {
            logger.error('SQUARE_LOCATION_ID not configured');
            return res.status(500).json({ error: 'Payment system not configured. Please contact support.' });
        }

        // Check if subscriber already exists
        const existing = await subscriptionHandler.getSubscriberByEmail(email);
        if (existing) {
            return res.status(400).json({ error: 'An account with this email already exists' });
        }

        // Get plan pricing and Square plan variation ID
        const plans = await subscriptionHandler.getPlans();
        const selectedPlan = plans.find(p => p.plan_key === plan);
        if (!selectedPlan) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Verify Square subscription plan exists
        if (!selectedPlan.square_plan_id) {
            logger.error('Square plan not configured', { plan: plan });
            return res.status(500).json({
                error: 'Subscription plan not configured. Please contact support.'
            });
        }

        // Validate and apply promo code if provided
        let promoCodeId = null;
        let discountCents = 0;
        let finalPriceCents = selectedPlan.price_cents;

        if (promoCode) {
            const promoResult = await db.query(`
                SELECT * FROM promo_codes
                WHERE UPPER(code) = UPPER($1)
                  AND is_active = TRUE
                  AND (valid_from IS NULL OR valid_from <= NOW())
                  AND (valid_until IS NULL OR valid_until >= NOW())
                  AND (max_uses IS NULL OR times_used < max_uses)
            `, [promoCode.trim()]);

            if (promoResult.rows.length > 0) {
                const promo = promoResult.rows[0];

                // Check plan restriction
                if (!promo.applies_to_plans || promo.applies_to_plans.length === 0 || promo.applies_to_plans.includes(plan)) {
                    promoCodeId = promo.id;

                    // Calculate discount
                    if (promo.discount_type === 'percent') {
                        discountCents = Math.floor(selectedPlan.price_cents * promo.discount_value / 100);
                    } else {
                        discountCents = promo.discount_value;
                    }

                    // Don't let discount exceed price
                    if (discountCents > selectedPlan.price_cents) {
                        discountCents = selectedPlan.price_cents;
                    }

                    finalPriceCents = selectedPlan.price_cents - discountCents;

                    logger.info('Promo code applied', {
                        code: promo.code,
                        discountCents,
                        originalPrice: selectedPlan.price_cents,
                        finalPrice: finalPriceCents
                    });
                }
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
                idempotency_key: `customer-${email}-${Date.now()}`
            })
        });

        if (!customerResponse.customer) {
            const errorMsg = customerResponse.errors?.[0]?.detail || 'Failed to create customer';
            logger.error('Square customer creation failed', { error: errorMsg });
            return res.status(400).json({ error: errorMsg });
        }

        squareCustomerId = customerResponse.customer.id;

        // Create card on file (Square tokenizes the card - we never see card numbers)
        const cardResponse = await squareApi.makeSquareRequest('/v2/cards', {
            method: 'POST',
            body: JSON.stringify({
                source_id: sourceId,
                idempotency_key: `card-${email}-${Date.now()}`,
                card: {
                    customer_id: squareCustomerId
                }
            })
        });

        if (!cardResponse.card) {
            const errorMsg = cardResponse.errors?.[0]?.detail || 'Failed to save payment method';
            logger.error('Square card creation failed', { error: errorMsg, customerId: squareCustomerId });
            return res.status(400).json({ error: errorMsg });
        }

        cardId = cardResponse.card.id;
        cardBrand = cardResponse.card.card_brand;
        cardLastFour = cardResponse.card.last_4;

        // Create local subscriber record
        const subscriber = await subscriptionHandler.createSubscriber({
            email: email.toLowerCase(),
            businessName,
            plan,
            squareCustomerId,
            cardBrand,
            cardLastFour,
            cardId
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
                        idempotency_key: `payment-${subscriber.id}-${Date.now()}`,
                        amount_money: {
                            amount: finalPriceCents,
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
                        subscriberId: subscriber.id,
                        squarePaymentId: paymentResult.id,
                        amountCents: finalPriceCents,
                        currency: 'CAD',
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
                logger.error('Discounted payment failed', { error: paymentError.message });
                return res.status(400).json({
                    error: 'Payment failed: ' + (paymentError.message || 'Please check your card details')
                });
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
                logger.error('Subscription creation failed', { error: subError.message });
                return res.status(400).json({
                    error: 'Subscription failed: ' + (subError.message || 'Please try again')
                });
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

        // Log subscription event
        await subscriptionHandler.logEvent({
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
                logger.error('Failed to record promo code usage', { error: promoError.message });
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

                await db.query(`
                    INSERT INTO password_reset_tokens (user_id, token, expires_at)
                    VALUES ($1, $2, $3)
                `, [userId, passwordSetupToken, tokenExpiry]);

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
            logger.error('Failed to create user account', { error: userError.message });
        }

        logger.info('Subscription created', {
            subscriberId: subscriber.id,
            email: subscriber.email,
            plan,
            paymentStatus: paymentResult?.status || 'no_payment'
        });

        res.json({
            success: true,
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

    } catch (error) {
        logger.error('Create subscription error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/subscriptions/status
 * Check subscription status for an email
 */
router.get('/subscriptions/status', validators.checkStatus, async (req, res) => {
    try {
        const { email } = req.query;
        const status = await subscriptionHandler.checkSubscriptionStatus(email);
        res.json(status);
    } catch (error) {
        logger.error('Check subscription status error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/cancel
 * Cancel a subscription (cancels in both local DB and Square)
 */
router.post('/subscriptions/cancel', requireAuth, validators.cancelSubscription, async (req, res) => {
    try {
        const { email, reason } = req.body;

        const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
        if (!subscriber) {
            return res.status(404).json({ error: 'Subscriber not found' });
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

        await subscriptionHandler.logEvent({
            subscriberId: subscriber.id,
            eventType: 'subscription.canceled',
            eventData: {
                reason,
                square_subscription_id: subscriber.square_subscription_id
            }
        });

        res.json({
            success: true,
            subscriber: updated
        });

    } catch (error) {
        logger.error('Cancel subscription error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/refund
 * Process a refund for a subscription payment
 */
router.post('/subscriptions/refund', requireAdmin, validators.processRefund, async (req, res) => {
    try {
        const { email, reason } = req.body;

        const subscriber = await subscriptionHandler.getSubscriberByEmail(email);
        if (!subscriber) {
            return res.status(404).json({ error: 'Subscriber not found' });
        }

        const payments = await subscriptionHandler.getPaymentHistory(subscriber.id);
        const lastPayment = payments.find(p => p.status === 'completed' && !p.refunded_at);

        if (!lastPayment) {
            return res.status(400).json({ error: 'No refundable payment found' });
        }

        let squareRefund = null;
        if (lastPayment.square_payment_id) {
            try {
                const refundResponse = await squareApi.makeSquareRequest('/v2/refunds', {
                    method: 'POST',
                    body: JSON.stringify({
                        idempotency_key: `refund-${lastPayment.id}-${Date.now()}`,
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
                logger.error('Square refund failed', { error: refundError.message });
                return res.status(500).json({ error: 'Refund processing failed: ' + refundError.message });
            }
        }

        await subscriptionHandler.processRefund(lastPayment.id, lastPayment.amount_cents, reason || '30-day trial refund');
        await subscriptionHandler.cancelSubscription(subscriber.id, 'Refunded');

        await subscriptionHandler.logEvent({
            subscriberId: subscriber.id,
            eventType: 'payment.refunded',
            eventData: { payment_id: lastPayment.id, amount: lastPayment.amount_cents, reason }
        });

        res.json({
            success: true,
            refund: squareRefund,
            message: 'Refund processed successfully'
        });

    } catch (error) {
        logger.error('Process refund error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/subscriptions/admin/list
 * Get all subscribers (admin endpoint)
 */
router.get('/subscriptions/admin/list', requireAdmin, validators.listSubscribers, async (req, res) => {
    try {
        const { status } = req.query;
        const subscribers = await subscriptionHandler.getAllSubscribers({ status });
        const stats = await subscriptionHandler.getSubscriptionStats();

        res.json({
            success: true,
            count: subscribers.length,
            subscribers,
            stats
        });

    } catch (error) {
        logger.error('List subscribers error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/subscriptions/admin/plans
 * Get subscription plans with Square status (admin endpoint)
 */
router.get('/subscriptions/admin/plans', requireAdmin, async (req, res) => {
    try {
        const squareSubscriptions = require('../utils/square-subscriptions');
        const plans = await squareSubscriptions.listPlans();

        res.json({
            success: true,
            plans,
            squareConfigured: !!process.env.SQUARE_LOCATION_ID
        });

    } catch (error) {
        logger.error('List subscription plans error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/subscriptions/admin/setup-plans
 * Initialize or update subscription plans in Square (SUPER ADMIN ONLY)
 */
router.post('/subscriptions/admin/setup-plans', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Super-admin check
        const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        const userEmail = req.session?.user?.email?.toLowerCase();

        if (!superAdminEmails.includes(userEmail)) {
            logger.warn('Unauthorized attempt to setup subscription plans', { email: userEmail });
            return res.status(403).json({
                error: 'Super admin access required',
                message: 'Only super admins can setup subscription plans in Square.'
            });
        }

        if (!process.env.SQUARE_LOCATION_ID) {
            return res.status(400).json({
                error: 'SQUARE_LOCATION_ID not configured',
                message: 'Please configure SQUARE_LOCATION_ID in your environment before setting up plans.'
            });
        }

        if (!process.env.SQUARE_ACCESS_TOKEN) {
            return res.status(400).json({
                error: 'SQUARE_ACCESS_TOKEN not configured',
                message: 'Please configure SQUARE_ACCESS_TOKEN in your environment before setting up plans.'
            });
        }

        const squareSubscriptions = require('../utils/square-subscriptions');
        const result = await squareSubscriptions.setupSubscriptionPlans();

        logger.info('Subscription plans setup completed', {
            plans: result.plans.length,
            errors: result.errors.length,
            adminEmail: userEmail
        });

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('Setup subscription plans error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/webhooks/events
 * View recent webhook events (SUPER ADMIN ONLY - cross-tenant debugging)
 */
router.get('/webhooks/events', requireAuth, requireAdmin, validators.listWebhookEvents, async (req, res) => {
    try {
        // Super-admin check
        const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        const userEmail = req.session?.user?.email?.toLowerCase();

        if (!superAdminEmails.includes(userEmail)) {
            logger.warn('Unauthorized access attempt to webhook events', { email: userEmail });
            return res.status(403).json({
                error: 'Super admin access required',
                message: 'This endpoint requires super-admin privileges. Contact system administrator.'
            });
        }

        const { limit = 50, status, event_type } = req.query;

        let query = `
            SELECT id, square_event_id, event_type, merchant_id, status,
                   received_at, processed_at, processing_time_ms, error_message,
                   sync_results
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

        res.json({
            events: result.rows,
            stats: stats.rows[0]
        });
    } catch (error) {
        logger.error('Error fetching webhook events', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
