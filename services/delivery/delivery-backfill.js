/**
 * Delivery Customer Backfill Service
 * Resolves "Unknown Customer" entries via Square API lookup.
 *
 * Extracted from delivery-service.js as part of Phase 4b module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getCustomerDetails: getSquareCustomerDetails } = require('../loyalty-admin/customer-details-service');
const { updateOrder } = require('./delivery-orders');

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
    backfillUnknownCustomers
};
