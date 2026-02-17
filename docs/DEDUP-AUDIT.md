# Deduplication Audit Report

**Date**: 2026-02-17
**Scope**: Full codebase — services/, routes/, public/js/, jobs/, utils/
**Status**: 5 of 18 findings fixed (G-1, G-2, G-6, L-1, R-1). Remaining items tracked as BACKLOG-15 through BACKLOG-28 in TECHNICAL_DEBT.md.

---

## Summary Table

| ID | Finding | Files | Risk | Effort | Priority | Status |
|----|---------|-------|------|--------|----------|--------|
| L-1 | Customer identification — 3 parallel implementations | 3 | Critical | L | P1 | **FIXED** |
| L-2 | Reward progress / threshold crossing — 2 implementations | 2 | High | L | P1 | BACKLOG-15 |
| L-3 | `redeemReward()` — same name, different signatures | 2 | High | M | P1 | BACKLOG-16 |
| L-4 | Customer lookup helpers — duplicated between layers | 2 | High | M | P1 | BACKLOG-17 |
| L-5 | Offer/variation queries — overlapping implementations | 2 | Medium | S | P1 | BACKLOG-18 |
| L-6 | Square API client — two wrapper layers | 2 | Medium | M | P1 | BACKLOG-19 |
| L-7 | Redemption detection — only exists in admin layer | 1 | Low | S | P1 | BACKLOG-20 |
| R-1 | Reorder quantity formula — JS vs SQL implementations | 2 | Critical | M | P2 | **FIXED** (shared `reorder-math.js`, BACKLOG-28 for vendor config wiring) |
| R-2 | Days-of-stock / days-until-stockout — 5 implementations | 5 | High | M | P2 | BACKLOG-21 |
| R-3 | Available vs total stock — inconsistent base value | 4 | High | S | P2 | BACKLOG-22 |
| G-1 | `escapeHtml()` — 26 identical copies | 26 | Medium | S | P3 | **FIXED** |
| G-2 | Idempotency key generation — 4 inconsistent patterns | 8+ | Medium | S | P3 | **FIXED** |
| G-3 | Currency formatting — no shared helper | 14+ | Medium | S | P3 | BACKLOG-23 |
| G-4 | Order normalization (Square camelCase to snake_case) | 1 (3 call sites) | Low | S | P3 | BACKLOG-24 |
| G-5 | Location lookup queries — repeated across routes | 6 | Low | S | P3 | BACKLOG-25 |
| G-6 | `escapeAttr()` — 2 copies | 2 | Low | S | P3 | **FIXED** (with G-1) |
| G-7 | Date string formatting — repeated pattern | 5 | Low | S | P3 | BACKLOG-26 |
| G-8 | `.toLocaleString()` — inconsistent locale/options | 14 | Low | S | P3 | BACKLOG-27 |

**Effort**: S = < 1 file change, M = 2-5 files, L = 6+ files with integration risk

---

## Priority 1: Loyalty System

### L-1: Customer Identification — 3 Parallel Implementations

**What's duplicated**: The 6-method customer identification fallback chain (direct ID, tenders, Loyalty API, order rewards, fulfillment recipient, discount reverse-lookup) is implemented independently in three places.

**Files + line numbers**:

| Implementation | File | Lines | Methods |
|---------------|------|-------|---------|
| Class-based (complete) | `services/loyalty/customer-service.js` | 53-594 | All 6 methods as class methods |
| Inline (partial) | `services/loyalty-admin/webhook-processing-service.js` | 53-275 | 6 methods, mix of inline + imported |
| Standalone exports | `services/loyalty-admin/customer-admin-service.js` | 110-413 | 3 methods as standalone functions |

**Detailed breakdown**:

- `services/loyalty/customer-service.js`:
  - `identifyCustomerFromOrder()` — Lines 53-134 (orchestrator)
  - `identifyFromTenders()` — Lines 140-189
  - `identifyFromLoyaltyEvents()` — Lines 195-274
  - `identifyFromOrderRewards()` — Lines 280-361
  - `identifyFromFulfillmentRecipient()` — Lines 367-495
  - `identifyFromLoyaltyDiscount()` — Lines 503-594

