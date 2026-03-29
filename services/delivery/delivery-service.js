/**
 * Delivery Scheduler Service
 * Handles delivery order management, route generation, and Square integration.
 *
 * This service was moved from utils/delivery-api.js as part of P1-3 (utils reorganization).
 * Leaf modules extracted: delivery-utils, delivery-settings, delivery-audit, delivery-gtin,
 * delivery-geocoding, delivery-pod. Re-exported here for backward compatibility.
 *
 * Usage:
 *   const { getOrders, createOrder } = require('./services/delivery');
 *   const orders = await getOrders(merchantId, { status: 'pending' });
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const crypto = require('crypto');

// Import from extracted leaf modules
const { safeJsonStringify, validateUUID, ORS_BASE_URL, ORS_API_KEY, getSquareCustomerDetails } = require('./delivery-utils');
const { getSettings, _decryptOrsKey, updateSettings } = require('./delivery-settings');
const { logAuditEvent, getAuditLog } = require('./delivery-audit');
const { enrichLineItemsWithGtin, enrichOrdersWithGtin } = require('./delivery-gtin');
const { geocodeAddress, geocodePendingOrders } = require('./delivery-geocoding');
const { savePodPhoto, getPodPhoto, cleanupExpiredPods } = require('./delivery-pod');

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
    const order = await updateOrder(merchantId, orderId, { status: 'skipped' });

    if (order) {
        await logAuditEvent(merchantId, userId, 'order_skipped', orderId, null, {
            previousStatus: 'active'
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

// =========================================================================
// ROUTE MANAGEMENT
// =========================================================================

/**
 * Get the active route for today
 * @param {number} merchantId - The merchant ID
 * @param {string} routeDate - Date string (YYYY-MM-DD), defaults to today
 * @returns {Promise<Object|null>} Active route or null
 */
async function getActiveRoute(merchantId, routeDate = null) {
    const date = routeDate || new Date().toISOString().split('T')[0];

    const result = await db.query(
        `SELECT dr.*,
                (SELECT COUNT(*) FROM delivery_orders WHERE route_id = dr.id) as order_count,
                (SELECT COUNT(*) FROM delivery_orders WHERE route_id = dr.id AND status = 'completed') as completed_count,
                (SELECT COUNT(*) FROM delivery_orders WHERE route_id = dr.id AND status = 'skipped') as skipped_count
         FROM delivery_routes dr
         WHERE dr.merchant_id = $1 AND dr.route_date = $2 AND dr.status = 'active'
         ORDER BY dr.generated_at DESC
         LIMIT 1`,
        [merchantId, date]
    );

    return result.rows[0] || null;
}

/**
 * Get route with its orders
 * @param {number} merchantId - The merchant ID
 * @param {string} routeId - The route UUID
 * @returns {Promise<Object|null>} Route with orders
 */
async function getRouteWithOrders(merchantId, routeId) {
    const routeResult = await db.query(
        `SELECT * FROM delivery_routes WHERE id = $1 AND merchant_id = $2`,
        [routeId, merchantId]
    );

    if (routeResult.rows.length === 0) {
        return null;
    }

    const route = routeResult.rows[0];
    let orders = await getOrders(merchantId, { routeId });

    // Enrich orders with GTIN data for driver view
    orders = await enrichOrdersWithGtin(merchantId, orders);

    return { ...route, orders };
}

/**
 * Generate an optimized route for pending orders
 * @param {number} merchantId - The merchant ID
 * @param {number} userId - User generating the route
 * @param {Object} options - Route generation options
 * @returns {Promise<Object>} Generated route with orders
 */
