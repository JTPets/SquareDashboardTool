/**
 * Subscription Webhook Handler
 *
 * Handles Square webhook events related to subscriptions, invoices,
 * and customer deletion (subscription-related).
 *
 * Event types handled:
 * - subscription.created
 * - subscription.updated
 * - invoice.payment_made
 * - invoice.payment_failed
 * - customer.deleted
 *
 * Bridge: All handlers now update BOTH System B (subscribers table)
 * AND System A (merchants table) via the subscription-bridge service.
 *
 * @module services/webhook-handlers/subscription-handler
 */

const logger = require('../../utils/logger');
const subscriptionHandler = require('../../utils/subscription-handler');
const subscriptionBridge = require('../subscription-bridge');

// Map Square subscription status to internal status
const STATUS_MAP = {
    'ACTIVE': 'active',
    'CANCELED': 'canceled',
    'DEACTIVATED': 'expired',
    'PAUSED': 'past_due',
    'PENDING': 'trial'
};

class SubscriptionHandler {
    /**
     * Handle subscription.created event
     * Activates the subscriber when a new subscription is created
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with subscriberId if found
     */
    async handleCreated(context) {
        const { data } = context;
        const result = { handled: true };

        if (!data.subscription) {
            logger.debug('subscription.created event missing subscription data');
            return result;
        }

        const sub = data.subscription;
        const subscriber = await subscriptionHandler.getSubscriberBySquareSubscriptionId(sub.id);

        if (subscriber) {
            result.subscriberId = subscriber.id;
            await subscriptionHandler.updateSubscriberStatus(subscriber.id, 'active');

            // Bridge: activate merchant in System A
            const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
            if (merchantId) {
                await subscriptionBridge.activateMerchantSubscription(subscriber.id, merchantId);
                result.merchantId = merchantId;
            }

            logger.info('Subscription activated via webhook', {
                subscriberId: subscriber.id,
                merchantId
            });
        } else {
            logger.debug('No subscriber found for subscription', {
                squareSubscriptionId: sub.id
            });
        }

        return result;
    }

    /**
     * Handle subscription.updated event
     * Updates subscriber status based on Square subscription status
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with subscriberId and newStatus if found
     */
    async handleUpdated(context) {
        const { data } = context;
        const result = { handled: true };

        if (!data.subscription) {
            logger.debug('subscription.updated event missing subscription data');
            return result;
        }

        const sub = data.subscription;
        const subscriber = await subscriptionHandler.getSubscriberBySquareSubscriptionId(sub.id);

        if (subscriber) {
            result.subscriberId = subscriber.id;
            const newStatus = STATUS_MAP[sub.status] || 'active';
            result.newStatus = newStatus;

            await subscriptionHandler.updateSubscriberStatus(subscriber.id, newStatus);

            // Bridge: sync status to merchant in System A
            const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
            if (merchantId) {
                if (newStatus === 'active') {
                    await subscriptionBridge.activateMerchantSubscription(subscriber.id, merchantId);
                } else if (newStatus === 'canceled' || newStatus === 'expired') {
                    await subscriptionBridge.cancelMerchantSubscription(subscriber.id, merchantId);
                } else if (newStatus === 'past_due') {
                    await subscriptionBridge.suspendMerchantSubscription(subscriber.id, merchantId);
                }
                result.merchantId = merchantId;
            }

            logger.info('Subscription status updated via webhook', {
                subscriberId: subscriber.id,
                merchantId,
                newStatus,
                squareStatus: sub.status
            });
        } else {
            logger.debug('No subscriber found for subscription', {
                squareSubscriptionId: sub.id
            });
        }

        return result;
    }

