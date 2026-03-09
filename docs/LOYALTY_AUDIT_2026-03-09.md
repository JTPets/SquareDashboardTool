# Loyalty System Audit — 2026-03-09

Comprehensive audit of `services/loyalty-admin/` (36 files) and `services/webhook-handlers/order-handler/order-loyalty.js`.

## CRITICAL Issues

### CRIT-1: Race Condition — Concurrent Webhooks Create Duplicate Rewards

**File**: `services/loyalty-admin/reward-progress-service.js:308-333`

**Root cause**: After earning a reward (line 226-230), the code re-counts remaining unlocked purchases (line 292-306). If `currentQuantity >= required_quantity`, it creates a new `in_progress` reward (line 310-327) with a plain `INSERT` — no `ON CONFLICT` guard. Two concurrent webhooks processing orders for the same customer+offer can both earn the same reward and both attempt to create a new `in_progress` row.

The partial unique index `loyalty_rewards_one_in_progress_idx` (migration 024) catches this at the DB level, but the code has **no error handling** for the unique violation. The transaction throws, the entire order's loyalty processing rolls back, and the purchase is silently lost.

**Blast radius**: Any high-volume customer buying qualifying items in quick succession risks losing purchase tracking when both webhooks hit the same window.

**Fix**: Wrap the new `in_progress` INSERT in `ON CONFLICT ... WHERE status = 'in_progress' DO UPDATE SET current_quantity = EXCLUDED.current_quantity`, or catch the unique violation and re-fetch.

---

### CRIT-2: No Row-Level Locking on Purchase Events During Progress Calculation

**File**: `services/loyalty-admin/reward-progress-service.js:36-48`

**Root cause**: The quantity calculation query (lines 36-48) reads unlocked purchase events without `FOR UPDATE`. Two concurrent transactions can both read the same unlocked rows, both conclude the threshold is met, and both proceed to lock the same purchase events. The CTE-based lock query (line 120-142) uses `UPDATE ... FROM ranked_purchases` but doesn't prevent two concurrent transactions from seeing the same snapshot under `READ COMMITTED`.

**Blast radius**: Double-earning of rewards from the same purchases. Financial loss (free product given twice).

**Fix**: Add `FOR UPDATE` to the quantity calculation query and the crossing-row fetch (line 150-167), or use an advisory lock keyed on `(merchantId, offerId, squareCustomerId)`.

---

### CRIT-3: Purchase INSERT Lacks ON CONFLICT for Idempotency Key

**File**: `services/loyalty-admin/purchase-service.js:88-99, 142-157`

**Root cause**: The idempotency check (line 88-99) is a SELECT, then the INSERT (line 142-157) has no `ON CONFLICT`. Two concurrent calls with the same idempotency key where the first hasn't committed yet will both pass the SELECT, and the second INSERT throws a unique constraint violation, rolling back the entire order transaction.

The `order-intake.js` ON CONFLICT claim prevents this at the order level, but direct calls from `processRefund` or `manual-entry-service.js` bypass the order-level claim.

**Blast radius**: Refund processing or manual entries for the same order could lose data if concurrent.

**Fix**: Add `ON CONFLICT (merchant_id, idempotency_key) DO NOTHING RETURNING *` to the INSERT.

---

## HIGH Issues

### HIGH-1: Double Redemption Detection Window

**Files**: `order-loyalty.js:275`, `reward-service.js:481-678`

`detectRewardRedemptionFromOrder()` is called after `processLoyaltyOrder()` commits. It reads earned rewards without locking, then calls `redeemReward()` which starts a new transaction with `FOR UPDATE`. Between read and lock, another webhook can detect the same reward. No data corruption (FOR UPDATE protects), but noisy error logs.

**Fix**: Gracefully handle already-redeemed status in `redeemReward()` (return instead of throw) or deduplicate in `orderProcessingCache`.

---

### HIGH-2: All Loyalty Errors Silently Swallowed

**File**: `order-loyalty.js:310-317`

The entire `processLoyalty` function is wrapped in try/catch that logs but never re-throws. Any transient DB error permanently loses that order's loyalty data — Square won't retry a webhook that returned success.

