/**
 * Subscription Handler for Square Dashboard Addon Tool
 * Manages subscriptions using Square Payments and Subscriptions APIs
 */

const logger = require('./logger');
const db = require('./database');

// Trial period in days
const TRIAL_DAYS = 30;

// Subscription statuses
const STATUS = {
    TRIAL: 'trial',
    ACTIVE: 'active',
    PAST_DUE: 'past_due',
    CANCELED: 'canceled',
    EXPIRED: 'expired'
};

/**
 * Create a new subscriber with trial period
 * @param {Object} params - Subscriber details
 * @returns {Promise<Object>} Created subscriber
 */
async function createSubscriber({ email, businessName, plan, squareCustomerId, cardBrand, cardLastFour, cardId }) {
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + TRIAL_DAYS);

    // Get plan pricing
    const planResult = await db.query(
        'SELECT price_cents FROM subscription_plans WHERE plan_key = $1',
        [plan]
    );
    const priceCents = planResult.rows[0]?.price_cents || (plan === 'annual' ? 9999 : 999);

    const result = await db.query(`
        INSERT INTO subscribers (
            email, business_name, subscription_plan, price_cents,
            square_customer_id, card_brand, card_last_four, card_id,
            subscription_status, trial_start_date, trial_end_date,
            subscription_start_date, next_billing_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10, CURRENT_TIMESTAMP, $10)
        RETURNING *
    `, [
        email,
        businessName || null,
        plan,
        priceCents,
        squareCustomerId || null,
        cardBrand || null,
        cardLastFour || null,
        cardId || null,
        STATUS.TRIAL,
        trialEndDate
    ]);

    logger.info('Subscriber created', { email, plan, trialEndDate });
    return result.rows[0];
}

/**
 * Get subscriber by email
 * @param {string} email - Subscriber email
 * @returns {Promise<Object|null>} Subscriber or null
 */
async function getSubscriberByEmail(email) {
    const result = await db.query(
        'SELECT * FROM subscribers WHERE email = $1',
        [email.toLowerCase()]
    );
    return result.rows[0] || null;
}

/**
 * Get subscriber by ID
 * @param {number} id - Subscriber ID
 * @returns {Promise<Object|null>} Subscriber or null
 */
async function getSubscriberById(id) {
    const result = await db.query(
        'SELECT * FROM subscribers WHERE id = $1',
        [id]
    );
    return result.rows[0] || null;
}

/**
 * Get subscriber by Square Customer ID
 * @param {string} squareCustomerId - Square customer ID
 * @returns {Promise<Object|null>} Subscriber or null
 */
async function getSubscriberBySquareCustomerId(squareCustomerId) {
    const result = await db.query(
        'SELECT * FROM subscribers WHERE square_customer_id = $1',
        [squareCustomerId]
    );
    return result.rows[0] || null;
}

/**
 * Get subscriber by Square Subscription ID
 * @param {string} squareSubscriptionId - Square subscription ID
 * @returns {Promise<Object|null>} Subscriber or null
 */
async function getSubscriberBySquareSubscriptionId(squareSubscriptionId) {
    const result = await db.query(
        'SELECT * FROM subscribers WHERE square_subscription_id = $1',
        [squareSubscriptionId]
    );
    return result.rows[0] || null;
}

/**
 * Check if a subscription is currently valid (active or in trial)
 * @param {string} email - Subscriber email
 * @returns {Promise<Object>} Status object with isValid boolean
 */
async function checkSubscriptionStatus(email) {
    const subscriber = await getSubscriberByEmail(email);

    if (!subscriber) {
        return { isValid: false, status: 'not_found', message: 'No subscription found' };
    }

    const now = new Date();
    const status = subscriber.subscription_status;

    // Check trial status
    if (status === STATUS.TRIAL) {
        const trialEnd = new Date(subscriber.trial_end_date);
        if (now < trialEnd) {
            const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
            return {
                isValid: true,
                status: STATUS.TRIAL,
                daysLeft,
                message: `Trial active - ${daysLeft} days remaining`
            };
        } else {
            // Trial expired, update status
            await updateSubscriptionStatus(subscriber.id, STATUS.EXPIRED);
            return { isValid: false, status: STATUS.EXPIRED, message: 'Trial expired' };
        }
    }

    // Check active subscription
    if (status === STATUS.ACTIVE) {
        const subEnd = subscriber.subscription_end_date ? new Date(subscriber.subscription_end_date) : null;
        if (!subEnd || now < subEnd) {
            return { isValid: true, status: STATUS.ACTIVE, message: 'Subscription active' };
        } else {
            // Subscription expired
            await updateSubscriptionStatus(subscriber.id, STATUS.EXPIRED);
            return { isValid: false, status: STATUS.EXPIRED, message: 'Subscription expired' };
        }
    }

    // Past due - give grace period
    if (status === STATUS.PAST_DUE) {
        return { isValid: false, status: STATUS.PAST_DUE, message: 'Payment past due' };
    }

    // Canceled or expired
    return { isValid: false, status, message: `Subscription ${status}` };
}