- `services/loyalty-admin/webhook-processing-service.js`:
  - Inline customer ID from `order.customer_id` — Lines 53-73
  - Inline tender loop — Lines 76-107
  - Calls `lookupCustomerFromLoyalty()` — Line 118
  - Calls `lookupCustomerFromOrderRewards()` — Line 153
  - Calls `lookupCustomerFromFulfillmentRecipient()` — Line 188
  - Inline discount reverse-lookup — Lines 216-275

- `services/loyalty-admin/customer-admin-service.js`:
  - `lookupCustomerFromLoyalty()` — Lines 110-214
  - `lookupCustomerFromFulfillmentRecipient()` — Lines 222-334
  - `lookupCustomerFromOrderRewards()` — Lines 342-413

**Risk**: If fallback order or matching logic changes in one implementation but not the others, the webhook layer and admin layer will identify different customers for the same order. This could cause loyalty points to be credited to the wrong customer.

**Suggested fix**: Extract a single `CustomerIdentifier` module used by both layers. The loyalty/customer-service.js version is the most complete — make it the single source of truth and have webhook-processing-service.js delegate to it.

**Effort**: L — Requires careful integration testing since customer identification is the foundation of the entire loyalty system.

---

### L-2: Reward Progress / Threshold Crossing — 2 Implementations

**What's duplicated**: `updateRewardProgress()` exists in both layers with different approaches to handling the threshold crossing (when a customer reaches the required number of purchases).

**Files + line numbers**:

| Implementation | File | Lines | Approach |
|---------------|------|-------|----------|
| Class-based (sophisticated) | `services/loyalty/purchase-service.js` | 268-721 | Split-row logic for threshold crossing |
| Standalone (simpler) | `services/loyalty-admin/purchase-service.js` | 130-306 | Basic locking with LIMIT/ORDER BY |

**Detailed breakdown**:

- `services/loyalty/purchase-service.js`:
  - `updateRewardProgress()` — Lines 268-365
  - `createOrUpdateReward()` — Lines 385-721 (includes split-row deduplication at lines 507-683)
  - Window date calculation — Lines 269-297
  - Progress counting with split-row exclusion — Lines 314-335

- `services/loyalty-admin/purchase-service.js`:
  - `updateRewardProgress()` — Lines 130-306
  - Count qualifying quantity — Lines 136-144
  - Get/create in_progress reward — Lines 148-209
  - Threshold check and state transition — Lines 212-235

**Risk**: The loyalty layer splits a crossing purchase row into locked + unlocked portions; the admin layer does not. Running admin operations (backfill, catchup) could calculate different progress than the webhook path for the same set of purchases. If both paths ever process the same order, rewards could be double-counted or missed.

**Suggested fix**: Extract the progress calculation and threshold-crossing logic into a shared `reward-progress.js` module. Both layers should use the same algorithm. Document which features (split-row, rollover) are required vs optional.

**Effort**: L — The split-row logic is complex and tightly coupled to transaction handling in each layer.

---

### L-3: `redeemReward()` — Same Name, Different Signatures

**What's duplicated**: Two functions named `redeemReward()` exist with different parameter signatures and different behavior.

**Files + line numbers**:

| Implementation | File | Lines | Signature |
|---------------|------|-------|-----------|
| Class method | `services/loyalty/reward-service.js` | 161-279 | `redeemReward(rewardId, redemptionData = {})` |
| Standalone function | `services/loyalty-admin/reward-service.js` | 40-194 | `redeemReward(redemptionData)` (rewardId inside object) |

**Detailed breakdown**:

- `services/loyalty/reward-service.js`:
  - Lines 161-279: Gets reward by ID, validates status, updates to `redeemed`, creates redemption record
  - Simpler — no Square discount cleanup

- `services/loyalty-admin/reward-service.js`:
  - Lines 40-194: Validates, updates status, logs audit event, triggers async Square discount cleanup (lines 155-168)
  - More complete — handles audit trail and Square integration

**Risk**: Calling the wrong `redeemReward()` could skip audit logging or Square cleanup. The different signatures make this easy to mix up. A developer importing from the wrong module will get silent misbehavior, not an error.

