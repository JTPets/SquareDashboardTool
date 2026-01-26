/**
 * Webhook Management Routes
 *
 * Handles webhook subscription CRUD operations:
 * - List, create, update, delete webhook subscriptions
 * - Audit webhook configuration
 * - Send test webhook events
 *
 * NOTE: The main webhook processor (POST /api/webhooks/square)
 * remains in server.js for now and will be refactored to use
 * a service layer in a future iteration.
 *
 * Endpoints:
 * - GET    /api/webhooks/subscriptions           - List subscriptions
 * - GET    /api/webhooks/subscriptions/audit     - Audit configuration
 * - GET    /api/webhooks/event-types             - Get available event types
 * - POST   /api/webhooks/register                - Register new subscription
 * - POST   /api/webhooks/ensure                  - Ensure subscription exists
 * - PUT    /api/webhooks/subscriptions/:id       - Update subscription
 * - DELETE /api/webhooks/subscriptions/:id       - Delete subscription
 * - POST   /api/webhooks/subscriptions/:id/test  - Send test event
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const squareWebhooks = require('../utils/square-webhooks');
const { requireAuth } = require('../middleware/auth');
const { requireMerchant } = require('../middleware/merchant');
const asyncHandler = require('../middleware/async-handler');
const validators = require('../middleware/validators/webhooks');

/**
 * GET /api/webhooks/subscriptions
 * List all webhook subscriptions for the current merchant
 */
router.get('/webhooks/subscriptions', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const subscriptions = await squareWebhooks.listWebhookSubscriptions(merchantId);

    res.json({
        success: true,
        subscriptions,
        count: subscriptions.length
    });
}));

/**
 * GET /api/webhooks/subscriptions/audit
 * Audit current webhook configuration against recommended event types
 */
router.get('/webhooks/subscriptions/audit', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const audit = await squareWebhooks.auditWebhookConfiguration(merchantId);

    res.json({
        success: true,
        ...audit
    });
}));

/**
 * GET /api/webhooks/event-types
 * Get all available webhook event types and their categories
 */
router.get('/webhooks/event-types', requireAuth, asyncHandler(async (req, res) => {
    res.json({
        success: true,
        eventTypes: squareWebhooks.WEBHOOK_EVENT_TYPES,
        all: squareWebhooks.getAllEventTypes(),
        recommended: squareWebhooks.getRecommendedEventTypes()
    });
}));

/**
 * POST /api/webhooks/register
 * Register a new webhook subscription with Square
 *
 * Body:
 * - notificationUrl: string (required) - The webhook endpoint URL
 * - eventTypes: string[] (optional) - Event types to subscribe to (defaults to recommended)
 * - name: string (optional) - Friendly name for the subscription
 */
router.post('/webhooks/register', requireAuth, requireMerchant, validators.register, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { notificationUrl, eventTypes, name } = req.body;

    const subscription = await squareWebhooks.createWebhookSubscription(merchantId, {
        notificationUrl,
        eventTypes,
        name
    });

    logger.info('Webhook subscription registered', {
        merchantId,
        subscriptionId: subscription.id,
        notificationUrl
    });

    res.json({
        success: true,
        subscription,
        message: 'Webhook subscription created successfully. Copy the signature key from Square Developer Dashboard.',
        nextSteps: [
            '1. Go to Square Developer Dashboard > Your App > Webhooks',
            '2. Find the new subscription and copy the Signature Key',
            '3. Set SQUARE_WEBHOOK_SIGNATURE_KEY in your .env file',
            '4. Restart the server to apply the new key'
        ]
    });
}));

/**
 * POST /api/webhooks/ensure
 * Ensure a webhook subscription exists (creates if missing, updates if needed)
 *
 * Body:
 * - notificationUrl: string (required) - The webhook endpoint URL
 * - eventTypes: string[] (optional) - Event types to subscribe to
 * - updateIfExists: boolean (optional) - Update event types if subscription exists
 */
router.post('/webhooks/ensure', requireAuth, requireMerchant, validators.ensure, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { notificationUrl, eventTypes, updateIfExists } = req.body;

    const subscription = await squareWebhooks.ensureWebhookSubscription(merchantId, notificationUrl, {
        eventTypes,
        updateIfExists
    });

    res.json({
        success: true,
        subscription,
        message: subscription.created_at ?
            'Webhook subscription already exists' :
            'New webhook subscription created'
    });
}));

/**
 * PUT /api/webhooks/subscriptions/:subscriptionId
 * Update an existing webhook subscription
 *
 * Body:
 * - enabled: boolean (optional) - Enable/disable the subscription
 * - eventTypes: string[] (optional) - Updated event types
 * - notificationUrl: string (optional) - Updated notification URL
 * - name: string (optional) - Updated name
 */
router.put('/webhooks/subscriptions/:subscriptionId', requireAuth, requireMerchant, validators.update, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { subscriptionId } = req.params;
    const { enabled, eventTypes, notificationUrl, name } = req.body;

    const updates = {};
    if (enabled !== undefined) updates.enabled = enabled;
    if (eventTypes) updates.eventTypes = eventTypes;
    if (notificationUrl) updates.notificationUrl = notificationUrl;
    if (name) updates.name = name;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({
            error: 'No updates provided'
        });
    }

    const subscription = await squareWebhooks.updateWebhookSubscription(
        merchantId,
        subscriptionId,
        updates
    );

    logger.info('Webhook subscription updated', {
        merchantId,
        subscriptionId,
        updates: Object.keys(updates)
    });

    res.json({
        success: true,
        subscription
    });
}));

/**
 * DELETE /api/webhooks/subscriptions/:subscriptionId
 * Delete a webhook subscription
 */
router.delete('/webhooks/subscriptions/:subscriptionId', requireAuth, requireMerchant, validators.deleteSubscription, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { subscriptionId } = req.params;

    await squareWebhooks.deleteWebhookSubscription(merchantId, subscriptionId);

    logger.info('Webhook subscription deleted', {
        merchantId,
        subscriptionId
    });

    res.json({
        success: true,
        message: 'Webhook subscription deleted successfully'
    });
}));

/**
 * POST /api/webhooks/subscriptions/:subscriptionId/test
 * Send a test webhook event
 */
router.post('/webhooks/subscriptions/:subscriptionId/test', requireAuth, requireMerchant, validators.test, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    const { subscriptionId } = req.params;

    const result = await squareWebhooks.testWebhookSubscription(merchantId, subscriptionId);

    res.json({
        success: true,
        result,
        message: 'Test webhook sent. Check your server logs for the received event.'
    });
}));

module.exports = router;