/**
 * Update subscription status
 * @param {number} subscriberId - Subscriber ID
 * @param {string} status - New status
 * @returns {Promise<Object>} Updated subscriber
 */
async function updateSubscriptionStatus(subscriberId, status) {
    const result = await db.query(`
        UPDATE subscribers
        SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
    `, [status, subscriberId]);

    logger.info('Subscription status updated', { subscriberId, status });
    return result.rows[0];
}

/**
 * Activate subscription after successful payment
 * @param {number} subscriberId - Subscriber ID
 * @param {Object} params - Activation params (optional)
 * @returns {Promise<Object>} Updated subscriber
 */
async function activateSubscription(subscriberId, params = {}) {
    const { squareSubscriptionId, nextBillingDate } = params;

    const subscriber = await getSubscriberById(subscriberId);
    if (!subscriber) {
        throw new Error('Subscriber not found');
    }

    // Calculate subscription end date based on plan
    const subEndDate = new Date();
    if (subscriber.subscription_plan === 'annual') {
        subEndDate.setFullYear(subEndDate.getFullYear() + 1);
    } else {
        subEndDate.setMonth(subEndDate.getMonth() + 1);
    }

    const result = await db.query(`
        UPDATE subscribers
        SET subscription_status = $1,
            square_subscription_id = COALESCE($2, square_subscription_id),
            subscription_start_date = COALESCE(subscription_start_date, CURRENT_TIMESTAMP),
            subscription_end_date = $3,
            next_billing_date = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING *
    `, [STATUS.ACTIVE, squareSubscriptionId || null, subEndDate, nextBillingDate || subEndDate, subscriberId]);

    logger.info('Subscription activated', { subscriberId, plan: subscriber.subscription_plan });
    return result.rows[0];
}

/**
 * Update subscriber status (alias for updateSubscriptionStatus for webhook compatibility)
 * @param {number} subscriberId - Subscriber ID
 * @param {string} status - New status
 * @returns {Promise<Object>} Updated subscriber
 */
async function updateSubscriberStatus(subscriberId, status) {
    return updateSubscriptionStatus(subscriberId, status);
}

/**
 * Cancel subscription
 * @param {number} subscriberId - Subscriber ID
 * @param {string} reason - Cancellation reason
 * @returns {Promise<Object>} Updated subscriber
 */
async function cancelSubscription(subscriberId, reason = null) {
    const result = await db.query(`
        UPDATE subscribers
        SET subscription_status = $1,
            canceled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
    `, [STATUS.CANCELED, subscriberId]);

    logger.info('Subscription canceled', { subscriberId, reason });
    return result.rows[0];
}

/**
 * Record a payment
 * @param {Object} payment - Payment details
 * @returns {Promise<Object>} Created payment record
 */
async function recordPayment({
    subscriberId,
    squarePaymentId,
    squareInvoiceId,
    amountCents,
    currency = 'CAD',
    status,
    paymentType = 'subscription',
    billingPeriodStart,
    billingPeriodEnd,
    receiptUrl,
    failureReason
}) {
    const result = await db.query(`
        INSERT INTO subscription_payments (
            subscriber_id, square_payment_id, square_invoice_id, amount_cents, currency,
            status, payment_type, billing_period_start, billing_period_end,
            receipt_url, failure_reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
    `, [
        subscriberId,
        squarePaymentId || null,
        squareInvoiceId || null,
        amountCents,
        currency,
        status,
        paymentType,
        billingPeriodStart || null,
        billingPeriodEnd || null,
        receiptUrl || null,
        failureReason || null
    ]);

    logger.info('Payment recorded', { subscriberId, squarePaymentId, squareInvoiceId, status, amountCents });
    return result.rows[0];
}

