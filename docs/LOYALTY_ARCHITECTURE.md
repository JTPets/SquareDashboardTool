# Loyalty Admin Service Architecture

This document describes the modular architecture of `services/loyalty-admin/` after completing the P1-1 Phase 4 refactoring.

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

**Status**: The legacy `loyalty-service.js` monolith (~1,480 lines) has been **fully eliminated**. All functions have been extracted to dedicated modular services.

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
│ RedemptionTypes)│     │  Token)             │     └─────────────────────────┘
└─────────────────┘     └─────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│ settings-       │     │ customer-cache-     │     │ offer-admin-service.js  │
│ service.js      │     │ service.js          │     │ (createOffer, getOffers,│
│                 │     │                     │     │  etc.)                  │
└─────────────────┘     └─────────────────────┘     └─────────────────────────┘
                                   │                            │
                                   ▼                            ▼
                        ┌─────────────────────┐     ┌─────────────────────────┐
                        │ customer-admin-     │     │ variation-admin-        │
                        │ service.js          │     │ service.js              │
                        └─────────────────────┘     └─────────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌─────────────────┐     ┌─────────────────────┐   ┌─────────────────────────┐
│ square-discount-│     │  purchase-service   │   │   reward-service.js     │
│ service.js      │◄────│       .js           │──►│ (redeemReward,          │
│ (Square catalog │     │ (processQualifying- │   │  detectRedemption-      │
│  discount ops)  │     │  Purchase, process- │   │  FromOrder)             │
└────────┬────────┘     │  Refund, update-    │   └───────────┬─────────────┘
         │              │  RewardProgress)    │               │
         │              └──────────┬──────────┘               │
         │                         │                          │
         │              ┌──────────┴──────────┐               │
         │              ▼                     ▼               │
         │   ┌─────────────────────┐ ┌───────────────────┐    │
         │   │ expiration-service  │ │ webhook-processing│    │
         │   │       .js           │ │    -service.js    │◄───┘
         │   │ (processExpired-    │ │ (processOrderFor- │
         │   │  WindowEntries,     │ │  Loyalty, process-│
         └──►│  processExpired-    │ │  OrderRefundsFor- │
             │  EarnedRewards)     │ │  Loyalty)         │
             └─────────────────────┘ └──────────┬────────┘
                                               │
                                               ▼
                                    ┌─────────────────────┐
                                    │ backfill-service.js │
                                    │ (runLoyaltyCatchup, │
                                    │  orderHistory,      │
                                    │  prefetch)          │
                                    └─────────────────────┘