**Fix**: Re-throw errors to trigger Square webhook retry, or implement a dead-letter queue for failed loyalty processing.

---

### HIGH-3: Refund Processing Not Atomic Across Line Items

**File**: `purchase-service.js:276-437`

`processRefund()` always creates its own transaction — no `transactionClient` option. Each refund line item in `processOrderRefundsForLoyalty` gets an independent transaction. If item 2 of 3 fails, item 1 is committed and item 3 is skipped.

**Fix**: Add `transactionClient` option to `processRefund()`, wrap all refund items in a single transaction.

---

### HIGH-4: Pre-Redemption Check Implemented But Never Called

**File**: `order-loyalty.js:74-206`

`checkOrderForRedemption()` is exported and wired into OrderHandler but never called in the webhook flow. The function comment says "must run BEFORE processing purchases" to prevent linking purchases to the reward being redeemed. The actual code does the opposite — purchases first, then redemption detection.

`shouldSkipLineItem` + `buildDiscountMap` in `order-intake.js` may partially mitigate this by skipping items with loyalty discounts. Needs verification.

**Fix**: Either wire the pre-check into the flow or delete the dead code.

---

### HIGH-5: schema.sql Out of Sync With Live Database

**File**: `database/schema.sql:1559-1560`

`schema.sql` still has `CONSTRAINT loyalty_rewards_one_in_progress UNIQUE(merchant_id, offer_id, square_customer_id) DEFERRABLE INITIALLY DEFERRED`. Migration 024 replaced this with a partial unique index `WHERE status = 'in_progress'`. Building from `schema.sql` creates the wrong constraint.

**Fix**: Update `schema.sql` to match migration 024.

---

### HIGH-6: Refund-Triggered Revocation Doesn't Clean Up Square Discount

**File**: `purchase-service.js:342-408`

When a refund causes earned reward revocation, the code updates DB status but does NOT call `cleanupSquareCustomerGroupDiscount()`. The customer retains an active discount in Square POS. Compare with `expiration-service.js:190-201` and `redeemReward()` which both call cleanup.

**Fix**: Add `cleanupSquareCustomerGroupDiscount()` after the revocation block, outside the transaction.

---

## MEDIUM Issues

### MED-1: Async Square Discount Creation Can Orphan Objects on Rollback

**File**: `reward-progress-service.js:261-289`

After transitioning to `earned`, Square discount creation fires as a detached `.then()`. If the main transaction rolls back after firing, a Square discount may exist with no corresponding DB record. The retry mechanism won't find an orphan (no `square_sync_pending = TRUE` row).

**Fix**: Don't fire async discount creation until after transaction commit.

---

### MED-2: Expiration Loop Exits on First Error

**File**: `expiration-service.js:46-81`

The catch block at line 75 does ROLLBACK then `throw`, exiting the entire function. One bad record prevents processing all remaining expirations.

**Fix**: Catch per-iteration, log, and continue.

---

### MED-3: N+1 Queries in Redemption Detection

**Files**: `order-loyalty.js:97-156`, `reward-service.js:506-583`

For each discount on an order, individual `loyalty_rewards` query. An order with 5 discounts = 5 queries.

**Fix**: Batch `WHERE square_discount_id = ANY($1) OR square_pricing_rule_id = ANY($1)`.

---

### MED-4: 6 Sequential Queries in Customer Summary Update

**File**: `customer-summary-service.js:22-111`

Six separate queries run inside the transaction before the upsert, adding latency to every purchase/refund.

**Fix**: Combine into 1-2 CTEs.

---

### MED-5: No DB-Level State Transition Enforcement

**File**: Database schema

`loyalty_rewards.status` has CHECK for valid values but nothing prevents backwards transitions (`redeemed → earned`, `revoked → in_progress`).

**Fix**: Add a trigger enforcing: `in_progress → earned → redeemed|revoked` (terminal states).

---

### MED-6: Ambiguous LIMIT 1 in Free-Item Reward Matching

**File**: `reward-service.js:271-285`

If a customer has earned rewards for two offers whose qualifying variations both include the free item, `LIMIT 1` returns an arbitrary match.

**Fix**: Add `ORDER BY r.earned_at ASC` (FIFO) or match against specific offer.

