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

/**
 * POST /api/webhooks/square
 *
 * Receives Square webhook events and processes them.
 *
 * Flow:
 * 1. Verify HMAC-SHA256 signature
 * 2. Check for duplicate events (idempotency)
 * 3. Log event to database
 * 4. Resolve merchant
 * 5. Route to appropriate handler
 * 6. Update event status
 * 7. Return response
 *
 * Security:
 * - Signature verification required in production
 * - SQUARE_WEBHOOK_SIGNATURE_KEY must be configured
 * - SQUARE_WEBHOOK_URL must match exactly what's registered with Square
 */
router.post('/square', async (req, res) => {
    await webhookProcessor.processWebhook(req, res);
});

module.exports = router;