    /**
     * Handle invoice.payment_made event
     * Records successful payment and ensures subscription is active
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with subscriberId if found
     */
    async handleInvoicePaymentMade(context) {
        const { data } = context;
        const result = { handled: true };

        if (!data.invoice) {
            logger.debug('invoice.payment_made event missing invoice data');
            return result;
        }

        const invoice = data.invoice;
        const customerId = invoice.primary_recipient?.customer_id;

        if (!customerId) {
            logger.debug('invoice.payment_made event missing customer_id');
            return result;
        }

        const subscriber = await subscriptionHandler.getSubscriberBySquareCustomerId(customerId);

        if (subscriber) {
            result.subscriberId = subscriber.id;

            await subscriptionHandler.activateSubscription(subscriber.id);
            await subscriptionHandler.recordPayment({
                subscriberId: subscriber.id,
                squarePaymentId: invoice.payment_requests?.[0]?.computed_amount_money ? null : invoice.id,
                squareInvoiceId: invoice.id,
                amountCents: invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0,
                status: 'completed',
                paymentType: 'subscription'
            });

            // Bridge: activate merchant in System A
            const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
            if (merchantId) {
                await subscriptionBridge.activateMerchantSubscription(subscriber.id, merchantId);
                result.merchantId = merchantId;
            }

            logger.info('Payment recorded via webhook', {
                subscriberId: subscriber.id,
                merchantId
            });
        } else {
            logger.debug('No subscriber found for customer', {
                squareCustomerId: customerId
            });
        }

        return result;
    }

    /**
     * Handle invoice.payment_failed event
     * Records failed payment and marks subscription as past_due
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with subscriberId if found
     */
    async handleInvoicePaymentFailed(context) {
        const { data } = context;
        const result = { handled: true };

        if (!data.invoice) {
            logger.debug('invoice.payment_failed event missing invoice data');
            return result;
        }

        const invoice = data.invoice;
        const customerId = invoice.primary_recipient?.customer_id;

        if (!customerId) {
            logger.debug('invoice.payment_failed event missing customer_id');
            return result;
        }

        const subscriber = await subscriptionHandler.getSubscriberBySquareCustomerId(customerId);

        if (subscriber) {
            result.subscriberId = subscriber.id;

            await subscriptionHandler.updateSubscriberStatus(subscriber.id, 'past_due');
            await subscriptionHandler.recordPayment({
                subscriberId: subscriber.id,
                squareInvoiceId: invoice.id,
                amountCents: invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0,
                status: 'failed',
                paymentType: 'subscription',
                failureReason: 'Payment failed'
            });

            // Bridge: suspend merchant in System A
            const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
            if (merchantId) {
                await subscriptionBridge.suspendMerchantSubscription(subscriber.id, merchantId);
                result.merchantId = merchantId;
            }

            logger.warn('Payment failed via webhook', {
                subscriberId: subscriber.id,
                merchantId
            });
        } else {
            logger.debug('No subscriber found for customer', {
                squareCustomerId: customerId
            });
        }

        return result;
    }

    /**
     * Handle customer.deleted event
     * Marks subscription as canceled when customer is deleted from Square
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with subscriberId if found
     */
    async handleCustomerDeleted(context) {
        const { data } = context;
        const result = { handled: true };

        if (!data.customer) {
            logger.debug('customer.deleted event missing customer data');
            return result;
        }

        const subscriber = await subscriptionHandler.getSubscriberBySquareCustomerId(data.customer.id);

        if (subscriber) {
            result.subscriberId = subscriber.id;
            await subscriptionHandler.updateSubscriberStatus(subscriber.id, 'canceled');

            // Bridge: cancel merchant in System A
            const merchantId = await subscriptionBridge.resolveMerchantId(subscriber);
            if (merchantId) {
                await subscriptionBridge.cancelMerchantSubscription(subscriber.id, merchantId);
                result.merchantId = merchantId;
            }

            logger.info('Customer deleted via webhook', {
                subscriberId: subscriber.id,
                merchantId
            });
        } else {
            logger.debug('No subscriber found for deleted customer', {
                squareCustomerId: data.customer.id
            });
        }

        return result;
    }
}

module.exports = SubscriptionHandler;
