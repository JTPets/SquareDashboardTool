/**
 * Loyalty Webhook Handler
 *
 * Handles Square webhook events related to loyalty programs, loyalty accounts,
 * and gift cards.
 *
 * Event types handled:
 * - loyalty.event.created
 * - loyalty.account.updated
 * - loyalty.account.created
 * - loyalty.program.updated
 * - gift_card.customer_linked
 *
 * @module services/webhook-handlers/loyalty-handler
 */

const logger = require('../../utils/logger');
const loyaltyService = require('../../utils/loyalty-service');

// Square API version for direct API calls
const SQUARE_API_VERSION = '2025-01-16';

class LoyaltyHandler {
    /**
     * Handle loyalty.event.created event
     * Processes loyalty events to catch orders where customer was linked after initial webhook
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with processing details
     */
    async handleLoyaltyEventCreated(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (process.env.WEBHOOK_ORDER_SYNC === 'false') {
            return result;
        }

        if (!merchantId) {
            logger.warn('Cannot process loyalty event - merchant not found for webhook');
            result.error = 'Merchant not found';
            return result;
        }

        // Square webhook structure: event.data.object.loyalty_event
        const loyaltyEvent = data.loyalty_event;

        if (!loyaltyEvent) {
            logger.warn('Loyalty event webhook missing loyalty_event in payload', {
                dataKeys: Object.keys(data),
                merchantId
            });
            return result;
        }

        // Extract order_id from the loyalty event (can be in different places depending on event type)
        const orderId = loyaltyEvent.accumulate_points?.order_id
            || loyaltyEvent.redeem_reward?.order_id
            || loyaltyEvent.order_id;

        const loyaltyAccountId = loyaltyEvent.loyalty_account_id;

        logger.info('Loyalty event received via webhook', {
            eventId: loyaltyEvent.id,
            eventType: loyaltyEvent.type,
            orderId,
            loyaltyAccountId,
            merchantId
        });

        // Process based on whether we have an order_id
        if (orderId && loyaltyAccountId) {
            await this._processLoyaltyEventWithOrder(orderId, loyaltyAccountId, merchantId, result);
        } else if (loyaltyAccountId) {
            // No order_id in this event - do reverse lookup
            await this._processLoyaltyEventReverseLookup(loyaltyAccountId, loyaltyEvent.type, merchantId, result);
        } else {
            logger.info('Loyalty event skipped - no loyalty account ID in event', {
                orderId,
                eventType: loyaltyEvent.type,
                merchantId
            });
            result.loyaltyEventSkipped = { reason: 'no_loyalty_account_id' };
        }

        return result;
    }

    /**
     * Process a loyalty event that has an order_id
     * @private
     */
    async _processLoyaltyEventWithOrder(orderId, loyaltyAccountId, merchantId, result) {
        // Check if we've already processed this order for loyalty
        const alreadyProcessed = await loyaltyService.isOrderAlreadyProcessedForLoyalty(orderId, merchantId);

        if (alreadyProcessed) {
            logger.info('Loyalty event skipped - order already processed', { orderId, merchantId });
            result.loyaltyEventSkipped = { orderId, reason: 'already_processed' };
            return;
        }

        logger.info('Loyalty event for unprocessed order - attempting to process', {
            orderId,
            loyaltyAccountId,
            merchantId
        });

        const accessToken = await loyaltyService.getSquareAccessToken(merchantId);
        if (!accessToken) {
            return;
        }

        // Fetch the loyalty account to get customer_id
        const accountResponse = await fetch(
            `https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                }
            }
        );

        if (!accountResponse.ok) {
            return;
        }

        const accountData = await accountResponse.json();
        const customerId = accountData.loyalty_account?.customer_id;

        if (!customerId) {
            return;
        }

        // Fetch the order
        const orderResponse = await fetch(
            `https://connect.squareup.com/v2/orders/${orderId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                }
            }
        );

        if (!orderResponse.ok) {
            return;
        }

        const orderData = await orderResponse.json();
        const order = orderData.order;

        if (!order || order.state !== 'COMPLETED') {
            return;
        }

        // Process with the customer_id we got from loyalty account
        // Override the order's customer_id if it's missing
        const effectiveOrder = {
            ...order,
            customer_id: order.customer_id || customerId
        };

        const loyaltyResult = await loyaltyService.processOrderForLoyalty(
            effectiveOrder,
            merchantId,
            { customerSourceOverride: 'loyalty_api' }
        );

