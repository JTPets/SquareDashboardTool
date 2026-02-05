# Loyalty Admin Service Architecture

This document describes the modular architecture of `services/loyalty-admin/` after the P1-1 Phase 4 refactoring.

## Overview

The loyalty-admin service layer provides the API for loyalty program administration, including:
- Offer management (CRUD operations)
- Qualifying variation management
- Settings management
- Customer management and caching
- Reward management and redemption
- Square Customer Group Discount integration
- Audit logging
- Webhook order processing

## Module Dependency Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              index.js                                        │
│                         (Public API - 47 exports)                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│   constants.js  │     │   shared-utils.js   │     │     audit-service.js    │
│ (RewardStatus,  │     │ (fetchWithTimeout,  │     │ (logAuditEvent,         │
│  AuditActions,  │     │  getSquareAccess-   │     │  getAuditLogs)          │
│ RedemptionTypes)│     │  Token, getSquare-  │◄────│                         │
└─────────────────┘     │  Api)               │     └─────────────────────────┘
         │              └─────────────────────┘                  │
         │                          │                            │
         ▼                          ▼                            ▼
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│ settings-       │     │ customer-cache-     │     │ offer-admin-service.js  │
│ service.js      │     │ service.js          │     │ (createOffer, getOffers,│
│ (getSetting,    │     │ (cacheCustomer-     │     │  getOfferById, update-  │
│  updateSetting, │     │  Details, getCached-│     │  Offer, deleteOffer)    │
│  etc.)          │     │  Customer, etc.)    │     └─────────────────────────┘
└─────────────────┘     └─────────────────────┘                  │
                                    │                            │
                                    ▼                            ▼
                        ┌─────────────────────┐     ┌─────────────────────────┐
                        │ customer-admin-     │     │ variation-admin-        │
                        │ service.js          │     │ service.js              │
                        │ (getCustomerDetails,│     │ (checkVariation-        │
                        │  lookupCustomer-    │     │  Conflicts, add/get/    │
                        │  From*, etc.)       │     │  removeQualifying-      │
                        └─────────────────────┘     │  Variations, etc.)      │
                                    │              └─────────────────────────┘
                                    ▼
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│ expiration-     │     │ backfill-service.js │     │ square-discount-        │
│ service.js      │     │ (prefetchRecent-    │     │ service.js              │
│ (processExpired-│     │  LoyaltyEvents,     │     │ (createSquareCustomer-  │
│  WindowEntries, │     │  isOrderAlready-    │     │  GroupDiscount, cleanup,│
│  processExpired-│     │  Processed, run-    │     │  validateEarnedRewards, │
│  EarnedRewards) │     │  LoyaltyCatchup)    │     │  detectRedemption)      │
└────────┬────────┘     └──────────┬──────────┘     └───────────┬─────────────┘
         │                         │                            │
         │         LAZY REQUIRE    │                            │
         └─────────────────────────┼────────────────────────────┘
                                   ▼
                        ┌─────────────────────┐
                        │ loyalty-service.js  │
                        │ (LEGACY - ~1,480    │
                        │  lines remaining)   │
                        │                     │
                        │ Contains:           │
                        │ - processQualifying-│
                        │   Purchase          │
                        │ - processRefund     │
                        │ - redeemReward      │
                        │ - processOrderFor-  │
                        │   Loyalty           │
                        │ - updateReward-     │
                        │   Progress          │
                        └─────────────────────┘