---

### MED-7: Partial Commit on Per-Item Error in Order Intake

**File**: `order-intake.js:188-197`

If one variation's `processQualifyingPurchase` throws, the error is caught, but the transaction commits with the successful items. The order is marked as processed, so the failed variation is permanently lost.

**Fix**: Rollback entire transaction on any error, or implement per-item retry.

---

## LOW Issues

### LOW-1: Diagnostic Logging at INFO Level

Multiple `DIAGNOSTIC` blocks marked "remove after issue confirmed resolved" log full discount arrays at INFO level on every order.

### LOW-2: New DB Connection Per Expired Reward

`expiration-service.js:134` creates a new connection per reward in the loop.

### LOW-3: `buildDiscountMap` Includes Non-Earned Reward IDs

`order-intake.js:290-296` fetches all reward discount IDs regardless of status.

### LOW-4: Refund Idempotency Key Collision Without `returnLineItemUid`

`purchase-service.js:251-253` falls back to quantity-based key, which can collide.

### LOW-5: Dead Code — `checkOrderForRedemption`

Exported, never called. Duplicates `detectRewardRedemptionFromOrder`.

### LOW-6: Customer Source Mapping Loses Granularity

`order-loyalty.js:48-53` only maps 3 of 6+ identification methods.

### LOW-7: `markSyncPending` Silently Fails

`reward-progress-service.js:353-369` catches all errors, never throws.

### LOW-8: 43% of Services Have Zero Test Coverage

16 of 37 loyalty-admin services untested. Most critical: `reward-progress-service.js` (state machine), `audit-service.js` (compliance), `customer-identification-service.js` (6-method fallback chain).

---

## Summary

| # | Severity | Issue | Component |
|---|----------|-------|-----------|
| CRIT-1 | CRITICAL | Duplicate reward creation race condition | reward-progress-service.js |
| CRIT-2 | CRITICAL | No row-level locking on purchase events | reward-progress-service.js |
| CRIT-3 | CRITICAL | Purchase INSERT lacks ON CONFLICT | purchase-service.js |
| HIGH-1 | HIGH | Double redemption detection window | order-loyalty.js / reward-service.js |
| HIGH-2 | HIGH | Loyalty errors silently swallowed | order-loyalty.js |
| HIGH-3 | HIGH | Refund processing not atomic | purchase-service.js |
| HIGH-4 | HIGH | Pre-redemption check never called | order-loyalty.js |
| HIGH-5 | HIGH | schema.sql out of sync | database/schema.sql |
| HIGH-6 | HIGH | Revocation missing Square cleanup | purchase-service.js |
| MED-1 | MEDIUM | Async discount creation orphans | reward-progress-service.js |
| MED-2 | MEDIUM | Expiration loop exits on first error | expiration-service.js |
| MED-3 | MEDIUM | N+1 queries in redemption detection | order-loyalty.js / reward-service.js |
| MED-4 | MEDIUM | 6 sequential queries in summary | customer-summary-service.js |
| MED-5 | MEDIUM | No DB state transition enforcement | schema |
| MED-6 | MEDIUM | Ambiguous LIMIT 1 in free-item match | reward-service.js |
| MED-7 | MEDIUM | Partial commit on per-item error | order-intake.js |
| LOW-1 | LOW | Diagnostic logs at INFO level | multiple |
| LOW-2 | LOW | New DB connection per expired reward | expiration-service.js |
| LOW-3 | LOW | buildDiscountMap includes all statuses | order-intake.js |
| LOW-4 | LOW | Refund idempotency key collision | purchase-service.js |
| LOW-5 | LOW | Dead code — unused function | order-loyalty.js |
| LOW-6 | LOW | Customer source mapping gaps | order-loyalty.js |
| LOW-7 | LOW | markSyncPending silently fails | reward-progress-service.js |
| LOW-8 | LOW | 43% services untested | systemic |

**Recommended fix order**: CRIT-2 → CRIT-1 → HIGH-6 → HIGH-2 → CRIT-3 → HIGH-5 → HIGH-3 → HIGH-4 → MED-1 → MED-5 → MED-2 → MED-7 → remaining.
