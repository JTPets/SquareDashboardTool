/**
 * Tests for services/loyalty-admin/index.js
 *
 * Validates that the barrel file exports all expected public API functions.
 * This is a structural test — it doesn't test business logic (covered by individual service tests).
 */

const loyaltyAdmin = require('../../../services/loyalty-admin');

describe('loyalty-admin index (barrel exports)', () => {
    // ========================================================================
    // Constants
    // ========================================================================

    test('exports RewardStatus enum', () => {
        expect(loyaltyAdmin.RewardStatus).toBeDefined();
        expect(loyaltyAdmin.RewardStatus.IN_PROGRESS).toBe('in_progress');
        expect(loyaltyAdmin.RewardStatus.EARNED).toBe('earned');
        expect(loyaltyAdmin.RewardStatus.REDEEMED).toBe('redeemed');
        expect(loyaltyAdmin.RewardStatus.REVOKED).toBe('revoked');
    });

    test('exports AuditActions enum', () => {
        expect(loyaltyAdmin.AuditActions).toBeDefined();
        expect(loyaltyAdmin.AuditActions.OFFER_CREATED).toBe('OFFER_CREATED');
    });

    test('exports RedemptionTypes enum', () => {
        expect(loyaltyAdmin.RedemptionTypes).toBeDefined();
        expect(loyaltyAdmin.RedemptionTypes.ORDER_DISCOUNT).toBe('order_discount');
    });

    // ========================================================================
    // Functions — verify all exported as functions
    // ========================================================================

    const expectedFunctions = [
        // Settings
        'getSetting', 'updateSetting', 'initializeDefaultSettings', 'getAllSettings', 'getSettings',
        // Offer management
        'createOffer', 'getOffers', 'getOfferById', 'updateOffer', 'deleteOffer',
        // Qualifying variations
        'checkVariationConflicts', 'addQualifyingVariations', 'getQualifyingVariations',
        'getOfferForVariation', 'removeQualifyingVariation', 'getVariationAssignments',
        // Purchase processing
        'processQualifyingPurchase', 'processRefund',
        // Reward management
        'redeemReward', 'getCustomerEarnedRewards',
        // Rolling window
        'processExpiredWindowEntries',
        // Customer APIs
        'getCustomerLoyaltyStatus', 'getCustomerLoyaltyHistory', 'getCustomerDetails',
        'getCustomerOfferProgress',
        'prefetchRecentLoyaltyEvents', 'findCustomerFromPrefetchedEvents',
        // Customer caching
        'cacheCustomerDetails', 'getCachedCustomer', 'searchCachedCustomers', 'updateCustomerStats',
        // Customer search
        'searchCustomers',
        // Square discount
        'getSquareLoyaltyProgram', 'createSquareCustomerGroupDiscount',
        'cleanupSquareCustomerGroupDiscount', 'updateCustomerRewardNote',
        'detectRewardRedemptionFromOrder', 'matchEarnedRewardByFreeItem',
        'matchEarnedRewardByDiscountAmount',
        // Line item filter
        'shouldSkipLineItem', 'buildDiscountMap',
        // Order intake
        'processLoyaltyOrder', 'isOrderAlreadyProcessed',
        // Webhook refund
        'processOrderRefundsForLoyalty',
        // Backfill / Sync
        'isOrderAlreadyProcessedForLoyalty', 'processOrderForLoyaltyIfNeeded',
        // Customer order audit
        'getCustomerOrderHistoryForAudit', 'addOrdersToLoyaltyTracking', 'analyzeOrders',
        // Catchup
        'runLoyaltyCatchup',
        // Manual processing
        'processOrderManually',
        // Customer refresh
        'refreshCustomersWithMissingData',
        // Redemption queries
        'getRedemptions', 'getRewards', 'updateVendorCreditStatus',
        // Audit stats
        'getLoyaltyStats', 'getAuditFindings', 'resolveAuditFinding',
        // Square sync
        'linkOfferToSquareTier', 'getRewardForSquareSync', 'syncRewardsToPOS', 'getPendingSyncCounts',
        // Backfill orchestration
        'runBackfill',
        // Discount validation
        'updateRewardDiscountAmount', 'syncRewardDiscountPrices',
        'validateEarnedRewardsDiscounts', 'processExpiredEarnedRewards',
        // Utilities
        'getSquareAccessToken', 'fetchWithTimeout',
        // Audit
        'logAuditEvent', 'getAuditLogs',
        // Manual entry
        'processManualEntry',
        // Square reward
        'createSquareReward',
        // Redemption audit
        'auditMissedRedemptions',
        // Square sync retry
        'retryPendingSquareSyncs',
    ];

    test.each(expectedFunctions)('exports %s as a function', (fnName) => {
        expect(typeof loyaltyAdmin[fnName]).toBe('function');
    });

    test('total exported keys match expected count', () => {
        const exportedKeys = Object.keys(loyaltyAdmin);
        // 3 constant objects + all functions
        const expectedCount = 3 + expectedFunctions.length;
        expect(exportedKeys.length).toBe(expectedCount);
    });

    // ========================================================================
    // Verify no accidental undefined exports
    // ========================================================================

    test('no exported values are undefined', () => {
        Object.entries(loyaltyAdmin).forEach(([key, value]) => {
            expect(value).toBeDefined();
        });
    });
});