/**
 * Process refund
 * @param {number} paymentId - Payment ID
 * @param {number} refundAmountCents - Refund amount in cents
 * @param {string} reason - Refund reason
 * @returns {Promise<Object>} Updated payment record
 */
async function processRefund(paymentId, refundAmountCents, reason) {
    const result = await db.query(`
        UPDATE subscription_payments
        SET status = 'refunded',
            refund_amount_cents = $1,
            refund_reason = $2,
            refunded_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
    `, [refundAmountCents, reason, paymentId]);

    logger.info('Refund processed', { paymentId, refundAmountCents, reason });
    return result.rows[0];
}

/**
 * Log subscription event
 * @param {Object} event - Event details
 * @returns {Promise<Object>} Created event record
 */
async function logEvent({ subscriberId, eventType, eventData, squareEventId }) {
    const result = await db.query(`
        INSERT INTO subscription_events (subscriber_id, event_type, event_data, square_event_id)
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `, [subscriberId, eventType, JSON.stringify(eventData), squareEventId]);

    return result.rows[0];
}

/**
 * Get subscription plans
 * @returns {Promise<Array>} Active subscription plans
 */
async function getPlans() {
    const result = await db.query(`
        SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price_cents ASC
    `);
    return result.rows;
}

/**
 * Get subscriber's payment history
 * @param {number} subscriberId - Subscriber ID
 * @returns {Promise<Array>} Payment history
 */
async function getPaymentHistory(subscriberId) {
    const result = await db.query(`
        SELECT * FROM subscription_payments
        WHERE subscriber_id = $1
        ORDER BY created_at DESC
    `, [subscriberId]);
    return result.rows;
}

/**
 * Update subscriber's card on file
 * @param {number} subscriberId - Subscriber ID
 * @param {Object} cardInfo - Card details
 * @returns {Promise<Object>} Updated subscriber
 */
async function updateCardOnFile(subscriberId, { cardId, cardBrand, cardLastFour }) {
    const result = await db.query(`
        UPDATE subscribers
        SET card_id = $1, card_brand = $2, card_last_four = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *
    `, [cardId, cardBrand, cardLastFour, subscriberId]);

    logger.info('Card on file updated', { subscriberId, cardBrand, cardLastFour });
    return result.rows[0];
}

/**
 * Get all subscribers (admin)
 * @param {Object} filters - Optional filters
 * @returns {Promise<Array>} Subscribers list
 */
async function getAllSubscribers(filters = {}) {
    let sql = 'SELECT * FROM subscribers';
    const params = [];

    if (filters.status) {
        sql += ' WHERE subscription_status = $1';
        params.push(filters.status);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await db.query(sql, params);
    return result.rows;
}

/**
 * Get subscription statistics
 * @returns {Promise<Object>} Subscription stats
 */
async function getSubscriptionStats() {
    const result = await db.query(`
        SELECT
            COUNT(*) as total_subscribers,
            COUNT(*) FILTER (WHERE subscription_status = 'trial') as trial_count,
            COUNT(*) FILTER (WHERE subscription_status = 'active') as active_count,
            COUNT(*) FILTER (WHERE subscription_status = 'canceled') as canceled_count,
            COUNT(*) FILTER (WHERE subscription_status = 'expired') as expired_count,
            COUNT(*) FILTER (WHERE subscription_plan = 'monthly') as monthly_count,
            COUNT(*) FILTER (WHERE subscription_plan = 'annual') as annual_count,
            COALESCE(SUM(price_cents) FILTER (WHERE subscription_status = 'active'), 0) as monthly_revenue_cents
        FROM subscribers
    `);

    return result.rows[0];
}

module.exports = {
    STATUS,
    TRIAL_DAYS,
    createSubscriber,
    getSubscriberByEmail,
    getSubscriberById,
    getSubscriberBySquareCustomerId,
    getSubscriberBySquareSubscriptionId,
    checkSubscriptionStatus,
    updateSubscriptionStatus,
    updateSubscriberStatus,
    activateSubscription,
    cancelSubscription,
    recordPayment,
    processRefund,
    logEvent,
    getPlans,
    getPaymentHistory,
    updateCardOnFile,
    getAllSubscribers,
    getSubscriptionStats
};