        if (loyaltyResult.processed) {
            result.loyaltyEventRecovery = {
                orderId,
                customerId,
                purchasesRecorded: loyaltyResult.purchasesRecorded.length
            };
            logger.info('Successfully processed order via loyalty event webhook', {
                orderId,
                customerId,
                purchaseCount: loyaltyResult.purchasesRecorded.length,
                merchantId
            });
        }
    }

    /**
     * Process a loyalty event without order_id using reverse lookup
     * @private
     */
    async _processLoyaltyEventReverseLookup(loyaltyAccountId, eventType, merchantId, result) {
        logger.info('Loyalty event without order_id - doing reverse lookup', {
            loyaltyAccountId,
            eventType
        });

        const accessToken = await loyaltyService.getSquareAccessToken(merchantId);
        if (!accessToken) {
            return;
        }

        const accountResponse = await fetch(
            `https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Square-Version': SQUARE_API_VERSION
                }
            }
        );

        if (!accountResponse.ok) {
            return;
        }

        const accountData = await accountResponse.json();
        const customerId = accountData.loyalty_account?.customer_id;

        if (!customerId) {
            return;
        }

        const catchupResult = await loyaltyService.runLoyaltyCatchup({
            merchantId,
            customerIds: [customerId],
            periodDays: 1, // 24 hours - loyalty events happen same-day
            maxCustomers: 1
        });

        if (catchupResult.ordersNewlyTracked > 0) {
            logger.info('Loyalty catchup found untracked orders via event webhook', {
                customerId,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            });
            result.loyaltyCatchup = {
                customerId,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            };
        }
    }

    /**
     * Handle loyalty.account.updated event
     * Does a reverse lookup to catch any recent orders that Square internally linked
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with catchup details
     */
    async handleLoyaltyAccountUpdated(context) {
        return this._handleLoyaltyAccountChange(context);
    }

    /**
     * Handle loyalty.account.created event
     * Does a reverse lookup to catch any recent orders that Square internally linked
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with catchup details
     */
    async handleLoyaltyAccountCreated(context) {
        return this._handleLoyaltyAccountChange(context);
    }

    /**
     * Internal handler for loyalty account create/update events
     * @private
     */
    async _handleLoyaltyAccountChange(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (!merchantId) {
            logger.debug('Loyalty account webhook - merchant not found, skipping');
            return result;
        }

        // Square webhook structure: event.data.object.loyalty_account
        const loyaltyAccount = data.loyalty_account;

        if (!loyaltyAccount) {
            logger.warn('Loyalty account webhook missing loyalty_account in payload', {
                dataKeys: Object.keys(data),
                merchantId
            });
            return result;
        }

        const customerId = loyaltyAccount.customer_id;

        if (!customerId) {
            return result;
        }

        logger.info('Loyalty account updated - checking for untracked orders', {
            loyaltyAccountId: loyaltyAccount.id,
            customerId,
            merchantId
        });

        // Do a reverse lookup for this specific customer's recent orders
        // This catches orders that Square internally linked via payment -> loyalty
        const catchupResult = await loyaltyService.runLoyaltyCatchup({
            merchantId,
            customerIds: [customerId],
            periodDays: 1, // 24 hours - loyalty events happen same-day
            maxCustomers: 1
        });

        if (catchupResult.ordersNewlyTracked > 0) {
            logger.info('Loyalty catchup found untracked orders via account webhook', {
                customerId,
                ordersFound: catchupResult.ordersFound,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            });
            result.loyaltyCatchup = {
                customerId,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            };
        }

        return result;
    }

    /**
     * Handle loyalty.program.updated event
     * Just acknowledges the event without specific processing
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with acknowledged flag
     */
    async handleLoyaltyProgramUpdated(context) {
        logger.debug('Webhook event acknowledged but not processed', {
            type: 'loyalty.program.updated'
        });
        return { handled: true, acknowledged: true };
    }

    /**
     * Handle gift_card.customer_linked event
     * Catches up any purchases made with the gift card that can now be attributed
     *
     * @param {Object} context - Webhook context
     * @returns {Promise<Object>} Result with catchup details
     */
    async handleGiftCardCustomerLinked(context) {
        const { data, merchantId } = context;
        const result = { handled: true };

        if (!merchantId) {
            logger.debug('Gift card webhook - merchant not found, skipping');
            return result;
        }

        const giftCardData = data;
        const customerId = giftCardData.customer_id;

        if (!customerId) {
            return result;
        }

        logger.info('Gift card linked to customer - checking for untracked orders', {
            giftCardId: giftCardData.id,
            customerId,
            merchantId
        });

        // Do a reverse lookup - any orders paid with this gift card
        // should now be attributable to this customer
        const catchupResult = await loyaltyService.runLoyaltyCatchup({
            merchantId,
            customerIds: [customerId],
            periodDays: 7, // 1 week for gift cards (may be used before linking)
            maxCustomers: 1
        });

        if (catchupResult.ordersNewlyTracked > 0) {
            logger.info('Loyalty catchup found untracked orders via gift_card.customer_linked', {
                customerId,
                giftCardId: giftCardData.id,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            });
            result.loyaltyCatchup = {
                customerId,
                giftCardId: giftCardData.id,
                ordersNewlyTracked: catchupResult.ordersNewlyTracked
            };
        }

        return result;
    }
}

module.exports = LoyaltyHandler;
