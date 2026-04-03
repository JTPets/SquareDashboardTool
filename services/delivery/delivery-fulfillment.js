/**
 * Delivery Fulfillment Service
 *
 * Handles syncing delivery completion state back to Square.
 * Extracted from routes/delivery.js POST /orders/:id/complete handler.
 */

const logger = require('../../utils/logger');
const { getSquareClientForMerchant } = require('../../middleware/merchant');
const { generateIdempotencyKey } = require('../../utils/idempotency');

// Square fulfillment state transitions must follow this order
const FULFILLMENT_STATE_ORDER = ['PROPOSED', 'RESERVED', 'PREPARED', 'COMPLETED'];

/**
 * Build a fulfillment update object with the correct timestamp field
 * when transitioning to COMPLETED.
 */
function buildFulfillmentUpdate(fulfillment, nextState, completedAt) {
    const update = { uid: fulfillment.uid, state: nextState };

    if (nextState !== 'COMPLETED') {
        return update;
    }

    if (fulfillment.type === 'DELIVERY') {
        update.deliveryDetails = { ...fulfillment.deliveryDetails, deliveredAt: completedAt };
    } else if (fulfillment.type === 'SHIPMENT') {
        update.shipmentDetails = { ...fulfillment.shipmentDetails, shippedAt: completedAt };
    } else if (fulfillment.type === 'PICKUP') {
        update.pickupDetails = { ...fulfillment.pickupDetails, pickedUpAt: completedAt };
    }

    return update;
}

/**
 * Sync a delivery order's completion back to Square by stepping all
 * fulfillments through required state transitions and then marking the
 * Square order itself as COMPLETED.
 *
 * @param {number} merchantId
 * @param {Object} order - Local delivery order (must have square_order_id)
 * @returns {Promise<{squareSynced: boolean, squareSyncError: string|null}>}
 */
async function completeDeliveryInSquare(merchantId, order) {
    if (!order.square_order_id) {
        return { squareSynced: false, squareSyncError: null };
    }

    try {
        const squareClient = await getSquareClientForMerchant(merchantId);
        let squareOrder = await squareClient.orders.get({ orderId: order.square_order_id });

        if (!squareOrder.order?.fulfillments?.length) {
            logger.warn('Square order has no fulfillments', {
                orderId: order.id,
                squareOrderId: order.square_order_id
            });
            return { squareSynced: false, squareSyncError: null };
        }

        const deliveryFulfillments = squareOrder.order.fulfillments.filter(f =>
            f.type === 'DELIVERY' || f.type === 'SHIPMENT' || f.type === 'PICKUP'
        );
        const fulfillmentsToComplete = deliveryFulfillments.length > 0
            ? deliveryFulfillments
            : squareOrder.order.fulfillments;

        logger.info('Found fulfillments to complete', {
            orderId: order.id,
            squareOrderId: order.square_order_id,
            fulfillmentCount: fulfillmentsToComplete.length,
            fulfillments: fulfillmentsToComplete.map(f => ({ uid: f.uid, type: f.type, state: f.state }))
        });

        const completedAt = new Date().toISOString();
        let allFulfillmentsCompleted = true;

        for (const initialFulfillment of fulfillmentsToComplete) {
            if (initialFulfillment.state === 'COMPLETED') {
                logger.info('Fulfillment already completed', { orderId: order.id, fulfillmentUid: initialFulfillment.uid });
                continue;
            }

            const currentStateIndex = FULFILLMENT_STATE_ORDER.indexOf(initialFulfillment.state);

            if (currentStateIndex < 0) {
                logger.warn('Fulfillment in unexpected state, skipping', {
                    orderId: order.id, fulfillmentUid: initialFulfillment.uid, state: initialFulfillment.state
                });
                allFulfillmentsCompleted = false;
                continue;
            }

            for (let i = currentStateIndex + 1; i < FULFILLMENT_STATE_ORDER.length; i++) {
                const nextState = FULFILLMENT_STATE_ORDER[i];

                // Re-fetch to get current version (required for optimistic concurrency)
                squareOrder = await squareClient.orders.get({ orderId: order.square_order_id });
                const fulfillment = squareOrder.order.fulfillments.find(f => f.uid === initialFulfillment.uid);

                if (!fulfillment) {
                    throw new Error(`Fulfillment ${initialFulfillment.uid} not found after re-fetch`);
                }

                logger.info('Transitioning fulfillment state', {
                    orderId: order.id, fulfillmentUid: fulfillment.uid, from: fulfillment.state, to: nextState
                });

                await squareClient.orders.update({
                    orderId: order.square_order_id,
                    order: {
                        locationId: squareOrder.order.locationId,
                        version: squareOrder.order.version,
                        fulfillments: [buildFulfillmentUpdate(fulfillment, nextState, completedAt)]
                    },
                    idempotencyKey: generateIdempotencyKey(`complete-${order.id}-${fulfillment.uid}-${nextState}`)
                });
            }

            logger.info('Fulfillment completed', {
                orderId: order.id, fulfillmentUid: initialFulfillment.uid, fulfillmentType: initialFulfillment.type
            });
        }

        // After all fulfillments are done, move the Square order to COMPLETED state
        if (allFulfillmentsCompleted) {
            squareOrder = await squareClient.orders.get({ orderId: order.square_order_id });

            if (squareOrder.order.state !== 'COMPLETED') {
                logger.info('Updating order state to COMPLETED', {
                    orderId: order.id, squareOrderId: order.square_order_id, currentState: squareOrder.order.state
                });

                await squareClient.orders.update({
                    orderId: order.square_order_id,
                    order: {
                        locationId: squareOrder.order.locationId,
                        version: squareOrder.order.version,
                        state: 'COMPLETED'
                    },
                    idempotencyKey: generateIdempotencyKey(`complete-order-${order.id}`)
                });

                logger.info('Order state updated to COMPLETED', {
                    orderId: order.id, squareOrderId: order.square_order_id
                });
            }
        }

        logger.info('Synced delivery completion to Square', {
            merchantId, orderId: order.id, squareOrderId: order.square_order_id,
            fulfillmentsCompleted: fulfillmentsToComplete.length,
            orderStateUpdated: allFulfillmentsCompleted
        });

        return { squareSynced: true, squareSyncError: null };

    } catch (squareError) {
        logger.error('Failed to sync completion to Square', {
            error: squareError.message, orderId: order.id,
            squareOrderId: order.square_order_id, merchantId
        });
        return { squareSynced: false, squareSyncError: squareError.message };
    }
}

module.exports = { completeDeliveryInSquare };
