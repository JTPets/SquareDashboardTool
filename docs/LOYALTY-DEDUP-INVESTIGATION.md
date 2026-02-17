# Loyalty Dedup Investigation: BACKLOG-15 (L-2) + BACKLOG-16 (L-3)

**Date**: 2026-02-17
**Status**: Investigation only — no code changes
**Scope**: Dual `updateRewardProgress()` and dual `redeemReward()` implementations

---

## Executive Summary

Two parallel loyalty service layers exist with functionally divergent implementations of the same operations. The **admin layer** (`services/loyalty-admin/`) is the canonical production path. The **loyalty layer** (`services/loyalty/`) is a modern webhook-processing layer that is feature-flagged off (`USE_NEW_LOYALTY_SERVICE=false`). Both layers have their own `updateRewardProgress()` and `redeemReward()` with different signatures and different algorithms.

**Current risk**: LOW — only one path is active in production today. Risk becomes HIGH if the feature flag is enabled without reconciling the algorithms, or if developers import from the wrong module.

---

## BACKLOG-15: Dual updateRewardProgress() — Threshold-Crossing Logic

### Implementation A: Admin Layer (PRODUCTION — active)

**File**: `services/loyalty-admin/purchase-service.js:130-306`
**Signature**: `updateRewardProgress(client, data)` where `data = { merchantId, offerId, squareCustomerId, offer }`
**Triggered by**: `processQualifyingPurchase()` (:445), `processRefund()` (:630), `processExpiredWindowEntries()` (expiration-service.js)

#### Algorithm

1. **Count qualifying quantity**: Simple `SUM(quantity)` of unlocked purchases within rolling window
   ```sql
   WHERE window_end_date >= CURRENT_DATE AND reward_id IS NULL
   ```
   - No exclusion of superseded/split rows
   - No `purchased_at` window filtering — uses `window_end_date >= CURRENT_DATE` only

2. **Get or create in_progress reward**: `SELECT ... FOR UPDATE` on `status = 'in_progress'`
   - If none exists and `currentQuantity > 0`: creates new `in_progress` reward
   - If exists: updates `current_quantity`, logs audit event

3. **Threshold check**: `currentQuantity >= offer.required_quantity && reward.status === 'in_progress'`

4. **Purchase locking** (when threshold crossed):
   ```sql
   UPDATE loyalty_purchase_events SET reward_id = $1
   WHERE id IN (
       SELECT id FROM loyalty_purchase_events
       WHERE ... AND reward_id IS NULL
       ORDER BY purchased_at ASC
       LIMIT $5  -- offer.required_quantity
   )
   ```
   - Locks exactly `required_quantity` rows using `LIMIT`
   - **Does NOT split crossing rows** — if a row with qty=3 crosses the threshold, the entire row is locked
   - Excess units in that row are consumed (lost to next cycle)

5. **Post-earn actions**:
   - Transitions reward to `earned` status
   - Logs `REWARD_EARNED` audit event
   - Updates customer stats (async, fire-and-forget)
   - Creates Square Customer Group Discount (async, fire-and-forget)
   - Updates `loyalty_customer_summary` (within transaction)

### Implementation B: Loyalty Layer (INACTIVE — feature-flagged off)

**File**: `services/loyalty/purchase-service.js:268-365` + `createOrUpdateReward()` at :385-721
**Signature**: `updateRewardProgress(client, squareCustomerId, offerId, requiredQuantity, windowMonths, traceId, redemptionContext)` — 7 parameters
**Triggered by**: `LoyaltyPurchaseService.recordPurchase()` (:185)

#### Algorithm

1. **Calculate window from first purchase**: Derives window start/end from `MIN(purchased_at)` of unlocked purchases
   ```sql
   MIN(purchased_at) as window_start,
   MIN(purchased_at) + INTERVAL '1 month' * $4 as window_end
   ```
   - Dynamically calculates window, not from stored `window_end_date`

