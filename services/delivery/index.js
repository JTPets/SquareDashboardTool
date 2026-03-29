/**
 * Delivery Service Layer
 *
 * Public API for delivery-related services. This module provides:
 * - Delivery order management (CRUD operations)
 * - Route generation and optimization
 * - Geocoding functionality
 * - Proof of Delivery (POD) photo handling
 * - Delivery settings management
 * - Audit logging
 *
 * This service was extracted from utils/delivery-api.js as part of P1-3.
 * Leaf modules split out in Phase 4a: utils, settings, audit, gtin, geocoding, pod.
 *
 * Usage:
 *   const { getOrders, createOrder, generateRoute } = require('./services/delivery');
 *
 *   const orders = await getOrders(merchantId, { status: 'pending' });
 *   const route = await generateRoute(merchantId, orderIds, startPoint);
 */

const deliveryService = require('./delivery-service');
const deliverySettings = require('./delivery-settings');
const deliveryAudit = require('./delivery-audit');
const deliveryGtin = require('./delivery-gtin');
const deliveryGeocoding = require('./delivery-geocoding');
const deliveryPod = require('./delivery-pod');
const deliveryUtils = require('./delivery-utils');

module.exports = {
    ...deliveryService,
    ...deliverySettings,
    ...deliveryAudit,
    ...deliveryGtin,
    ...deliveryGeocoding,
    ...deliveryPod,
    ...deliveryUtils
};
