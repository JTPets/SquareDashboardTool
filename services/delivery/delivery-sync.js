/**
 * Delivery Sync Service
 *
 * Backfills delivery orders from Square for a date range.
 * Extracted from routes/delivery.js POST /sync handler.
 */

const logger = require('../../utils/logger');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const { getLocationIds } = require('./delivery-stats');
const { getOrderBySquareId, updateOrder } = require('./delivery-orders');
const { ingestSquareOrder } = require('./delivery-square');

/**
 * Sync open and recently-completed Square orders with delivery/shipment
 * fulfillments into the local delivery queue.
 *
 * @param {number} merchantId
 * @param {number} [daysBack=7] - How many days back to search
 * @returns {Promise<{found: number, imported: number, skipped: number, errors?: Array}>}
 */
async function syncSquareOrders(merchantId, daysBack = 7) {
    const squareClient = await getSquareClientForMerchant(merchantId);
    const locationIds = await getLocationIds(merchantId);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const searchResponse = await squareClient.orders.search({
        locationIds,
        query: {
            filter: {
                dateTimeFilter: { createdAt: { startAt: startDate.toISOString() } },
                stateFilter: { states: ['OPEN', 'COMPLETED'] },
                fulfillmentFilter: { fulfillmentTypes: ['DELIVERY', 'SHIPMENT'] }
            },
            sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' }
        },
        limit: 100
    });

    const orders = searchResponse.orders || [];
    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const order of orders) {
        try {
            const deliveryFulfillment = order.fulfillments?.find(f =>
                f.type === 'DELIVERY' || f.type === 'SHIPMENT'
            );

            if (!deliveryFulfillment) {
                skipped++;
                continue;
            }

            if (order.state === 'COMPLETED') {
                const existing = await getOrderBySquareId(merchantId, order.id);

                if (existing) {
                    if (existing.status !== 'completed') {
                        await updateOrder(merchantId, existing.id, {
                            status: 'completed',
                            squareSyncedAt: new Date()
                        });
                        logger.info('Updated existing delivery order to completed', {
                            merchantId, orderId: existing.id, squareOrderId: order.id
                        });
                        imported++;
                    } else {
                        skipped++;
                    }
                } else {
                    // Don't import new orders already completed in Square — already fulfilled
                    logger.debug('Skipping completed Square order - not in our system', {
                        merchantId,
                        squareOrderId: order.id,
                        customerName: order.fulfillments?.[0]?.deliveryDetails?.recipient?.displayName ||
                                     order.fulfillments?.[0]?.shipmentDetails?.recipient?.displayName
                    });
                    skipped++;
                }
                continue;
            }

            const result = await ingestSquareOrder(merchantId, order);
            if (result) {
                imported++;
            } else {
                logger.warn('Delivery order skipped - no address or ingest returned null', {
                    merchantId, squareOrderId: order.id, state: order.state,
                    hasFulfillments: !!order.fulfillments?.length
                });
                skipped++;
            }
        } catch (orderError) {
            logger.error('Failed to ingest delivery order', {
                merchantId, squareOrderId: order.id,
                error: orderError.message, stack: orderError.stack
            });
            errors.push({ orderId: order.id, error: orderError.message });
        }
    }

    logger.info('Delivery order sync completed', {
        merchantId, found: orders.length, imported, skipped, errors: errors.length
    });

    return {
        found: orders.length,
        imported,
        skipped,
        errors: errors.length > 0 ? errors : undefined
    };
}

module.exports = { syncSquareOrders };