async function generateRoute(merchantId, userId, options = {}) {
    const { routeDate = null, orderIds = null, excludeOrderIds = null, startLat = null, startLng = null, endLat = null, endLng = null } = options;
    const date = routeDate || new Date().toISOString().split('T')[0];

    // Check for existing active route
    const existingRoute = await getActiveRoute(merchantId, date);
    if (existingRoute && !options.force) {
        throw new Error('An active route already exists for this date. Finish it first.');
    }

    // Get merchant settings for start/end addresses
    const settings = await getSettings(merchantId);
    if (!settings || !settings.start_address) {
        throw new Error('Start address not configured. Please update delivery settings.');
    }

    // LOGIC CHANGE: Per-route start/end coordinate overrides.
    // If valid override pair provided, use them instead of merchant defaults for this route.
    const resolvedStart = {
        lat: (startLat != null && startLng != null && isFinite(startLat) && isFinite(startLng)) ? startLat : parseFloat(settings.start_address_lat),
        lng: (startLat != null && startLng != null && isFinite(startLat) && isFinite(startLng)) ? startLng : parseFloat(settings.start_address_lng)
    };
    const resolvedEnd = {
        lat: (endLat != null && endLng != null && isFinite(endLat) && isFinite(endLng)) ? endLat : (settings.end_address_lat ? parseFloat(settings.end_address_lat) : resolvedStart.lat),
        lng: (endLat != null && endLng != null && isFinite(endLat) && isFinite(endLng)) ? endLng : (settings.end_address_lng ? parseFloat(settings.end_address_lng) : resolvedStart.lng)
    };

    // Get pending orders that need to be on the route
    let ordersQuery = `
        SELECT * FROM delivery_orders
        WHERE merchant_id = $1 AND status = 'pending'
          AND geocoded_at IS NOT NULL
    `;
    const params = [merchantId];

    if (orderIds && orderIds.length > 0) {
        params.push(orderIds);
        ordersQuery += ` AND id = ANY($${params.length})`;
    }

    // LOGIC CHANGE: Support excluding specific orders from route generation.
    // Allows merchants to hold back orders (e.g., scheduled for tomorrow, needs special transport).
    if (excludeOrderIds && excludeOrderIds.length > 0) {
        params.push(excludeOrderIds);
        ordersQuery += ` AND id != ANY($${params.length})`;
    }

    const ordersResult = await db.query(ordersQuery, params);
    const pendingOrders = ordersResult.rows;

    if (pendingOrders.length === 0) {
        throw new Error('No geocoded pending orders available for route generation.');
    }

    // Check all orders have coordinates
    const notGeocoded = pendingOrders.filter(o => !o.address_lat || !o.address_lng);
    if (notGeocoded.length > 0) {
        throw new Error(`${notGeocoded.length} orders need address verification before route generation.`);
    }

    // Optimize route using OpenRouteService
    let optimizedRoute;
    try {
        optimizedRoute = await optimizeRoute({
            ...settings,
            start_address_lat: resolvedStart.lat,
            start_address_lng: resolvedStart.lng,
            end_address_lat: resolvedEnd.lat,
            end_address_lng: resolvedEnd.lng
        }, pendingOrders);
    } catch (err) {
        logger.error('Route optimization failed', { merchantId, error: err.message });
        // Fall back to simple ordering by creation time
        optimizedRoute = {
            orderedIds: pendingOrders.map(o => o.id),
            distance: null,
            duration: null
        };
    }

    // Create route record in transaction
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Cancel any existing active routes for this date
        if (existingRoute) {
            // LOGIC CHANGE: Reset orphaned orders before cancelling route (BUG-001 fix).
            // Previously, force-regenerate cancelled the route but left its orders
            // stranded in active/skipped/delivered status with a stale route_id.

            // Step 1: Auto-complete delivered orders (they have POD photos — don't lose that work)
            await client.query(
                `UPDATE delivery_orders
                 SET status = 'completed', updated_at = NOW()
                 WHERE route_id = $1 AND status = 'delivered'`,
                [existingRoute.id]
            );

            // Step 2: Roll back active/skipped orders to pending so they re-enter the queue
            await client.query(
                `UPDATE delivery_orders
                 SET status = 'pending', route_id = NULL, route_position = NULL, route_date = NULL, updated_at = NOW()
                 WHERE route_id = $1 AND status IN ('active', 'skipped')`,
                [existingRoute.id]
            );

            await client.query(
                `UPDATE delivery_routes SET status = 'cancelled' WHERE id = $1`,
                [existingRoute.id]
            );
        }

        // Create new route (includes resolved start/end coords for audit trail)
        const routeResult = await client.query(
            `INSERT INTO delivery_routes (
                merchant_id, route_date, generated_by, total_stops,
                total_distance_km, estimated_duration_min, waypoint_order,
                start_lat, start_lng, end_lat, end_lng
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *`,
            [
                merchantId,
                date,
                userId,
                pendingOrders.length,
                optimizedRoute.distance,
                optimizedRoute.duration,
                optimizedRoute.orderedIds,
                resolvedStart.lat,
                resolvedStart.lng,
                resolvedEnd.lat,
                resolvedEnd.lng
            ]
        );
        const route = routeResult.rows[0];

        // Update orders with route info
        for (let i = 0; i < optimizedRoute.orderedIds.length; i++) {
            await client.query(
                `UPDATE delivery_orders
                 SET route_id = $1, route_position = $2, route_date = $3, status = 'active'
                 WHERE id = $4 AND merchant_id = $5`,
                [route.id, i + 1, date, optimizedRoute.orderedIds[i], merchantId]
            );
        }

        await client.query('COMMIT');

        // Log audit event
        await logAuditEvent(merchantId, userId, 'route_generated', null, route.id, {
            totalStops: pendingOrders.length,
            distanceKm: optimizedRoute.distance,
            durationMin: optimizedRoute.duration
        });

        // Return route with orders
        const orders = await getOrders(merchantId, { routeId: route.id });
        return { ...route, orders };

    } catch (err) {
        logger.error('Route generation transaction failed', { merchantId, error: err.message, stack: err.stack });
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Finish a route and roll skipped orders back to pending
 * @param {number} merchantId - The merchant ID
 * @param {string} routeId - The route UUID
 * @param {number} userId - User finishing the route
 * @returns {Promise<Object>} Finished route stats
 */
async function finishRoute(merchantId, routeId, userId) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Get route
        const routeResult = await client.query(
            `SELECT * FROM delivery_routes WHERE id = $1 AND merchant_id = $2`,
            [routeId, merchantId]
        );

        if (routeResult.rows.length === 0) {
            throw new Error('Route not found');
        }

        const route = routeResult.rows[0];
        if (route.status !== 'active') {
            throw new Error('Route is not active');
        }

        // Count completed and skipped
        const statsResult = await client.query(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
                COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
                COUNT(*) FILTER (WHERE status = 'active') as still_active
             FROM delivery_orders WHERE route_id = $1`,
            [routeId]
        );
        const stats = statsResult.rows[0];

        // LOGIC CHANGE: Auto-complete delivered orders before rollback (BUG-002 fix).
        // Previously, delivered orders (with POD photos) were ignored by finishRoute()
        // and left stranded with a stale route_id pointing to the now-finished route.
        await client.query(
            `UPDATE delivery_orders
             SET status = 'completed', updated_at = NOW()
             WHERE route_id = $1 AND status = 'delivered'`,
            [routeId]
        );

        // Roll skipped and still-active orders back to pending
        await client.query(
            `UPDATE delivery_orders
             SET status = 'pending', route_id = NULL, route_position = NULL, route_date = NULL
             WHERE route_id = $1 AND status IN ('skipped', 'active')`,
            [routeId]
        );

        // Mark route as finished
        await client.query(
            `UPDATE delivery_routes
             SET status = 'finished', finished_at = NOW()
             WHERE id = $1`,
            [routeId]
        );

        await client.query('COMMIT');

        // Log audit event
        await logAuditEvent(merchantId, userId, 'route_finished', null, routeId, {
            completed: parseInt(stats.completed),
            skipped: parseInt(stats.skipped),
            rolledBack: parseInt(stats.skipped) + parseInt(stats.still_active)
        });

        return {
            routeId,
            completed: parseInt(stats.completed),
            skipped: parseInt(stats.skipped),
            delivered: parseInt(stats.delivered),
            rolledBack: parseInt(stats.skipped) + parseInt(stats.still_active)
        };

    } catch (err) {
        logger.error('Finish route transaction failed', { merchantId, routeId, error: err.message, stack: err.stack });
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Optimize route using OpenRouteService
 * @param {Object} settings - Merchant delivery settings
 * @param {Array} orders - Orders to optimize
 * @returns {Promise<Object>} Optimized route data
 */
async function optimizeRoute(settings, orders) {
    const apiKey = settings.openrouteservice_api_key || ORS_API_KEY;

    if (!apiKey) {
        logger.warn('OpenRouteService API key not configured, using fallback ordering');
        return {
            orderedIds: orders.map(o => o.id),
            distance: null,
            duration: null
        };
    }

    // Build coordinates array: [start, ...stops, end]
    const coordinates = [];

    // Start point
    if (settings.start_address_lat && settings.start_address_lng) {
        coordinates.push([parseFloat(settings.start_address_lng), parseFloat(settings.start_address_lat)]);
    } else {
        throw new Error('Start address not geocoded');
    }

    // Order stops
    const orderCoords = orders.map(o => ({
        id: o.id,
        coords: [parseFloat(o.address_lng), parseFloat(o.address_lat)]
    }));
    coordinates.push(...orderCoords.map(o => o.coords));

    // End point (optional, defaults to start)
    if (settings.end_address_lat && settings.end_address_lng) {
        coordinates.push([parseFloat(settings.end_address_lng), parseFloat(settings.end_address_lat)]);
    } else {
        coordinates.push(coordinates[0]); // Return to start
    }

    try {
        // Use ORS optimization endpoint
        const response = await fetch(`${ORS_BASE_URL}/optimization`, {
            method: 'POST',
            headers: {
                'Authorization': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jobs: orderCoords.map((o, i) => ({
                    id: i + 1,
                    location: o.coords,
                    service: 300 // 5 min service time per stop
                })),
                vehicles: [{
                    id: 1,
                    profile: 'driving-car',
                    start: coordinates[0],
                    end: coordinates[coordinates.length - 1]
                }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ORS API error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();

        if (result.routes && result.routes.length > 0) {
            const route = result.routes[0];
            // Map step indices back to order IDs
            const orderedIds = route.steps
                .filter(s => s.type === 'job')
                .map(s => orderCoords[s.job - 1].id);

            return {
                orderedIds,
                distance: route.distance ? route.distance / 1000 : null, // Convert to km
                duration: route.duration ? Math.round(route.duration / 60) : null // Convert to min
            };
        }

        // Fallback if no routes returned
        return {
            orderedIds: orders.map(o => o.id),
            distance: null,
            duration: null
        };

    } catch (err) {
        logger.error('ORS optimization error', { error: err.message, stack: err.stack });
        throw err;
    }
}

// =========================================================================
// SQUARE INTEGRATION
// =========================================================================

/**
 * Ingest a Square order as a delivery order
 * @param {number} merchantId - The merchant ID
 * @param {Object} squareOrder - Square order data
 * @returns {Promise<Object|null>} Created delivery order or null if skipped
 */
async function ingestSquareOrder(merchantId, squareOrder) {
    // Check if already exists
    const existing = await getOrderBySquareId(merchantId, squareOrder.id);
    if (existing) {
        const updates = {};

        // Update status if Square order is now completed but ours isn't
        if (squareOrder.state === 'COMPLETED' && existing.status !== 'completed') {
            updates.status = 'completed';
            updates.squareSyncedAt = new Date();
        }

        // Backfill order data if missing
        if (!existing.square_order_data && (squareOrder.lineItems || squareOrder.line_items)) {
            const lineItems = await enrichLineItemsWithGtin(merchantId, squareOrder.lineItems || squareOrder.line_items || []);
            updates.squareOrderData = {
                lineItems,
                totalMoney: squareOrder.totalMoney || squareOrder.total_money,
                createdAt: squareOrder.createdAt || squareOrder.created_at,
                state: squareOrder.state
            };
            logger.info('Backfilling order data for existing delivery order', { merchantId, orderId: existing.id });
        }

        // Apply updates if any
        if (Object.keys(updates).length > 0) {
            await updateOrder(merchantId, existing.id, updates);
            logger.info('Updated existing delivery order', { merchantId, orderId: existing.id, updates: Object.keys(updates) });
            return { ...existing, ...updates };
        }

        logger.info('Square order already ingested - no updates needed', { merchantId, squareOrderId: squareOrder.id, existingStatus: existing.status });
        return existing;
    }

    // Extract customer info from fulfillment or tenders
    let customerName = 'Unknown Customer';
    let address = null;
    let phone = null;
    let fulfillmentNote = null;

    // Check fulfillments for delivery info
    // Note: Square SDK v43 uses camelCase, older versions use snake_case
    if (squareOrder.fulfillments && squareOrder.fulfillments.length > 0) {
        const fulfillment = squareOrder.fulfillments.find(f =>
            f.type === 'DELIVERY' || f.type === 'SHIPMENT'
        ) || squareOrder.fulfillments[0];

        // Handle both camelCase (v43+) and snake_case (older) property names
        const deliveryDetails = fulfillment.deliveryDetails || fulfillment.delivery_details;
        const shipmentDetails = fulfillment.shipmentDetails || fulfillment.shipment_details;

        if (deliveryDetails) {
            const dd = deliveryDetails;
            customerName = dd.recipient?.displayName || dd.recipient?.display_name || customerName;
            phone = dd.recipient?.phoneNumber || dd.recipient?.phone_number;
            // Capture per-order delivery instructions from checkout (Square Online "Delivery Instructions" field)
            fulfillmentNote = dd.note || null;
            if (dd.recipient?.address) {
                const addr = dd.recipient.address;
                address = [
                    addr.addressLine1 || addr.address_line_1,
                    addr.addressLine2 || addr.address_line_2,
                    addr.locality,
                    addr.administrativeDistrictLevel1 || addr.administrative_district_level_1,
                    addr.postalCode || addr.postal_code,
                    addr.country
                ].filter(Boolean).join(', ');
            }
        } else if (shipmentDetails) {
            const sd = shipmentDetails;
            customerName = sd.recipient?.displayName || sd.recipient?.display_name || customerName;
            phone = sd.recipient?.phoneNumber || sd.recipient?.phone_number;
            if (sd.recipient?.address) {
                const addr = sd.recipient.address;
                address = [
                    addr.addressLine1 || addr.address_line_1,
                    addr.addressLine2 || addr.address_line_2,
                    addr.locality,
                    addr.administrativeDistrictLevel1 || addr.administrative_district_level_1,
                    addr.postalCode || addr.postal_code,
                    addr.country
                ].filter(Boolean).join(', ');
            }
        }
    }

    if (!address) {
        logger.warn('Square order has no delivery address - skipping', {
            merchantId,
            squareOrderId: squareOrder.id,
            fulfillmentTypes: squareOrder.fulfillments?.map(f => f.type),
            customerName
        });
        return null;
    }

    // Determine initial status based on Square order state
    // If Square order is already COMPLETED, mark ours as completed too
    const initialStatus = squareOrder.state === 'COMPLETED' ? 'completed' : 'pending';

    // Extract customer ID from Square order (camelCase for SDK v43+)
    const squareCustomerId = squareOrder.customerId || squareOrder.customer_id || null;

    // FALLBACK: If customer name/phone missing but we have customer ID, look up from Square API
    // This fixes "Unknown Customer" when webhook data has incomplete fulfillment recipient
    if ((customerName === 'Unknown Customer' || !phone) && squareCustomerId) {
        try {
            const customerDetails = await getSquareCustomerDetails(squareCustomerId, merchantId);

            if (customerDetails) {
                if (customerName === 'Unknown Customer' && customerDetails.displayName) {
                    customerName = customerDetails.displayName;
                    logger.info('Resolved customer name via Square API lookup', {
                        merchantId,
                        squareOrderId: squareOrder.id,
                        squareCustomerId,
                        customerName
                    });
                }
                if (!phone && customerDetails.phone) {
                    phone = customerDetails.phone;
                    logger.info('Resolved customer phone via Square API lookup', {
                        merchantId,
                        squareOrderId: squareOrder.id,
                        squareCustomerId,
                        hasPhone: true
                    });
                }
            }
        } catch (lookupError) {
            // Don't fail order ingestion if customer lookup fails
            logger.warn('Customer lookup failed during delivery ingestion', {
                merchantId,
                squareOrderId: squareOrder.id,
                squareCustomerId,
                error: lookupError.message
            });
        }
    }

    // Extract relevant order data for driver reference (line items, totals, etc.)
    const lineItems = await enrichLineItemsWithGtin(merchantId, squareOrder.lineItems || squareOrder.line_items || []);
    const squareOrderData = {
        lineItems,
        totalMoney: squareOrder.totalMoney || squareOrder.total_money,
        createdAt: squareOrder.createdAt || squareOrder.created_at,
        state: squareOrder.state
    };

    // Track Square order state for refresh logic
    const squareOrderState = squareOrder.state;

    // Flag orders that need customer refresh when state changes
    // DRAFT orders often have incomplete fulfillment data that gets populated when OPEN
    const needsCustomerRefresh = (
        squareOrderState === 'DRAFT' ||
        customerName === 'Unknown Customer' ||
        (!phone && !squareCustomerId)
    );

    if (needsCustomerRefresh) {
        logger.info('Delivery order needs customer refresh', {
            merchantId,
            squareOrderId: squareOrder.id,
            squareOrderState,
            customerName,
            hasPhone: !!phone,
            hasCustomerId: !!squareCustomerId
        });
    }

    // Create delivery order
    const order = await createOrder(merchantId, {
        squareOrderId: squareOrder.id,
        squareCustomerId,
        customerName,
        address,
        phone,
        notes: squareOrder.note || null,  // Order-level note (staff-visible)
        customerNote: fulfillmentNote,    // Per-order checkout delivery instructions (delivery_details.note)
        status: initialStatus,
        squareOrderData,
        squareOrderState,
        needsCustomerRefresh
    });

    // Geocode the address immediately so it's ready for routing
    try {
        const settings = await getSettings(merchantId);
        const coords = await geocodeAddress(address, settings?.openrouteservice_api_key);

        if (coords) {
            await updateOrder(merchantId, order.id, {
                addressLat: coords.lat,
                addressLng: coords.lng,
                geocodedAt: new Date()
            });
            logger.info('Geocoded delivery order', { orderId: order.id, address });
        } else {
            logger.warn('Failed to geocode address', { orderId: order.id, address });
        }
    } catch (geoError) {
        // Don't fail the order creation if geocoding fails
        logger.error('Geocoding error', { orderId: order.id, address, error: geoError.message });
    }

    return order;
}

/**
 * Handle Square order status change
 * @param {number} merchantId - The merchant ID
 * @param {string} squareOrderId - Square order ID
 * @param {string} newState - New Square order state
 */
async function handleSquareOrderUpdate(merchantId, squareOrderId, newState) {
    const order = await getOrderBySquareId(merchantId, squareOrderId);

    if (!order) {
        return; // Not a delivery order we're tracking
    }

    // If Square order is completed or cancelled, mark our order accordingly
    if (newState === 'COMPLETED') {
        if (order.status !== 'completed') {
            await updateOrder(merchantId, order.id, {
                status: 'completed',
                squareSyncedAt: new Date()
            });
            logger.info('Marked delivery order completed from Square', {
                merchantId,
                orderId: order.id,
                squareOrderId
            });
        }
    } else if (newState === 'CANCELED') {
        // LOGIC CHANGE: Expand cancellation to include skipped/delivered (BUG-003 fix).
        // Previously only pending/active orders were deleted, leaving skipped/delivered
        // orders as zombie records for cancelled Square orders.
        if (['pending', 'active', 'skipped', 'delivered'].includes(order.status)) {
            await db.query(
                `DELETE FROM delivery_orders WHERE id = $1 AND merchant_id = $2`,
                [order.id, merchantId]
            );
            logger.info('Removed cancelled Square order from delivery queue', {
                merchantId,
                orderId: order.id,
                squareOrderId
            });
        }
    }
}

// =========================================================================
// ROUTE SHARING TOKENS (for contract drivers)
// =========================================================================

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
    const order = await getOrderById(tokenData.merchant_id, orderId);
    if (!order || order.route_id !== tokenData.route_id) {
        throw new Error('Order not found on this route');
    }

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

/**
 * Backfill customer data for orders with "Unknown Customer"
 * Looks up customer details from Square API using square_customer_id
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object>} Results summary
 */
async function backfillUnknownCustomers(merchantId) {
    // Find orders with "Unknown Customer" that have a square_customer_id
    const ordersToFix = await db.query(`
        SELECT id, square_customer_id, customer_name, phone
        FROM delivery_orders
        WHERE merchant_id = $1
          AND customer_name = 'Unknown Customer'
          AND square_customer_id IS NOT NULL
          AND status NOT IN ('completed', 'cancelled')
        ORDER BY created_at DESC
        LIMIT 100
    `, [merchantId]);

    if (ordersToFix.rows.length === 0) {
        // LOGIC CHANGE: Include `total` field to match the shape returned on the
        // non-empty path. Previously callers expecting `total` would get undefined.
        return { updated: 0, failed: 0, total: 0, message: 'No orders with Unknown Customer found' };
    }

    logger.info('Starting customer backfill for delivery orders', {
        merchantId,
        ordersToFix: ordersToFix.rows.length
    });

    let updated = 0;
    let failed = 0;

    for (const order of ordersToFix.rows) {
        try {
            const customerDetails = await getSquareCustomerDetails(order.square_customer_id, merchantId);

            if (customerDetails) {
                const updates = {};
                if (customerDetails.displayName) {
                    updates.customerName = customerDetails.displayName;
                }
                if (!order.phone && customerDetails.phone) {
                    updates.phone = customerDetails.phone;
                }

                if (Object.keys(updates).length > 0) {
                    await updateOrder(merchantId, order.id, updates);
                    updated++;
                    logger.info('Backfilled customer data for delivery order', {
                        merchantId,
                        orderId: order.id,
                        squareCustomerId: order.square_customer_id,
                        updates: Object.keys(updates)
                    });
                }
            }
        } catch (error) {
            failed++;
            logger.warn('Failed to backfill customer for order', {
                merchantId,
                orderId: order.id,
                error: error.message
            });
        }
    }

    return {
        updated,
        failed,
        total: ordersToFix.rows.length,
        message: `Updated ${updated} orders, ${failed} failed`
    };
}

module.exports = {
    // Orders
    getOrders,
    getOrderById,
    getOrderBySquareId,
    createOrder,
    updateOrder,
    deleteOrder,
    skipOrder,
    markDelivered,
    completeOrder,

    // Routes
    getActiveRoute,
    getRouteWithOrders,
    generateRoute,
    finishRoute,

    // Geocoding
    geocodeAddress,
    geocodePendingOrders,

    // POD
    savePodPhoto,
    getPodPhoto,
    cleanupExpiredPods,

    // Settings
    getSettings,
    updateSettings,

    // Audit
    logAuditEvent,
    getAuditLog,

    // Square integration
    ingestSquareOrder,
    handleSquareOrderUpdate,
    backfillUnknownCustomers,

    // Route sharing tokens
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
