/**
 * Delivery Audit Logging Service
 * Handles audit trail for delivery operations.
 *
 * Extracted from delivery-service.js as part of leaf module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');

/**
 * Log an audit event
 * @param {number} merchantId - The merchant ID
 * @param {number} userId - The user ID
 * @param {string} action - The action type
 * @param {string} orderId - Optional order ID
 * @param {string} routeId - Optional route ID
 * @param {Object} details - Additional details
 */
async function logAuditEvent(merchantId, userId, action, orderId = null, routeId = null, details = {}) {
    try {
        await db.query(
            `INSERT INTO delivery_audit_log (
                merchant_id, user_id, action, delivery_order_id, route_id, details
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [merchantId, userId, action, orderId, routeId, JSON.stringify(details)]
        );
    } catch (err) {
        logger.error('Failed to log audit event', { merchantId, action, error: err.message });
    }
}

/**
 * Get audit log entries
 * @param {number} merchantId - The merchant ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Audit log entries
 */
async function getAuditLog(merchantId, options = {}) {
    const { limit = 100, offset = 0, action = null, orderId = null, routeId = null } = options;

    let query = `
        SELECT dal.*, u.name as user_name, u.email as user_email
        FROM delivery_audit_log dal
        LEFT JOIN users u ON u.id = dal.user_id
        WHERE dal.merchant_id = $1
    `;
    const params = [merchantId];

    if (action) {
        params.push(action);
        query += ` AND dal.action = $${params.length}`;
    }

    if (orderId) {
        params.push(orderId);
        query += ` AND dal.delivery_order_id = $${params.length}`;
    }

    if (routeId) {
        params.push(routeId);
        query += ` AND dal.route_id = $${params.length}`;
    }

    query += ` ORDER BY dal.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
}

module.exports = {
    logAuditEvent,
    getAuditLog
};
