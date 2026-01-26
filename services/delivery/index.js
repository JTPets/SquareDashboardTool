/**
 * Delivery Service Layer
 *
 * Public API for delivery-related services. This module provides:
 * - Delivery order management (CRUD operations)
 * - Route generation and optimization
 * - Geocoding functionality
 * - Proof of Delivery (POD) photo handling
 * - Delivery settings management
 *
 * This service was extracted from utils/delivery-api.js as part of P1-3.
 *
 * Usage:
 *   const { getOrders, createOrder, generateRoute } = require('./services/delivery');
 *
 *   const orders = await getOrders(merchantId, { status: 'pending' });
 *   const route = await generateRoute(merchantId, orderIds, startPoint);
 */

module.exports = require('./delivery-service');
