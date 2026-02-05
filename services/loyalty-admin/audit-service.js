/**
 * Loyalty Audit Service
 *
 * Handles audit logging for all loyalty operations.
 * All loyalty actions must be auditable for compliance and debugging.
 *
 * Extracted from loyalty-service.js as part of P1-1 Phase 4 refactoring.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { AuditActions } = require('./constants');

/**
 * Log an audit event for loyalty operations
 * @param {Object} event - Audit event details
 * @param {number} event.merchantId - REQUIRED: Merchant ID for multi-tenant isolation
 * @param {string} event.action - Action type from AuditActions
 * @param {number} [event.offerId] - Related offer ID
 * @param {number} [event.rewardId] - Related reward ID
 * @param {number} [event.purchaseEventId] - Related purchase event ID
 * @param {number} [event.redemptionId] - Related redemption ID
 * @param {string} [event.squareCustomerId] - Square customer ID
 * @param {string} [event.squareOrderId] - Square order ID
 * @param {string} [event.oldState] - Previous state
 * @param {string} [event.newState] - New state
 * @param {number} [event.oldQuantity] - Previous quantity
 * @param {number} [event.newQuantity] - New quantity
 * @param {string} [event.triggeredBy] - 'SYSTEM', 'ADMIN', 'WEBHOOK', etc.
 * @param {number} [event.userId] - Admin user ID if applicable
 * @param {Object} [event.details] - Additional details object
 * @param {Object} [client] - Optional database client for transactions
 */
async function logAuditEvent(event, client = null) {
    if (!event.merchantId) {
        throw new Error('merchantId is required for logAuditEvent - tenant isolation required');
    }

    try {
        // Use provided client (for transactions) or db.query (for standalone)
        const queryFn = client ? client.query.bind(client) : db.query.bind(db);
        await queryFn(`
            INSERT INTO loyalty_audit_logs (
                merchant_id, action, offer_id, reward_id, purchase_event_id, redemption_id,
                square_customer_id, square_order_id, old_state, new_state,
                old_quantity, new_quantity, triggered_by, user_id, details
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
            event.merchantId,
            event.action,
            event.offerId || null,
            event.rewardId || null,
            event.purchaseEventId || null,
            event.redemptionId || null,
            event.squareCustomerId || null,
            event.squareOrderId || null,
            event.oldState || null,
            event.newState || null,
            event.oldQuantity || null,
            event.newQuantity || null,
            event.triggeredBy || 'SYSTEM',
            event.userId || null,
            event.details ? JSON.stringify(event.details) : null
        ]);
    } catch (error) {
        logger.error('Failed to log loyalty audit event', {
            error: error.message,
            action: event.action,
            merchantId: event.merchantId
        });
        // Don't throw - audit logging should not break main operations
    }
}

/**
 * Get audit log entries
 * @param {number} merchantId - REQUIRED: Merchant ID
 * @param {Object} options - Query options
 * @param {number} [options.limit=100] - Maximum entries to return
 * @param {number} [options.offset=0] - Pagination offset
 * @param {string} [options.action] - Filter by action type
 * @param {string} [options.squareCustomerId] - Filter by customer
 * @param {number} [options.offerId] - Filter by offer
 * @returns {Promise<Array>} Array of audit log entries
 */
async function getAuditLogs(merchantId, options = {}) {
    if (!merchantId) {
        throw new Error('merchantId is required - tenant isolation required');
    }

    const { limit = 100, offset = 0, action = null, squareCustomerId = null, offerId = null } = options;

    let query = `
        SELECT al.*,
               o.offer_name, o.brand_name,
               u.name as user_name
        FROM loyalty_audit_logs al
        LEFT JOIN loyalty_offers o ON al.offer_id = o.id
        LEFT JOIN users u ON al.user_id = u.id
        WHERE al.merchant_id = $1
    `;
    const params = [merchantId];

    if (action) {
        query += ` AND al.action = $${params.length + 1}`;
        params.push(action);
    }

    if (squareCustomerId) {
        query += ` AND al.square_customer_id = $${params.length + 1}`;
        params.push(squareCustomerId);
    }

    if (offerId) {
        query += ` AND al.offer_id = $${params.length + 1}`;
        params.push(offerId);
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
}

module.exports = {
    logAuditEvent,
    getAuditLogs,
    // Re-export AuditActions for convenience
    AuditActions
};
