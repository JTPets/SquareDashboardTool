/**
 * Delivery Orders Service
 * CRUD operations for delivery orders.
 *
 * Extracted from delivery-service.js as part of Phase 4b module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { safeJsonStringify, validateUUID } = require('./delivery-utils');
const { logAuditEvent } = require('./delivery-audit');

/**
 * Get delivery orders for a merchant
 * @param {number} merchantId - The merchant ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of delivery orders
 */
async function getOrders(merchantId, options = {}) {
    const {
        status = null,
        routeDate = null,
        routeId = null,
        dateFrom = null,
        dateTo = null,
        includeCompleted = false,
        limit = 100,
        offset = 0
    } = options;

    let query = `
        SELECT
            dord.*,
            dp.id as pod_id,
            dp.photo_path as pod_photo_path,
            dp.captured_at as pod_captured_at,
            lc.note AS customer_profile_note
        FROM delivery_orders dord
        LEFT JOIN delivery_pod dp ON dp.delivery_order_id = dord.id
        LEFT JOIN loyalty_customers lc
            ON lc.square_customer_id = dord.square_customer_id
            AND lc.merchant_id = dord.merchant_id
        WHERE dord.merchant_id = $1
    `;
    const params = [merchantId];

    if (status) {
        if (Array.isArray(status)) {
            const placeholders = status.map((_, i) => `$${params.length + i + 1}`).join(', ');
            query += ` AND dord.status IN (${placeholders})`;
            params.push(...status);
        } else {
            params.push(status);
            query += ` AND dord.status = $${params.length}`;
        }
    }

    if (!includeCompleted && !status) {
        query += ` AND dord.status != 'completed'`;
    }

    if (routeDate) {
        params.push(routeDate);
        query += ` AND dord.route_date = $${params.length}`;
    }

    if (routeId) {
        params.push(routeId);
        query += ` AND dord.route_id = $${params.length}`;
    }

    // Date range filtering (for history queries)
    if (dateFrom) {
        params.push(dateFrom);
        query += ` AND dord.updated_at >= $${params.length}::date`;
    }

    if (dateTo) {
        params.push(dateTo);
        query += ` AND dord.updated_at < ($${params.length}::date + interval '1 day')`;
    }

    query += ` ORDER BY dord.updated_at DESC, dord.route_position NULLS LAST`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
}

/**
 * Get a single delivery order by ID
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @returns {Promise<Object|null>} Delivery order or null
 */
async function getOrderById(merchantId, orderId) {
    // Validate UUID format (security - prevent injection via malformed IDs)
    validateUUID(orderId, 'order ID');

    const result = await db.query(
        `SELECT dord.*,
                dp.id as pod_id,
                dp.photo_path as pod_photo_path,
                dp.captured_at as pod_captured_at
         FROM delivery_orders dord
         LEFT JOIN delivery_pod dp ON dp.delivery_order_id = dord.id
         WHERE dord.id = $1 AND dord.merchant_id = $2`,
        [orderId, merchantId]
    );
    return result.rows[0] || null;
}

/**
 * Get delivery order by Square order ID
 * @param {number} merchantId - The merchant ID
 * @param {string} squareOrderId - The Square order ID
 * @returns {Promise<Object|null>} Delivery order or null
 */
async function getOrderBySquareId(merchantId, squareOrderId) {
    const result = await db.query(
        `SELECT * FROM delivery_orders
         WHERE square_order_id = $1 AND merchant_id = $2`,
        [squareOrderId, merchantId]
    );
    return result.rows[0] || null;
}

/**
 * Create a new delivery order
 * @param {number} merchantId - The merchant ID
 * @param {Object} orderData - Order data
 * @returns {Promise<Object>} Created delivery order
 */
async function createOrder(merchantId, orderData) {
    const {
        squareOrderId = null,
        squareCustomerId = null,
        customerName,
        address,
        addressLat = null,
        addressLng = null,
        phone = null,
        notes = null,
        customerNote = null,
        status = 'pending',
        squareOrderData = null,
        squareOrderState = null,
        needsCustomerRefresh = false
    } = orderData;

    const serializedOrderData = squareOrderData ? safeJsonStringify(squareOrderData) : null;
    const geocodedAt = addressLat && addressLng ? new Date() : null;

    // Use ON CONFLICT for Square-linked orders to prevent duplicates from racing webhooks.
    // Manual orders (squareOrderId=null) are excluded by the partial unique index.
    const sql = squareOrderId
        ? `INSERT INTO delivery_orders (
                merchant_id, square_order_id, square_customer_id, customer_name, address,
                address_lat, address_lng, phone, notes, customer_note, status,
                geocoded_at, square_order_data, square_order_state, needs_customer_refresh
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (square_order_id, merchant_id) WHERE square_order_id IS NOT NULL
            DO UPDATE SET
                square_customer_id = COALESCE(EXCLUDED.square_customer_id, delivery_orders.square_customer_id),
                customer_name = CASE
                    WHEN delivery_orders.customer_name = 'Unknown Customer' THEN EXCLUDED.customer_name
                    ELSE delivery_orders.customer_name
                END,
                address = COALESCE(EXCLUDED.address, delivery_orders.address),
                phone = COALESCE(EXCLUDED.phone, delivery_orders.phone),
                square_order_data = COALESCE(EXCLUDED.square_order_data, delivery_orders.square_order_data),
                square_order_state = COALESCE(EXCLUDED.square_order_state, delivery_orders.square_order_state),
                needs_customer_refresh = EXCLUDED.needs_customer_refresh
            RETURNING *, (xmax = 0) AS _inserted`
        : `INSERT INTO delivery_orders (
                merchant_id, square_order_id, square_customer_id, customer_name, address,
                address_lat, address_lng, phone, notes, customer_note, status,
                geocoded_at, square_order_data, square_order_state, needs_customer_refresh
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *, TRUE AS _inserted`;

    const result = await db.query(sql, [
        merchantId, squareOrderId, squareCustomerId, customerName, address,
        addressLat, addressLng, phone, notes, customerNote, status,
        geocodedAt, serializedOrderData, squareOrderState, needsCustomerRefresh
    ]);

    const row = result.rows[0];
    const wasInserted = row._inserted;
    delete row._inserted;

    if (wasInserted) {
        logger.info('Created delivery order', {
            merchantId,
            orderId: row.id,
            squareOrderId,
            squareCustomerId
        });
    } else {
        logger.info('Delivery order already exists (conflict), returned existing', {
            merchantId,
            orderId: row.id,
            squareOrderId
        });
    }

    return row;
}