**Suggested fix**: Rename to distinguish intent: `redeemRewardBasic()` vs `redeemRewardWithAudit()`, or consolidate into one implementation with an options parameter for audit/cleanup behavior.

**Effort**: M — Requires updating all callers and ensuring the right version is used in each context.

---

### L-4: Customer Lookup Helpers — Duplicated Between Layers

**What's duplicated**: Three customer lookup functions exist as both class methods in the loyalty layer and standalone exports in the admin layer, with nearly identical logic.

**Files + line numbers**:

| Function | Loyalty Layer | Admin Layer |
|----------|--------------|-------------|
| Loyalty API lookup | `customer-service.js:195-274` | `customer-admin-service.js:110-214` |
| Fulfillment recipient lookup | `customer-service.js:367-495` | `customer-admin-service.js:222-334` |
| Order rewards lookup | `customer-service.js:280-361` | `customer-admin-service.js:342-413` |

**Risk**: Bug fixes or Square API changes applied to one set of functions but not the other. For example, if Square changes the loyalty events response format, one lookup would break while the other continues working.

**Suggested fix**: Make the admin-layer functions the canonical implementations and have the loyalty-layer class methods delegate to them (or vice versa). The admin versions are already used by webhook-processing-service.js via import.

**Effort**: M — Straightforward refactor with clear function boundaries.

---

### L-5: Offer/Variation Queries — Overlapping Implementations

**What's duplicated**: Offer and variation lookup queries exist in both the webhook and admin layers with similar-but-not-identical SQL.

**Files + line numbers**:

| Function | File | Lines |
|----------|------|-------|
| `getActiveOffers()` | `services/loyalty/offer-service.js` | 30-62 |
| `getOffersForVariation()` | `services/loyalty/offer-service.js` | 69-112 |
| `isQualifyingVariation()` | `services/loyalty/offer-service.js` | 119-122 |
| `getOfferById()` | `services/loyalty/offer-service.js` | 129-156 |
| `getQualifyingVariations()` | `services/loyalty/offer-service.js` | 163-188 |
| `getAllQualifyingVariationIds()` | `services/loyalty/offer-service.js` | 194-212 |
| `getQualifyingVariations()` | `services/loyalty-admin/variation-admin-service.js` | 164-176 |
| `getOfferForVariation()` | `services/loyalty-admin/variation-admin-service.js` | 184-200 |
| `getAllVariationAssignments()` | `services/loyalty-admin/variation-admin-service.js` | 247-275 |
| `getOffers()` | `services/loyalty-admin/offer-admin-service.js` | 110-149 |
| `getOfferById()` | `services/loyalty-admin/offer-admin-service.js` | 151-170 |

**Risk**: SQL query differences (e.g., join conditions, active filters) between the two layers could cause the webhook to qualify a variation that the admin UI shows as non-qualifying, or vice versa.

**Suggested fix**: Create a shared `loyalty-queries.js` module with canonical SQL for offer/variation lookups. Both layers import from it. Admin-specific queries (CRUD, conflict checks) stay in variation-admin-service.js.

**Effort**: S — Most queries are simple SELECT statements that can be extracted with minimal risk.

---

### L-6: Square API Client — Two Wrapper Layers

**What's duplicated**: The loyalty layer has its own Square API client class (`LoyaltySquareClient`) that wraps the SDK, while the admin layer uses `getSquareClientForMerchant()` from middleware or `shared-utils.js` for direct SDK access.

**Files + line numbers**:

| Implementation | File | Lines | Pattern |
|---------------|------|-------|---------|
| Custom HTTP client | `services/loyalty/square-client.js` | 50-496 | Custom request wrapper with rate-limit retry |
| Shared utils | `services/loyalty-admin/shared-utils.js` | 20-66 | `fetchWithTimeout()` + `getSquareAccessToken()` |
| SDK middleware | `middleware/merchant.js` | (used by admin layer) | `getSquareClientForMerchant()` |

**Key methods in `square-client.js`**:
- `getCustomer()` — Lines 283-289
- `searchCustomers()` — Lines 296-302
- `searchLoyaltyEvents()` — Lines 309-315
- `getOrder()` — Lines 483-496

