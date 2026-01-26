/**
 * Square Webhook Route
 *
 * Thin route layer that delegates to webhook-processor service.
 * Handles POST /api/webhooks/square endpoint.
 *
 * @module routes/webhooks/square
 */

const express = require('express');
const router = express.Router();
const webhookProcessor = require('../../services/webhook-processor');
const { configureWebhookRateLimit } = require('../../middleware/security');

// P1-8: Apply rate limiting to webhook endpoint
const webhookRateLimit = configureWebhookRateLimit();

/**
 * POST /api/webhooks/square
 *
 * Receives Square webhook events and processes them.
 *
 * Flow:
 * 1. Rate limit check (P1-8)
 * 2. Verify HMAC-SHA256 signature
 * 3. Check for duplicate events (idempotency)
 * 4. Log event to database
 * 5. Resolve merchant
 * 6. Route to appropriate handler
 * 7. Update event status
 * 8. Return response
 *
 * Security:
 * - Rate limiting: 100 requests/minute per merchant (P1-8)
 * - Signature verification required in production
 * - SQUARE_WEBHOOK_SIGNATURE_KEY must be configured
 * - SQUARE_WEBHOOK_URL must match exactly what's registered with Square
 */
router.post('/square', webhookRateLimit, async (req, res) => {
    await webhookProcessor.processWebhook(req, res);
});

module.exports = router;