2. **Count qualifying quantity with split-row exclusion**:
   ```sql
   WHERE purchased_at >= $4 AND purchased_at < $5
     AND reward_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM loyalty_purchase_events child
       WHERE child.original_event_id = lpe.id
     )
   ```
   - Excludes rows that have been superseded by split records
   - Uses `purchased_at` range (not `window_end_date`)

3. **Threshold check**: `currentProgress >= requiredQuantity`

4. **Reward creation**: Calls `createOrUpdateReward()` which:
   - Checks for existing `in_progress` reward → transitions to `earned`
   - If no `in_progress`: checks for existing unredeemed `earned` reward → returns early (prevents duplicates)
   - Has redemption context awareness: if current order is a redemption, allows new purchases to stay unlocked

5. **Purchase locking with row splitting** (when threshold crossed):
   - **Step 1**: Lock rows fully consumed (`cumulative_qty <= required`):
     ```sql
     WITH ranked_purchases AS (
       SELECT id, quantity,
         SUM(quantity) OVER (ORDER BY purchased_at ASC, id ASC) as cumulative_qty
       FROM loyalty_purchase_events ...
     )
     UPDATE ... WHERE cumulative_qty <= $5
     ```
   - **Step 2**: Split the crossing row:
     - Creates locked partial: `qty = needed_from_crossing`, `reward_id = rewardId`, `original_event_id = crossing_row.id`
     - Creates unlocked excess: `qty = excess`, `reward_id = NULL`, `original_event_id = crossing_row.id`
     - Original row stays unchanged but is excluded from future counting (has children)

6. **Post-earn actions**:
   - Logs via `loyaltyLogger.reward()` (structured logger, not audit table)
   - Logs via `this.tracer.span()` (in-memory trace)
   - **No Square Customer Group Discount creation**
   - **No `loyalty_customer_summary` update**
   - **No `logAuditEvent()` call**

### Side-by-Side Behavioral Differences

| Aspect | Admin Layer (Active) | Loyalty Layer (Inactive) |
|--------|---------------------|--------------------------|
| **Signature** | `(client, { merchantId, offerId, squareCustomerId, offer })` | `(client, squareCustomerId, offerId, requiredQuantity, windowMonths, traceId, redemptionContext)` |
| **Window calculation** | Uses stored `window_end_date >= CURRENT_DATE` | Calculates from `MIN(purchased_at) + window_months` |
| **Split-row exclusion** | No — counts all unlocked rows | Yes — `NOT EXISTS (child.original_event_id = lpe.id)` |
| **Crossing-row handling** | `LIMIT` locks entire row (excess lost) | Splits into locked + unlocked children |
| **Rollover accuracy** | Imprecise — excess units consumed | Precise — excess preserved for next cycle |
| **Audit logging** | `logAuditEvent()` to `loyalty_audit_logs` | `loyaltyLogger` to file only |
| **Square discount** | Creates async | Does not create |
| **Customer summary** | Updates `loyalty_customer_summary` | Does not update |
| **Redemption context** | Not supported | Supported — knows when earned reward is being redeemed |

### Which Path Is Active?

```
Webhook (order.completed)
  → OrderHandler._processLoyalty()  (order-handler.js:838)
    → processOrderForLoyalty()  (order-handler.js:128)
      → if (FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE)
        → YES: LoyaltyWebhookService.processOrder()          ← LOYALTY LAYER
             → LoyaltyPurchaseService.recordPurchase()
             → this.updateRewardProgress(...)                 ← 7-param version
        → NO:  loyaltyService.processOrderForLoyalty()        ← ADMIN LAYER (DEFAULT)
             → processQualifyingPurchase()
             → updateRewardProgress(client, data)             ← object-param version
```

**Current production**: `USE_NEW_LOYALTY_SERVICE=false` → Admin layer is active.

**Both paths CANNOT fire for the same purchase**: The feature flag is a hard branch. Only one path runs.

### Dead Code Assessment

The loyalty layer's `updateRewardProgress()` is **not dead code** — it's behind a feature flag and is the intended future path. However, it is currently inactive and:
- Has divergent behavior that would produce different results if enabled
- Missing audit logging, Square discount creation, and customer summary updates
- Has more sophisticated row-splitting that the admin layer lacks