**Risk**: Rate-limit handling, retry logic, and timeout behavior differ between the two clients. The loyalty layer has built-in retry (lines 131-174) while the admin layer relies on the SDK's defaults. If Square changes rate limits, only one client may handle it correctly.

**Suggested fix**: Evaluate whether the custom client adds value over the SDK's built-in retry. If so, make it the shared implementation. If not, remove it in favor of the standard `getSquareClientForMerchant()` pattern.

**Effort**: M — Requires testing all Square API interactions after migration.

---

### L-7: Redemption Detection — Only Exists in Admin Layer

**What's duplicated**: This is an asymmetry rather than a duplication. Redemption detection logic exists only in the admin layer; the webhook layer has no equivalent.

**Files + line numbers**:

| Function | File | Lines |
|----------|------|-------|
| `detectRewardRedemptionFromOrder()` | `services/loyalty-admin/reward-service.js` | 469-666 |
| `matchEarnedRewardByFreeItem()` | `services/loyalty-admin/reward-service.js` | 217-354 |
| `matchEarnedRewardByDiscountAmount()` | `services/loyalty-admin/reward-service.js` | 373-451 |
| `orderHasOurDiscount()` (minimal check) | `jobs/loyalty-audit-job.js` | 152-178 |

**Risk**: Low currently — webhooks process purchases, not redemptions. But `orderHasOurDiscount()` in the audit job is a simplified version of the detection logic. If detection rules change, the audit job's simplified check may produce false positives or negatives.

**Suggested fix**: If the audit job's detection needs to evolve, it should call `detectRewardRedemptionFromOrder()` from the admin layer rather than maintaining its own simplified version.

**Effort**: S — Single call-site change.

---

## Priority 2: Reorder Formula (BACKLOG-14)

### R-1: Reorder Quantity Formula — JS vs SQL Implementations — **FIXED**

**Status**: Resolved 2026-02-17. Shared module `services/catalog/reorder-math.js` is the single source of truth. Both `routes/analytics.js` and `services/vendor-dashboard.js` now call `calculateReorderQuantity()` from the shared module. 31 unit tests in `__tests__/services/catalog/reorder-math.test.js`.

**What was fixed**:
- Extracted reorder formula into `services/catalog/reorder-math.js` with `calculateReorderQuantity()` and `calculateDaysOfStock()`
- `routes/analytics.js` calls the shared function directly (replaced ~40 lines of inline logic)
- `services/vendor-dashboard.js` moved reorder_value computation from SQL to JS via `computeReorderValues()` which calls the shared function per-item
- Function accepts `leadTimeDays` and `safetyDays` (both defaulting to 0) — ready for BACKLOG-28 vendor config wiring
- All 3 prior divergences resolved: lead_time inclusion, reorder_multiple application, stock_alert_min enforcement

**Follow-up**: BACKLOG-28 — Wire vendor dashboard per-vendor config (lead_time_days, target_supply_days, safety_days) into reorder.html via this function.

---

### R-2: Days-of-Stock / Days-Until-Stockout — 5 Implementations

**What's duplicated**: The "how many days of inventory remain" calculation appears in 5 files with slight variations.

**Files + line numbers**:

| File | Lines | Formula | Variant |
|------|-------|---------|---------|
| `routes/analytics.js` | 218-224 | `available_qty / daily_avg` | Uses available (on-hand minus committed) |
| `services/vendor-dashboard.js` | 142-176 | `available_qty / daily_avg` | Uses available, part of reorder filter |
| `services/catalog/inventory-service.js` | 58-64 | `total_qty / daily_avg` | Uses total on-hand (no committed subtraction) |
| `services/catalog/audit-service.js` | 116-121 | `current_stock / daily_velocity` | Uses CTE variables, NULL for no velocity |
| `routes/bundles.js` | 232-234, 261-263 | `stock / totalDailyVelocity` | JavaScript, includes bundle-driven velocity |
| `public/js/reorder.js` | 672-674 | `stock / totalDailyVelocity` | Frontend, mirrors bundles.js |

