# Loyalty System Tracking Audit Report

**Date:** January 22, 2026
**Auditor:** Claude Code
**Scope:** Full codebase audit for errors that could cause loyalty tracking problems

---

## Executive Summary

This audit identified **12 critical issues** in the loyalty tracking system that could cause:
- Purchases not being tracked
- Rewards not being created or being blocked
- Inconsistent progress calculations
- Data integrity problems
- Race conditions leading to duplicates or missed events

**Severity Breakdown:**
- CRITICAL (blocks functionality): 3
- HIGH (causes incorrect tracking): 5
- MEDIUM (potential edge case issues): 4

---

## CRITICAL Issues

### 1. Schema Column Mismatch - `locked_to_reward_id` vs `reward_id`

**Severity:** CRITICAL
**Files Affected:**
- `services/loyalty/purchase-service.js:217`
- `services/loyalty/purchase-service.js:411`

**Problem:**
The purchase service queries for `locked_to_reward_id` which **does not exist** in the schema. The actual column name is `reward_id`.

```javascript
// purchase-service.js:217 - WRONG
AND locked_to_reward_id IS NULL

// Schema (010_loyalty_program.sql:124) - CORRECT
reward_id UUID,  -- Set when this purchase is locked into an earned reward
```

**Impact:**
- Queries fail or return incorrect results
- Purchase progress calculations are wrong
- Customers may never earn rewards despite making qualifying purchases

**Fix:**
Change all references from `locked_to_reward_id` to `reward_id` in `purchase-service.js`.

---

### 2. Schema Column Mismatch - `time_window_days` vs `window_months`

**Severity:** CRITICAL
**Files Affected:**
- `services/loyalty/purchase-service.js:82, 142, 387, 396, 400, 422`
- `services/loyalty/offer-service.js:39, 78`
- All tests in `services/loyalty/__tests__/purchase-service.test.js`

**Problem:**
The modular services use `time_window_days` but the schema defines `window_months`.

```javascript
// offer-service.js:39 - WRONG
lo.time_window_days,

// Schema (010_loyalty_program.sql:37) - CORRECT
window_months INTEGER NOT NULL DEFAULT 12 CHECK (window_months > 0),
```

**Impact:**
- Window calculations return NULL/undefined
- Rolling window logic is completely broken in the modular services
- Purchases may be counted even after their window expires
- Purchases may be incorrectly excluded from valid windows

**Fix:**
Update all references to use `window_months` and adjust the window calculation logic from days to months.

---

### 3. Database Unique Constraint Prevents Multiple Rewards Per Customer

**Severity:** CRITICAL
**File:** `database/migrations/010_loyalty_program.sql:200-201`

**Problem:**
The unique constraint does not filter by status:

```sql
-- Current constraint (WRONG)
CONSTRAINT loyalty_rewards_one_in_progress UNIQUE(merchant_id, offer_id, square_customer_id)
    DEFERRABLE INITIALLY DEFERRED
```

This constraint applies to ALL rewards regardless of status. Once a customer has ANY reward (in_progress, earned, redeemed, or revoked), they cannot create another one for the same offer.

**Expected Behavior:**
- Customer earns reward #1 and redeems it
- Customer should be able to start progress toward reward #2
- Currently: Customer is BLOCKED from ever earning a second reward

**Impact:**
- Repeat customers can never earn more than one reward per offer
- This fundamentally breaks the "frequent buyer" program concept

**Fix:**
Create a partial unique index instead:

```sql
DROP CONSTRAINT IF EXISTS loyalty_rewards_one_in_progress;
CREATE UNIQUE INDEX loyalty_rewards_one_in_progress
  ON loyalty_rewards (merchant_id, offer_id, square_customer_id)
  WHERE status = 'in_progress';
```

---

## HIGH Severity Issues

### 4. Dual Implementation Inconsistency

**Severity:** HIGH
**Files:**
- `utils/loyalty-service.js` (main monolithic implementation)
- `services/loyalty/*.js` (new modular implementation)

**Problem:**
There are TWO separate implementations of the loyalty logic:

