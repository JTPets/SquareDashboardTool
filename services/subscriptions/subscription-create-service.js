/**
 * Subscription Create Service
 *
 * Handles all logic for POST /subscriptions/create:
 *   - Promo validation and discount calculation
 *   - Square customer + card-on-file creation
 *   - Three payment paths: discounted first-payment, 100%-free, full Square-managed
 *   - Merchant feature activation (System A bridge)
 *   - User account creation with password-setup token
 *
 * Extracted from routes/subscriptions.js (BACKLOG-74 follow-up).
 */

const crypto = require('crypto');
const db = require('../../utils/database');
const logger = require('../../utils/logger');
const squareApi = require('../square');
const { generateIdempotencyKey } = require('../square');
const { hashResetToken } = require('../../utils/hash-utils');
const subscriptionHandler = require('../../utils/subscription-handler');
const { hashPassword, generateRandomPassword } = require('../../utils/password');
const { validatePromoCode } = require('./promo-validation');
const subscriptionBridge = require('./subscription-bridge');

/**
 * Create Square customer and card on file. Throws on failure.
 * @returns {{ squareCustomerId, cardId, cardBrand, cardLastFour }}
 */
async function createSquareCustomerAndCard(email, businessName, sourceId) {
    const customerResponse = await squareApi.makeSquareRequest('/v2/customers', {
        method: 'POST',
        body: JSON.stringify({
            email_address: email,
            company_name: businessName || undefined,
            idempotency_key: generateIdempotencyKey(`customer-${email}`)
        })
    });

    if (!customerResponse.customer) {
        const detail = customerResponse.errors?.[0]?.detail || 'Unknown error';
        logger.error('Square customer creation failed', { error: detail, email });
        throw Object.assign(new Error('Account creation failed. Please try again.'), { statusCode: 400, code: 'CUSTOMER_CREATION_FAILED' });
    }

    const squareCustomerId = customerResponse.customer.id;

    const cardResponse = await squareApi.makeSquareRequest('/v2/cards', {
        method: 'POST',
        body: JSON.stringify({
            source_id: sourceId,
            idempotency_key: generateIdempotencyKey(`card-${email}`),
            card: { customer_id: squareCustomerId }
        })
    });

    if (!cardResponse.card) {
        const detail = cardResponse.errors?.[0]?.detail || 'Unknown error';
        logger.error('Square card creation failed', { error: detail, customerId: squareCustomerId });
        throw Object.assign(new Error('Failed to save payment method. Please check your card details.'), { statusCode: 400, code: 'CARD_CREATION_FAILED' });
    }

    return {
        squareCustomerId,
        cardId: cardResponse.card.id,
        cardBrand: cardResponse.card.card_brand,
        cardLastFour: cardResponse.card.last_4
    };
}

/**
 * Process discounted first payment, then schedule Square subscription from next cycle.
 * @returns {{ payment, squareSubscription }}
 */
async function processDiscountedPayment({ merchantId, subscriberId, squareCustomerId, cardId, selectedPlan, plan, finalPriceCents, discountCents, promoCode, locationId }) {
    const squareSubscriptions = require('../../utils/square-subscriptions');
    const paymentNote = `Square Dashboard Addon - ${selectedPlan.name} (Promo: -$${(discountCents / 100).toFixed(2)})`;

    const paymentResponse = await squareApi.makeSquareRequest('/v2/payments', {
        method: 'POST',
        body: JSON.stringify({
            source_id: cardId,
            idempotency_key: generateIdempotencyKey(`payment-${subscriberId}`),
            // OSS: SaaS billing currency — platform subscription fee, not per-merchant inventory currency.
            amount_money: { amount: finalPriceCents, currency: 'CAD' },
            customer_id: squareCustomerId,
            note: paymentNote
        })
    });

    if (!paymentResponse.payment) {
        throw Object.assign(new Error('Payment failed. Please check your card details and try again.'), { statusCode: 400, code: 'PAYMENT_FAILED' });
    }

    const payment = paymentResponse.payment;
    await subscriptionHandler.recordPayment({
        merchantId, subscriberId, squarePaymentId: payment.id,
        amountCents: finalPriceCents, currency: 'CAD', // OSS: SaaS billing currency
        status: payment.status === 'COMPLETED' ? 'completed' : 'pending',
        paymentType: 'subscription', receiptUrl: payment.receipt_url
    });

    const nextBillingDate = new Date();
    if (plan === 'annual') nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
    else nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
    const startDate = nextBillingDate.toISOString().split('T')[0];

    const squareSubscription = await squareSubscriptions.createSubscription({
        customerId: squareCustomerId, cardId, planVariationId: selectedPlan.square_plan_id,
        locationId, startDate
    });

    return { payment, squareSubscription };
}