**Risk**: Different formulas in different views means the inventory page, catalog audit, reorder page, and vendor dashboard could show different days-of-stock for the same item. This creates confusion for the merchant.

**Suggested fix**: Create a SQL fragment or VIEW `v_days_of_stock` that standardizes the calculation. Choose whether "available" (on-hand minus committed) or "total" is the correct base, and use it consistently. Bundle-specific velocity calculations can extend the base formula.

**Effort**: M — Need to decide canonical formula and update 5 files.

---

### R-3: Available vs Total Stock — Inconsistent Base Value

**What's duplicated**: Some calculations use raw on-hand quantity while others subtract committed inventory to get "available" quantity.

**Files + line numbers**:

| File | Lines | Stock Base |
|------|-------|------------|
| `routes/analytics.js` | 218-224 | `on_hand - committed` (available) |
| `services/vendor-dashboard.js` | 142-176 | `on_hand - committed` (available) |
| `services/catalog/inventory-service.js` | 58-64 | `on_hand` only (total) |
| `services/catalog/audit-service.js` | 116-121 | `current_stock` (total, from CTE) |

**Risk**: The inventory page shows days-of-stock based on total quantity, while the reorder page uses available quantity. A merchant with 10 units on hand but 8 committed sees "X days" on one page and a much smaller value on another.

**Suggested fix**: Standardize on available quantity (`on_hand - committed`) for all days-of-stock calculations since this reflects actual sellable inventory. Update inventory-service.js and audit-service.js to match.

**Effort**: S — Two SQL query changes.

---

## Priority 3: General Codebase

### G-1: `escapeHtml()` — 26 Identical Copies

**What's duplicated**: The same XSS-prevention function is copy-pasted into 26 frontend JavaScript files.

```javascript
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

**Files** (all in `public/js/`):

| # | File |
|---|------|
| 1 | admin-subscriptions.js |
| 2 | bundle-manager.js |
| 3 | catalog-audit.js |
| 4 | catalog-workflow.js |
| 5 | cycle-count-history.js |
| 6 | cycle-count.js |
| 7 | dashboard.js |
| 8 | deleted-items.js |
| 9 | delivery-history.js |
| 10 | delivery-route.js |
| 11 | delivery.js |
| 12 | driver.js |
| 13 | expiry-audit.js |
| 14 | expiry-discounts.js |
| 15 | expiry.js |
| 16 | gmc-feed.js |
| 17 | inventory.js |
| 18 | login.js |
| 19 | logs.js |
| 20 | loyalty.js |
| 21 | merchants.js |
| 22 | purchase-orders.js |
| 23 | reorder.js |
| 24 | settings.js |
| 25 | vendor-catalog.js |
| 26 | vendor-dashboard.js |

**Risk**: If the escaping logic needs to change (e.g., to handle a new XSS vector), 26 files must be updated. Missing one file creates a security vulnerability.

**Suggested fix**: Extract to `public/js/common-utils.js`, include it globally via a `<script>` tag in the shared layout, and remove all 26 local copies.

**Effort**: S — Mechanical extraction with no logic changes.

---

### G-2: Idempotency Key Generation — 4 Inconsistent Patterns

**What's duplicated**: Square API idempotency keys are generated with 4 different patterns, only one of which uses the centralized `generateIdempotencyKey()` utility.

**Patterns found**:

| Pattern | Example | Files |
|---------|---------|-------|
| Centralized utility | `generateIdempotencyKey('prefix')` | `services/square/api.js:106` (definition), lines 2265, 2375 (usage) |
| Prefix + Date.now() | `\`seniors-group-${merchantId}-${Date.now()}\`` | `services/seniors/seniors-service.js:150,178,323,402`, `utils/square-subscriptions.js:116,208`, `utils/square-webhooks.js:249`, `routes/subscriptions.js:230,251,297,610` |
| Composite key | `\`${orderId}:${variationId}:${quantity}\`` | Used in loyalty purchase processing |
| Action + entity + state + Date.now() | `\`complete-${orderId}-${uid}-${state}-${Date.now()}\`` | `routes/delivery.js:362,406` |