```

## Module Details

### Core Modules (No Dependencies on loyalty-service.js)

| Module | Lines | Functions | Purpose |
|--------|-------|-----------|---------|
| `constants.js` | 57 | 0 | RewardStatus, AuditActions, RedemptionTypes enums |
| `shared-utils.js` | 73 | 3 | fetchWithTimeout, getSquareAccessToken, getSquareApi |
| `audit-service.js` | 133 | 2 | logAuditEvent, getAuditLogs |
| `settings-service.js` | 109 | 4 | getSetting, updateSetting, initializeDefaultSettings, getAllSettings |
| `offer-admin-service.js` | 314 | 5 | CRUD for loyalty offers |
| `variation-admin-service.js` | 285 | 6 | Qualifying variation management |
| `customer-cache-service.js` | 224 | 4 | Customer detail caching |
| `customer-admin-service.js` | 595 | 7 | Customer lookups and status queries |

### Modules with Lazy Requires (Circular Dependency Avoidance)

| Module | Lines | Functions | Lazy Require Reason |
|--------|-------|-----------|---------------------|
| `expiration-service.js` | 206 | 2 | Needs `updateRewardProgress` from loyalty-service |
| `backfill-service.js` | 926 | 7 | Needs `processOrderForLoyalty` from loyalty-service |
| `square-discount-service.js` | 1231 | 13 | Needs `redeemReward` from loyalty-service |

### Legacy Module (Pending Further Extraction)

| Module | Lines | Functions | Status |
|--------|-------|-----------|--------|
| `loyalty-service.js` | 1482 | 5 exported | Core purchase/reward/webhook processing |

## Lazy Requires and Why They Exist

### Pattern Used

```javascript
// Lazy require to avoid circular dependency
let _loyaltyService = null;
function getLoyaltyService() {
    if (!_loyaltyService) {
        _loyaltyService = require('./loyalty-service');
    }
    return _loyaltyService;
}
```

### Where and Why

1. **expiration-service.js** → loyalty-service.js
   - Needs: `updateRewardProgress`, `cleanupSquareCustomerGroupDiscount`
   - Why: Expiration processing must recalculate reward progress after window entries expire
   - **Note**: `cleanupSquareCustomerGroupDiscount` is now in square-discount-service.js; comment on line 17 is stale

2. **backfill-service.js** → loyalty-service.js
   - Needs: `processOrderForLoyalty`
   - Why: Backfill and catchup operations must process orders through the same loyalty logic

3. **square-discount-service.js** → loyalty-service.js
   - Needs: `redeemReward`
   - Why: Auto-detected redemptions from orders must call redeemReward

## Functions Remaining in loyalty-service.js

These functions are tightly coupled and form the core purchase processing pipeline:

| Function | Lines | Purpose | Why Not Extracted |
|----------|-------|---------|-------------------|
| `processQualifyingPurchase` | 84-227 | Record qualifying purchases | Core pipeline entry |
| `updateRewardProgress` | 236-412 | Update reward state machine | Called by multiple paths |
| `processRefund` | 425-589 | Handle refunds | Modifies reward state |
| `redeemReward` | 604-754 | Mark reward as redeemed | Core redemption logic |
| `updateCustomerSummary` | 765-846 | Update denormalized summary | Internal helper |
| `processOrderForLoyalty` | 866-1322 | Process webhook orders | Complex customer identification |
| `processOrderRefundsForLoyalty` | 1329-1420 | Process order refunds | Refund processing |

### Extraction Recommendation

Future extraction would require breaking the tight coupling between:
- `updateRewardProgress` → `createSquareCustomerGroupDiscount` (async fire-and-forget)
- `redeemReward` → `cleanupSquareCustomerGroupDiscount` (cleanup after redemption)

## Import Rules

### ✅ DO

1. **External consumers**: Import from `./services/loyalty-admin` (index.js)
   ```javascript
   const loyaltyAdmin = require('./services/loyalty-admin');
   ```

2. **Internal modules**: Import directly from sibling modules
   ```javascript
   const { logAuditEvent } = require('./audit-service');
   ```

3. **Circular dependencies**: Use lazy require pattern
   ```javascript
   function getLoyaltyService() {
       if (!_loyaltyService) {
           _loyaltyService = require('./loyalty-service');
       }
       return _loyaltyService;
   }
   ```

### ❌ DON'T

1. Extracted modules should NOT import from `./index.js`
2. Extracted modules should NOT import functions from loyalty-service.js that exist in other extracted modules
3. Don't use require at top level when circular dependency exists

## Known Issues (Post-Merge Verification)

### Issue 1: Missing Import in loyalty-service.js

**Location**: `services/loyalty-admin/loyalty-service.js` lines 372, 717

**Problem**: `createSquareCustomerGroupDiscount` and `cleanupSquareCustomerGroupDiscount` are called but not imported. These functions exist in `square-discount-service.js`.

**Impact**: Would cause ReferenceError at runtime if these code paths execute.

**Fix Required**:
```javascript
// Add to imports section (after line 54)
const { createSquareCustomerGroupDiscount, cleanupSquareCustomerGroupDiscount } = require('./square-discount-service');
```

### Issue 2: Stale Comment and Wrong Import in expiration-service.js

**Location**: `services/loyalty-admin/expiration-service.js` lines 17, 165-166

**Problem**:
- Comment says "cleanupSquareCustomerGroupDiscount will move to square-discount-service.js" but it's already there
- Code uses `getLoyaltyService()` to get the function, but loyalty-service.js doesn't export it

**Impact**: Would cause error when trying to cleanup expired earned rewards.

**Fix Required**:
```javascript
// Line 17: Update comment
// cleanupSquareCustomerGroupDiscount is now in square-discount-service.js

// Line 165-166: Replace with direct import
const { cleanupSquareCustomerGroupDiscount } = require('./square-discount-service');
```

## Export Verification

All 47 exports from index.js are correctly mapped:

### Constants (3)
- RewardStatus, AuditActions, RedemptionTypes

### Settings (4)
- getSetting, updateSetting, initializeDefaultSettings, getAllSettings

### Offer Management (5)
- createOffer, getOffers, getOfferById, updateOffer, deleteOffer

### Variation Management (6)
- checkVariationConflicts, addQualifyingVariations, getQualifyingVariations, getOfferForVariation, removeQualifyingVariation, getAllVariationAssignments

### Customer APIs (11)
- getCustomerDetails, lookupCustomerFromLoyalty, lookupCustomerFromFulfillmentRecipient, lookupCustomerFromOrderRewards, getCustomerLoyaltyStatus, getCustomerLoyaltyHistory, getCustomerEarnedRewards, cacheCustomerDetails, getCachedCustomer, searchCachedCustomers, updateCustomerStats

### Square Integration (7)
- getSquareLoyaltyProgram, createSquareCustomerGroupDiscount, cleanupSquareCustomerGroupDiscount, detectRewardRedemptionFromOrder, createSquareLoyaltyReward, validateEarnedRewardsDiscounts, prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents

### Processing (9)
- processQualifyingPurchase, processRefund, redeemReward, processOrderForLoyalty, processOrderRefundsForLoyalty, processExpiredWindowEntries, processExpiredEarnedRewards, isOrderAlreadyProcessedForLoyalty, processOrderForLoyaltyIfNeeded

### Backfill/Audit (5)
- getCustomerOrderHistoryForAudit, addOrdersToLoyaltyTracking, runLoyaltyCatchup, logAuditEvent, getAuditLogs, getSquareAccessToken, fetchWithTimeout

## Instructions for Future Extractions

1. **Identify the function(s)** to extract and their dependencies
2. **Create new service file** in `services/loyalty-admin/`
3. **Move function(s)** with necessary imports
4. **Update index.js** to import from new module instead of loyalty-service.js
5. **Update loyalty-service.js** to import from new module if still needed internally
6. **Check for circular dependencies** - use lazy require if needed
7. **Update this document** with new module information

---

*Last Updated: 2026-02-05*
*Refactoring Phase: P1-1 Phase 4 Complete*