/**
 * Process 100%-free promo: schedule Square subscription from next cycle, no immediate payment.
 * @returns {{ payment: null, squareSubscription }}
 */
async function processFreePromo({ squareCustomerId, cardId, selectedPlan, plan, locationId, subscriberId, promoCode }) {
    const squareSubscriptions = require('../../utils/square-subscriptions');
    const nextBillingDate = new Date();
    if (plan === 'annual') nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
    else nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
    const startDate = nextBillingDate.toISOString().split('T')[0];

    const squareSubscription = await squareSubscriptions.createSubscription({
        customerId: squareCustomerId, cardId, planVariationId: selectedPlan.square_plan_id,
        locationId, startDate
    });

    logger.info('Subscription created with 100% promo discount - no payment processed', {
        subscriberId, promoCode, nextBillingDate: startDate
    });

    return { payment: null, squareSubscription };
}

/**
 * Process full subscription: Square manages first payment and all recurring billing.
 * @returns {{ payment: null, squareSubscription }}
 */
async function processFullSubscription({ squareCustomerId, cardId, selectedPlan, locationId, subscriberId }) {
    const squareSubscriptions = require('../../utils/square-subscriptions');
    try {
        const squareSubscription = await squareSubscriptions.createSubscription({
            customerId: squareCustomerId, cardId,
            planVariationId: selectedPlan.square_plan_id, locationId
        });
        logger.info('Square subscription created - first payment handled by Square', {
            subscriberId, squareSubscriptionId: squareSubscription.id
        });
        return { payment: null, squareSubscription };
    } catch (subError) {
        logger.error('Subscription creation failed', {
            error: subError.message, subscriberId, customerId: squareCustomerId
        });
        throw Object.assign(new Error('Subscription creation failed. Please try again.'), { statusCode: 400, code: 'SUBSCRIPTION_FAILED' });
    }
}

/**
 * Post-payment: update subscription ID, activate merchant access, log event, record promo use.
 */
async function activateMerchantFeatures({ merchantId, subscriber, promoCodeId, discountCents, promoExpiresAt, squareSubscription, plan, originalPrice, finalPrice, promoCode, payment }) {
    if (squareSubscription) {
        await db.query(
            `UPDATE subscribers SET square_subscription_id = $1, subscription_status = 'active', updated_at = NOW() WHERE id = $2`,
            [squareSubscription.id, subscriber.id]
        );
    }

    if (merchantId) {
        await subscriptionBridge.activateMerchantSubscription(subscriber.id, merchantId);
    }

    await subscriptionHandler.logEvent({
        merchantId, subscriberId: subscriber.id, eventType: 'subscription.created',
        eventData: {
            plan, originalAmount: originalPrice, discountCents, finalAmount: finalPrice,
            promoCode: promoCode || null,
            payment_id: payment?.id || null,
            square_subscription_id: squareSubscription?.id || null
        }
    });

    if (promoCodeId) {
        // B4: Atomic increment — protects against concurrent redemptions exceeding max_uses
        const claimed = await db.query(
            `UPDATE promo_codes SET times_used = times_used + 1, updated_at = NOW()
             WHERE id = $1 AND (max_uses IS NULL OR times_used < max_uses)
             RETURNING id`,
            [promoCodeId]
        );
        if (claimed.rows.length === 0) {
            logger.error('Promo max_uses exceeded at redemption (race condition)', { promoCodeId, merchantId });
            throw Object.assign(new Error('Promo code is no longer available'), { statusCode: 409, code: 'PROMO_MAXED' });
        }
        await db.query(
            `INSERT INTO promo_code_uses (promo_code_id, subscriber_id, discount_applied_cents) VALUES ($1, $2, $3)`,
            [promoCodeId, subscriber.id, discountCents]
        );
        // B3: store promo_expires_at (NULL when duration_months is unset = unlimited)
        await db.query(
            `UPDATE subscribers SET promo_code_id = $1, discount_applied_cents = $2, promo_expires_at = $3 WHERE id = $4`,
            [promoCodeId, discountCents, promoExpiresAt || null, subscriber.id]
        );
    }
}

/**
 * Create a user account for the subscriber if one doesn't exist.
 * @returns {{ userId, passwordSetupToken }}
 */
