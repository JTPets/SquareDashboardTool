# BACKLOG-6 Investigation: Consolidate Square Discount/Pricing Rule Deletion

> **Status**: Investigation complete, plan ready for review
> **Date**: 2026-02-12
> **Scope**: Research only — no code changes made

---

## 1. All Square Catalog Object Deletion Paths

### Path A: Loyalty Reward Cleanup (Individual DELETEs)

**File**: `services/loyalty-admin/square-discount-service.js`

| Function | Lines | What it deletes | Trigger |
|----------|-------|-----------------|---------|
| `deleteRewardDiscountObjects()` | 508–589 | DISCOUNT, PRODUCT_SET, PRICING_RULE catalog objects | Called by cleanup orchestrator |
| `cleanupSquareCustomerGroupDiscount()` | 724–804 | Orchestrates: remove customer from group, delete 3 catalog objects, delete group, clear DB IDs | Reward redemption or expiration |
| `removeCustomerFromGroup()` | 242–296 | Customer-group membership (not a catalog object) | Part of cleanup orchestrator |
| `deleteCustomerGroup()` | 306–358 | Customer group (not a catalog object) | Part of cleanup orchestrator |

**Callers**:
- `services/loyalty-admin/reward-service.js:153` — `redeemReward()` calls `cleanupSquareCustomerGroupDiscount()`
- `services/loyalty-admin/expiration-service.js:156` — `processExpiredEarnedRewards()` (cron) calls `cleanupSquareCustomerGroupDiscount()`
- `routes/loyalty.js:1053` — Admin force re-sync endpoint calls `cleanupSquareCustomerGroupDiscount()`
- `routes/loyalty.js:1129` — Bulk sync endpoint calls `cleanupSquareCustomerGroupDiscount()`

**How it works**:
1. Fetches reward record from DB to get Square object IDs
2. Removes customer from Square group via `DELETE /v2/customers/{id}/groups/{groupId}`
3. Loops through up to 3 catalog object IDs and sends individual `DELETE /v2/catalog/object/{objectId}` for each
4. Deletes the customer group via `DELETE /v2/customers/groups/{groupId}`
5. Nullifies all Square IDs in the `loyalty_rewards` DB row

---

### Path B: Expiry Discount Batch Deletion

**File**: `services/expiry/discount-service.js`

| Function | Lines | What it deletes | Trigger |
|----------|-------|-----------------|---------|
| `upsertPricingRule()` | 948–1107 | PRICING_RULE and PRODUCT_SET (when tier has zero variations) | Called during `applyDiscounts()` automation |

**Callers**:
- `services/expiry/discount-service.js` — `applyDiscounts()` → `upsertPricingRule()` for each tier
- Triggered by cron job (`runExpiryDiscountAutomation()`)
- Also triggered after `clearExpiryDiscountForReorder()` causes an `applyDiscounts()` run

**How it works**:
1. Searches Square catalog for existing PRICING_RULE and PRODUCT_SET by name prefix
2. If `variationIds.length === 0` and objects exist, sends `POST /v2/catalog/batch-delete` with all object IDs in one call
3. If variations exist, upserts (creates/updates) the pricing rule and product set instead

---

### Path C: Reorder Expiry Discount Clear (DB-Only, Deferred Square Cleanup)

**File**: `services/expiry/discount-service.js`

| Function | Lines | What it deletes | Trigger |
|----------|-------|-----------------|---------|
| `clearExpiryDiscountForReorder()` | 1716–1823 | Nothing from Square — DB-only tier reset | Purchase order creation |

**Callers**:
- `routes/purchase-orders.js:158` — PO creation calls this for each item with auto-apply discounts

**How it works**:
1. Resets `variation_discount_status` to OK tier in DB
2. Clears `expiration_date` in `variation_expiration` table
3. Logs audit event with `triggered_by = 'REORDER'`
4. The next `applyDiscounts()` cron run rebuilds pricing rules, which calls `upsertPricingRule()` — if the tier now has zero variations, Path B deletes the Square objects

---

### Path D: Square Client Utility (Unused)

**File**: `services/loyalty/square-client.js`

| Function | Lines | What it deletes | Trigger |
|----------|-------|-----------------|---------|
| `deleteCatalogObject()` | 443–456 | Any single catalog object | Not called from anywhere in codebase |

**Notes**: This is a generic convenience method on the SquareClient class. It tolerates 404 (returns `true`). Currently unused — no code calls it.

---

### Excluded Paths (Not Catalog Object Deletion)

| Path | File | Reason Excluded |
|------|------|-----------------|
| Seniors discount | `services/seniors/seniors-service.js` | Only creates and enables/disables pricing rules (date changes). Never deletes. |
| Vendor catalog | `services/vendor/catalog-service.js:913` | Deletes DB rows (`vendor_catalog_items`), not Square catalog objects |
| Offer admin | `services/loyalty-admin/offer-admin-service.js:244` | Deletes DB rows (`loyalty_offers`), not Square catalog objects |