---

## BACKLOG-16: Dual redeemReward() — Different Signatures

### Implementation A: Admin Layer (PRODUCTION — active)

**File**: `services/loyalty-admin/reward-service.js:40-194`
**Signature**: `redeemReward(redemptionData)` — single object parameter
**Exported via**: `services/loyalty-admin/index.js` → `utils/loyalty-service.js` (re-export stub)

#### Parameters
```javascript
{
  merchantId,           // REQUIRED
  rewardId,             // reward to redeem
  squareOrderId,        // Square order ID
  squareCustomerId,     // for validation only
  redemptionType,       // ORDER_DISCOUNT | MANUAL_ADMIN | AUTO_DETECTED
  redeemedVariationId,  // which variation was free
  redeemedValueCents,   // value of redeemed item
  redeemedByUserId,     // admin user ID (if manual)
  adminNotes,           // admin-provided notes
  squareLocationId,     // location
  redeemedAt            // timestamp override
}
```

#### Operations (in transaction)
1. Lock and fetch reward (`FOR UPDATE`)
2. Validate: exists, status = `earned`, customer matches
3. Fetch variation details for redemption record
4. **INSERT into `loyalty_redemptions`** table (legacy, kept for backward compat)
5. **UPDATE `loyalty_rewards`** → status = `redeemed`, set `redemption_id`, `redemption_order_id`
6. **Log audit event** (`REWARD_REDEEMED`)
7. **Update customer summary**
8. COMMIT
9. **Cleanup Square discount objects** (outside transaction, non-critical)

#### Return Value
```javascript
{ success: true, redemption: { ...full_redemption_row }, reward: { ...updated_reward } }
```

#### Error Handling
- Throws on validation failure (not found, wrong status, customer mismatch)
- Rollback on any error

#### Callers
- `routes/loyalty.js:586` — HTTP POST `/api/loyalty/rewards/:rewardId/redeem`
- `detectRewardRedemptionFromOrder()` (reward-service.js:546, :589, :630) — auto-detection
- `loyalty-catchup-job.js` — via `detectRewardRedemptionFromOrder()`
- `order-handler.js:904` — via `loyaltyService.detectRewardRedemptionFromOrder()`

### Implementation B: Loyalty Layer (INACTIVE — feature-flagged off)

**File**: `services/loyalty/reward-service.js:161-279`
**Signature**: `redeemReward(rewardId, redemptionData = {})` — 2 positional parameters
**Class method on**: `LoyaltyRewardService`

#### Parameters
```javascript
rewardId,                    // first param
{
  squareOrderId,             // optional
  traceId                    // optional
}
```

#### Operations (in transaction)
1. Lock and fetch reward (`FOR UPDATE`)
2. Validate: exists, not already redeemed (`redeemed_at` check), not expired, status = `earned`
3. **UPDATE `loyalty_rewards`** → status = `redeemed`, set `redemption_order_id`, `trace_id`
4. COMMIT
5. Log via `loyaltyLogger.redemption()` (file only)
6. Log via `this.tracer.span()` (in-memory)

#### What It Does NOT Do
- **No `loyalty_redemptions` table insert** — no redemption record
- **No audit event** (`logAuditEvent`)
- **No customer summary update**
- **No Square discount cleanup**
- **No admin notes / manual redemption support**

#### Return Value
```javascript
{ success: true, rewardId, offerId, offerName, squareCustomerId, redeemedAt }
```

#### Error Handling
- Returns `{ success: false, reason: '...' }` on validation failure (does NOT throw)
- Different from admin layer which throws

#### Callers
- **None in production** — only called in tests (`services/loyalty/__tests__/reward-service.test.js`)

### Side-by-Side Behavioral Differences

