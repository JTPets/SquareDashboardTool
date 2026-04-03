/**
 * Delivery Routes Service
 * Route generation, optimization, and management.
 *
 * Extracted from delivery-service.js as part of Phase 4b module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { ORS_BASE_URL, ORS_API_KEY } = require('./delivery-utils');
const { getSettings } = require('./delivery-settings');
const { logAuditEvent } = require('./delivery-audit');
const { enrichOrdersWithGtin } = require('./delivery-gtin');
const { getOrders } = require('./delivery-orders');

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

    // Reset stale skipped orders (from finished/cancelled/previous-day routes) back to pending.
    // This handles the case where a driver skipped orders but the route was never explicitly
    // finished — those orders must re-enter the queue for the next route.
    await db.query(
        `UPDATE delivery_orders
         SET status = 'pending', route_id = NULL, route_position = NULL, route_date = NULL, updated_at = NOW()
         WHERE merchant_id = $1
           AND status = 'skipped'
           AND (route_id IS NULL OR route_id NOT IN (
               SELECT id FROM delivery_routes WHERE status = 'active' AND merchant_id = $1
           ))`,
        [merchantId]
    );

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
    if (!routeId) {
        const active = await getActiveRoute(merchantId);
        if (!active) {
            const err = new Error('No active route found');
            err.status = 400;
            throw err;
        }
        routeId = active.id;
    }

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

/**
 * Get the active route for a date together with its GTIN-enriched orders.
 * Combines getActiveRoute + getRouteWithOrders for use by the route handler.
 * @param {number} merchantId
 * @param {string} [routeDate] - Defaults to today
 * @returns {Promise<{route: Object|null, orders: Array}>}
 */
async function getActiveRouteWithOrders(merchantId, routeDate) {
    const route = await getActiveRoute(merchantId, routeDate);
    if (!route) return { route: null, orders: [] };
    const routeWithOrders = await getRouteWithOrders(merchantId, route.id);
    const orders = routeWithOrders?.orders || [];
    return { route, orders };
}

module.exports = {
    getActiveRoute,
    getRouteWithOrders,
    generateRoute,
    finishRoute,
    optimizeRoute,
    getActiveRouteWithOrders
};
