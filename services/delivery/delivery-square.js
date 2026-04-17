/**
 * Delivery Square Integration Service
 * Handles ingesting Square orders and status updates.
 *
 * Extracted from delivery-service.js as part of Phase 4b module split.
 */

const db = require('../../utils/database');
const logger = require('../../utils/logger');
const { getCustomerDetails: getSquareCustomerDetails } = require('../loyalty-admin/customer-details-service');
const { getSettings } = require('./delivery-settings');
const { enrichLineItemsWithGtin } = require('./delivery-gtin');
const { geocodeAddress } = require('./delivery-geocoding');
const { getOrderBySquareId, createOrder, updateOrder } = require('./delivery-orders');

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
        const fulfillmentType = squareOrder.fulfillments?.find(
            f => f.type === 'DELIVERY' || f.type === 'SHIPMENT'
        )?.type;
        const logLevel = fulfillmentType === 'SHIPMENT' ? 'info' : 'warn';
        logger[logLevel]('Square order has no delivery address - skipping', {
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

module.exports = {
    ingestSquareOrder,
    handleSquareOrderUpdate
};