| Aspect | utils/loyalty-service.js | services/loyalty/*.js |
|--------|--------------------------|----------------------|
| Time window | Uses `window_months` | Uses `time_window_days` |
| Column name | Uses `reward_id` | Uses `locked_to_reward_id` |
| Window calc | Months from purchase date | Days from current date |

**Impact:**
- Depending on which code path is executed, different results occur
- Testing passes but production fails (or vice versa)
- Debugging is extremely difficult

**Fix:**
- Consolidate on one implementation
- Remove or update the modular services to match the main implementation
- Add integration tests that verify both paths produce identical results

---

### 5. Race Condition in Purchase Idempotency Check

**Severity:** HIGH
**File:** `services/loyalty/purchase-service.js:53-74`

**Problem:**
The idempotency check and insert are not atomic:

```javascript
// Step 1: Check for existing (NOT in transaction)
const existingResult = await db.query(`
  SELECT id FROM loyalty_purchase_events
  WHERE merchant_id = $1 AND square_order_id = $2 AND variation_id = $3
`, [this.merchantId, squareOrderId, variationId]);

// Step 2: If not found, insert (separate operation)
// Race: Another request could insert between steps 1 and 2
```

**Impact:**
- Duplicate purchase events can be created
- Customer progress may be counted twice
- Rewards may be earned prematurely

**Fix:**
Use the idempotency_key unique constraint with `ON CONFLICT DO NOTHING`:

```javascript
const result = await client.query(`
  INSERT INTO loyalty_purchase_events (...)
  VALUES (...)
  ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
  RETURNING id
`, [...]);

if (result.rows.length === 0) {
  // Already existed
  return { recorded: false, reason: 'duplicate' };
}
```

---

### 6. Window Start Calculation Uses Wrong Date

**Severity:** HIGH
**File:** `services/loyalty/purchase-service.js:206-207`

**Problem:**
Window start is calculated from the current date, not the first purchase date:

```javascript
// WRONG: Uses current date
const windowStart = new Date();
windowStart.setDate(windowStart.getDate() - (timeWindowDays || 365));

// CORRECT: Should use first purchase date in window
```

**Impact:**
- A customer's window shifts every day
- Purchases made near the window boundary may be incorrectly included/excluded
- Progress counts change unpredictably over time

**Fix:**
Calculate window start based on the earliest qualifying purchase date.

---

### 7. Free Item Detection May Skip Valid Purchases

**Severity:** HIGH
**File:** `services/loyalty/webhook-service.js:268-291`

**Problem:**
Items with $0 total are skipped, but this doesn't distinguish between:
- A loyalty reward redemption (should skip)
- A promotional discount (should count if originally paid)
- A price-matched item (should count)

```javascript
// Skip if price is 0 (likely a free item / reward)
const totalMoney = lineItem.total_money?.amount || 0;
if (totalMoney <= 0) {
  // This skips ALL $0 items, not just redemptions
  return { ... reason: 'free_item' };
}
```

**Impact:**
- Customers with promotional discounts don't get loyalty credit
- Items price-matched to $0 don't count
- Only loyalty redemptions should be excluded, not all free items

**Fix:**
Check if the discount is a loyalty discount before skipping:

```javascript
const hasLoyaltyDiscount = lineItem.applied_discounts?.some(d =>
  ourLoyaltyDiscountIds.has(d.discount_uid)
);
if (totalMoney <= 0 && hasLoyaltyDiscount) {
  // Skip only loyalty redemptions
}
```

---

### 8. Progress Update Doesn't Create New In-Progress After Reward Earned

**Severity:** HIGH
**File:** `services/loyalty/purchase-service.js:249-327`

**Problem:**
When a reward is earned, the code doesn't check for remaining purchases that should start a new in_progress reward.

**Scenario:**
1. Customer buys 15 items (required_quantity = 10)
2. Reward is earned with 10 items locked to it
3. 5 items remain but no new in_progress reward is created

**Impact:**
- Excess purchases are "lost" and don't contribute to the next reward
- Customer has to start from scratch after redeeming

**Fix:**
After earning a reward, recalculate remaining unlocked purchases and create a new in_progress if > 0.

---

## MEDIUM Severity Issues

### 9. Missing Transaction in Main Purchase Recording

**Severity:** MEDIUM
**File:** `services/loyalty/purchase-service.js:107-192`

**Problem:**
When a variation qualifies for multiple offers (which shouldn't happen per business rules, but isn't prevented), each offer is processed in a separate transaction. A failure partway through leaves inconsistent state.

**Fix:**
Wrap the entire for-loop in a single transaction.

---

### 10. Variation ID Field Ambiguity

**Severity:** MEDIUM
**File:** `services/loyalty/webhook-service.js:235`

**Problem:**
```javascript
const variationId = lineItem.catalog_object_id || lineItem.variation_id;
```

These may reference different catalog objects (item vs variation). The code assumes they're interchangeable.

**Impact:**
- May look up wrong variation
- May miss qualifying purchases

**Fix:**
Always use `catalog_object_id` for line items from Square's API.

---

### 11. Customer Summary Not Updated on Refund Revocation

**Severity:** MEDIUM
**File:** `utils/loyalty-service.js:2113-2177`

**Problem:**
When a reward is revoked due to refund, `updateCustomerSummary` is not called, leaving stale data.

**Fix:**
Add `await updateCustomerSummary(client, merchantId, squareCustomerId, offer.id);` after revocation.

---

### 12. Missing Index for Common Query Pattern

**Severity:** MEDIUM
**File:** `database/migrations/010_loyalty_program.sql`

**Problem:**
The query pattern `WHERE window_end_date >= CURRENT_DATE AND reward_id IS NULL` is used frequently but has no covering index.

**Fix:**
```sql
CREATE INDEX idx_loyalty_purchase_events_active_unlocked
  ON loyalty_purchase_events (merchant_id, offer_id, square_customer_id, window_end_date)
  WHERE reward_id IS NULL;
```

---

## Recommendations

### Immediate Actions (Before Next Deployment)

1. **Fix column name mismatches** (Issues #1, #2)
   - Update `purchase-service.js` and `offer-service.js`
   - Update all related tests

2. **Fix unique constraint** (Issue #3)
   - Create migration to replace constraint with partial unique index

3. **Add integration tests** that verify:
   - Multi-reward earning works
   - Window calculations are consistent
   - Idempotency prevents duplicates

### Short-Term Actions (This Sprint)

4. **Consolidate implementations** (Issue #4)
   - Decide on single source of truth
   - Deprecate or remove duplicate code

5. **Fix race conditions** (Issue #5)
   - Use `ON CONFLICT` for idempotency

6. **Improve free item detection** (Issue #7)
   - Check discount source before skipping

### Medium-Term Actions (Next Sprint)

7. **Add comprehensive logging** for debugging
8. **Create monitoring alerts** for:
   - Duplicate purchase events
   - Failed reward creations
   - Constraint violations
9. **Add database constraints** to prevent invalid states

---

## Testing Checklist

Before deploying fixes, verify:

- [ ] Customer can earn multiple rewards over time
- [ ] Purchases are correctly counted in rolling window
- [ ] Duplicate webhooks don't create duplicate events
- [ ] Free promotional items still count for loyalty
- [ ] Refunds correctly revoke rewards when needed
- [ ] Excess purchases roll over to next reward cycle
- [ ] Window expiration is handled correctly

---

## Files Requiring Changes

| File | Issues | Priority |
|------|--------|----------|
| `services/loyalty/purchase-service.js` | #1, #2, #5, #6, #8, #9 | CRITICAL |
| `services/loyalty/offer-service.js` | #2 | CRITICAL |
| `database/migrations/` | #3, #12 | CRITICAL |
| `services/loyalty/webhook-service.js` | #7, #10 | HIGH |
| `utils/loyalty-service.js` | #4, #11 | HIGH |
| `services/loyalty/__tests__/*.test.js` | #2 | MEDIUM |

---

*Report generated by Claude Code loyalty system audit*