---

## 2. Detailed Comparison

### API Call Pattern

| Aspect | Path A (Loyalty) | Path B (Expiry) | Path C (Reorder) |
|--------|------------------|-----------------|-------------------|
| **Square API method** | Individual `DELETE /v2/catalog/object/{id}` in a loop | Single `POST /v2/catalog/batch-delete` | None (DB-only) |
| **HTTP implementation** | Raw `fetch()` with manual headers | `makeSquareRequest()` utility wrapper | N/A |
| **Max objects per call** | 1 | All at once (batch) | N/A |
| **Typical object count** | 3 (discount + product_set + pricing_rule) | 2 (pricing_rule + product_set) | N/A |

### Error Handling

| Aspect | Path A (Loyalty) | Path B (Expiry) | Path C (Reorder) |
|--------|------------------|-----------------|-------------------|
| **404 handling** | Tolerates (counts as success) | Not explicitly handled (relies on `makeSquareRequest`) | N/A |
| **Retry on failure** | None — single attempt per object | Yes — `makeSquareRequest` retries with exponential backoff, rate-limit awareness | N/A |
| **Partial failure** | Continues loop, collects errors, returns `{success: false, errors: [...]}` | No partial — batch succeeds or fails atomically | N/A |
| **Error propagation** | Returns `{success: false}` (never throws) | Catches and logs as warning, returns success anyway | Throws on DB errors |
| **Caller impact on failure** | Cleanup is non-critical in `redeemReward()` (logged as warning) | Non-critical (empty tier just keeps stale objects) | Critical (throws, PO creation may fail) |

### Square API Version

| Path | Version | Source |
|------|---------|--------|
| Path A (Loyalty) | `2025-01-16` | Hardcoded in each `fetch()` call |
| Path B (Expiry) | `2025-10-16` | From `SQUARE_API_VERSION` constant in `services/square/api.js:25` |
| Path D (Unused) | `2025-01-16` | From `SQUARE_API_VERSION` constant in `services/loyalty/square-client.js:16` |

**Flag**: Path A uses a 9-month-older API version than Path B. Both work today, but diverging versions is a maintenance risk.

### Idempotency Keys

| Path | Uses Idempotency Key? |
|------|-----------------------|
| Path A | No (DELETE is inherently idempotent) |
| Path B | No (batch-delete is also idempotent) |
| Path C | N/A |

DELETE operations don't require idempotency keys since deleting an already-deleted object is a no-op (404).

### Catalog Version / Optimistic Concurrency

| Path | Handles `version` Field? |
|------|--------------------------|
| Path A | No — raw DELETE doesn't check version |
| Path B | No — batch-delete doesn't check version |
| Path B (upsert part) | Yes — passes `version` on update to prevent stale writes |

Deletion doesn't typically require version checks — if the object exists, delete it. If it doesn't, treat as success.

### Local DB Cleanup

| Path | DB Cleanup After Square Deletion |
|------|----------------------------------|
| Path A | Yes — nullifies `square_group_id`, `square_discount_id`, `square_product_set_id`, `square_pricing_rule_id` in `loyalty_rewards` |
| Path B | No explicit DB cleanup — tier record kept, objects just gone from Square |
| Path C | Yes — resets `variation_discount_status` and `variation_expiration` in a transaction |

---

## 3. Inconsistencies and Issues

### Issue 1: Two Different HTTP Abstractions (HIGH)

Path A uses raw `fetch()` with manually constructed headers:
```javascript
// Path A: raw fetch, no retry, no rate-limit handling
const response = await fetch(
    `https://connect.squareup.com/v2/catalog/object/${objectId}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}`, ... } }
);
```

Path B uses the shared `makeSquareRequest()` wrapper:
```javascript
// Path B: shared utility with retry, rate-limit, timeout handling
await squareApiModule.makeSquareRequest('/v2/catalog/batch-delete', {
    method: 'POST', accessToken, body: JSON.stringify({ object_ids: objectsToDelete })
});
```

**Impact**: Path A has zero retry logic and no rate-limit handling. If Square returns a 429 or a transient 500, Path A silently fails and moves on. Path B retries with exponential backoff and handles rate limits properly.

### Issue 2: Diverging Square API Versions (MEDIUM)

- Loyalty paths hardcode `'Square-Version': '2025-01-16'` in every `fetch()` call
- Expiry path uses `services/square/api.js` which has `SQUARE_API_VERSION = '2025-10-16'`

When the API version is bumped, only `services/square/api.js` gets updated. The loyalty path keeps the stale version.

### Issue 3: Inconsistent Error Semantics (MEDIUM)

- Path A: Always returns `{success: boolean}` — never throws. Callers check `result.success`.
- Path B: Catches errors and logs as `warn`, returns success regardless. Caller treats deletion failure as non-blocking.
- Path C: Throws on failure. Caller must catch or the PO creation request fails.

There's no consistent contract for "what happens when deletion fails."

### Issue 4: No Batch Capability in Loyalty Path (LOW)

Path A deletes 3 objects in a sequential loop (3 HTTP round-trips). Path B uses batch-delete (1 HTTP round-trip). For 3 objects the overhead is small, but the batch API exists and is used elsewhere.

### Issue 5: Hardcoded Base URL (LOW)

Path A hardcodes `https://connect.squareup.com/v2/...` in each call. Path B uses a `SQUARE_BASE_URL` constant from the shared API module. Not a functional issue (the URL doesn't change), but a maintenance concern.

