/**
 * Cart Activity Service
 * Tracks DRAFT orders (shopping carts) from Square Online
 * Handles conversion tracking, abandonment marking, and cleanup
 *
 * Usage:
 *   const cartActivityService = require('./services/cart/cart-activity-service');
 *   await cartActivityService.createFromDraftOrder(order, merchantId);
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const crypto = require('crypto');

/**
 * Safely stringify objects containing BigInt values
 * Square SDK returns BigInt for money amounts
 */
function safeJsonStringify(obj) {
    return JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? Number(value) : value
    );
}

/**
 * Extract last 4 digits of phone number
 * @param {string} phone - Full phone number
 * @returns {string|null} Last 4 digits or null
 */
function extractPhoneLast4(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Hash customer ID for privacy-compliant storage
 * @param {string} customerId - Square customer ID
 * @returns {string|null} SHA-256 hash or null
 */
function hashCustomerId(customerId) {
    if (!customerId) return null;
    return crypto.createHash('sha256').update(customerId).digest('hex');
}

/**
 * Extract cart data from Square order
 * @param {Object} order - Square order object
 * @returns {Object} Extracted cart data
 */
function extractCartData(order) {
    // Get fulfillment data (handles both camelCase and snake_case)
    const fulfillment = order.fulfillments?.[0];
    const deliveryDetails = fulfillment?.deliveryDetails || fulfillment?.delivery_details;
    const shipmentDetails = fulfillment?.shipmentDetails || fulfillment?.shipment_details;
    const recipient = deliveryDetails?.recipient || shipmentDetails?.recipient;

    // Extract phone (privacy: last 4 only)
    const phone = recipient?.phoneNumber || recipient?.phone_number;
    const phoneLast4 = extractPhoneLast4(phone);

    // Extract customer ID
    const customerId = order.customerId || order.customer_id;
    const customerIdHash = hashCustomerId(customerId);

    // Extract cart total (in cents)
    const totalMoney = order.totalMoney || order.total_money;
    const cartTotalCents = totalMoney?.amount ? Number(totalMoney.amount) : 0;

    // Extract line items
    const lineItems = order.lineItems || order.line_items || [];
    const itemCount = lineItems.length;
    const itemsJson = lineItems.map(item => ({
        name: item.name,
        quantity: item.quantity,
        variationName: item.variationName || item.variation_name,
        priceCents: item.basePriceMoney?.amount || item.base_price_money?.amount || 0
    }));

    // Extract source
    const sourceName = order.source?.name || 'Unknown';
    const locationId = order.locationId || order.location_id;

    // Extract fulfillment type and shipping estimate
    const fulfillmentType = fulfillment?.type || null;
    const shippingCharge = deliveryDetails?.deliverAt ? null :
        (shipmentDetails?.shippingCharge?.amount || null);

    return {
        squareOrderId: order.id,
        squareCustomerId: customerId,
        customerIdHash,
        phoneLast4,
        cartTotalCents,
        itemCount,
        itemsJson,
        sourceName,
        locationId,
        fulfillmentType,
        shippingEstimateCents: shippingCharge ? Number(shippingCharge) : null
    };
}

/**
 * Create cart activity record from DRAFT order
 * @param {Object} order - Square DRAFT order
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Created cart activity record or null if skipped
 */
async function createFromDraftOrder(order, merchantId) {
    // Skip orders with no items
    if (!order.lineItems?.length && !order.line_items?.length) {
        logger.debug('Skipping DRAFT order with no items', {
            merchantId,
            squareOrderId: order.id
        });
        return null;
    }

    const cartData = extractCartData(order);

    try {
        const result = await db.query(`
            INSERT INTO cart_activity (
                merchant_id, square_order_id, square_customer_id,
                customer_id_hash, phone_last4, cart_total_cents,
                item_count, items_json, source_name, location_id,
                fulfillment_type, shipping_estimate_cents, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
            ON CONFLICT (merchant_id, square_order_id) DO UPDATE SET
                cart_total_cents = EXCLUDED.cart_total_cents,
                item_count = EXCLUDED.item_count,
                items_json = EXCLUDED.items_json,
                updated_at = NOW()
            RETURNING *
        `, [
            merchantId,
            cartData.squareOrderId,
            cartData.squareCustomerId,
            cartData.customerIdHash,
            cartData.phoneLast4,
            cartData.cartTotalCents,
            cartData.itemCount,
            safeJsonStringify(cartData.itemsJson),
            cartData.sourceName,
            cartData.locationId,
            cartData.fulfillmentType,
            cartData.shippingEstimateCents
        ]);

        const cart = result.rows[0];

        // Log with appropriate level based on customer data availability
        if (!cartData.squareCustomerId && !cartData.phoneLast4) {
            logger.warn('DRAFT order has no customer_id or phone', {
                merchantId,
                squareOrderId: order.id,
                cartActivityId: cart.id
            });
        } else {
            logger.info('Cart activity created from DRAFT order', {
                merchantId,
                squareOrderId: order.id,
                cartActivityId: cart.id,
                itemCount: cartData.itemCount,
                cartTotal: cartData.cartTotalCents,
                source: cartData.sourceName
            });
        }

        return cart;
    } catch (err) {
        logger.error('Failed to create cart activity', {
            merchantId,
            squareOrderId: order.id,
            error: err.message
        });
        throw err;
    }
}

/**
 * Mark cart as converted when DRAFT transitions to OPEN/COMPLETED
 * @param {string} squareOrderId - Square order ID
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Updated cart or null if not found
 */
async function markConverted(squareOrderId, merchantId) {
    try {
        const result = await db.query(`
            UPDATE cart_activity
            SET status = 'converted',
                converted_at = NOW(),
                updated_at = NOW()
            WHERE merchant_id = $1
              AND square_order_id = $2
              AND status = 'pending'
            RETURNING *
        `, [merchantId, squareOrderId]);

        if (result.rows.length > 0) {
            const cart = result.rows[0];
            const conversionTimeMs = cart.converted_at - cart.created_at;

            logger.info('Cart converted: DRAFT -> OPEN/COMPLETED', {
                merchantId,
                squareOrderId,
                cartActivityId: cart.id,
                conversionTimeMs
            });

            return cart;
        }

        return null;
    } catch (err) {
        logger.warn('Cart activity lookup failed during conversion check', {
            merchantId,
            squareOrderId,
            error: err.message
        });
        return null;
    }
}

/**
 * Mark cart as canceled
 * @param {string} squareOrderId - Square order ID
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Updated cart or null if not found
 */
async function markCanceled(squareOrderId, merchantId) {
    try {
        const result = await db.query(`
            UPDATE cart_activity
            SET status = 'canceled',
                updated_at = NOW()
            WHERE merchant_id = $1
              AND square_order_id = $2
              AND status = 'pending'
            RETURNING *
        `, [merchantId, squareOrderId]);

        if (result.rows.length > 0) {
            logger.info('Cart marked canceled', {
                merchantId,
                squareOrderId,
                cartActivityId: result.rows[0].id
            });
            return result.rows[0];
        }

        return null;
    } catch (err) {
        logger.error('Failed to mark cart canceled', {
            merchantId,
            squareOrderId,
            error: err.message
        });
        return null;
    }
}

/**
 * Mark pending carts as abandoned if older than threshold
 * @param {number} merchantId - Merchant ID (optional, null for all merchants)
 * @param {number} daysThreshold - Days after which to mark as abandoned (default: 7)
 * @returns {Promise<number>} Number of carts marked as abandoned
 */
async function markAbandoned(merchantId = null, daysThreshold = 7) {
    try {
        let query = `
            UPDATE cart_activity
            SET status = 'abandoned',
                updated_at = NOW()
            WHERE status = 'pending'
              AND created_at < NOW() - INTERVAL '${daysThreshold} days'
        `;
        const params = [];

        if (merchantId) {
            query += ` AND merchant_id = $1`;
            params.push(merchantId);
        }

        query += ' RETURNING id, merchant_id, square_order_id';

        const result = await db.query(query, params);

        if (result.rows.length > 0) {
            logger.info('Carts marked as abandoned', {
                count: result.rows.length,
                merchantId: merchantId || 'all',
                daysThreshold
            });
        }

        return result.rows.length;
    } catch (err) {
        logger.error('Failed to mark carts as abandoned', {
            merchantId,
            error: err.message
        });
        throw err;
    }
}

/**
 * Purge old cart activity records
 * @param {number} merchantId - Merchant ID (optional, null for all merchants)
 * @param {number} daysThreshold - Days after which to delete (default: 30)
 * @returns {Promise<number>} Number of records deleted
 */
async function purgeOld(merchantId = null, daysThreshold = 30) {
    try {
        let query = `
            DELETE FROM cart_activity
            WHERE created_at < NOW() - INTERVAL '${daysThreshold} days'
        `;
        const params = [];

        if (merchantId) {
            query += ` AND merchant_id = $1`;
            params.push(merchantId);
        }

        const result = await db.query(query, params);

        if (result.rowCount > 0) {
            logger.info('Old cart activity records purged', {
                count: result.rowCount,
                merchantId: merchantId || 'all',
                daysThreshold
            });
        }

        return result.rowCount;
    } catch (err) {
        logger.error('Failed to purge old cart activity', {
            merchantId,
            error: err.message
        });
        throw err;
    }
}

/**
 * Get list of cart activity records with filters
 * @param {number} merchantId - Merchant ID
 * @param {Object} options - Query options
 * @returns {Promise<{carts: Array, total: number}>}
 */
async function getList(merchantId, options = {}) {
    const {
        status,
        startDate,
        endDate,
        limit = 50,
        offset = 0
    } = options;

    let whereConditions = ['merchant_id = $1'];
    let params = [merchantId];
    let paramIndex = 2;

    if (status) {
        whereConditions.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
    }

    if (startDate) {
        whereConditions.push(`created_at >= $${paramIndex}`);
        params.push(startDate);
        paramIndex++;
    }

    if (endDate) {
        whereConditions.push(`created_at <= $${paramIndex}`);
        params.push(endDate);
        paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const countResult = await db.query(
        `SELECT COUNT(*) as total FROM cart_activity WHERE ${whereClause}`,
        params.slice(0, paramIndex - 1)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const query = `
        SELECT
            id, square_order_id, phone_last4,
            cart_total_cents, item_count, items_json,
            source_name, fulfillment_type, status,
            created_at, updated_at, converted_at
        FROM cart_activity
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);
    const result = await db.query(query, params);

    return {
        carts: result.rows,
        total
    };
}

/**
 * Get cart activity statistics
 * @param {number} merchantId - Merchant ID
 * @param {number} days - Number of days to look back (default: 7)
 * @returns {Promise<Object>} Statistics object
 */
async function getStats(merchantId, days = 7) {
    const result = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE status = 'pending') as pending,
            COUNT(*) FILTER (WHERE status = 'converted' AND converted_at >= NOW() - INTERVAL '${days} days') as converted,
            COUNT(*) FILTER (WHERE status = 'abandoned') as abandoned,
            COUNT(*) FILTER (WHERE status = 'canceled') as canceled,
            COUNT(*) FILTER (WHERE status IN ('converted', 'abandoned', 'canceled') AND created_at >= NOW() - INTERVAL '${days} days') as total_resolved,
            AVG(cart_total_cents) FILTER (WHERE status = 'pending') as avg_pending_cart,
            AVG(cart_total_cents) FILTER (WHERE status = 'converted') as avg_converted_cart
        FROM cart_activity
        WHERE merchant_id = $1
    `, [merchantId]);

    const stats = result.rows[0];
    const totalResolved = parseInt(stats.total_resolved, 10) || 0;
    const converted = parseInt(stats.converted, 10) || 0;

    return {
        pending: parseInt(stats.pending, 10) || 0,
        converted,
        abandoned: parseInt(stats.abandoned, 10) || 0,
        canceled: parseInt(stats.canceled, 10) || 0,
        conversionRate: totalResolved > 0 ? Math.round((converted / totalResolved) * 100) : 0,
        avgPendingCartCents: Math.round(parseFloat(stats.avg_pending_cart) || 0),
        avgConvertedCartCents: Math.round(parseFloat(stats.avg_converted_cart) || 0)
    };
}

/**
 * Check if a cart activity record exists for an order
 * @param {string} squareOrderId - Square order ID
 * @param {number} merchantId - Merchant ID
 * @returns {Promise<Object|null>} Cart record or null
 */
async function getBySquareOrderId(squareOrderId, merchantId) {
    const result = await db.query(`
        SELECT * FROM cart_activity
        WHERE merchant_id = $1 AND square_order_id = $2
    `, [merchantId, squareOrderId]);

    return result.rows[0] || null;
}

module.exports = {
    createFromDraftOrder,
    markConverted,
    markCanceled,
    markAbandoned,
    purgeOld,
    getList,
    getStats,
    getBySquareOrderId,
    extractCartData
};
