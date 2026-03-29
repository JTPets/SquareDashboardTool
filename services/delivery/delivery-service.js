/**
 * Delivery Service — Barrel Re-export
 *
 * This file exists for backward compatibility. Several files across the codebase
 * require('./delivery-service') directly. All functionality has been extracted to
 * dedicated modules:
 *
 *   delivery-orders.js    — Order CRUD (getOrders, createOrder, updateOrder, etc.)
 *   delivery-routes.js    — Route generation, optimization, finish
 *   delivery-tokens.js    — Route sharing tokens for contract drivers
 *   delivery-square.js    — Square order ingestion and status updates
 *   delivery-backfill.js  — Customer backfill for "Unknown Customer"
 *   delivery-settings.js  — Merchant delivery settings
 *   delivery-audit.js     — Audit logging
 *   delivery-utils.js     — Shared constants and helpers
 *   delivery-gtin.js      — GTIN/UPC enrichment
 *   delivery-geocoding.js — Address geocoding via ORS
 *   delivery-pod.js       — Proof of Delivery photo handling
 *
 * Usage:
 *   const { getOrders, createOrder } = require('./services/delivery');
 *   // or: require('./services/delivery/delivery-service') — still works
 */

module.exports = {
    // Orders
    ...require('./delivery-orders'),

    // Routes
    ...require('./delivery-routes'),

    // Route sharing tokens
    ...require('./delivery-tokens'),

    // Square integration
    ...require('./delivery-square'),

    // Customer backfill
    ...require('./delivery-backfill'),

    // Settings
    ...require('./delivery-settings'),

    // Audit
    ...require('./delivery-audit'),

    // Utils
    ...require('./delivery-utils'),

    // GTIN enrichment
    ...require('./delivery-gtin'),

    // Geocoding
    ...require('./delivery-geocoding'),

    // POD
    ...require('./delivery-pod'),
};