---

## 4. Existing Bug/Danger Assessment

### No Active Bugs Found

Both paths function correctly in production today. The inconsistencies are maintenance and reliability risks, not active bugs.

### Potential Risk: Loyalty Cleanup Under Rate Limiting

If Square rate-limits during a reward redemption cleanup (Path A), the catalog objects remain in Square while the DB references are nullified (step 4 of cleanup runs regardless). This creates orphaned Square objects that are never cleaned up. The validation function `validateEarnedRewards()` at line 806+ can detect this, but it's not run automatically.

### Potential Risk: Expiry Tier Deletion Failure Is Silent

If `upsertPricingRule()` fails to delete an empty tier's Square objects, it logs a warning and returns `{success: true, pricingRule: null}`. The stale pricing rule remains in Square, potentially applying a discount to zero products (harmless) or to products that shouldn't have it (if the product set isn't also deleted). In practice both are deleted in the same batch call, so this is unlikely.

---

## 5. Consolidation Plan

### Proposed Utility: `utils/square-catalog-cleanup.js`

Create a single shared utility for deleting Square catalog objects with consistent behavior.

#### Function 1: `deleteCatalogObjects(merchantId, objectIds, options)`

```javascript
/**
 * Delete Square catalog objects (discounts, pricing rules, product sets)
 * Uses batch-delete for efficiency. Tolerates 404 (already deleted).
 *
 * @param {number} merchantId - Merchant ID for token lookup
 * @param {string[]} objectIds - Square catalog object IDs to delete
 * @param {Object} [options]
 * @param {boolean} [options.throwOnError=false] - Throw on failure vs return result
 * @returns {Promise<{success: boolean, deleted: number, errors?: Array}>}
 */
async function deleteCatalogObjects(merchantId, objectIds, options = {}) {
    // 1. Filter null/undefined IDs
    // 2. If empty, return {success: true, deleted: 0}
    // 3. Use makeSquareRequest('/v2/catalog/batch-delete', ...) for retry + rate-limit handling
    // 4. Tolerate 404 responses (treat as success)
    // 5. Log results (info on success, warn on partial failure)
    // 6. Return {success, deleted, errors}
}
```

**Key design decisions**:
- Always use `makeSquareRequest` (inherits retry, rate-limit, timeout handling)
- Always use batch-delete endpoint (1 round-trip instead of N)
- Uses centralized `SQUARE_API_VERSION` from `services/square/api.js`
- `throwOnError` option lets callers choose: loyalty cleanup doesn't throw, expiry cleanup can throw
- Consistent return format: `{success, deleted, errors}`

#### Function 2: `deleteCustomerGroupWithMembers(merchantId, groupId, customerIds)`

```javascript
/**
 * Delete a Square customer group after removing all members.
 * Handles: remove customers from group, delete group.
 * Tolerates 404 at each step.
 *
 * @param {number} merchantId
 * @param {string} groupId - Square group ID
 * @param {string[]} [customerIds] - Customer IDs to remove first
 * @returns {Promise<{success: boolean, customersRemoved: boolean, groupDeleted: boolean}>}
 */
async function deleteCustomerGroupWithMembers(merchantId, groupId, customerIds = []) {
    // 1. Remove each customer from group via makeSquareRequest
    // 2. Delete the group via makeSquareRequest
    // 3. Return structured result
}
```

**Note**: Customer/group operations use different API endpoints (`/v2/customers/...`) than catalog operations (`/v2/catalog/...`). They're logically separate but always called together in the loyalty cleanup flow. This function consolidates the group cleanup part.

### Refactored Callers

#### Path A: `cleanupSquareCustomerGroupDiscount()` (After)

```javascript
async function cleanupSquareCustomerGroupDiscount({ merchantId, squareCustomerId, internalRewardId }) {
    const reward = await getRewardSquareIds(internalRewardId, merchantId);
    if (!reward) return { success: false, error: 'Reward not found' };

    // Step 1+3: Remove customer from group, delete group
    const groupResult = await deleteCustomerGroupWithMembers(
        merchantId,
        reward.square_group_id,
        squareCustomerId ? [squareCustomerId] : []
    );

    // Step 2: Delete catalog objects (discount, product set, pricing rule)
    const catalogResult = await deleteCatalogObjects(merchantId, [
        reward.square_pricing_rule_id,
        reward.square_product_set_id,
        reward.square_discount_id,
    ]);

    // Step 4: Clear DB references (unchanged)
    await clearRewardSquareIds(internalRewardId);

    return { success: true, ...groupResult, discountsDeleted: catalogResult.success };
}
```

**Changes**: Replaces `deleteRewardDiscountObjects()` (raw fetch loop) with `deleteCatalogObjects()` (shared utility). Replaces `removeCustomerFromGroup()` + `deleteCustomerGroup()` with `deleteCustomerGroupWithMembers()`.

#### Path B: `upsertPricingRule()` Deletion Branch (After)

```javascript
// Inside upsertPricingRule(), when variationIds.length === 0:
if (objectsToDelete.length > 0) {
    const result = await deleteCatalogObjects(tier.merchant_id, objectsToDelete);
    if (!result.success) {
        logger.warn('Failed to delete pricing rule objects', {
            tierCode: tier.tier_code,
            errors: result.errors
        });
    }
}
```

**Changes**: Replaces inline `makeSquareRequest('/v2/catalog/batch-delete', ...)` with `deleteCatalogObjects()`. Behavior is identical since `deleteCatalogObjects` uses `makeSquareRequest` internally.

#### Path C: No Changes Needed

`clearExpiryDiscountForReorder()` doesn't interact with Square — it's DB-only. The eventual Square cleanup happens through Path B when `applyDiscounts()` runs. No consolidation needed.

#### Path D: Remove Unused Method

`services/loyalty/square-client.js:deleteCatalogObject()` is unused. Can be deleted.

### Files Changed

| File | Change | Risk |
|------|--------|------|
| `utils/square-catalog-cleanup.js` | **New** — shared deletion utility | Low (new code, no existing behavior changed) |
| `services/loyalty-admin/square-discount-service.js` | Replace `deleteRewardDiscountObjects()` body with call to shared utility. Replace `removeCustomerFromGroup()` + `deleteCustomerGroup()` with shared utility. | Medium (loyalty cleanup is production-critical) |
| `services/expiry/discount-service.js` | Replace inline batch-delete in `upsertPricingRule()` with call to shared utility | Low (simple swap, same underlying API) |
| `services/loyalty/square-client.js` | Remove unused `deleteCatalogObject()` method | Very Low |

### What NOT to Change

- `cleanupSquareCustomerGroupDiscount()` orchestration logic stays in `square-discount-service.js` — it's loyalty-specific workflow
- `clearExpiryDiscountForReorder()` stays as-is — it's DB-only, no Square interaction
- Seniors service — creates/updates pricing rules, never deletes
- `makeSquareRequest()` — already well-designed, becomes the foundation

### Testing Plan

1. Unit tests for `utils/square-catalog-cleanup.js`:
   - `deleteCatalogObjects` with valid IDs, empty IDs, null IDs
   - 404 tolerance
   - `throwOnError` behavior
   - `deleteCustomerGroupWithMembers` with and without customers
2. Update existing loyalty tests to mock the new utility
3. Update existing expiry tests to mock the new utility
4. Manual verification: redeem a reward, verify Square objects are cleaned up

### Migration Sequence

1. Create `utils/square-catalog-cleanup.js` with tests
2. Wire Path B (expiry) to use new utility — lowest risk, simplest swap
3. Wire Path A (loyalty) to use new utility — higher risk, test thoroughly
4. Remove unused `deleteCatalogObject()` from square-client.js
5. Remove now-unused `deleteRewardDiscountObjects()`, `removeCustomerFromGroup()`, `deleteCustomerGroup()` from square-discount-service.js (or keep as thin wrappers if other code references them)

---

## 6. Summary

| Finding | Severity | Impact |
|---------|----------|--------|
| Loyalty path uses raw `fetch()` with no retry/rate-limit handling | HIGH | Could leave orphaned Square objects under load |
| Diverging Square API versions (`2025-01-16` vs `2025-10-16`) | MEDIUM | Version drift risk when updating |
| Inconsistent error handling (return vs throw vs silent) | MEDIUM | Hard to reason about failure modes |
| Individual DELETEs instead of batch in loyalty path | LOW | 3 round-trips instead of 1 |
| Hardcoded Square base URL in loyalty path | LOW | Maintenance concern |
| Unused `deleteCatalogObject()` in square-client.js | LOW | Dead code |

The consolidation is straightforward: a ~60-line shared utility replaces duplicated logic in two files, with the expiry path being a near-drop-in replacement and the loyalty path requiring a moderate refactor of the cleanup orchestrator.
