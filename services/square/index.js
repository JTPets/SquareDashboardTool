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
 *   square-diagnostics.js — fix location mismatches, alerts, enable items
 *   square-custom-attributes.js — custom attribute CRUD + push helpers
 *   square-pricing.js     — price, cost & catalog content updates
 *   api.js                — remaining domain functions (being split further)
 *
 * Usage:
 *   const { syncCatalog, syncInventory, getSquareInventoryCount } = require('./services/square');
 */

const client = require('./square-client');
const locations = require('./square-locations');
const vendors = require('./square-vendors');
const diagnostics = require('./square-diagnostics');
const customAttrs = require('./square-custom-attributes');
const pricing = require('./square-pricing');
const api = require('./api');

module.exports = {
    ...client,
    ...locations,
    ...vendors,
    ...diagnostics,
    ...customAttrs,
    ...pricing,
    ...api
};
