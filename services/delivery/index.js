/**
 * Delivery Service Layer
 *
 * Public API for delivery-related services. Re-exports from all modules.
 *
 * Usage:
 *   const { getOrders, createOrder, generateRoute } = require('./services/delivery');
 */

module.exports = {
    ...require('./delivery-orders'),
    ...require('./delivery-routes'),
    ...require('./delivery-tokens'),
    ...require('./delivery-square'),
    ...require('./delivery-backfill'),
    ...require('./delivery-settings'),
    ...require('./delivery-audit'),
    ...require('./delivery-utils'),
    ...require('./delivery-gtin'),
    ...require('./delivery-geocoding'),
    ...require('./delivery-pod'),
};