async function createUserAccount({ email, businessName, subscriberId, termsAcceptedAt }) {
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);

    if (existingUser.rows.length > 0) {
        logger.info('User account already exists for subscriber', { userId: existingUser.rows[0].id, subscriberId });
        return { userId: existingUser.rows[0].id, passwordSetupToken: null };
    }

    const tempPassword = generateRandomPassword();
    const passwordHash = await hashPassword(tempPassword);
    const userResult = await db.query(
        `INSERT INTO users (email, password_hash, name, role, terms_accepted_at) VALUES ($1, $2, $3, 'user', $4) RETURNING id`,
        [normalizedEmail, passwordHash, businessName || null, termsAcceptedAt]
    );
    const userId = userResult.rows[0].id;

    const passwordSetupToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // SEC-7: never store plaintext reset tokens
    await db.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [userId, hashResetToken(passwordSetupToken), tokenExpiry]
    );
    await db.query(`UPDATE subscribers SET user_id = $1 WHERE id = $2`, [userId, subscriberId]);

    logger.info('User account created for subscriber', { userId, subscriberId, email: normalizedEmail });
    return { userId, passwordSetupToken };
}

/**
 * Create a new subscription end-to-end.
 *
 * @param {number} merchantId
 * @param {Object} params
 * @param {string} params.email
 * @param {string} [params.businessName]
 * @param {string} params.plan - plan_key (e.g. 'monthly', 'annual')
 * @param {string} params.sourceId - Square payment token
 * @param {string} [params.promoCode]
 * @param {string} [params.termsAcceptedAt]
 * @returns {Promise<{ subscriber, payment, passwordSetupToken }>}
 * @throws {Error} with .statusCode and .code for expected failures
 */
async function createSubscription(merchantId, { email, businessName, plan, sourceId, promoCode, termsAcceptedAt }) {
    const plans = await subscriptionHandler.getPlans(merchantId);
    const selectedPlan = plans.find(p => p.plan_key === plan);
    if (!selectedPlan) {
        throw Object.assign(new Error('Invalid plan selected'), { statusCode: 400 });
    }
    if (!selectedPlan.square_plan_id) {
        logger.error('Square plan not configured', { plan, merchantId });
        throw Object.assign(new Error('Subscription plan not configured. Please contact support.'), { statusCode: 500 });
    }

    let promoCodeId = null;
    let discountCents = 0;
    let finalPriceCents = selectedPlan.price_cents;
    let promoExpiresAt = null;

    if (promoCode) {
        const promoResult = await validatePromoCode({ code: promoCode, merchantId, plan, priceCents: selectedPlan.price_cents });
        if (promoResult.valid) {
            promoCodeId = promoResult.promo.id;
            discountCents = promoResult.discount;
            finalPriceCents = promoResult.finalPrice;
            // B3: compute expiry when promo has a finite duration
            if (promoResult.promo.duration_months) {
                promoExpiresAt = new Date();
                promoExpiresAt.setMonth(promoExpiresAt.getMonth() + promoResult.promo.duration_months);
            }
            logger.info('Promo code applied', {
                code: promoResult.promo.code, discountCents,
                originalPrice: selectedPlan.price_cents, finalPrice: finalPriceCents,
                promoExpiresAt: promoExpiresAt || 'unlimited'
            });
        }
    }

    const { squareCustomerId, cardId, cardBrand, cardLastFour } = await createSquareCustomerAndCard(email, businessName, sourceId);

    const subscriber = await subscriptionHandler.createSubscriber({
        email: email.toLowerCase(), businessName, plan,
        squareCustomerId, cardBrand, cardLastFour, cardId, merchantId
    });

    const locationId = process.env.SQUARE_LOCATION_ID;
    let result;
    if (discountCents > 0 && finalPriceCents > 0) {
        result = await processDiscountedPayment({ merchantId, subscriberId: subscriber.id, squareCustomerId, cardId, selectedPlan, plan, finalPriceCents, discountCents, promoCode, locationId });
    } else if (finalPriceCents === 0) {
        result = await processFreePromo({ squareCustomerId, cardId, selectedPlan, plan, locationId, subscriberId: subscriber.id, promoCode });
    } else {
        result = await processFullSubscription({ squareCustomerId, cardId, selectedPlan, locationId, subscriberId: subscriber.id });
    }

    await activateMerchantFeatures({
        merchantId, subscriber, promoCodeId, discountCents, promoExpiresAt,
        squareSubscription: result.squareSubscription, plan,
        originalPrice: selectedPlan.price_cents, finalPrice: finalPriceCents,
        promoCode, payment: result.payment
    });

    let userAccountResult = { passwordSetupToken: null };
    try {
        userAccountResult = await createUserAccount({ email, businessName, subscriberId: subscriber.id, termsAcceptedAt });
    } catch (userError) {
        logger.error('Failed to create user account', { error: userError.message, merchantId });
    }

    logger.info('Subscription created', {
        subscriberId: subscriber.id, email: subscriber.email,
        plan, paymentStatus: result.payment?.status || 'no_payment'
    });

    return { subscriber, payment: result.payment, passwordSetupToken: userAccountResult.passwordSetupToken };
}

module.exports = { createSubscription };