| Aspect | Admin Layer (Active) | Loyalty Layer (Inactive) |
|--------|---------------------|--------------------------|
| **Signature** | `redeemReward(redemptionData)` | `redeemReward(rewardId, data)` |
| **merchantId** | From `redemptionData.merchantId` | From `this.merchantId` (class) |
| **Redemption record** | Yes — `loyalty_redemptions` table | No |
| **Audit trail** | Yes — `logAuditEvent()` | No — file logger only |
| **Square cleanup** | Yes — `cleanupSquareCustomerGroupDiscount()` | No |
| **Customer summary** | Yes — `updateCustomerSummary()` | No |
| **Error behavior** | Throws on validation | Returns `{ success: false }` |
| **Admin support** | Yes — `redeemedByUserId`, `adminNotes` | No |
| **Redemption type** | Yes — `ORDER_DISCOUNT`, `MANUAL_ADMIN`, `AUTO_DETECTED` | No |
| **Value tracking** | Yes — `redeemedValueCents`, `redeemedVariationId` | No |

### Can Both Fire for the Same Redemption?

**No** — with the current architecture:
- The admin `redeemReward()` is called by `detectRewardRedemptionFromOrder()` which runs after purchase processing
- The loyalty `redeemReward()` has no callers in production
- Even if the feature flag were enabled, the loyalty layer's `processOrder()` does not call `redeemReward()` — it only records purchases. Redemption detection happens in `order-handler._processLoyalty()` (:904) which always uses `loyaltyService.detectRewardRedemptionFromOrder()` (admin layer)

**Risk scenario**: A developer instantiates `LoyaltyRewardService` and calls `redeemReward()` directly — the redemption succeeds (DB update) but skips audit, Square cleanup, and redemption record creation. Silent data loss.

---

## Call Chain Diagrams

### Purchase → Reward Progress (Active Path)

```
Square Webhook (order.completed / payment.updated)
  │
  ├─ order-handler.js:292 → _processLoyalty()
  │    │
  │    ├─ :841 → loyaltyService.isOrderAlreadyProcessedForLoyalty() [dedup]
  │    ├─ :853 → _checkOrderForRedemption() [pre-check]
  │    │    ├─ Strategy 1: Match discount catalog_object_id → loyalty_rewards
  │    │    ├─ Strategy 2: matchEarnedRewardByFreeItem() [free item fallback]
  │    │    └─ Strategy 3: matchEarnedRewardByDiscountAmount() [discount amount]
  │    │
  │    ├─ :867 → processOrderForLoyalty(order, merchantId, { redemptionContext })
  │    │    │
  │    │    └─ FEATURE_FLAGS.USE_NEW_LOYALTY_SERVICE?
  │    │         │
  │    │         ├─ FALSE (current): loyaltyService.processOrderForLoyalty()
  │    │         │    │  (webhook-processing-service.js)
  │    │         │    ├─ Identify customer (6 methods)
  │    │         │    ├─ For each qualifying line item:
  │    │         │    │    └─ processQualifyingPurchase() (purchase-service.js:336)
  │    │         │    │         ├─ getOfferForVariation()
  │    │         │    │         ├─ Idempotency check
  │    │         │    │         ├─ INSERT loyalty_purchase_events
  │    │         │    │         └─ updateRewardProgress(client, data)  ← ADMIN LAYER
  │    │         │    │              ├─ SUM unlocked purchases
  │    │         │    │              ├─ Get/create in_progress reward
  │    │         │    │              ├─ If threshold: LIMIT-lock + earn
  │    │         │    │              ├─ Create Square discount (async)
  │    │         │    │              └─ Update customer summary
  │    │         │    └─ processRefund() if applicable
  │    │         │
  │    │         └─ TRUE (future): LoyaltyWebhookService.processOrder()
  │    │              │  (webhook-service.js)
  │    │              ├─ identifyCustomerFromOrder() (6 methods)
  │    │              ├─ getActiveOffers() + getAllQualifyingVariationIds()
  │    │              └─ For each qualifying line item:
  │    │                   └─ purchaseService.recordPurchase()  (loyalty/purchase-service.js:44)
  │    │                        └─ this.updateRewardProgress(...)  ← LOYALTY LAYER
  │    │                             ├─ Calculate window from MIN(purchased_at)
  │    │                             ├─ SUM with split-row exclusion
  │    │                             ├─ If threshold: createOrUpdateReward()
  │    │                             │    ├─ Window-lock fully consumed rows
  │    │                             │    └─ Split crossing row into locked + excess
  │    │                             ├─ NO Square discount creation
  │    │                             └─ NO customer summary update
  │    │
  │    └─ :904 → loyaltyService.detectRewardRedemptionFromOrder() [always admin layer]
  │         ├─ Strategy 1-3 matching
  │         └─ If detected: redeemReward(redemptionData)  ← ADMIN LAYER always
  │
  └─ payment-path: _processPaymentForLoyalty() → same flow via processOrderForLoyalty()
```

