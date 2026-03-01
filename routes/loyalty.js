/**
 * Loyalty Routes — Facade
 *
 * This file was split from a 2,134-line monolith into 10 focused modules.
 * See routes/loyalty/ for individual route files.
 *
 * Modules:
 * - offers.js: Offer CRUD (5 handlers)
 * - variations.js: Qualifying variation management (4 handlers)
 * - customers.js: Customer lookup, status, history, search (7 handlers)
 * - rewards.js: Reward management, vendor credit, redemptions (4 handlers)
 * - square-integration.js: Square POS integration and sync (5 handlers)
 * - processing.js: Order processing, backfill, catchup, manual entry (6 handlers)
 * - audit.js: Audit log, stats, findings, missed redemptions (5 handlers)
 * - reports.js: Report generation and CSV exports (8 handlers)
 * - settings.js: Loyalty program settings (2 handlers)
 * - discounts.js: Discount validation (2 handlers)
 *
 * Total: 48 handlers across 10 modules
 */

const express = require('express');
const router = express.Router();

router.use('/', require('./loyalty/offers'));
router.use('/', require('./loyalty/variations'));
router.use('/', require('./loyalty/customers'));
router.use('/', require('./loyalty/rewards'));
router.use('/', require('./loyalty/square-integration'));
router.use('/', require('./loyalty/processing'));
router.use('/', require('./loyalty/audit'));
router.use('/', require('./loyalty/reports'));
router.use('/', require('./loyalty/settings'));
router.use('/', require('./loyalty/discounts'));

module.exports = router;
