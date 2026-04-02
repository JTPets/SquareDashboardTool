/**
 * Delivery Auto-Finish Job
 *
 * BACKLOG-116: Drivers forget to hit "finish route." Stale active routes
 * trap orders and prevent rescheduling.
 *
 * Two scheduled tasks:
 *  1. Auto-finish stale active routes (nightly at 11 PM ET)
 *     - Finds routes with status='active' created before today
 *     - Resets skipped/active orders to pending (unscheduled)
 *     - Completes delivered orders, then marks route finished
 *
 *  2. Retention cleanup (weekly)
 *     - Deletes finished/cancelled routes older than DELIVERY_RETENTION_DAYS
 *     - Deletes associated completed/delivered/skipped/cancelled orders first
 *     - Never deletes active/pending data or unscheduled pending orders
 *
 * @module jobs/delivery-auto-finish-job
 */

const logger = require('../utils/logger');
const db = require('../utils/database');

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Auto-finish all stale active routes (created before today, across all merchants).
 *
 * @returns {Promise<Object>} { routesFinished, ordersReset, errors }
 */
async function runDeliveryAutoFinish() {
    logger.info('Starting delivery auto-finish job');

    try {
        const result = await autoFinishStaleRoutes();
        logger.info('Delivery auto-finish job completed', result);
        return result;
    } catch (err) {
        logger.error('Delivery auto-finish job failed', { error: err.message, stack: err.stack });
        return { routesFinished: 0, ordersReset: 0, errors: 1 };
    }
}

/**
 * Run retention cleanup — delete old finished/cancelled routes and their orders.
 *
 * @returns {Promise<Object>} { routesDeleted, ordersDeleted, errors }
 */
async function runDeliveryRetentionCleanup() {
    logger.info('Starting delivery retention cleanup job');

    try {
        const result = await cleanupOldRoutes();
        logger.info('Delivery retention cleanup job completed', result);
        return result;
    } catch (err) {
        logger.error('Delivery retention cleanup job failed', { error: err.message, stack: err.stack });
        return { routesDeleted: 0, ordersDeleted: 0, errors: 1 };
    }
}

async function autoFinishStaleRoutes() {
    const staleResult = await db.query(
        `SELECT id, merchant_id FROM delivery_routes
         WHERE status = 'active' AND created_at::date < CURRENT_DATE`
    );

    const staleRoutes = staleResult.rows;
    if (staleRoutes.length === 0) {
        logger.info('No stale delivery routes found');
        return { routesFinished: 0, ordersReset: 0 };
    }

    let routesFinished = 0;
    let ordersReset = 0;

    for (const route of staleRoutes) {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');

            // Promote delivered orders (POD photos taken) to completed
            await client.query(
                `UPDATE delivery_orders SET status = 'completed', updated_at = NOW()
                 WHERE route_id = $1 AND status = 'delivered'`,
                [route.id]
            );

            // Reset skipped/active orders to pending so they can be rescheduled
            const resetResult = await client.query(
                `UPDATE delivery_orders
                 SET status = 'pending', route_id = NULL,
                     route_position = NULL, route_date = NULL, updated_at = NOW()
                 WHERE route_id = $1 AND status IN ('skipped', 'active')`,
                [route.id]
            );

            await client.query(
                `UPDATE delivery_routes SET status = 'finished', finished_at = NOW()
                 WHERE id = $1`,
                [route.id]
            );

            await client.query('COMMIT');
            routesFinished++;
            ordersReset += resetResult.rowCount;
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Failed to auto-finish route', {
                routeId: route.id, merchantId: route.merchant_id, error: err.message
            });
        } finally {
            client.release();
        }
    }

    logger.info(`Auto-finished ${routesFinished} stale routes, reset ${ordersReset} orders to pending`);
    return { routesFinished, ordersReset };
}

async function cleanupOldRoutes() {
    const retentionDays = parseInt(process.env.DELIVERY_RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS;

    const routeResult = await db.query(
        `SELECT id FROM delivery_routes
         WHERE status IN ('finished', 'cancelled')
           AND created_at < NOW() - ($1 * INTERVAL '1 day')`,
        [retentionDays]
    );

    const routeIds = routeResult.rows.map(r => r.id);
    if (routeIds.length === 0) {
        logger.info('No old delivery routes to clean up');
        return { routesDeleted: 0, ordersDeleted: 0 };
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Delete non-active orders on those routes first
        const ordersResult = await client.query(
            `DELETE FROM delivery_orders
             WHERE route_id = ANY($1)
               AND status IN ('completed', 'delivered', 'skipped', 'cancelled')`,
            [routeIds]
        );

        const routesResult = await client.query(
            `DELETE FROM delivery_routes WHERE id = ANY($1)`,
            [routeIds]
        );

        await client.query('COMMIT');

        const ordersDeleted = ordersResult.rowCount;
        const routesDeleted = routesResult.rowCount;
        logger.info(`Cleaned ${routesDeleted} routes and ${ordersDeleted} orders older than ${retentionDays} days`);
        return { routesDeleted, ordersDeleted };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function runScheduledDeliveryAutoFinish() {
    await runDeliveryAutoFinish();
}

async function runScheduledDeliveryRetentionCleanup() {
    await runDeliveryRetentionCleanup();
}

module.exports = {
    runDeliveryAutoFinish,
    runDeliveryRetentionCleanup,
    runScheduledDeliveryAutoFinish,
    runScheduledDeliveryRetentionCleanup
};
