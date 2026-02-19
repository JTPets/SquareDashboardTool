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
 *   data,             // event.data?.object || {} (wrapper contents)
 *   entityId,         // event.data?.id - Canonical entity ID (order ID, customer ID, etc.)
 *   entityType,       // event.data?.type - Entity type (order, customer, etc.)
 *   merchantId,       // Internal merchant ID (resolved)
 *   squareMerchantId, // Square's merchant ID
 *   webhookEventId,   // ID from webhook_events table
 *   startTime         // For duration tracking
 * }
 *
 * IMPORTANT: Square places entity IDs at event.data.id, NOT inside event.data.object.
 * Always use context.entityId for the canonical ID rather than searching in context.data.
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
const CustomerHandler = require('./customer-handler');

// Import shared dependencies
const syncQueue = require('../sync-queue');

// Initialize handlers with dependencies
const subscriptionHandler = new SubscriptionHandler();
const oauthHandler = new OAuthHandler();
const catalogHandler = new CatalogHandler(syncQueue);
const inventoryHandler = new InventoryHandler(syncQueue);
const orderHandler = new OrderHandler();
const loyaltyHandler = new LoyaltyHandler();
const customerHandler = new CustomerHandler();

/**
 * Fan-out handler: calls multiple handlers for a single event type.
 * Uses Promise.allSettled so a failure in one handler does not block the other.
 * Merges results and logs individual failures without throwing.
 *
 * @param {Object} ctx - Webhook context
 * @param {Array<{name: string, fn: Function}>} handlerList - Handlers to invoke
 * @returns {Promise<Object>} Merged result with per-handler details
 */
async function fanOut(ctx, handlerList) {
    const outcomes = await Promise.allSettled(
        handlerList.map(h => h.fn(ctx))
    );

    const merged = { handled: true, handlers: {} };
    for (let i = 0; i < handlerList.length; i++) {
        const { name } = handlerList[i];
        const outcome = outcomes[i];
        if (outcome.status === 'fulfilled') {
            merged.handlers[name] = outcome.value;
        } else {
            merged.handlers[name] = { error: outcome.reason?.message || 'Unknown error' };
            logger.error('Fan-out handler failed', {
                eventType: ctx.event?.type,
                handler: name,
                merchantId: ctx.merchantId,
                error: outcome.reason?.message,
                stack: outcome.reason?.stack
            });
        }
    }
    return merged;
}

/**
 * Handler registry mapping event types to handler methods.
 * Each entry maps an event type string to an async handler function.
 */
const handlers = {
    // Subscription events
    'subscription.created': (ctx) => subscriptionHandler.handleCreated(ctx),
    'subscription.updated': (ctx) => subscriptionHandler.handleUpdated(ctx),
    // invoice.payment_made triggers BOTH subscription payment recording AND
    // committed inventory cleanup (RESERVED_FOR_SALE removal).
    // Without the inventory handler, COMMITTED stock stays stuck until the 4 AM reconciliation.
    'invoice.payment_made': (ctx) => fanOut(ctx, [
        { name: 'subscription', fn: (c) => subscriptionHandler.handleInvoicePaymentMade(c) },
        { name: 'inventory',    fn: (c) => inventoryHandler.handleInvoiceChanged(c) }
    ]),
    'invoice.payment_failed': (ctx) => subscriptionHandler.handleInvoicePaymentFailed(ctx),

    // Customer events
    'customer.deleted': (ctx) => subscriptionHandler.handleCustomerDeleted(ctx),
    'customer.created': (ctx) => customerHandler.handleCustomerChange(ctx),
    'customer.updated': (ctx) => customerHandler.handleCustomerChange(ctx),

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

    // Invoice events (BACKLOG-10: committed inventory tracking)
    'invoice.created': (ctx) => inventoryHandler.handleInvoiceChanged(ctx),
    'invoice.updated': (ctx) => inventoryHandler.handleInvoiceChanged(ctx),
    'invoice.published': (ctx) => inventoryHandler.handleInvoiceChanged(ctx),
    'invoice.canceled': (ctx) => inventoryHandler.handleInvoiceClosed(ctx),
    'invoice.deleted': (ctx) => inventoryHandler.handleInvoiceClosed(ctx),
    'invoice.refunded': (ctx) => inventoryHandler.handleInvoiceChanged(ctx),
    'invoice.scheduled_charge_failed': (ctx) => inventoryHandler.handleInvoiceChanged(ctx),

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
    loyaltyHandler,
    customerHandler
};
