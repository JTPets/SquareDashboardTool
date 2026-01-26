/**
 * Webhook Handler Registry
 *
 * Central registry mapping Square webhook event types to their handlers.
 * Each handler is a function that receives a context object and returns
 * a result object.
 *
 * Context object structure:
 * {
 *   event,            // Raw Square webhook event
 *   data,             // event.data?.object || {}
 *   merchantId,       // Internal merchant ID (resolved)
 *   squareMerchantId, // Square's merchant ID
 *   webhookEventId,   // ID from webhook_events table
 *   startTime         // For duration tracking
 * }
 *
 * @module services/webhook-handlers
 */

const logger = require('../../utils/logger');

// Import handlers (added as they are created)
const SubscriptionHandler = require('./subscription-handler');
const OAuthHandler = require('./oauth-handler');
const CatalogHandler = require('./catalog-handler');
const InventoryHandler = require('./inventory-handler');
const OrderHandler = require('./order-handler');
const LoyaltyHandler = require('./loyalty-handler');

// Import shared dependencies
const syncQueue = require('../sync-queue');

// Initialize handlers with dependencies
const subscriptionHandler = new SubscriptionHandler();
const oauthHandler = new OAuthHandler();
const catalogHandler = new CatalogHandler(syncQueue);
const inventoryHandler = new InventoryHandler(syncQueue);
const orderHandler = new OrderHandler();
const loyaltyHandler = new LoyaltyHandler();

/**
 * Handler registry mapping event types to handler methods.
 * Each entry maps an event type string to an async handler function.
 */
const handlers = {
    // Subscription events
    'subscription.created': (ctx) => subscriptionHandler.handleCreated(ctx),
    'subscription.updated': (ctx) => subscriptionHandler.handleUpdated(ctx),
    'invoice.payment_made': (ctx) => subscriptionHandler.handleInvoicePaymentMade(ctx),
    'invoice.payment_failed': (ctx) => subscriptionHandler.handleInvoicePaymentFailed(ctx),

    // Customer events (subscription-related)
    'customer.deleted': (ctx) => subscriptionHandler.handleCustomerDeleted(ctx),
    'customer.updated': (ctx) => catalogHandler.handleCustomerUpdated(ctx),

    // Catalog events
    'catalog.version.updated': (ctx) => catalogHandler.handleCatalogVersionUpdated(ctx),

    // Vendor events
    'vendor.created': (ctx) => catalogHandler.handleVendorCreated(ctx),
    'vendor.updated': (ctx) => catalogHandler.handleVendorUpdated(ctx),

    // Location events
    'location.created': (ctx) => catalogHandler.handleLocationCreated(ctx),
    'location.updated': (ctx) => catalogHandler.handleLocationUpdated(ctx),

    // Inventory events
    'inventory.count.updated': (ctx) => inventoryHandler.handleInventoryCountUpdated(ctx),

    // Order events
    'order.created': (ctx) => orderHandler.handleOrderCreatedOrUpdated(ctx),
    'order.updated': (ctx) => orderHandler.handleOrderCreatedOrUpdated(ctx),
    'order.fulfillment.updated': (ctx) => orderHandler.handleFulfillmentUpdated(ctx),

    // Payment events
    'payment.created': (ctx) => orderHandler.handlePaymentCreated(ctx),
    'payment.updated': (ctx) => orderHandler.handlePaymentUpdated(ctx),

    // Refund events
    'refund.created': (ctx) => orderHandler.handleRefundCreatedOrUpdated(ctx),
    'refund.updated': (ctx) => orderHandler.handleRefundCreatedOrUpdated(ctx),

    // OAuth events
    'oauth.authorization.revoked': (ctx) => oauthHandler.handleAuthorizationRevoked(ctx),

    // Loyalty events
    'loyalty.event.created': (ctx) => loyaltyHandler.handleLoyaltyEventCreated(ctx),
    'loyalty.account.updated': (ctx) => loyaltyHandler.handleLoyaltyAccountUpdated(ctx),
    'loyalty.account.created': (ctx) => loyaltyHandler.handleLoyaltyAccountCreated(ctx),
    'loyalty.program.updated': (ctx) => loyaltyHandler.handleLoyaltyProgramUpdated(ctx),

    // Gift card events
    'gift_card.customer_linked': (ctx) => loyaltyHandler.handleGiftCardCustomerLinked(ctx)
};

/**
 * Route a webhook event to its appropriate handler.
 *
 * @param {string} eventType - The Square event type (e.g., 'order.created')
 * @param {Object} context - The handler context object
 * @returns {Promise<{handled: boolean, result?: any, reason?: string}>}
 */
async function routeEvent(eventType, context) {
    const handler = handlers[eventType];

    if (!handler) {
        logger.debug('No handler registered for event type', { eventType });
        return { handled: false, reason: 'unhandled_event_type' };
    }

    try {
        const result = await handler(context);
        return { handled: true, result };
    } catch (error) {
        logger.error('Webhook handler error', {
            eventType,
            merchantId: context.merchantId,
            error: error.message,
            stack: error.stack
        });
        throw error; // Re-throw to let webhook processor handle it
    }
}

/**
 * Check if a handler exists for an event type.
 *
 * @param {string} eventType - The Square event type
 * @returns {boolean}
 */
function hasHandler(eventType) {
    return eventType in handlers;
}

/**
 * Get list of all registered event types.
 *
 * @returns {string[]}
 */
function getRegisteredEventTypes() {
    return Object.keys(handlers);
}

module.exports = {
    routeEvent,
    hasHandler,
    getRegisteredEventTypes,
    handlers,

    // Export handler instances for testing
    subscriptionHandler,
    oauthHandler,
    catalogHandler,
    inventoryHandler,
    orderHandler,
    loyaltyHandler
};
