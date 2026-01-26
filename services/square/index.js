/**
 * Square Service Layer
 *
 * Public API for Square integration services. This module provides:
 * - Catalog synchronization (items, variations, categories, images)
 * - Vendor synchronization
 * - Location synchronization
 * - Inventory management (counts, alerts, committed inventory)
 * - Custom attribute management
 * - Price and cost updates
 * - Sales velocity tracking
 *
 * This service was extracted from utils/square-api.js as part of P1-3.
 *
 * Usage:
 *   const { syncCatalog, syncInventory, getSquareInventoryCount } = require('./services/square');
 *
 *   await syncCatalog(merchantId);
 *   const count = await getSquareInventoryCount(variationId, locationId, merchantId);
 */

module.exports = require('./api');
