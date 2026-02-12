/**
 * Square Webhook Subscription Management
 * Handles programmatic registration, listing, and management of Square webhook subscriptions
 */

const db = require('./database');
const logger = require('./logger');
const { decryptToken, isEncryptedToken } = require('./token-encryption');

// Square API configuration
const SQUARE_API_VERSION = '2025-01-16';
const SQUARE_BASE_URL = 'https://connect.squareup.com';

/**
 * All supported webhook event types for this application
 * Organized by category for easier management
 */
const WEBHOOK_EVENT_TYPES = {
    // Core features - Essential for app functionality
    essential: [
        'order.created',              // New orders, delivery ingestion, loyalty tracking
        'order.updated',              // Order changes, delivery updates, loyalty tracking
        'order.fulfillment.updated',  // Delivery status sync, sales velocity
        'catalog.version.updated',    // Catalog sync (items, prices, variations)
        'inventory.count.updated',    // Real-time inventory updates
        'oauth.authorization.revoked' // Security - app disconnection handling
    ],

    // Loyalty features
    loyalty: [
        'loyalty.event.created',      // Catches orders linked via loyalty card scan
        'loyalty.account.created',    // New loyalty account - catchup for customer's orders
        'loyalty.account.updated',    // Loyalty account changed - catchup for customer's orders
        'payment.created',            // Payment tracking for loyalty
        'payment.updated',            // Payment completion for loyalty processing
        'customer.created',           // New customer - catchup + seniors birthday check (BACKLOG-11)
        'customer.updated',           // Customer info changed - catchup + seniors birthday check
        'gift_card.customer_linked'   // Gift card linked - catchup for gift card purchases
    ],

    // Refund handling
    refunds: [
        'refund.created',             // Refund processing for loyalty adjustments
        'refund.updated'              // Refund status changes
    ],

    // Vendor management
    vendors: [
        'vendor.created',             // New vendors
        'vendor.updated'              // Vendor changes
    ],

    // Location management
    locations: [
        'location.created',           // New locations
        'location.updated'            // Location changes
    ],

    // Subscription management (if using paid subscriptions)
    subscriptions: [
        'subscription.created',
        'subscription.updated',
        'invoice.payment_made',
        'invoice.payment_failed',
        'customer.deleted'
    ]
};

/**
 * Get all webhook event types as a flat array
 * @returns {string[]} All event types
 */
function getAllEventTypes() {
    return Object.values(WEBHOOK_EVENT_TYPES).flat();
}

/**
 * Get recommended event types for standard installations
 * @returns {string[]} Recommended event types
 */
function getRecommendedEventTypes() {
    return [
        ...WEBHOOK_EVENT_TYPES.essential,
        ...WEBHOOK_EVENT_TYPES.loyalty,
        ...WEBHOOK_EVENT_TYPES.refunds,
        ...WEBHOOK_EVENT_TYPES.vendors,
        ...WEBHOOK_EVENT_TYPES.locations
    ];
}

/**
 * Get decrypted access token for a merchant
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<string>} Decrypted access token
 */
async function getMerchantToken(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }

    const result = await db.query(
        'SELECT square_access_token FROM merchants WHERE id = $1 AND is_active = TRUE',
        [merchantId]
    );

    if (result.rows.length === 0) {
        throw new Error(`Merchant ${merchantId} not found or inactive`);
    }

    const token = result.rows[0].square_access_token;

    if (!token) {
        throw new Error(`Merchant ${merchantId} has no access token configured`);
    }

    if (!isEncryptedToken(token)) {
        return token;
    }

    return decryptToken(token);
}

/**
 * Make a Square API request
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options
 * @param {string} accessToken - Square access token
 * @returns {Promise<Object>} Response data
 */
async function makeSquareRequest(endpoint, options, accessToken) {
    const url = `${SQUARE_BASE_URL}${endpoint}`;
    const headers = {
        'Square-Version': SQUARE_API_VERSION,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
    };

    const response = await fetch(url, {
        ...options,
        headers
    });

    const data = await response.json();

    if (!response.ok) {
        const error = new Error(data.errors?.[0]?.detail || 'Square API error');
        error.status = response.status;
        error.errors = data.errors;
        throw error;
    }

    return data;
}

/**
 * List all webhook subscriptions for a merchant
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object[]>} List of webhook subscriptions
 */
