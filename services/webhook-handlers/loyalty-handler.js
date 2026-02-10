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
const { FEATURE_FLAGS } = require('../../config/constants');

// Modern loyalty service (feature-flagged)
const { LoyaltyWebhookService } = require('../loyalty');
const { LoyaltySquareClient } = require('../loyalty/square-client');

/**
 * Process order for loyalty using either modern or legacy service
 * Feature flag: USE_NEW_LOYALTY_SERVICE
 *
 * @param {Object} order - Square order object
 * @param {number} merchantId - Internal merchant ID
 * @param {Object} [options] - Processing options
 * @param {string} [options.source] - Source of event
 * @returns {Promise<Object>} Normalized result compatible with legacy format
 */
async function processOrderForLoyalty(order, merchantId, options = {}) {
    const { source = 'LOYALTY_WEBHOOK' } = options;

    if (FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE) {
        logger.debug('Using modern loyalty service for order processing', {
            orderId: order.id,
            merchantId,
            source
        });

        const service = new LoyaltyWebhookService(merchantId);
        await service.initialize();
        const result = await service.processOrder(order, { source });

        // Adapt modern result to legacy format
        return {
            processed: result.processed,
            customerId: result.customerId || null,
            purchasesRecorded: (result.lineItemResults || [])
                .filter(r => r.recorded)
                .map(r => ({
                    variationId: r.variationId,
                    quantity: r.quantity,
                    rewardEarned: r.rewardEarned || false
                })),
            _modern: true,
            _trace: result.trace
        };
    }

    // Use legacy service (default)
    return loyaltyService.processOrderForLoyalty(order, merchantId, options);
}

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
            await this._processLoyaltyEventWithOrder(orderId, loyaltyAccountId, merchantId, result, loyaltyEvent.type);
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
     * @param {string} orderId - Square order ID
     * @param {string} loyaltyAccountId - Square loyalty account ID
     * @param {number} merchantId - Internal merchant ID
     * @param {Object} result - Result object to populate
     * @param {string} eventType - Type of loyalty event (e.g., 'ACCUMULATE_POINTS', 'REDEEM_REWARD')
     */
    async _processLoyaltyEventWithOrder(orderId, loyaltyAccountId, merchantId, result, eventType) {
        // REDEEM_REWARD events should ALWAYS be processed for tracking
        // even if we already recorded purchases for this order
        if (eventType === 'REDEEM_REWARD') {
            logger.info('Processing REDEEM_REWARD event', {
                orderId,
                loyaltyAccountId,
                merchantId
            });
            await this._processRedemptionEvent(orderId, loyaltyAccountId, merchantId, result);
            return;
        }

        // For ACCUMULATE_POINTS and other events, check if already processed
        const alreadyProcessed = await loyaltyService.isOrderAlreadyProcessedForLoyalty(orderId, merchantId);

        if (alreadyProcessed) {
            logger.info('Loyalty event skipped - order already processed', {
                orderId,
                merchantId,
                eventType
            });
            result.loyaltyEventSkipped = { orderId, reason: 'already_processed', eventType };
            return;
        }

        logger.info('Loyalty event for unprocessed order - attempting to process', {
            orderId,
            loyaltyAccountId,
            merchantId
        });

        // Use LoyaltySquareClient with built-in retry logic for rate limiting
        let squareClient;
        try {
            squareClient = new LoyaltySquareClient(merchantId);
            await squareClient.initialize();
        } catch (initError) {
            logger.error('Failed to initialize Square client for loyalty webhook', {
                error: initError.message,
                merchantId
            });
            return;
        }

        // Fetch the loyalty account to get customer_id
        let loyaltyAccount;
        try {
            loyaltyAccount = await squareClient.getLoyaltyAccount(loyaltyAccountId);
        } catch (accountError) {
            logger.error('Failed to fetch loyalty account', {
                action: 'LOYALTY_ACCOUNT_FETCH_FAILED',
                loyaltyAccountId,
                error: accountError.message,
                merchantId
            });
            return;
        }

        const customerId = loyaltyAccount?.customer_id;
        if (!customerId) {
            return;
        }

        // Fetch the order
        let order;
        try {
            order = await squareClient.getOrder(orderId);
        } catch (orderError) {
            logger.error('Failed to fetch order for loyalty processing', {
                action: 'ORDER_FETCH_FAILED',
                orderId,
                error: orderError.message,
                merchantId
            });
            return;
        }

        if (!order || order.state !== 'COMPLETED') {
            return;
        }

        // Process with the customer_id we got from loyalty account
        // Override the order's customer_id if it's missing
        const effectiveOrder = {
            ...order,
            customer_id: order.customer_id || customerId
        };

        const loyaltyResult = await processOrderForLoyalty(
            effectiveOrder,
            merchantId,
            { source: 'LOYALTY_EVENT', customerSourceOverride: 'loyalty_api' }
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

        // Use LoyaltySquareClient with built-in retry logic for rate limiting
        let squareClient;
        try {
            squareClient = new LoyaltySquareClient(merchantId);
            await squareClient.initialize();
        } catch (initError) {
            logger.error('Failed to initialize Square client for reverse lookup', {
                error: initError.message,
                merchantId
            });
            return;
        }

        let loyaltyAccount;
        try {
            loyaltyAccount = await squareClient.getLoyaltyAccount(loyaltyAccountId);
        } catch (accountError) {
            logger.error('Failed to fetch loyalty account for reverse lookup', {
                action: 'LOYALTY_ACCOUNT_FETCH_FAILED',
                loyaltyAccountId,
                error: accountError.message,
                merchantId
            });
            return;
        }

        const customerId = loyaltyAccount?.customer_id;
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
     * Process a REDEEM_REWARD event
     * This handles reward redemption tracking separately from purchase accrual
     * @private
     */
    async _processRedemptionEvent(orderId, loyaltyAccountId, merchantId, result) {
        // Use LoyaltySquareClient with built-in retry logic for rate limiting
        let squareClient;
        try {
            squareClient = new LoyaltySquareClient(merchantId);
            await squareClient.initialize();
        } catch (initError) {
            logger.error('Failed to initialize Square client for redemption event', {
                error: initError.message,
                merchantId
            });
            return;
        }

        // Fetch the order to detect the redemption
        let order;
        try {
            order = await squareClient.getOrder(orderId);
        } catch (orderError) {
            logger.error('Failed to fetch order for redemption processing', {
                action: 'ORDER_FETCH_FAILED',
                orderId,
                error: orderError.message,
                merchantId
            });
            return;
        }

        if (!order) {
            logger.warn('Order not found for REDEEM_REWARD event', {
                orderId,
                loyaltyAccountId,
                merchantId
            });
            return;
        }

        // Use the existing detectRewardRedemptionFromOrder to find and mark the reward as redeemed
        const redemptionResult = await loyaltyService.detectRewardRedemptionFromOrder(order, merchantId);

        if (redemptionResult.detected) {
            result.loyaltyRedemption = {
                orderId,
                rewardId: redemptionResult.rewardId,
                offerName: redemptionResult.offerName,
                source: 'REDEEM_REWARD_WEBHOOK'
            };
            logger.info('Reward redemption processed via REDEEM_REWARD webhook', {
                orderId,
                rewardId: redemptionResult.rewardId,
                offerName: redemptionResult.offerName,
                merchantId
            });
        } else {
            // Log that we received REDEEM_REWARD but couldn't find a matching reward
            // This is expected for Square-native loyalty redemptions (not our custom system)
            logger.info('REDEEM_REWARD is a Square-native loyalty redemption (not our custom system)', {
                orderId,
                loyaltyAccountId,
                merchantId,
                discountsInOrder: order.discounts?.length || 0
            });
            result.loyaltyRedemptionNotFound = {
                orderId,
                loyaltyAccountId,
                reason: 'square_native_redemption'
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
