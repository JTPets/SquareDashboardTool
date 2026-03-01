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
 * ARCHITECTURE (P1-1 Phase 4 Complete):
 * All functions have been extracted to dedicated modular services.
 * The legacy loyalty-service.js monolith has been eliminated.
 *
 * Module Structure:
 * - constants.js: RewardStatus, AuditActions, RedemptionTypes
 * - shared-utils.js: fetchWithTimeout, getSquareAccessToken
 * - audit-service.js: logAuditEvent, getAuditLogs
 * - settings-service.js: getSetting, updateSetting, etc.
 * - offer-admin-service.js: createOffer, getOffers, etc.
 * - variation-admin-service.js: addQualifyingVariations, etc.
 * - customer-cache-service.js: cacheCustomerDetails, etc.
 * - customer-admin-service.js: getCustomerDetails, lookups, etc.
 * - expiration-service.js: processExpiredWindowEntries, processExpiredEarnedRewards
 * - backfill-service.js: runLoyaltyCatchup, order history
 * - square-discount-service.js: Square Customer Group Discount ops
 * - purchase-service.js: processQualifyingPurchase, processRefund, updateRewardProgress
 * - reward-service.js: redeemReward, detectRewardRedemptionFromOrder
 * - webhook-processing-service.js: processOrderForLoyalty, processOrderRefundsForLoyalty
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
// MODULAR SERVICES
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
    removeQualifyingVariation
} = require('./variation-admin-service');

// Customer cache service
const {
    cacheCustomerDetails,
    getCachedCustomer,
    searchCachedCustomers,
    updateCustomerStats
} = require('./customer-cache-service');

// Customer search service (A-11: extracted from routes/loyalty/customers.js)
const { searchCustomers } = require('./customer-search-service');

// Customer admin service
const {
    getCustomerDetails,
    lookupCustomerFromLoyalty,
    lookupCustomerFromFulfillmentRecipient,
    lookupCustomerFromOrderRewards,
    getCustomerLoyaltyStatus,
    getCustomerLoyaltyHistory,
    getCustomerEarnedRewards,
    getCustomerOfferProgress
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
    updateRewardDiscountAmount,
    syncRewardDiscountPrices,
    validateEarnedRewardsDiscounts,
    updateCustomerRewardNote
} = require('./square-discount-service');

// Purchase service (NEW - extracted from loyalty-service.js)
const {
    processQualifyingPurchase,
    processRefund,
    updateRewardProgress,
    updateCustomerSummary
} = require('./purchase-service');

// Reward service (NEW - extracted from loyalty-service.js and square-discount-service.js)
const {
    redeemReward,
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount
} = require('./reward-service');

// Webhook processing service (NEW - extracted from loyalty-service.js)
const {
    processOrderForLoyalty,
    processOrderRefundsForLoyalty
} = require('./webhook-processing-service');

// Order processing service (A-13: extracted from routes/loyalty/processing.js)
const { processOrderManually } = require('./order-processing-service');

// Customer refresh service (A-14: extracted from routes/loyalty/processing.js)
const { refreshCustomersWithMissingData } = require('./customer-refresh-service');

// Backfill orchestration service (A-12: extracted from routes/loyalty/processing.js)
const { runBackfill } = require('./backfill-orchestration-service');

// Redemption audit service
const { auditMissedRedemptions } = require('./redemption-audit-service');

// Order intake service (consolidated entry point for all order processing)
const {
    processLoyaltyOrder,
    isOrderAlreadyProcessed
} = require('./order-intake');

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
    getCustomerOfferProgress,
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

    // Customer search (A-11)
    searchCustomers,

    // Square Customer Group Discount Integration
    getSquareLoyaltyProgram,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    updateCustomerRewardNote,
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount,

    // Order intake (single entry point for all order processing)
    processLoyaltyOrder,
    isOrderAlreadyProcessed,

    // Webhook processing (legacy — prefer processLoyaltyOrder for new code)
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

    // Manual order processing (A-13)
    processOrderManually,

    // Customer refresh (A-14)
    refreshCustomersWithMissingData,

    // Backfill orchestration (A-12)
    runBackfill,

    // Discount Validation, Price Sync & Expiration
    updateRewardDiscountAmount,
    syncRewardDiscountPrices,
    validateEarnedRewardsDiscounts,
    processExpiredEarnedRewards,

    // Utilities
    getSquareAccessToken,
    fetchWithTimeout,

    // Audit
    logAuditEvent,
    getAuditLogs,

    // Redemption audit
    auditMissedRedemptions
};
