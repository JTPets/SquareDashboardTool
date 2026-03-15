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
 * - backfill-service.js: runLoyaltyCatchup, isOrderAlreadyProcessedForLoyalty
 * - loyalty-event-prefetch-service.js: prefetchRecentLoyaltyEvents
 * - order-history-audit-service.js: getCustomerOrderHistoryForAudit
 * - square-discount-service.js: Square Customer Group Discount ops
 * - purchase-service.js: processQualifyingPurchase, processRefund
 * - reward-progress-service.js: updateRewardProgress
 * - customer-summary-service.js: updateCustomerSummary
 * - reward-service.js: redeemReward, detectRewardRedemptionFromOrder
 * - webhook-processing-service.js: processOrderRefundsForLoyalty
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
    getAllSettings,
    getSettings
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
    getVariationAssignments
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
    isOrderAlreadyProcessedForLoyalty,
    processOrderForLoyaltyIfNeeded,
    runLoyaltyCatchup
} = require('./backfill-service');

// Loyalty event prefetch service (split from backfill-service.js)
const {
    prefetchRecentLoyaltyEvents,
    findCustomerFromPrefetchedEvents
} = require('./loyalty-event-prefetch-service');

// Order history audit service (split from backfill-service.js)
const {
    getCustomerOrderHistoryForAudit,
    addOrdersToLoyaltyTracking
} = require('./order-history-audit-service');

// Square discount services (split from square-discount-service.js)
const {
    getSquareLoyaltyProgram,
    createSquareCustomerGroupDiscount,
    cleanupSquareCustomerGroupDiscount,
    updateCustomerRewardNote
} = require('./square-discount-service');
const { updateRewardDiscountAmount } = require('./square-discount-catalog-service');
const { syncRewardDiscountPrices, validateEarnedRewardsDiscounts } = require('./discount-validation-service');

// Purchase service (NEW - extracted from loyalty-service.js)
const {
    processQualifyingPurchase
} = require('./purchase-service');

// Refund service (extracted from purchase-service.js)
const { processRefund } = require('./refund-service');

// Reward progress service (split from purchase-service.js)
const { updateRewardProgress } = require('./reward-progress-service');

// Customer summary service (split from purchase-service.js)
const { updateCustomerSummary } = require('./customer-summary-service');

// Reward service (NEW - extracted from loyalty-service.js and square-discount-service.js)
const {
    redeemReward,
    detectRewardRedemptionFromOrder,
    matchEarnedRewardByFreeItem,
    matchEarnedRewardByDiscountAmount
} = require('./reward-service');

// Webhook processing service (refunds only — order processing moved to order-intake.js)
const {
    processOrderRefundsForLoyalty
} = require('./webhook-processing-service');

// Order processing service (A-13: extracted from routes/loyalty/processing.js)
const { processOrderManually } = require('./order-processing-service');

// Customer refresh service (A-14: extracted from routes/loyalty/processing.js)
const { refreshCustomersWithMissingData } = require('./customer-refresh-service');

// Redemption query service (A-15: extracted from routes/loyalty/rewards.js)
const { getRedemptions, getRewards, updateVendorCreditStatus } = require('./redemption-query-service');

// Audit stats service (A-16: extracted from routes/loyalty/audit.js)
const { getLoyaltyStats, getAuditFindings, resolveAuditFinding } = require('./audit-stats-service');

// Square sync service (A-18: extracted from routes/loyalty/square-integration.js)
const { linkOfferToSquareTier, getRewardForSquareSync, syncRewardsToPOS, getPendingSyncCounts } = require('./square-sync-service');

// Manual entry service (O-8: extracted from routes/loyalty/processing.js)
const { processManualEntry } = require('./manual-entry-service');

// Square reward service (O-9: extracted from routes/loyalty/square-integration.js)
const { createSquareReward } = require('./square-reward-service');

// Backfill orchestration service (A-12: extracted from routes/loyalty/processing.js)
const { runBackfill } = require('./backfill-orchestration-service');

// Redemption audit service
const { auditMissedRedemptions } = require('./redemption-audit-service');

// Square sync retry service (LA-4 fix)
const { retryPendingSquareSyncs } = require('./square-sync-retry-service');

// Line item filter (extracted from order-intake.js)
const { shouldSkipLineItem, buildDiscountMap } = require('./line-item-filter');

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
    getSettings,

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
    getVariationAssignments,

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

    // Line item filter (extracted from order-intake.js)
    shouldSkipLineItem,
    buildDiscountMap,

    // Order intake (single entry point for all order processing)
    processLoyaltyOrder,
    isOrderAlreadyProcessed,

    // Webhook refund processing
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

    // Redemption & reward queries (A-15)
    getRedemptions,
    getRewards,
    updateVendorCreditStatus,

    // Audit stats & findings (A-16)
    getLoyaltyStats,
    getAuditFindings,
    resolveAuditFinding,

    // Square sync (A-18)
    linkOfferToSquareTier,
    getRewardForSquareSync,
    syncRewardsToPOS,
    getPendingSyncCounts,

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

    // Manual entry (O-8)
    processManualEntry,

    // Square reward creation (O-9)
    createSquareReward,

    // Redemption audit
    auditMissedRedemptions,

    // Square sync retry (LA-4)
    retryPendingSquareSyncs
};
