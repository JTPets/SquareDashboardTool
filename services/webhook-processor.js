/**
 * Webhook Processor
 *
 * Main orchestration service for Square webhook processing.
 * Handles signature verification, idempotency, merchant resolution,
 * and event routing to appropriate handlers.
 *
 * @module services/webhook-processor
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const db = require('../utils/database');
const subscriptionHandler = require('../utils/subscription-handler');
const webhookRetry = require('../utils/webhook-retry');
const { routeEvent } = require('./webhook-handlers');

class WebhookProcessor {
    /**
     * Verify Square HMAC-SHA256 signature using timing-safe comparison
     *
     * @param {string} signature - The signature from x-square-hmacsha256-signature header
     * @param {string} rawBody - The raw request body
     * @param {string} notificationUrl - The webhook URL registered with Square
     * @param {string} signatureKey - The webhook signature key from Square
     * @returns {boolean} Whether the signature is valid
     */
    verifySignature(signature, rawBody, notificationUrl, signatureKey) {
        if (!signature || typeof signature !== 'string') {
            return false;
        }

        const hmac = crypto.createHmac('sha256', signatureKey);
        hmac.update(notificationUrl + rawBody);
        const expectedSignature = hmac.digest('base64');

        // Use timing-safe comparison to prevent timing attacks
        const signatureBuffer = Buffer.from(signature, 'utf8');
        const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

        // timingSafeEqual throws if lengths differ, so check first
        if (signatureBuffer.length !== expectedBuffer.length) {
            return false;
        }

        return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    }

    /**
     * Check if an event has already been processed (idempotency)
     *
     * @param {string} eventId - The Square event ID
     * @returns {Promise<boolean>} Whether the event is a duplicate
     */
    async isDuplicateEvent(eventId) {
        if (!eventId) {
            return false;
        }
        const existing = await db.query(
            'SELECT id FROM webhook_events WHERE square_event_id = $1',
            [eventId]
        );
        return existing.rows.length > 0;
    }

    /**
     * Log incoming event to webhook_events table
     *
     * @param {Object} event - The Square webhook event
     * @returns {Promise<number|null>} The webhook event ID or null
     */
    async logEvent(event) {
        const insertResult = await db.query(`
            INSERT INTO webhook_events (square_event_id, event_type, merchant_id, event_data, status)
            VALUES ($1, $2, $3, $4, 'processing')
            RETURNING id
        `, [event.event_id, event.type, event.merchant_id, JSON.stringify(event.data)]);
        return insertResult.rows[0]?.id;
    }

    /**
     * Resolve Square merchant ID to internal merchant ID
     *
     * @param {string} squareMerchantId - Square's merchant ID
     * @returns {Promise<number|null>} Internal merchant ID or null
     */
    async resolveMerchant(squareMerchantId) {
        if (!squareMerchantId) {
            return null;
        }

        const merchantResult = await db.query(
            'SELECT id FROM merchants WHERE square_merchant_id = $1 AND is_active = TRUE',
            [squareMerchantId]
        );

        if (merchantResult.rows.length > 0) {
            const internalMerchantId = merchantResult.rows[0].id;
            logger.info('Webhook merchant resolved', {
                squareMerchantId,
                internalMerchantId
            });
            return internalMerchantId;
        }

        logger.warn('Webhook received for unknown/inactive merchant', {
            squareMerchantId
        });
        return null;
    }

    /**
     * Build context object for handlers
     *
     * @param {Object} event - The Square webhook event
     * @param {number|null} merchantId - Internal merchant ID
     * @param {number|null} webhookEventId - Webhook event ID from database
     * @param {number} startTime - Processing start timestamp
     * @returns {Object} Handler context
     */
    buildContext(event, merchantId, webhookEventId, startTime) {
        return {
            event,
            data: event.data?.object || {},
            entityId: event.data?.id || null,  // Canonical entity ID (order ID, customer ID, etc.)
            entityType: event.data?.type || null,  // Entity type (order, customer, etc.)
            merchantId,
            squareMerchantId: event.merchant_id,
            webhookEventId,
            startTime
        };
    }

    /**
     * Update webhook_events with processing results
     *
     * @param {number} webhookEventId - The webhook event ID
     * @param {Object} syncResults - Results from processing
     * @param {number} processingTime - Processing time in ms
     * @returns {Promise<void>}
     */
    async updateEventResults(webhookEventId, syncResults, processingTime) {
        if (!webhookEventId) {
            return;
        }

        const status = syncResults.error
            ? 'failed'
            : (syncResults.skipped ? 'skipped' : 'completed');

        await db.query(`
            UPDATE webhook_events
            SET status = $1,
                processed_at = NOW(),
                sync_results = $2,
                processing_time_ms = $3,
                error_message = $4
            WHERE id = $5
        `, [status, JSON.stringify(syncResults), processingTime, syncResults.error || null, webhookEventId]);
    }

    /**
     * Main webhook processing entry point
     *
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @returns {Promise<void>}
     */
    async processWebhook(req, res) {
        const startTime = Date.now();
        let webhookEventId = null;

        try {
            const signature = req.headers['x-square-hmacsha256-signature'];
            const event = req.body;

            // ==================== SIGNATURE VERIFICATION ====================
            const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
            if (!signatureKey) {
                if (process.env.NODE_ENV === 'production') {
                    logger.error('SECURITY: Webhook rejected - SQUARE_WEBHOOK_SIGNATURE_KEY not configured in production');
                    return res.status(500).json({ error: 'Webhook verification not configured' });
                }
                logger.warn('Development mode: Webhook signature verification skipped (configure SQUARE_WEBHOOK_SIGNATURE_KEY for production)');
            } else {
                // SECURITY: SQUARE_WEBHOOK_URL must be set to prevent Host header injection
                if (!process.env.SQUARE_WEBHOOK_URL) {
                    logger.error('SECURITY: SQUARE_WEBHOOK_URL environment variable is required for webhook signature verification');
                    return res.status(500).json({ error: 'Webhook URL not configured' });
                }

                const notificationUrl = process.env.SQUARE_WEBHOOK_URL;
                const payload = req.rawBody || JSON.stringify(req.body);

                if (!this.verifySignature(signature, payload, notificationUrl, signatureKey)) {
                    logger.warn('Invalid webhook signature', {
                        received: signature,
                        url: notificationUrl,
                        hasRawBody: !!req.rawBody,
                        bodyLength: payload?.length
                    });
                    return res.status(401).json({ error: 'Invalid signature' });
                }
            }

            // ==================== IDEMPOTENCY CHECK ====================
            if (await this.isDuplicateEvent(event.event_id)) {
                logger.info('Duplicate webhook event ignored', { eventId: event.event_id });
                return res.json({ received: true, duplicate: true });
            }

            // ==================== LOG EVENT ====================
            webhookEventId = await this.logEvent(event);

            logger.info('Square webhook received', {
                eventType: event.type,
                eventId: event.event_id,
                merchantId: event.merchant_id
            });

            // ==================== RESOLVE MERCHANT ====================
            const internalMerchantId = await this.resolveMerchant(event.merchant_id);

            // ==================== BUILD CONTEXT ====================
            const context = this.buildContext(event, internalMerchantId, webhookEventId, startTime);

            // ==================== ROUTE TO HANDLER ====================
            let syncResults = {};
            let subscriberId = null;

            const routeResult = await routeEvent(event.type, context);

            if (routeResult.handled) {
                syncResults = routeResult.result || {};
                subscriberId = routeResult.result?.subscriberId || null;
            } else {
                logger.info('Unhandled webhook event type', { type: event.type });
                syncResults.unhandled = true;
            }

            // ==================== LEGACY EVENT LOGGING ====================
            await subscriptionHandler.logEvent({
                subscriberId,
                eventType: event.type,
                eventData: event.data,
                squareEventId: event.event_id
            });

            // ==================== UPDATE RESULTS ====================
            const processingTime = Date.now() - startTime;
            await this.updateEventResults(webhookEventId, syncResults, processingTime);

            res.json({ received: true, processingTimeMs: processingTime });

        } catch (error) {
            logger.error('Webhook processing error', {
                error: error.message,
                stack: error.stack
            });

            // Mark webhook for retry with exponential backoff
            if (webhookEventId) {
                const processingTime = Date.now() - startTime;
                await webhookRetry.markForRetry(webhookEventId, error.message).catch(dbErr => {
                    logger.error('Failed to mark webhook for retry', {
                        webhookEventId,
                        error: dbErr.message,
                        stack: dbErr.stack
                    });
                });

                // Update processing time
                await db.query(`
                    UPDATE webhook_events
                    SET processing_time_ms = $1
                    WHERE id = $2
                `, [processingTime, webhookEventId]).catch(err => {
                    logger.warn('Failed to update webhook processing time', {
                        webhookEventId,
                        error: err.message
                    });
                });
            }

            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = new WebhookProcessor();
