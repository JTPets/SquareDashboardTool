/**
 * Vendor Catalog Routes
 *
 * Mounts sub-routers for vendor management and vendor catalog operations.
 * All sub-routers define paths relative to /api (mounted in server.js).
 *
 * Sub-routers:
 *   vendors.js  – GET /vendors, /vendor-dashboard, PATCH /vendors/:id/settings,
 *                 GET /vendor-catalog/merchant-taxes
 *   import.js   – POST/GET /vendor-catalog/import*, /preview, /import-mapped,
 *                 /field-types, /stats
 *   lookup.js   – GET /vendor-catalog, /lookup/:upc, /batches, /batches/:id/report
 *   manage.js   – POST/DELETE batch actions, /push-price-changes, /confirm-links,
 *                 /deduplicate, /create-items
 */

const express = require('express');
const router = express.Router();

router.use('/', require('./vendors'));
router.use('/', require('./import'));
router.use('/', require('./lookup'));
router.use('/', require('./manage'));

module.exports = router;