/**
 * Update a delivery order
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>} Updated order or null
 */
async function updateOrder(merchantId, orderId, updates) {
    const allowedFields = [
        'customer_name', 'address', 'address_lat', 'address_lng',
        'geocoded_at', 'phone', 'notes', 'customer_note', 'status', 'route_id',
        'route_position', 'route_date', 'square_synced_at', 'square_customer_id',
        'square_order_data', 'square_order_state', 'needs_customer_refresh'
    ];

    const setClauses = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
        const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
        if (allowedFields.includes(snakeKey)) {
            // Serialize JSONB fields
            const paramValue = snakeKey === 'square_order_data' && value ? safeJsonStringify(value) : value;
            params.push(paramValue);
            setClauses.push(`${snakeKey} = $${params.length}`);
        }
    }

    if (setClauses.length === 0) {
        return getOrderById(merchantId, orderId);
    }

    params.push(orderId, merchantId);

    const result = await db.query(
        `UPDATE delivery_orders
         SET ${setClauses.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length - 1} AND merchant_id = $${params.length}
         RETURNING *`,
        params
    );

    return result.rows[0] || null;
}

/**
 * Delete a delivery order (only manual orders)
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteOrder(merchantId, orderId) {
    // Only allow deleting manual orders (no square_order_id) that aren't completed
    const result = await db.query(
        `DELETE FROM delivery_orders
         WHERE id = $1 AND merchant_id = $2
           AND square_order_id IS NULL
           AND status NOT IN ('completed', 'delivered')
         RETURNING id`,
        [orderId, merchantId]
    );

    if (result.rows.length > 0) {
        logger.info('Deleted delivery order', { merchantId, orderId });
        return true;
    }
    return false;
}

/**
 * Mark an order as skipped
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @param {number} userId - The user performing the action
 * @returns {Promise<Object|null>} Updated order
 */
async function skipOrder(merchantId, orderId, userId) {
    // LOGIC CHANGE (BUG-006): Only allow skipping 'active' orders.
    // Pending orders are not on a route, completed/delivered should not regress.
    const existing = await getOrderById(merchantId, orderId);
    if (!existing) {
        return null;
    }
    if (existing.status !== 'active') {
        throw new Error(`Cannot skip order in '${existing.status}' status — only active orders can be skipped`);
    }

    const order = await updateOrder(merchantId, orderId, { status: 'skipped' });

    if (order) {
        // LOGIC CHANGE (BUG-013): Use actual previous status instead of hardcoded 'active'
        await logAuditEvent(merchantId, userId, 'order_skipped', orderId, null, {
            previousStatus: existing.status
        });
    }

    return order;
}

/**
 * Mark an order as delivered (POD captured)
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @returns {Promise<Object|null>} Updated order
 */
async function markDelivered(merchantId, orderId) {
    return updateOrder(merchantId, orderId, { status: 'delivered' });
}

/**
 * Mark an order as completed and sync to Square
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @param {number} userId - The user performing the action
 * @returns {Promise<Object|null>} Updated order
 */
async function completeOrder(merchantId, orderId, userId) {
    // LOGIC CHANGE (BUG-005): Only allow completing orders in active, delivered, or skipped status.
    // Reject pending (not on a route) and already-completed orders.
    const existing = await getOrderById(merchantId, orderId);
    if (!existing) {
        return null;
    }
    const allowedStatuses = ['active', 'delivered', 'skipped'];
    if (!allowedStatuses.includes(existing.status)) {
        throw new Error(`Cannot complete order in '${existing.status}' status — only active, delivered, or skipped orders can be completed`);
    }

    const order = await updateOrder(merchantId, orderId, {
        status: 'completed',
        squareSyncedAt: new Date()
    });

    if (order) {
        await logAuditEvent(merchantId, userId, 'order_completed', orderId, null, {
            squareOrderId: order.square_order_id,
            hasPod: !!order.pod_id
        });
    }

    return order;
}

/**
 * Update order notes (local only — order-specific instructions).
 * @param {number} merchantId
 * @param {string} orderId
 * @param {string|null} notes
 * @returns {Promise<{notes: string|null}|null>} null if order not found
 */
async function updateOrderNotes(merchantId, orderId, notes) {
    const order = await getOrderById(merchantId, orderId);
    if (!order) return null;
    await updateOrder(merchantId, order.id, { notes: notes || null });
    return { notes: notes || null };
}

module.exports = {
    getOrders,
    getOrderById,
    getOrderBySquareId,
    createOrder,
    updateOrder,
    deleteOrder,
    skipOrder,
    markDelivered,
    completeOrder,
    updateOrderNotes
};
