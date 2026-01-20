/**
 * Delivery Scheduler API Module
 * Handles delivery order management, route generation, and POD functionality
 *
 * Usage:
 *   const deliveryApi = require('./utils/delivery-api');
 *   const orders = await deliveryApi.getOrders(merchantId, { status: 'pending' });
 */

const db = require('./database');
const logger = require('./logger');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// POD storage directory (relative to app root)
const POD_STORAGE_DIR = process.env.POD_STORAGE_DIR || 'storage/pod';

// OpenRouteService configuration
const ORS_BASE_URL = 'https://api.openrouteservice.org';
const ORS_API_KEY = process.env.OPENROUTESERVICE_API_KEY;

// UUID validation regex (for security - validate IDs before use)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Safely stringify objects containing BigInt values
 * Square SDK returns BigInt for money amounts which JSON.stringify can't handle
 * @param {*} obj - Object to stringify
 * @returns {string} JSON string
 */
function safeJsonStringify(obj) {
    return JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? Number(value) : value
    );
}

/**
 * Validate UUID format
 * @param {string} id - ID to validate
 * @param {string} fieldName - Field name for error message
 * @throws {Error} If ID is not a valid UUID
 */
function validateUUID(id, fieldName = 'ID') {
    if (!id || !UUID_REGEX.test(id)) {
        throw new Error(`Invalid ${fieldName} format`);
    }
}

/**
 * Look up GTINs (UPCs) for line items from our catalog at INGEST time
 * Uses catalogObjectId (variation ID) from Square order data
 * @param {number} merchantId - The merchant ID
 * @param {Array} lineItems - Square order line items (with catalogObjectId)
 * @returns {Promise<Array>} Line items enriched with GTIN
 */
async function enrichLineItemsWithGtin(merchantId, lineItems) {
    if (!lineItems || lineItems.length === 0) {
        return [];
    }

    // Extract variation IDs from line items (catalogObjectId is the variation ID)
    const variationIds = lineItems
        .map(item => item.catalogObjectId || item.catalog_object_id)
        .filter(Boolean);

    // Batch lookup UPCs from our variations table
    let upcMap = new Map();
    if (variationIds.length > 0) {
        try {
            const result = await db.query(
                `SELECT id, upc FROM variations WHERE merchant_id = $1 AND id = ANY($2)`,
                [merchantId, variationIds]
            );
            result.rows.forEach(row => {
                if (row.upc) {
                    upcMap.set(row.id, row.upc);
                }
            });
        } catch (err) {
            logger.warn('Failed to lookup GTINs for line items', { merchantId, error: err.message });
        }
    }

    // Map line items with GTIN
    return lineItems.map(item => {
        const variationId = item.catalogObjectId || item.catalog_object_id;
        return {
            name: item.name,
            quantity: item.quantity,
            variationName: item.variationName || item.variation_name,
            note: item.note,
            gtin: variationId ? upcMap.get(variationId) || null : null,
            modifiers: (item.modifiers || []).map(m => ({
                name: m.name,
                quantity: m.quantity
            }))
        };
    });
}

/**
 * Enrich orders with GTIN data at READ time
 * Uses variation name matching for orders that don't have catalogObjectId stored
 * @param {number} merchantId - The merchant ID
 * @param {Array} orders - Array of delivery orders
 * @returns {Promise<Array>} Orders with lineItems enriched with GTIN
 */
