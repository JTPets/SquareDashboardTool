/**
 * Delivery Route Sharing Tokens Service
 * Handles shareable tokens for contract drivers to access routes.
 *
 * Extracted from delivery-service.js as part of Phase 4b module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const { enrichOrdersWithGtin } = require('./delivery-gtin');

/**
 * Lazy require to avoid circular dependencies.
 * delivery-tokens needs delivery-orders and delivery-routes,
 * which may transitively depend on modules that import tokens.
 */
function _getOrders() { return require('./delivery-orders'); }
function _getRoutes() { return require('./delivery-routes'); }
function _getPod() { return require('./delivery-pod'); }

/**
 * Generate a shareable token for a route
 * @param {number} merchantId - The merchant ID
 * @param {string} routeId - The route UUID
 * @param {number} userId - User generating the token
 * @param {Object} options - Token options
 * @returns {Promise<Object>} Created token record
 */
async function generateRouteToken(merchantId, routeId, userId, options = {}) {
    const { expiresInHours = 24 } = options;

    // Validate route exists and belongs to merchant
    const routeResult = await db.query(
        `SELECT * FROM delivery_routes WHERE id = $1 AND merchant_id = $2`,
        [routeId, merchantId]
    );

    if (routeResult.rows.length === 0) {
        throw new Error('Route not found');
    }

    const route = routeResult.rows[0];
    if (route.status !== 'active') {
        throw new Error('Can only share active routes');
    }

    // Revoke any existing active tokens for this route
    await db.query(
        `UPDATE delivery_route_tokens
         SET status = 'revoked'
         WHERE route_id = $1 AND status = 'active'`,
        [routeId]
    );

    // Generate a secure token (64-character hex string)
    const token = crypto.randomBytes(32).toString('hex');

    // Calculate expiry
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expiresInHours);

    // Create token record
    const result = await db.query(
        `INSERT INTO delivery_route_tokens (
            merchant_id, route_id, token, created_by, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [merchantId, routeId, token, userId, expiresAt]
    );

    logger.info('Generated route share token', {
        merchantId,
        routeId,
        tokenId: result.rows[0].id,
        expiresAt
    });

    return result.rows[0];
}

/**
 * Validate and get route data by share token
 * @param {string} token - The share token
 * @returns {Promise<Object|null>} Token record with route data or null if invalid
 */
async function getRouteByToken(token) {
    if (!token || token.length < 20) {
        return null;
    }

    const result = await db.query(
        `SELECT
            drt.*,
            dr.route_date,
            dr.total_stops,
            dr.total_distance_km,
            dr.estimated_duration_min,
            dr.status as route_status,
            dr.started_at,
            dr.finished_at,
            m.business_name as merchant_name
         FROM delivery_route_tokens drt
         JOIN delivery_routes dr ON dr.id = drt.route_id
         JOIN merchants m ON m.id = drt.merchant_id
         WHERE drt.token = $1`,
        [token]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const tokenRecord = result.rows[0];

    // Check token validity
    if (tokenRecord.status !== 'active') {
        return { ...tokenRecord, valid: false, reason: 'Token has been ' + tokenRecord.status };
    }

    if (tokenRecord.expires_at && new Date(tokenRecord.expires_at) < new Date()) {
        // Mark as expired
        await db.query(
            `UPDATE delivery_route_tokens SET status = 'expired' WHERE id = $1`,
            [tokenRecord.id]
        );
        return { ...tokenRecord, valid: false, reason: 'Token has expired' };
    }

    if (tokenRecord.route_status !== 'active') {
        return { ...tokenRecord, valid: false, reason: 'Route is no longer active' };
    }

    // Mark as used on first access (for tracking)
    if (!tokenRecord.used_at) {
        await db.query(
            `UPDATE delivery_route_tokens SET used_at = NOW() WHERE id = $1`,
            [tokenRecord.id]
        );
    }

    return { ...tokenRecord, valid: true };
}

/**
 * Get route orders by token (for driver view)
 * @param {string} token - The share token
 * @returns {Promise<Object|null>} Route with orders or null
 */
async function getRouteOrdersByToken(token) {
    const tokenData = await getRouteByToken(token);

    if (!tokenData || !tokenData.valid) {
        return tokenData; // Return invalid token info for error handling
    }

    // Get orders for this route, enriched with GTIN
    const { getOrders } = _getOrders();
    let orders = await getOrders(tokenData.merchant_id, { routeId: tokenData.route_id });
    orders = await enrichOrdersWithGtin(tokenData.merchant_id, orders);

    // Sort by route position
    orders.sort((a, b) => (a.route_position || 999) - (b.route_position || 999));

    return {
        ...tokenData,
        orders
    };
}

/**
 * Complete an order via share token
 * @param {string} token - The share token
 * @param {string} orderId - The order UUID
 * @returns {Promise<Object>} Updated order
 */
async function completeOrderByToken(token, orderId) {
    const tokenData = await getRouteByToken(token);

    if (!tokenData || !tokenData.valid) {
        throw new Error(tokenData?.reason || 'Invalid or expired token');
    }

    // Verify order belongs to this route
    const { getOrderById, completeOrder } = _getOrders();
    const order = await getOrderById(tokenData.merchant_id, orderId);
    if (!order || order.route_id !== tokenData.route_id) {
        throw new Error('Order not found on this route');
    }

    // Complete the order (using null for userId since it's a contract driver)
    return completeOrder(tokenData.merchant_id, orderId, null);
}

/**
 * Skip an order via share token
 * @param {string} token - The share token
 * @param {string} orderId - The order UUID
 * @returns {Promise<Object>} Updated order
 */
async function skipOrderByToken(token, orderId) {
    const tokenData = await getRouteByToken(token);

    if (!tokenData || !tokenData.valid) {
        throw new Error(tokenData?.reason || 'Invalid or expired token');
    }

    // Verify order belongs to this route
    const { getOrderById, skipOrder } = _getOrders();
    const order = await getOrderById(tokenData.merchant_id, orderId);
    if (!order || order.route_id !== tokenData.route_id) {
        throw new Error('Order not found on this route');
    }

    return skipOrder(tokenData.merchant_id, orderId, null);
}

/**
 * Save POD photo via share token
 * @param {string} token - The share token
 * @param {string} orderId - The order UUID
 * @param {Buffer} photoBuffer - Photo file buffer
 * @param {Object} metadata - Photo metadata
 * @returns {Promise<Object>} Created POD record
 */
async function savePodByToken(token, orderId, photoBuffer, metadata) {
    const tokenData = await getRouteByToken(token);

    if (!tokenData || !tokenData.valid) {
        throw new Error(tokenData?.reason || 'Invalid or expired token');
    }

    // Verify order belongs to this route
    const { getOrderById } = _getOrders();
    const order = await getOrderById(tokenData.merchant_id, orderId);
    if (!order || order.route_id !== tokenData.route_id) {
        throw new Error('Order not found on this route');
    }

    const { savePodPhoto } = _getPod();
    return savePodPhoto(tokenData.merchant_id, orderId, photoBuffer, metadata);
}

/**
 * Finish route and retire token
 * @param {string} token - The share token
 * @param {Object} options - Options like driver name/notes
 * @returns {Promise<Object>} Route finish stats
 */
async function finishRouteByToken(token, options = {}) {
    const { driverName = null, driverNotes = null } = options;

    const tokenData = await getRouteByToken(token);

    if (!tokenData || !tokenData.valid) {
        throw new Error(tokenData?.reason || 'Invalid or expired token');
    }

    // Finish the route
    const { finishRoute } = _getRoutes();
    const result = await finishRoute(tokenData.merchant_id, tokenData.route_id, null);

    // Retire the token
    await db.query(
        `UPDATE delivery_route_tokens
         SET status = 'used', finished_at = NOW(), driver_name = $2, driver_notes = $3
         WHERE id = $1`,
        [tokenData.id, driverName, driverNotes]
    );

    logger.info('Route finished via share token', {
        tokenId: tokenData.id,
        routeId: tokenData.route_id,
        merchantId: tokenData.merchant_id,
        driverName,
        result
    });

    return result;
}

/**
 * Revoke a route share token
 * @param {number} merchantId - The merchant ID
 * @param {string} tokenId - The token UUID
 * @returns {Promise<boolean>} True if revoked
 */
async function revokeRouteToken(merchantId, tokenId) {
    const result = await db.query(
        `UPDATE delivery_route_tokens
         SET status = 'revoked'
         WHERE id = $1 AND merchant_id = $2 AND status = 'active'
         RETURNING id`,
        [tokenId, merchantId]
    );

    if (result.rows.length > 0) {
        logger.info('Revoked route share token', { merchantId, tokenId });
        return true;
    }
    return false;
}

/**
 * Get active token for a route
 * @param {number} merchantId - The merchant ID
 * @param {string} routeId - The route UUID
 * @returns {Promise<Object|null>} Active token or null
 */
async function getActiveRouteToken(merchantId, routeId) {
    const result = await db.query(
        `SELECT * FROM delivery_route_tokens
         WHERE merchant_id = $1 AND route_id = $2 AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
        [merchantId, routeId]
    );

    return result.rows[0] || null;
}

module.exports = {
    generateRouteToken,
    getRouteByToken,
    getRouteOrdersByToken,
    completeOrderByToken,
    skipOrderByToken,
    savePodByToken,
    finishRouteByToken,
    revokeRouteToken,
    getActiveRouteToken
};
