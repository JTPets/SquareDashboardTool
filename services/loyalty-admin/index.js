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
 * ARCHITECTURE:
 * This module re-exports functions from both:
 * 1. New modular services (offer-admin-service, variation-admin-service, etc.)
 * 2. Legacy loyalty-service.js (for functions not yet extracted)
 *
 * The refactoring is incremental - functions are extracted to dedicated services
 * one at a time while maintaining backward compatibility.
 *
 * Migration Progress (P1-1 Phase 4):
 * - constants.js: Extracted (RewardStatus, AuditActions, RedemptionTypes)
 * - shared-utils.js: Extracted (fetchWithTimeout, getSquareAccessToken)
 * - audit-service.js: Extracted (logAuditEvent, getAuditLogs)
 * - settings-service.js: Extracted (getSetting, updateSetting, etc.)
 * - offer-admin-service.js: Extracted (createOffer, getOffers, etc.)
 * - variation-admin-service.js: Extracted (addQualifyingVariations, etc.)
 * - customer-cache-service.js: Extracted (cacheCustomerDetails, etc.)
 * - customer-admin-service.js: Extracted (getCustomerDetails, lookups, etc.)
 * - expiration-service.js: Extracted (processExpiredWindowEntries, processExpiredEarnedRewards)
 * - backfill-service.js: Extracted (prefetchRecentLoyaltyEvents, getCustomerOrderHistoryForAudit, etc.)
 * - square-discount-service.js: Extracted (createSquareCustomerGroupDiscount, validateEarnedRewardsDiscounts, etc.)
 *
 * Remaining in legacy loyalty-service.js (~1,480 lines):
 * - Purchase processing (processQualifyingPurchase, processRefund)
 * - Reward management (redeemReward, updateRewardProgress)
 * - Webhook processing (processOrderForLoyalty, processOrderRefundsForLoyalty)
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
 */

// ============================================================================
// NEW MODULAR SERVICES (Extracted)
// ============================================================================

// Constants
const { RewardStatus, AuditActions, RedemptionTypes } = require('./constants');

// Shared utilities
const { fetchWithTimeout, getSquareAccessToken, getSquareApi } = require('./shared-utils');

// Audit service
const { logAuditEvent, getAuditLogs } = require('./audit-service');

// Settings service
const {
    getSetting,
    updateSetting,
    initializeDefaultSettings,
    getAllSettings
} = require('./settings-service');

// Offer admin service
const {
    createOffer,
    getOffers,
    getOfferById,
    updateOffer,
    deleteOffer
} = require('./offer-admin-service');

// Variation admin service
const {
    checkVariationConflicts,
    addQualifyingVariations,
    getQualifyingVariations,
    getOfferForVariation,
    removeQualifyingVariation,
    getAllVariationAssignments
} = require('./variation-admin-service');

// Customer cache service
const {
    cacheCustomerDetails,
    getCachedCustomer,
    searchCachedCustomers,
    updateCustomerStats
} = require('./customer-cache-service');

// Customer admin service
const {
    getCustomerDetails,
    lookupCustomerFromLoyalty,
    lookupCustomerFromFulfillmentRecipient,
    lookupCustomerFromOrderRewards,
    getCustomerLoyaltyStatus,
    getCustomerLoyaltyHistory,
    getCustomerEarnedRewards
} = require('./customer-admin-service');

// Expiration service
const {
    processExpiredWindowEntries,
    processExpiredEarnedRewards
} = require('./expiration-service');

// Backfill service
const {
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents,
    isOrderAlreadyProcessedForLoyalty,
    processOrderForLoyaltyIfNeeded,
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking,
    runLoyaltyCatchup
} = require('./backfill-service');

// Square discount service
const {
    getSquareLoyaltyProgram,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    detectRewardRedemptionFromOrder,
    createSquareLoyaltyReward,
    validateEarnedRewardsDiscounts
} = require('./square-discount-service');

// ============================================================================
// LEGACY SERVICE (Core purchase and reward processing)
// ============================================================================

const legacyService = require('./loyalty-service');

// Re-export everything from legacy that isn't in new modules
const {
    // Purchase processing
    processQualifyingPurchase,
    processRefund,

    // Reward management
    redeemReward,

    // Webhook processing
    processOrderForLoyalty,
    processOrderRefundsForLoyalty
} = legacyService;

// ============================================================================
// EXPORTS - Complete public API
// ============================================================================

module.exports = {
    // Constants
    RewardStatus,
    AuditActions,
    RedemptionTypes,

    // Settings
    getSetting,
    updateSetting,
    initializeDefaultSettings,
    getAllSettings,

    // Offer management
    createOffer,
    getOffers,
    getOfferById,
    updateOffer,
    deleteOffer,

    // Qualifying variations
    checkVariationConflicts,
    addQualifyingVariations,
    getQualifyingVariations,
    getOfferForVariation,
    removeQualifyingVariation,
    getAllVariationAssignments,

    // Purchase processing
    processQualifyingPurchase,
    processRefund,

    // Reward management
    redeemReward,
    getCustomerEarnedRewards,

    // Rolling window
    processExpiredWindowEntries,

    // Customer APIs
    getCustomerLoyaltyStatus,
    getCustomerLoyaltyHistory,
    getCustomerDetails,
    lookupCustomerFromLoyalty,
    lookupCustomerFromFulfillmentRecipient,
    lookupCustomerFromOrderRewards,
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents,

    // Customer caching
    cacheCustomerDetails,
    getCachedCustomer,
    searchCachedCustomers,
    updateCustomerStats,

    // Square Customer Group Discount Integration
    getSquareLoyaltyProgram,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    detectRewardRedemptionFromOrder,
    createSquareLoyaltyReward,

    // Webhook processing
    processOrderForLoyalty,
    processOrderRefundsForLoyalty,

    // Backfill / Sync
    isOrderAlreadyProcessedForLoyalty,
    processOrderForLoyaltyIfNeeded,

    // Manual Customer Order Audit
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking,

    // Background Loyalty Catchup
    runLoyaltyCatchup,

    // Discount Validation & Expiration
    validateEarnedRewardsDiscounts,
    processExpiredEarnedRewards,

    // Utilities
    getSquareAccessToken,
    fetchWithTimeout,

    // Audit
    logAuditEvent,
    getAuditLogs
};