### Redemption (Active Path)

```
Detection + Redemption Flow:

1. Auto-detection (webhook):
   order-handler.js:904
     → loyaltyService.detectRewardRedemptionFromOrder()
       → reward-service.js:469 (admin layer)
         ├─ Strategy 1: catalog_object_id match → redeemReward(:546)
         ├─ Strategy 2: free item match → redeemReward(:589)
         └─ Strategy 3: discount amount match → redeemReward(:630)
              └─ redeemReward() (admin, :40)
                   ├─ Lock reward (FOR UPDATE)
                   ├─ Validate status = earned
                   ├─ INSERT loyalty_redemptions
                   ├─ UPDATE loyalty_rewards → redeemed
                   ├─ logAuditEvent(REWARD_REDEEMED)
                   ├─ updateCustomerSummary()
                   └─ cleanupSquareCustomerGroupDiscount() [async]

2. Manual admin redemption:
   routes/loyalty.js:586 → POST /api/loyalty/rewards/:rewardId/redeem
     → loyaltyService.redeemReward(redemptionData)
       → same admin layer redeemReward()

3. Catchup job:
   jobs/loyalty-catchup-job.js:216
     → loyaltyService.detectRewardRedemptionFromOrder()
       → same admin layer flow
```

---

## Additional Duplications Found

Beyond BACKLOG-15 and BACKLOG-16, these duplications exist between the two layers:

| # | Function | Admin Layer | Loyalty Layer | Risk |
|---|----------|-------------|---------------|------|
| L-4 | `getCustomerDetails()` | `customer-admin-service.js:29` — `(customerId, merchantId)` | `customer-service.js:601` — class method `(customerId)` | Medium — cache-first vs direct API |
| L-4 | `cacheCustomerDetails()` | `customer-cache-service.js:27` — `(customer, merchantId)` | `customer-service.js:633` — class method `(customerId)` | Medium — takes object vs fetches |
| L-4 | Customer identification | `lookupCustomer*()` (3 functions) | `identifyFrom*()` (5 class methods) | Medium — different naming, different API clients |
| L-5 | `getOffers` / `getActiveOffers` | `offer-admin-service.js:110` — with reward stats | `offer-service.js:30` — without stats | Low |
| L-5 | `getQualifyingVariations` | `variation-admin-service.js:164` — `(offerId, merchantId)` | `offer-service.js:163` — class method `(offerId)` | Low |
| L-5 | `getOfferForVariation` | `variation-admin-service.js:184` — singular return | `offer-service.js:69` — `getOffersForVariation` plural | Low — name conflict |
| L-6 | `fetchWithTimeout()` | `shared-utils.js:21` — standalone function | `square-client.js:39` — standalone function | Medium — no retry vs retry |
| L-6 | Square API client | Raw `fetch()` calls | `LoyaltySquareClient` class with retry | High — divergent error handling |

---

## Risk Assessment

### What Breaks Today

**Nothing** — the feature flag ensures only one path is active. The admin layer handles all production traffic correctly.

### What Could Break