async function listWebhookSubscriptions(merchantId) {
    const accessToken = await getMerchantToken(merchantId);

    try {
        const data = await makeSquareRequest('/v2/webhooks/subscriptions', {
            method: 'GET'
        }, accessToken);

        logger.info('Listed webhook subscriptions', {
            merchantId,
            count: data.subscriptions?.length || 0
        });

        return data.subscriptions || [];
    } catch (error) {
        logger.error('Failed to list webhook subscriptions', { merchantId, error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Get a specific webhook subscription by ID
 * @param {number} merchantId - The merchant ID
 * @param {string} subscriptionId - The webhook subscription ID
 * @returns {Promise<Object>} Webhook subscription details
 */
async function getWebhookSubscription(merchantId, subscriptionId) {
    const accessToken = await getMerchantToken(merchantId);

    try {
        const data = await makeSquareRequest(`/v2/webhooks/subscriptions/${subscriptionId}`, {
            method: 'GET'
        }, accessToken);

        return data.subscription;
    } catch (error) {
        logger.error('Failed to get webhook subscription', {
            merchantId,
            subscriptionId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Create a new webhook subscription
 * @param {number} merchantId - The merchant ID
 * @param {Object} options - Subscription options
 * @param {string} options.notificationUrl - The webhook notification URL
 * @param {string[]} [options.eventTypes] - Event types to subscribe to (defaults to recommended)
 * @param {string} [options.name] - Friendly name for the subscription
 * @param {string} [options.apiVersion] - Square API version (defaults to current)
 * @returns {Promise<Object>} Created subscription
 */
async function createWebhookSubscription(merchantId, options) {
    const accessToken = await getMerchantToken(merchantId);

    const {
        notificationUrl,
        eventTypes = getRecommendedEventTypes(),
        name = 'Square Dashboard Addon Webhooks',
        apiVersion = SQUARE_API_VERSION
    } = options;

    if (!notificationUrl) {
        throw new Error('notificationUrl is required');
    }

    // Validate URL format
    try {
        new URL(notificationUrl);
    } catch {
        throw new Error('notificationUrl must be a valid URL');
    }

    const idempotencyKey = `webhook-create-${merchantId}-${Date.now()}`;

    try {
        const data = await makeSquareRequest('/v2/webhooks/subscriptions', {
            method: 'POST',
            body: JSON.stringify({
                idempotency_key: idempotencyKey,
                subscription: {
                    name,
                    enabled: true,
                    event_types: eventTypes,
                    notification_url: notificationUrl,
                    api_version: apiVersion
                }
            })
        }, accessToken);

        logger.info('Created webhook subscription', {
            merchantId,
            subscriptionId: data.subscription?.id,
            eventTypes: eventTypes.length,
            notificationUrl
        });

        return data.subscription;
    } catch (error) {
        logger.error('Failed to create webhook subscription', {
            merchantId,
            notificationUrl,
            error: error.message
        });
        throw error;
    }
}

/**
 * Update an existing webhook subscription
 * @param {number} merchantId - The merchant ID
 * @param {string} subscriptionId - The webhook subscription ID
 * @param {Object} updates - Fields to update
 * @param {boolean} [updates.enabled] - Enable/disable the subscription
 * @param {string[]} [updates.eventTypes] - Updated event types
 * @param {string} [updates.notificationUrl] - Updated notification URL
 * @param {string} [updates.name] - Updated name
 * @returns {Promise<Object>} Updated subscription
 */
async function updateWebhookSubscription(merchantId, subscriptionId, updates) {
    const accessToken = await getMerchantToken(merchantId);

    const subscription = {};

    if (updates.enabled !== undefined) {
        subscription.enabled = updates.enabled;
    }
    if (updates.eventTypes) {
        subscription.event_types = updates.eventTypes;
    }
    if (updates.notificationUrl) {
        subscription.notification_url = updates.notificationUrl;
    }
    if (updates.name) {
        subscription.name = updates.name;
    }

    try {
        const data = await makeSquareRequest(`/v2/webhooks/subscriptions/${subscriptionId}`, {
            method: 'PUT',
            body: JSON.stringify({ subscription })
        }, accessToken);

        logger.info('Updated webhook subscription', {
            merchantId,
            subscriptionId,
            updates: Object.keys(updates)
        });

        return data.subscription;
    } catch (error) {
        logger.error('Failed to update webhook subscription', {
            merchantId,
            subscriptionId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Delete a webhook subscription
 * @param {number} merchantId - The merchant ID
 * @param {string} subscriptionId - The webhook subscription ID
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteWebhookSubscription(merchantId, subscriptionId) {
    const accessToken = await getMerchantToken(merchantId);

    try {
        await makeSquareRequest(`/v2/webhooks/subscriptions/${subscriptionId}`, {
            method: 'DELETE'
        }, accessToken);

        logger.info('Deleted webhook subscription', {
            merchantId,
            subscriptionId
        });

        return true;
    } catch (error) {
        logger.error('Failed to delete webhook subscription', {
            merchantId,
            subscriptionId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Test a webhook subscription by sending a test event
 * @param {number} merchantId - The merchant ID
 * @param {string} subscriptionId - The webhook subscription ID
 * @returns {Promise<Object>} Test result
 */
async function testWebhookSubscription(merchantId, subscriptionId) {
    const accessToken = await getMerchantToken(merchantId);

    try {
        const data = await makeSquareRequest(`/v2/webhooks/subscriptions/${subscriptionId}/test`, {
            method: 'POST',
            body: JSON.stringify({})
        }, accessToken);

        logger.info('Tested webhook subscription', {
            merchantId,
            subscriptionId,
            success: !data.errors
        });

        return data;
    } catch (error) {
        logger.error('Failed to test webhook subscription', {
            merchantId,
            subscriptionId,
            error: error.message
        });
        throw error;
    }
}

/**
 * Get or create webhook subscription for a merchant
 * Creates a new subscription if none exists, or returns existing one
 * @param {number} merchantId - The merchant ID
 * @param {string} notificationUrl - The webhook notification URL
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object>} Webhook subscription
 */
async function ensureWebhookSubscription(merchantId, notificationUrl, options = {}) {
    // First, check if a subscription already exists for this URL
    const existing = await listWebhookSubscriptions(merchantId);

    const matchingSubscription = existing.find(sub =>
        sub.notification_url === notificationUrl
    );

    if (matchingSubscription) {
        logger.info('Found existing webhook subscription', {
            merchantId,
            subscriptionId: matchingSubscription.id,
            notificationUrl
        });

        // Optionally update event types if provided
        if (options.eventTypes && options.updateIfExists) {
            const currentTypes = new Set(matchingSubscription.event_types || []);
            const newTypes = new Set(options.eventTypes);

            // Check if we need to update
            const needsUpdate = options.eventTypes.some(t => !currentTypes.has(t)) ||
                                (matchingSubscription.event_types || []).some(t => !newTypes.has(t));

            if (needsUpdate) {
                return updateWebhookSubscription(merchantId, matchingSubscription.id, {
                    eventTypes: options.eventTypes
                });
            }
        }

        return matchingSubscription;
    }

    // Create new subscription
    return createWebhookSubscription(merchantId, {
        notificationUrl,
        eventTypes: options.eventTypes,
        name: options.name
    });
}

/**
 * Get the signature key for a webhook subscription
 * Note: This must be retrieved from Square Developer Dashboard
 * @param {number} merchantId - The merchant ID
 * @param {string} subscriptionId - The webhook subscription ID
 * @returns {Promise<string>} Signature key (from environment)
 */
async function getSignatureKey(merchantId, subscriptionId) {
    // Signature keys are per-subscription and must be copied from Square Dashboard
    // We return the configured key from environment
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

    if (!key) {
        throw new Error('SQUARE_WEBHOOK_SIGNATURE_KEY not configured');
    }

    return key;
}

/**
 * Audit current webhook configuration against required event types
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object>} Audit results
 */
async function auditWebhookConfiguration(merchantId) {
    const subscriptions = await listWebhookSubscriptions(merchantId);
    const recommendedTypes = getRecommendedEventTypes();

    // Collect all subscribed event types
    const subscribedTypes = new Set();
    for (const sub of subscriptions) {
        for (const eventType of sub.event_types || []) {
            subscribedTypes.add(eventType);
        }
    }

    // Find missing and extra types
    const missingTypes = recommendedTypes.filter(t => !subscribedTypes.has(t));
    const extraTypes = [...subscribedTypes].filter(t => !recommendedTypes.includes(t));

    const result = {
        subscriptionCount: subscriptions.length,
        subscriptions: subscriptions.map(s => ({
            id: s.id,
            name: s.name,
            enabled: s.enabled,
            notificationUrl: s.notification_url,
            eventTypeCount: s.event_types?.length || 0
        })),
        recommendedTypeCount: recommendedTypes.length,
        subscribedTypeCount: subscribedTypes.size,
        missingTypes,
        extraTypes,
        isComplete: missingTypes.length === 0,
        hasActiveSubscription: subscriptions.some(s => s.enabled)
    };

    logger.info('Webhook configuration audit completed', {
        merchantId,
        isComplete: result.isComplete,
        missingCount: missingTypes.length
    });

    return result;
}

module.exports = {
    // Event type helpers
    WEBHOOK_EVENT_TYPES,
    getAllEventTypes,
    getRecommendedEventTypes,

    // Subscription management
    listWebhookSubscriptions,
    getWebhookSubscription,
    createWebhookSubscription,
    updateWebhookSubscription,
    deleteWebhookSubscription,
    testWebhookSubscription,
    ensureWebhookSubscription,

    // Utilities
    getSignatureKey,
    auditWebhookConfiguration
};
