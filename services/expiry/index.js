/**
 * Expiry Discount Service Layer
 *
 * Public API for expiry-based discount automation. This module provides:
 * - Discount tier management
 * - Expiry date evaluation
 * - Square discount/pricing rule management
 * - Automated discount application based on expiry proximity
 * - Audit logging for discount changes
 *
 * This service was extracted from utils/expiry-discount.js as part of P1-3.
 *
 * Usage:
 *   const { getActiveTiers, runExpiryDiscountAutomation } = require('./services/expiry');
 *
 *   const tiers = await getActiveTiers(merchantId);
 *   await runExpiryDiscountAutomation(merchantId);
 */

module.exports = require('./discount-service');
