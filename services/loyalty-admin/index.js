/**
 * Loyalty Admin Service Layer
 *
 * Public API for loyalty program administration. This module provides:
 * - Offer management (CRUD operations)
 * - Qualifying variation management
 * - Settings management
 * - Customer management and caching
 * - Reward management and redemption
 * - Square Customer Group Discount integration
 * - Audit logging
 * - Webhook order processing
 *
 * This service was extracted from utils/loyalty-service.js as part of P1-3.
 * The modern webhook processing service is in services/loyalty/.
 *
 * Usage:
 *   const loyaltyAdmin = require('./services/loyalty-admin');
 *
 *   // Offer management
 *   const offer = await loyaltyAdmin.createOffer({ ... });
 *   const offers = await loyaltyAdmin.getOffers(merchantId);
 *
 *   // Customer lookup
 *   const status = await loyaltyAdmin.getCustomerLoyaltyStatus(customerId, merchantId);
 *
 *   // Webhook processing (also available here for backward compatibility)
 *   await loyaltyAdmin.processOrderForLoyalty(order, merchantId);
 */

module.exports = require('./loyalty-service');