async function enrichOrdersWithGtin(merchantId, orders) {
    if (!orders || orders.length === 0) {
        return orders;
    }

    // Collect all unique variation names from all orders
    const variationNames = new Set();
    for (const order of orders) {
        const lineItems = order.square_order_data?.lineItems || [];
        for (const item of lineItems) {
            // Skip if already has GTIN
            if (item.gtin) continue;
            // Use variation name for lookup
            if (item.variationName) {
                variationNames.add(item.variationName);
            }
        }
    }

    if (variationNames.size === 0) {
        return orders;
    }

    // Batch lookup UPCs by variation name
    let upcMap = new Map();
    try {
        const result = await db.query(
            `SELECT name, upc FROM variations WHERE merchant_id = $1 AND name = ANY($2) AND upc IS NOT NULL`,
            [merchantId, Array.from(variationNames)]
        );
        result.rows.forEach(row => {
            if (row.upc) {
                upcMap.set(row.name, row.upc);
            }
        });
    } catch (err) {
        logger.warn('Failed to lookup GTINs for orders', { merchantId, error: err.message });
        return orders;
    }

    // Enrich orders with GTIN
    return orders.map(order => {
        if (!order.square_order_data?.lineItems) {
            return order;
        }

        const enrichedLineItems = order.square_order_data.lineItems.map(item => ({
            ...item,
            gtin: item.gtin || (item.variationName ? upcMap.get(item.variationName) : null) || null
        }));

        return {
            ...order,
            square_order_data: {
                ...order.square_order_data,
                lineItems: enrichedLineItems
            }
        };
    });
}

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
        includeCompleted = false,
        limit = 100,
        offset = 0
    } = options;

    let query = `
        SELECT
            dord.*,
            dp.id as pod_id,
            dp.photo_path as pod_photo_path,
            dp.captured_at as pod_captured_at
        FROM delivery_orders dord
        LEFT JOIN delivery_pod dp ON dp.delivery_order_id = dord.id
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

    query += ` ORDER BY dord.route_position NULLS LAST, dord.created_at ASC`;
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
        squareOrderData = null
    } = orderData;

    const result = await db.query(
        `INSERT INTO delivery_orders (
            merchant_id, square_order_id, square_customer_id, customer_name, address,
            address_lat, address_lng, phone, notes, customer_note, status,
            geocoded_at, square_order_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
            merchantId, squareOrderId, squareCustomerId, customerName, address,
            addressLat, addressLng, phone, notes, customerNote, status,
            addressLat && addressLng ? new Date() : null,
            squareOrderData ? safeJsonStringify(squareOrderData) : null
        ]
    );

    logger.info('Created delivery order', {
        merchantId,
        orderId: result.rows[0].id,
        squareOrderId,
        squareCustomerId
    });

    return result.rows[0];
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
        'square_order_data'
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
    const { routeDate = null, orderIds = null } = options;
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

    // Get pending orders that need to be on the route
    let ordersQuery = `
        SELECT * FROM delivery_orders
        WHERE merchant_id = $1 AND status = 'pending'
          AND geocoded_at IS NOT NULL
    `;
    const params = [merchantId];

    if (orderIds && orderIds.length > 0) {
        ordersQuery += ` AND id = ANY($2)`;
        params.push(orderIds);
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
        optimizedRoute = await optimizeRoute(settings, pendingOrders);
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
            await client.query(
                `UPDATE delivery_routes SET status = 'cancelled' WHERE id = $1`,
                [existingRoute.id]
            );
        }

        // Create new route
        const routeResult = await client.query(
            `INSERT INTO delivery_routes (
                merchant_id, route_date, generated_by, total_stops,
                total_distance_km, estimated_duration_min, waypoint_order
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *`,
            [
                merchantId,
                date,
                userId,
                pendingOrders.length,
                optimizedRoute.distance,
                optimizedRoute.duration,
                optimizedRoute.orderedIds
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
// GEOCODING
// =========================================================================

/**
 * Geocode an address using OpenRouteService
 * @param {string} address - The address to geocode
 * @param {string} apiKey - Optional API key override
 * @returns {Promise<Object|null>} Coordinates { lat, lng } or null
 */
async function geocodeAddress(address, apiKey = null) {
    const key = apiKey || ORS_API_KEY;

    if (!key) {
        logger.warn('OpenRouteService API key not configured for geocoding');
        return null;
    }

    try {
        const encodedAddress = encodeURIComponent(address);
        const response = await fetch(
            `${ORS_BASE_URL}/geocode/search?api_key=${key}&text=${encodedAddress}&size=1`,
            { method: 'GET' }
        );

        if (!response.ok) {
            logger.error('Geocoding API error', { status: response.status, address });
            return null;
        }

        const result = await response.json();

        if (result.features && result.features.length > 0) {
            const coords = result.features[0].geometry.coordinates;
            return {
                lng: coords[0],
                lat: coords[1],
                confidence: result.features[0].properties.confidence
            };
        }

        return null;

    } catch (err) {
        logger.error('Geocoding error', { error: err.message, address });
        return null;
    }
}

/**
 * Geocode pending orders that don't have coordinates
 * @param {number} merchantId - The merchant ID
 * @param {number} limit - Max orders to geocode in one batch
 * @returns {Promise<Object>} Geocoding results
 */
async function geocodePendingOrders(merchantId, limit = 10) {
    const settings = await getSettings(merchantId);
    const apiKey = settings?.openrouteservice_api_key || ORS_API_KEY;

    const ordersResult = await db.query(
        `SELECT id, address FROM delivery_orders
         WHERE merchant_id = $1 AND geocoded_at IS NULL
         ORDER BY created_at ASC
         LIMIT $2`,
        [merchantId, limit]
    );

    const results = { success: 0, failed: 0, orders: [] };

    for (const order of ordersResult.rows) {
        const coords = await geocodeAddress(order.address, apiKey);

        if (coords && coords.lat && coords.lng) {
            await db.query(
                `UPDATE delivery_orders
                 SET address_lat = $1, address_lng = $2, geocoded_at = NOW()
                 WHERE id = $3`,
                [coords.lat, coords.lng, order.id]
            );
            results.success++;
            results.orders.push({ id: order.id, status: 'success', coords });
        } else {
            results.failed++;
            results.orders.push({ id: order.id, status: 'failed', address: order.address });
        }

        // Rate limit: wait 100ms between requests
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
}

// =========================================================================
// PROOF OF DELIVERY
// =========================================================================

/**
 * Save a POD photo
 * @param {number} merchantId - The merchant ID
 * @param {string} orderId - The delivery order UUID
 * @param {Buffer} photoBuffer - Photo file buffer
 * @param {Object} metadata - Photo metadata
 * @returns {Promise<Object>} Created POD record
 */
async function savePodPhoto(merchantId, orderId, photoBuffer, metadata = {}) {
    const {
        originalFilename = 'pod.jpg',
        mimeType = 'image/jpeg',
        latitude = null,
        longitude = null
    } = metadata;

    // Validate orderId is a valid UUID format (security)
    validateUUID(orderId, 'order ID');

    // Validate image magic bytes (prevent MIME type spoofing)
    const magicBytes = photoBuffer.slice(0, 12);
    const isJpeg = magicBytes[0] === 0xFF && magicBytes[1] === 0xD8 && magicBytes[2] === 0xFF;
    const isPng = magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4E && magicBytes[3] === 0x47;
    const isGif = magicBytes[0] === 0x47 && magicBytes[1] === 0x49 && magicBytes[2] === 0x46;
    const isWebp = magicBytes[8] === 0x57 && magicBytes[9] === 0x45 && magicBytes[10] === 0x42 && magicBytes[11] === 0x50;

    if (!isJpeg && !isPng && !isGif && !isWebp) {
        throw new Error('Invalid image file - file content does not match image format');
    }

    // Verify order belongs to merchant
    const order = await getOrderById(merchantId, orderId);
    if (!order) {
        throw new Error('Order not found');
    }

    // Get retention settings
    const settings = await getSettings(merchantId);
    const retentionDays = settings?.pod_retention_days || 180;

    // Generate unique filename with merchant namespace
    // Use only safe extension based on detected type, not user input
    const fileId = crypto.randomUUID();
    const safeExt = isJpeg ? '.jpg' : isPng ? '.png' : isGif ? '.gif' : '.webp';
    const relativePath = `${merchantId}/${orderId}/${fileId}${safeExt}`;
    const fullPath = path.join(process.cwd(), POD_STORAGE_DIR, relativePath);

    // Ensure directory exists
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, photoBuffer);

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);

    // Create POD record
    const result = await db.query(
        `INSERT INTO delivery_pod (
            delivery_order_id, photo_path, original_filename,
            file_size_bytes, mime_type, latitude, longitude, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
            orderId, relativePath, originalFilename,
            photoBuffer.length, mimeType, latitude, longitude, expiresAt
        ]
    );

    // Update order status to delivered
    await updateOrder(merchantId, orderId, { status: 'delivered' });

    logger.info('Saved POD photo', { merchantId, orderId, podId: result.rows[0].id });

    return result.rows[0];
}

/**
 * Get POD photo path for serving
 * @param {number} merchantId - The merchant ID
 * @param {string} podId - The POD UUID
 * @returns {Promise<Object|null>} POD record with full path
 */
async function getPodPhoto(merchantId, podId) {
    // Validate UUID format (security)
    validateUUID(podId, 'POD ID');

    const result = await db.query(
        `SELECT dp.*, dord.merchant_id
         FROM delivery_pod dp
         JOIN delivery_orders dord ON dord.id = dp.delivery_order_id
         WHERE dp.id = $1 AND dord.merchant_id = $2`,
        [podId, merchantId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const pod = result.rows[0];
    pod.full_path = path.join(process.cwd(), POD_STORAGE_DIR, pod.photo_path);

    return pod;
}

/**
 * Clean up expired POD photos
 * @returns {Promise<Object>} Cleanup stats
 */
async function cleanupExpiredPods() {
    const expiredResult = await db.query(
        `SELECT dp.*, dord.merchant_id
         FROM delivery_pod dp
         JOIN delivery_orders dord ON dord.id = dp.delivery_order_id
         WHERE dp.expires_at < NOW()`
    );

    let deleted = 0;
    let errors = 0;

    for (const pod of expiredResult.rows) {
        try {
            const fullPath = path.join(process.cwd(), POD_STORAGE_DIR, pod.photo_path);
            await fs.unlink(fullPath);
            await db.query('DELETE FROM delivery_pod WHERE id = $1', [pod.id]);
            deleted++;
        } catch (err) {
            if (err.code !== 'ENOENT') {
                logger.error('Failed to delete expired POD', { podId: pod.id, error: err.message });
                errors++;
            } else {
                // File already gone, just delete record
                await db.query('DELETE FROM delivery_pod WHERE id = $1', [pod.id]);
                deleted++;
            }
        }
    }

    logger.info('POD cleanup complete', { deleted, errors });
    return { deleted, errors };
}

// =========================================================================
// SETTINGS
// =========================================================================

/**
 * Get delivery settings for a merchant
 * @param {number} merchantId - The merchant ID
 * @returns {Promise<Object|null>} Settings or null
 */
async function getSettings(merchantId) {
    const result = await db.query(
        `SELECT * FROM delivery_settings WHERE merchant_id = $1`,
        [merchantId]
    );
    return result.rows[0] || null;
}

/**
 * Update delivery settings for a merchant
 * @param {number} merchantId - The merchant ID
 * @param {Object} settings - Settings to update
 * @returns {Promise<Object>} Updated settings
 */
async function updateSettings(merchantId, settings) {
    const {
        startAddress = null,
        startAddressLat = null,
        startAddressLng = null,
        endAddress = null,
        endAddressLat = null,
        endAddressLng = null,
        sameDayCutoff = null,
        podRetentionDays = null,
        autoIngestReadyOrders = null,
        openrouteserviceApiKey = null
    } = settings;

    const result = await db.query(
        `INSERT INTO delivery_settings (
            merchant_id, start_address, start_address_lat, start_address_lng,
            end_address, end_address_lat, end_address_lng,
            same_day_cutoff, pod_retention_days, auto_ingest_ready_orders,
            openrouteservice_api_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (merchant_id) DO UPDATE SET
            start_address = COALESCE($2, delivery_settings.start_address),
            start_address_lat = COALESCE($3, delivery_settings.start_address_lat),
            start_address_lng = COALESCE($4, delivery_settings.start_address_lng),
            end_address = COALESCE($5, delivery_settings.end_address),
            end_address_lat = COALESCE($6, delivery_settings.end_address_lat),
            end_address_lng = COALESCE($7, delivery_settings.end_address_lng),
            same_day_cutoff = COALESCE($8, delivery_settings.same_day_cutoff),
            pod_retention_days = COALESCE($9, delivery_settings.pod_retention_days),
            auto_ingest_ready_orders = COALESCE($10, delivery_settings.auto_ingest_ready_orders),
            openrouteservice_api_key = COALESCE($11, delivery_settings.openrouteservice_api_key),
            updated_at = NOW()
        RETURNING *`,
        [
            merchantId, startAddress, startAddressLat, startAddressLng,
            endAddress, endAddressLat, endAddressLng,
            sameDayCutoff, podRetentionDays, autoIngestReadyOrders,
            openrouteserviceApiKey
        ]
    );

    logger.info('Updated delivery settings', { merchantId });
    return result.rows[0];
}

// =========================================================================
// AUDIT LOGGING
// =========================================================================

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

    // Extract relevant order data for driver reference (line items, totals, etc.)
    const lineItems = await enrichLineItemsWithGtin(merchantId, squareOrder.lineItems || squareOrder.line_items || []);
    const squareOrderData = {
        lineItems,
        totalMoney: squareOrder.totalMoney || squareOrder.total_money,
        createdAt: squareOrder.createdAt || squareOrder.created_at,
        state: squareOrder.state
    };

    // Create delivery order
    const order = await createOrder(merchantId, {
        squareOrderId: squareOrder.id,
        squareCustomerId,
        customerName,
        address,
        phone,
        notes: squareOrder.note || null,  // Order-specific notes
        status: initialStatus,
        squareOrderData
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
        // Remove from queue if not yet delivered
        if (['pending', 'active'].includes(order.status)) {
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
    handleSquareOrderUpdate
};