```

## Module Details

### Foundation Modules (No Service Dependencies)

| Module | Lines | Functions | Purpose |
|--------|-------|-----------|---------|
| `constants.js` | 56 | 0 | RewardStatus, AuditActions, RedemptionTypes enums |
| `shared-utils.js` | 72 | 3 | fetchWithTimeout, getSquareAccessToken, getSquareApi |

### Core Service Modules

| Module | Lines | Functions | Purpose |
|--------|-------|-----------|---------|
| `audit-service.js` | 132 | 2 | logAuditEvent, getAuditLogs |
| `settings-service.js` | 108 | 4 | getSetting, updateSetting, initializeDefaultSettings, getAllSettings |
| `offer-admin-service.js` | 313 | 5 | CRUD for loyalty offers |
| `variation-admin-service.js` | 284 | 6 | Qualifying variation management |
| `customer-cache-service.js` | 223 | 4 | Customer detail caching |
| `customer-admin-service.js` | 594 | 7 | Customer lookups and status queries |

### Business Logic Modules (Extracted from loyalty-service.js)

| Module | Lines | Functions | Purpose |
|--------|-------|-----------|---------|
| `purchase-service.js` | ~370 | 4 | processQualifyingPurchase, processRefund, updateRewardProgress, updateCustomerSummary |
| `reward-service.js` | ~250 | 3 | redeemReward, detectRewardRedemptionFromOrder, createSquareLoyaltyReward |
| `webhook-processing-service.js` | ~460 | 2 | processOrderForLoyalty, processOrderRefundsForLoyalty |

### Integration Modules

| Module | Lines | Functions | Purpose |
|--------|-------|-----------|---------|
| `square-discount-service.js` | ~1,136 | 11 | Square Customer Group Discount CRUD, validation |
| `expiration-service.js` | ~200 | 2 | processExpiredWindowEntries, processExpiredEarnedRewards |
| `backfill-service.js` | ~920 | 7 | Catchup, order history audit, prefetch |

## Import Rules

### External Consumers

Always import from `./services/loyalty-admin` (index.js):

```javascript
const loyaltyAdmin = require('./services/loyalty-admin');
await loyaltyAdmin.processOrderForLoyalty(order, merchantId);
```

### Internal Modules (Direct Sibling Imports)

Modules within loyalty-admin import directly from siblings, NEVER through index.js:

```javascript
// purchase-service.js
const { logAuditEvent } = require('./audit-service');
const { getOfferForVariation } = require('./variation-admin-service');
const { createSquareCustomerGroupDiscount } = require('./square-discount-service');
```

### No Lazy Requires Needed

After the final extraction, there are **no circular dependencies** in the module graph. All imports are direct:

- `purchase-service.js` → `square-discount-service.js` (one-way)
- `reward-service.js` → `purchase-service.js` (one-way, for updateCustomerSummary)
- `reward-service.js` → `square-discount-service.js` (one-way)
- `webhook-processing-service.js` → `purchase-service.js` (one-way)
- `expiration-service.js` → `purchase-service.js` (one-way)
- `backfill-service.js` → `webhook-processing-service.js` (one-way)

## Function Reference

### Purchase Processing (purchase-service.js)

| Function | Purpose |
|----------|---------|
| `processQualifyingPurchase(purchaseData)` | Record a qualifying purchase from an order |
| `processRefund(refundData)` | Handle refunds that affect loyalty tracking |
| `updateRewardProgress(client, data)` | Update reward state machine after purchase/refund |
| `updateCustomerSummary(client, merchantId, customerId, offerId)` | Update denormalized customer stats |

### Reward Management (reward-service.js)

| Function | Purpose |
|----------|---------|
| `redeemReward(redemptionData)` | Mark an earned reward as redeemed |
| `detectRewardRedemptionFromOrder(order, merchantId)` | Auto-detect when order uses our discount |
| `createSquareLoyaltyReward(params)` | Legacy redirect to createSquareCustomerGroupDiscount |

### Webhook Processing (webhook-processing-service.js)

| Function | Purpose |
|----------|---------|
| `processOrderForLoyalty(order, merchantId, options)` | Process order from webhook, identify customer, track purchases |
| `processOrderRefundsForLoyalty(order, merchantId)` | Process refunds from order webhook |

### Square Discount Operations (square-discount-service.js)

| Function | Purpose |
|----------|---------|
| `getSquareLoyaltyProgram(merchantId)` | Get Square Loyalty program config |
| `createSquareCustomerGroupDiscount(params)` | Create discount for earned reward |
| `cleanupSquareCustomerGroupDiscount(params)` | Delete discount after redemption |
| `validateEarnedRewardsDiscounts(params)` | Validate/fix discount sync issues |

## Export Verification

All 47 exports from index.js are correctly mapped to their source modules:

### Constants (3)
- RewardStatus, AuditActions, RedemptionTypes → `constants.js`

### Settings (4)
- getSetting, updateSetting, initializeDefaultSettings, getAllSettings → `settings-service.js`

### Offer Management (5)
- createOffer, getOffers, getOfferById, updateOffer, deleteOffer → `offer-admin-service.js`

### Variation Management (6)
- checkVariationConflicts, addQualifyingVariations, getQualifyingVariations, getOfferForVariation, removeQualifyingVariation, getAllVariationAssignments → `variation-admin-service.js`

### Customer APIs (11)
- From `customer-admin-service.js`: getCustomerDetails, lookupCustomerFromLoyalty, lookupCustomerFromFulfillmentRecipient, lookupCustomerFromOrderRewards, getCustomerLoyaltyStatus, getCustomerLoyaltyHistory, getCustomerEarnedRewards
- From `customer-cache-service.js`: cacheCustomerDetails, getCachedCustomer, searchCachedCustomers, updateCustomerStats

### Square Integration (5)
- From `square-discount-service.js`: getSquareLoyaltyProgram, createSquareCustomerGroupDiscount, cleanupSquareCustomerGroupDiscount, validateEarnedRewardsDiscounts
- From `reward-service.js`: detectRewardRedemptionFromOrder, createSquareLoyaltyReward

### Processing (7)
- From `purchase-service.js`: processQualifyingPurchase, processRefund
- From `reward-service.js`: redeemReward
- From `webhook-processing-service.js`: processOrderForLoyalty, processOrderRefundsForLoyalty
- From `expiration-service.js`: processExpiredWindowEntries, processExpiredEarnedRewards

### Backfill/Audit (7)
- From `backfill-service.js`: isOrderAlreadyProcessedForLoyalty, processOrderForLoyaltyIfNeeded, getCustomerOrderHistoryForAudit, addOrdersToLoyaltyTracking, runLoyaltyCatchup, prefetchRecentLoyaltyEvents, findCustomerFromPrefetchedEvents
- From `audit-service.js`: logAuditEvent, getAuditLogs
- From `shared-utils.js`: getSquareAccessToken, fetchWithTimeout

## Migration History

### P1-1 Phase 4 Complete

The loyalty-admin module refactoring is complete:

| Date | Module Created | Lines | Source |
|------|----------------|-------|--------|
| 2026-01-28 | constants.js | 56 | loyalty-service.js |
| 2026-01-28 | shared-utils.js | 72 | loyalty-service.js |
| 2026-01-28 | audit-service.js | 132 | loyalty-service.js |
| 2026-01-28 | settings-service.js | 108 | loyalty-service.js |
| 2026-01-28 | offer-admin-service.js | 313 | loyalty-service.js |
| 2026-01-28 | variation-admin-service.js | 284 | loyalty-service.js |
| 2026-01-28 | customer-cache-service.js | 223 | loyalty-service.js |
| 2026-01-29 | customer-admin-service.js | 594 | loyalty-service.js |
| 2026-01-29 | expiration-service.js | 205 | loyalty-service.js |
| 2026-01-29 | backfill-service.js | 925 | loyalty-service.js |
| 2026-01-30 | square-discount-service.js | 1230 | loyalty-service.js |
| 2026-02-05 | purchase-service.js | ~370 | loyalty-service.js |
| 2026-02-05 | reward-service.js | ~250 | loyalty-service.js + square-discount-service.js |
| 2026-02-05 | webhook-processing-service.js | ~460 | loyalty-service.js |

### Final Cleanup (2026-02-05)

- **Deleted**: `loyalty-service.js` (was 1,482 lines)
- **Moved**: `detectRewardRedemptionFromOrder`, `createSquareLoyaltyReward` from square-discount-service.js to reward-service.js
- **Removed**: All lazy requires (no circular dependencies remain)
- **Updated**: All internal imports to use direct sibling requires

---

*Last Updated: 2026-02-05*
*Refactoring Phase: P1-1 Phase 4 COMPLETE - Monolith Eliminated*
