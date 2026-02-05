/**
 * Webhook Retry Processor
 *
 * Handles retry logic for failed webhook events with exponential backoff.
 * Failed webhooks are retried up to MAX_RETRIES times with increasing delays.
 *
 * Backoff schedule (default):
 *   Retry 1: 1 minute
 *   Retry 2: 2 minutes
 *   Retry 3: 4 minutes
 *   Retry 4: 8 minutes
 *   Retry 5: 16 minutes
 */

const db = require('./database');
const logger = require('./logger');

// Configuration
const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 60 * 1000; // 1 minute base delay
const MAX_DELAY_MS = 30 * 60 * 1000; // Cap at 30 minutes

/**
 * Calculate the next retry delay using exponential backoff
 * @param {number} retryCount - Current retry count (0-based)
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(retryCount) {
    // Exponential backoff: BASE_DELAY * 2^retryCount
    const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
    // Cap at maximum delay
    return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Mark a webhook event for retry
 * @param {number} webhookEventId - The webhook_events.id
 * @param {string} errorMessage - The error that caused the failure
 * @param {number} maxRetries - Maximum retry attempts (default: 5)
 * @returns {Promise<Object>} Updated webhook event info
 */
async function markForRetry(webhookEventId, errorMessage, maxRetries = DEFAULT_MAX_RETRIES) {
    const result = await db.query(`
        UPDATE webhook_events
        SET
            status = 'failed',
            error_message = $1,
            retry_count = COALESCE(retry_count, 0),
            max_retries = $2,
            next_retry_at = CASE
                WHEN COALESCE(retry_count, 0) < $2
                THEN NOW() + (INTERVAL '1 minute' * POWER(2, COALESCE(retry_count, 0)))
                ELSE NULL
            END
        WHERE id = $3
        RETURNING id, retry_count, next_retry_at, max_retries
    `, [errorMessage, maxRetries, webhookEventId]);

    if (result.rows.length === 0) {
        logger.warn('Webhook event not found for retry marking', { webhookEventId });
        return null;
    }

    const event = result.rows[0];
    logger.info('Webhook marked for retry', {
        webhookEventId,
        retryCount: event.retry_count,
        maxRetries: event.max_retries,
        nextRetryAt: event.next_retry_at
    });

    return event;
}

/**
 * Increment retry count and schedule next retry
 * @param {number} webhookEventId - The webhook_events.id
 * @param {string} errorMessage - The error from this retry attempt
 * @returns {Promise<Object|null>} Updated event info, or null if max retries exceeded
 */
async function incrementRetry(webhookEventId, errorMessage) {
    const result = await db.query(`
        UPDATE webhook_events
        SET
            retry_count = COALESCE(retry_count, 0) + 1,
            last_retry_at = NOW(),
            error_message = $1,
            next_retry_at = CASE
                WHEN COALESCE(retry_count, 0) + 1 < COALESCE(max_retries, $2)
                THEN NOW() + (INTERVAL '1 minute' * POWER(2, COALESCE(retry_count, 0) + 1))
                ELSE NULL
            END,
            status = CASE
                WHEN COALESCE(retry_count, 0) + 1 >= COALESCE(max_retries, $2)
                THEN 'failed'
                ELSE 'pending_retry'
            END
        WHERE id = $3
        RETURNING id, retry_count, max_retries, next_retry_at, status
    `, [errorMessage, DEFAULT_MAX_RETRIES, webhookEventId]);

    if (result.rows.length === 0) {
        return null;
    }

    const event = result.rows[0];

    if (event.next_retry_at) {
        logger.info('Webhook retry scheduled', {
            webhookEventId,
            retryCount: event.retry_count,
            maxRetries: event.max_retries,
            nextRetryAt: event.next_retry_at
        });
    } else {
        logger.warn('Webhook max retries exceeded', {
            webhookEventId,
            retryCount: event.retry_count,
            maxRetries: event.max_retries
        });
    }

    return event;
}

/**
 * Mark a webhook as successfully processed (clears retry state)
 * @param {number} webhookEventId - The webhook_events.id
 * @param {Object} syncResults - Results from processing
 * @param {number} processingTimeMs - Processing time in milliseconds
 */
