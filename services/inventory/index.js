/**
 * Inventory Service Layer
 *
 * Public API for inventory-related services. This module provides:
 * - Cycle count batch generation
 * - Cycle count reporting via email
 * - Automatic re-queue of inaccurate counts
 *
 * This service was extracted from utils/cycle-count-utils.js as part of P1-3.
 *
 * Usage:
 *   const { generateDailyBatch, sendCycleCountReport } = require('./services/inventory');
 *
 *   const result = await generateDailyBatch(merchantId);
 *   await sendCycleCountReport(merchantId);
 */

module.exports = require('./cycle-count-service');
