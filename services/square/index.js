/**
 * Square Service Layer — Facade
 *
 * Public API for Square integration services. Re-exports all sub-modules
 * so consumers can continue importing from `require('./services/square')`.
 *
 * Sub-modules (Pkg 2b split — see docs/API-SPLIT-PLAN.md):
 *   square-client.js      — shared infrastructure (HTTP client, token resolution)
 *   square-locations.js   — location sync
 *   square-vendors.js     — vendor sync + reconciliation
 *   api.js                — remaining domain functions (being split further)
 *
 * Usage:
 *   const { syncCatalog, syncInventory, getSquareInventoryCount } = require('./services/square');
 */

const client = require('./square-client');
const locations = require('./square-locations');
const vendors = require('./square-vendors');
const api = require('./api');

module.exports = {
    ...client,
    ...locations,
    ...vendors,
    ...api
};
