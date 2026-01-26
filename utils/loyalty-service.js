/**
 * Loyalty Service - Re-export Stub
 *
 * This file re-exports the loyalty service from its new location at
 * services/loyalty-admin/ for backward compatibility.
 *
 * The actual implementation has been moved to:
 *   services/loyalty-admin/loyalty-service.js
 *
 * All existing imports of './utils/loyalty-service' will continue to work.
 *
 * For new code, prefer importing directly from:
 *   const loyaltyAdmin = require('./services/loyalty-admin');
 *
 * Migration completed as part of P1-3 (2026-01-26).
 */

module.exports = require('../services/loyalty-admin');