async function markSuccess(webhookEventId, syncResults, processingTimeMs) {
    await db.query(`
        UPDATE webhook_events
        SET
            status = 'completed',
            processed_at = NOW(),
            sync_results = $1,
            processing_time_ms = $2,
            next_retry_at = NULL,
            error_message = NULL
        WHERE id = $3
    `, [JSON.stringify(syncResults), processingTimeMs, webhookEventId]);

    logger.info('Webhook processed successfully', {
        webhookEventId,
        processingTimeMs
    });
}

/**
 * Get webhook events that are due for retry
 * @param {number} limit - Maximum number of events to fetch
 * @returns {Promise<Object[]>} List of webhook events ready for retry
 */
async function getEventsForRetry(limit = 50) {
    const result = await db.query(`
        SELECT
            id,
            square_event_id,
            event_type,
            merchant_id,
            square_merchant_id,
            event_data,
            retry_count,
            max_retries,
            error_message,
            received_at
        FROM webhook_events
        WHERE status = 'failed'
          AND next_retry_at IS NOT NULL
          AND next_retry_at <= NOW()
          AND COALESCE(retry_count, 0) < COALESCE(max_retries, $1)
        ORDER BY next_retry_at ASC
        LIMIT $2
    `, [DEFAULT_MAX_RETRIES, limit]);

    return result.rows;
}

/**
 * Get retry statistics
 * @returns {Promise<Object>} Retry statistics
 */
async function getRetryStats() {
    const result = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()) as pending_retries,
            COUNT(*) FILTER (WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at > NOW()) as scheduled_retries,
            COUNT(*) FILTER (WHERE status = 'failed' AND (next_retry_at IS NULL OR retry_count >= max_retries)) as exhausted_retries,
            COUNT(*) FILTER (WHERE status = 'completed') as completed,
            COUNT(*) FILTER (WHERE status = 'failed') as failed_total,
            AVG(retry_count) FILTER (WHERE status = 'completed' AND retry_count > 0) as avg_retries_to_success
        FROM webhook_events
        WHERE received_at > NOW() - INTERVAL '24 hours'
    `);

    return result.rows[0];
}

/**
 * Clean up old webhook events (retention policy)
 * @param {number} retentionDays - Days to retain completed events
 * @param {number} failedRetentionDays - Days to retain failed events
 * @returns {Promise<number>} Number of events deleted
 */
async function cleanupOldEvents(retentionDays = 14, failedRetentionDays = 30) {
    const result = await db.query(`
        DELETE FROM webhook_events
        WHERE (
            (status = 'completed' AND received_at < NOW() - INTERVAL '1 day' * $1)
            OR
            (status = 'failed' AND next_retry_at IS NULL AND received_at < NOW() - INTERVAL '1 day' * $2)
            OR
            (status = 'skipped' AND received_at < NOW() - INTERVAL '1 day' * $1)
        )
        RETURNING id
    `, [retentionDays, failedRetentionDays]);

    const deletedCount = result.rows.length;
    if (deletedCount > 0) {
        logger.info('Cleaned up old webhook events', { deletedCount, retentionDays, failedRetentionDays });
    }

    return deletedCount;
}

/**
 * Reset a permanently failed webhook for manual retry
 * @param {number} webhookEventId - The webhook_events.id
 * @returns {Promise<Object>} Updated event info
 */
async function resetForRetry(webhookEventId) {
    const result = await db.query(`
        UPDATE webhook_events
        SET
            retry_count = 0,
            next_retry_at = NOW(),
            status = 'failed',
            error_message = 'Manually reset for retry'
        WHERE id = $1
        RETURNING id, retry_count, next_retry_at
    `, [webhookEventId]);

    if (result.rows.length === 0) {
        return null;
    }

    logger.info('Webhook manually reset for retry', { webhookEventId });
    return result.rows[0];
}

module.exports = {
    // Core retry functions
    markForRetry,
    incrementRetry,
    markSuccess,
    getEventsForRetry,

    // Utilities
    calculateBackoffDelay,
    getRetryStats,
    cleanupOldEvents,
    resetForRetry,

    // Configuration
    DEFAULT_MAX_RETRIES,
    BASE_DELAY_MS,
    MAX_DELAY_MS
};