**Risk**: Inconsistent key formats could lead to failed idempotency (keys that should match don't) or accidental collisions (different operations generating the same key). The `Date.now()` pattern is not idempotent across retries — the whole point of idempotency keys.

**Suggested fix**: Mandate use of `generateIdempotencyKey()` from `services/square/api.js` for all Square API calls. Audit which keys intentionally include `Date.now()` (non-idempotent) vs which should be deterministic.

**Effort**: S — Mostly search-and-replace with review of each key's intent.

---

### G-3: Currency Formatting — No Shared Helper

**What's duplicated**: Currency formatting (cents to dollars display) is implemented inline across 14+ frontend files with no shared helper.

**Implementations found**:

| File | Lines | Pattern |
|------|-------|---------|
| `public/js/vendor-dashboard.js` | 409 | `formatCurrency(cents)` — full implementation |
| `public/cart-activity.html` | 365 | `formatCurrency(cents)` — separate implementation |
| `public/js/inventory.js` | ~106 | `'$' + totalValue.toLocaleString()` inline |
| `public/js/dashboard.js` | ~251 | `'$' + totalValueRetail.toLocaleString()` inline |
| Other files | Various | Inline `(cents / 100).toFixed(2)` patterns |

**Risk**: Inconsistent formatting (some use `en-CA` locale, some don't specify locale, some format differently). Mixed cent/dollar confusion possible if a developer assumes dollars when the value is in cents.

**Suggested fix**: Add `formatCurrency()` to the proposed `public/js/common-utils.js` shared utility file. Standardize on `en-CA` locale with 2 decimal places.

**Effort**: S — Extract existing function and replace inline patterns.

---

### G-4: Order Normalization (Square camelCase to snake_case)

**What's duplicated**: The `normalizeSquareOrder()` function in order-handler.js is called at 3 separate points after fetching orders from Square.

**Files + line numbers**:

| Usage | File | Lines |
|-------|------|-------|
| Definition | `services/webhook-handlers/order-handler.js` | 47 |
| Call #1 — `_fetchFullOrder()` | `services/webhook-handlers/order-handler.js` | 316 |
| Call #2 — `_autoIngestFromFulfillment()` | `services/webhook-handlers/order-handler.js` | 983 |
| Call #3 — `_processPaymentForLoyalty()` | `services/webhook-handlers/order-handler.js` | 1202 |

Each call site also has its own `getSquareClientForMerchant()` initialization (lines 312, 979, 1089, 1194).

**Risk**: Low — the function is defined once and called correctly. The repetition is in the calling pattern, not the logic. However, if normalization logic changes, all callers automatically get the update since they reference the same function.

**Suggested fix**: Consider extracting a helper `fetchAndNormalizeOrder(merchantId, orderId)` to combine the client init + fetch + normalize into one call, reducing the boilerplate at each call site.

**Effort**: S — Single file refactor within order-handler.js.

---

### G-5: Location Lookup Queries — Repeated Across Routes

**What's duplicated**: SQL queries to look up locations by ID and merchant_id are written inline in 6+ route files.

**Files + line numbers**:

| File | Lines | Query |
|------|-------|-------|
| `routes/gmc.js` | 756 | `SELECT id FROM locations WHERE id = $1 AND merchant_id = $2` |
| `routes/gmc.js` | 815 | Same query repeated |
| `routes/purchase-orders.js` | 65 | Same pattern |
| `routes/delivery.js` | 83 | `SELECT square_location_id FROM locations WHERE merchant_id = $1 AND active = TRUE` |
| `routes/loyalty.js` | 1319 | `SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1` |
| `routes/cycle-counts.js` | 231 | `SELECT id FROM locations WHERE active = TRUE AND merchant_id = $1 ORDER BY name LIMIT 1` |

**Risk**: Low — these are simple queries with parameterized values. However, if the locations table schema changes (e.g., adding a soft-delete column), every inline query needs updating.

**Suggested fix**: Create a `LocationRepository` or add helpers to `utils/database.js`:
- `getLocationById(locationId, merchantId)`
- `getActiveLocations(merchantId)`
- `getDefaultLocation(merchantId)`

**Effort**: S — Straightforward extraction.

---

### G-6: `escapeAttr()` — 2 Copies

**What's duplicated**: HTML attribute escaping function duplicated in 2 frontend files.

**Files + line numbers**:

| File | Lines |
|------|-------|
| `public/js/vendor-dashboard.js` | 421 |
| `public/js/label-printer.js` | 483 |

**Risk**: Low — the function is simple and unlikely to change. But it should move to the shared utility file along with `escapeHtml()`.

**Suggested fix**: Include in `public/js/common-utils.js`.

**Effort**: S.

---

### G-7: Date String Formatting — Repeated Pattern

**What's duplicated**: `new Date().toISOString().split('T')[0]` pattern for getting today's date as YYYY-MM-DD string is repeated across 5 frontend files (12 instances).

**Files + line numbers**:

| File | Lines | Count |
|------|-------|-------|
| `public/js/delivery.js` | 102, 110 | 2 |
| `public/js/delivery-history.js` | 55, 63, 67 | 3 |
| `public/js/cycle-count-history.js` | 11, 21, 22, 30, 31 | 5 |
| `public/js/catalog-audit.js` | 440 | 1 |
| `public/js/vendor-catalog.js` | 1325 | 1 |

**Risk**: Low — this is a common JavaScript idiom. But extracting it improves readability.

**Suggested fix**: Add `getToday()` and `getDateString(date)` to the shared utility file.

**Effort**: S.

---

### G-8: `.toLocaleString()` — Inconsistent Locale/Options

**What's duplicated**: Number and currency formatting via `.toLocaleString()` is used 60 times across 14 frontend files with inconsistent locale and option parameters.

**Files** (by occurrence count):

| File | Count |
|------|-------|
| `public/js/gmc-feed.js` | 11 |
| `public/js/dashboard.js` | 10 |
| `public/js/expiry.js` | 6 |
| `public/js/vendor-catalog.js` | 6 |
| `public/js/inventory.js` | 5 |
| `public/js/cycle-count-history.js` | 5 |
| `public/js/catalog-audit.js` | 4 |
| `public/js/logs.js` | 4 |
| `public/js/sales-velocity.js` | 3 |
| `public/js/expiry-discounts.js` | 2 |
| `public/js/delivery-route.js` | 1 |
| `public/js/vendor-dashboard.js` | 1 |
| `public/js/settings.js` | 1 |
| `public/js/loyalty.js` | 1 |

**Variants observed**:
- `.toLocaleString()` (no locale specified — uses browser default)
- `.toLocaleString('en-CA', { minimumFractionDigits: 2 })`
- `.toLocaleString('en-CA', { minimumFractionDigits: 0 })`

**Risk**: Numbers display differently depending on which page the merchant is viewing and which browser they use. No locale = browser default, which may not be `en-CA`.

**Suggested fix**: Create `formatNumber(n)` and `formatCurrency(cents)` helpers in the shared utility that always use `en-CA` locale with consistent options.

**Effort**: S — Mechanical replacement.

---

## Recommendations

### Immediate (next sprint)

1. **G-1**: Extract `escapeHtml()` to shared utility — lowest risk, highest file count reduction
2. **R-1**: Consolidate reorder formula (BACKLOG-14) — already flagged, highest business risk
3. **R-3**: Standardize available vs total stock — small change, fixes data inconsistency

### Short-term

4. **L-1**: Consolidate customer identification to single implementation
5. **L-3**: Rename or merge `redeemReward()` functions
6. **L-4**: Deduplicate customer lookup helpers between layers
7. **G-2**: Standardize idempotency key generation

### Medium-term

8. **L-2**: Unify reward progress calculation algorithm
9. **R-2**: Create shared days-of-stock calculation
10. **L-5**: Extract shared offer/variation query module
11. **G-3**: Create shared currency formatting utility

### Low-priority

12. **L-6**: Evaluate dual Square API client layers
13. **G-4**: Extract `fetchAndNormalizeOrder()` helper
14. **G-5**: Create location lookup helpers
15. **G-6, G-7, G-8**: Bundle into shared frontend utility effort with G-1