1. **Feature flag enabled without reconciliation**: If `USE_NEW_LOYALTY_SERVICE=true` is set:
   - Purchase processing switches to loyalty layer
   - Rewards are earned without Square discount creation → customers don't get auto-applied discounts at POS
   - Customer summary not updated → dashboard shows stale progress
   - Audit trail breaks → `loyalty_audit_logs` misses events
   - Row splitting creates `original_event_id` references that admin layer doesn't expect in subsequent queries

2. **Wrong import by developer**: If a developer imports `LoyaltyRewardService` from `services/loyalty/` and calls `redeemReward()`:
   - Redemption succeeds (DB update) but no audit trail, no Square cleanup, no redemption record
   - Customer summary shows stale data
   - Dashboard may not reflect the redemption

3. **Under load (if both paths could fire)**: Not possible today due to feature flag. But if a code path were to bypass the flag:
   - Double-counting: same purchase processed by both layers
   - Split rows from loyalty layer + LIMIT locking from admin layer = corrupt state
   - Rollover excess lost in admin path but preserved in loyalty path = progress drift

### Data Integrity Concerns

The loyalty layer creates `original_event_id` references when splitting rows. If the feature flag were toggled mid-stream:
- Admin layer doesn't filter on `original_event_id` → would count both parent and child rows
- Could lead to double-counting and premature reward earning

---

## Recommended Fix Approach (DO NOT IMPLEMENT)

### Phase 1: Consolidate redeemReward() (BACKLOG-16)

**Effort**: Small (S)
**Risk**: Low

1. Deprecate `services/loyalty/reward-service.js:redeemReward()` — it has no production callers
2. Add JSDoc `@deprecated` annotation pointing to admin layer version
3. Update tests that call the loyalty layer version to use admin layer directly
4. Consider removing the method entirely since the class has no callers in production

### Phase 2: Consolidate updateRewardProgress() (BACKLOG-15)

**Effort**: Medium (M)
**Risk**: Medium — the split-row algorithm is more correct but admin layer lacks it

Two approaches:

**Option A: Port split-row logic to admin layer** (recommended)
1. Add `NOT EXISTS (child.original_event_id)` filter to admin layer's progress query
2. Port crossing-row splitting from loyalty layer into admin layer's threshold handler
3. Keep all existing audit logging, Square discount creation, customer summary updates
4. Admin layer gains the accuracy of the loyalty layer while keeping its completeness

**Option B: Complete the loyalty layer** (higher effort)
1. Add `logAuditEvent()` calls to loyalty layer
2. Add Square Customer Group Discount creation
3. Add `updateCustomerSummary()` calls
4. Enable the feature flag
5. This effectively replaces the admin layer's purchase processing entirely

**Recommendation**: Option A — smaller surface area, lower risk, preserves the battle-tested admin layer.

### Phase 3: Standardize interfaces

1. Adopt the object-parameter pattern (`data = { ... }`) over positional parameters
2. Standardize on standalone functions (admin style) over class methods for this layer
3. The loyalty layer's class-based services remain useful for the webhook orchestration but should delegate to admin layer functions for DB operations

---

## Files Referenced

| File | Purpose | Lines of Interest |
|------|---------|-------------------|
| `services/loyalty-admin/purchase-service.js` | Admin `updateRewardProgress()` | :130-306 |
| `services/loyalty/purchase-service.js` | Loyalty `updateRewardProgress()` + `createOrUpdateReward()` | :268-721 |
| `services/loyalty-admin/reward-service.js` | Admin `redeemReward()` + detection | :40-194, :469-666 |
| `services/loyalty/reward-service.js` | Loyalty `redeemReward()` | :161-279 |
| `services/webhook-handlers/order-handler.js` | Webhook entry + feature flag branch | :128-173, :838-939 |
| `services/loyalty/webhook-service.js` | Modern webhook orchestrator | :70-418 |
| `services/loyalty-admin/index.js` | Admin public API (53 exports) | :160-253 |
| `utils/loyalty-service.js` | Re-export stub → admin layer | :1-18 |
| `config/constants.js` | `USE_NEW_LOYALTY_SERVICE` flag | :79-80 |
