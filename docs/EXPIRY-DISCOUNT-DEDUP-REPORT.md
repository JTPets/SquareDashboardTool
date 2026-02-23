# Expiry/Discount System Duplication Audit

**Date**: 2026-02-23
**Scope**: `services/expiry/discount-service.js` and all callers of tier evaluation, Square pricing rule CRUD, and `variation_discount_status` writes
**Context**: Audit performed during tier regression fix work, before implementing Fixes 1-4

---

## 1. Every Function That Writes to `variation_discount_status`

| # | Function | File:Line | Write Type | Notes |
|---|----------|-----------|------------|-------|
| 1 | `evaluateAllVariations()` | `services/expiry/discount-service.js:260` | INSERT...ON CONFLICT UPDATE | Upserts tier assignment, days_until_expiry, original_price |
| 2 | `evaluateAllVariations()` | `services/expiry/discount-service.js:300` | UPDATE | Updates days_until_expiry cache for unchanged tiers |
| 3 | `applyDiscounts()` | `services/expiry/discount-service.js:748` | UPDATE | Sets discounted_price_cents and discount_applied_at |
| 4 | `applyDiscounts()` | `services/expiry/discount-service.js:814` | UPDATE | Clears discounted_price_cents when item leaves auto-apply tier |
| 5 | `filterValidVariations()` | `services/expiry/discount-service.js:923` | DELETE | Removes rows for variations deleted in Square |
| 6 | `clearExpiryDiscountForReorder()` | `services/expiry/discount-service.js:1764` | UPDATE (in txn) | Resets to OK tier, clears discount_applied_at |
| 7 | Route inline query | `routes/expiry-discounts.js:153` | SELECT only | Read-only — not a write |
| 8 | Route inline query | `routes/purchase-orders.js:146` | SELECT only | Read-only — not a write |

**Assessment**: All writes to `variation_discount_status` go through `discount-service.js`. No scattered writes across routes. This is clean.

---

## 2. Every Function That Calls Square Pricing Rule Create/Delete

### Expiry System (discount-service.js)

| # | Function | File:Line | Action | Uses shared cleanup? |
|---|----------|-----------|--------|---------------------|
| 1 | `upsertPricingRule()` | `discount-service.js:949` | CREATE/UPDATE pricing rule + product set via batch-upsert | N/A (creates, doesn't delete) |
| 2 | `upsertPricingRule()` | `discount-service.js:1012` | DELETE pricing rule + product set when tier is empty | YES — uses `deleteCatalogObjects()` from `utils/square-catalog-cleanup.js` |
| 3 | `applyDiscounts()` | `discount-service.js:734` | Calls `upsertPricingRule()` per tier | Delegates to #1/#2 |
| 4 | `validateExpiryDiscounts()` | `discount-service.js:1615` | Calls `upsertPricingRule()` to fix missing/mismatched rules | Delegates to #1/#2 |

### Loyalty System (square-discount-service.js)

| # | Function | File:Line | Action | Uses shared cleanup? |
|---|----------|-----------|--------|---------------------|
| 5 | `createSquareCustomerGroupDiscount()` | `square-discount-service.js:333` | CREATE pricing rule + product set + discount via batch-upsert | N/A (creates) |
| 6 | `cleanupSquareCustomerGroupDiscount()` | `square-discount-service.js:691` | DELETE pricing rule + product set + discount | YES — uses `deleteCatalogObjects()` |
| 7 | `processExpiredEarnedRewards()` | `square-discount-service.js:906` | Clear `square_pricing_rule_id` on reward records | DB clear only — catalog objects may already be cleaned up |
| 8 | `markRewardsRedeemedByOrder()` | `square-discount-service.js:959` | Clear `square_pricing_rule_id` on reward records | DB clear only |

### Seniors System (seniors-service.js)

| # | Function | File:Line | Action | Uses shared cleanup? |
|---|----------|-----------|--------|---------------------|
| 9 | `createCatalogObjects()` | `seniors-service.js:184` | CREATE pricing rule via batch-upsert | N/A (creates) |
| 10 | `enablePricingRule()` | `seniors-service.js:297` | UPDATE pricing rule valid_until_date (enable) | Uses `batchUpsertCatalog()` via SquareApiClient |
| 11 | `disablePricingRule()` | `seniors-service.js:376` | UPDATE pricing rule valid_until_date (disable) | Uses `batchUpsertCatalog()` via SquareApiClient |
| 12 | `verifyPricingRuleState()` | `seniors-service.js:454` | READ only | Read-only |

**Assessment**: Three distinct systems (expiry, loyalty, seniors) all manage their own pricing rules in Square. They serve different business purposes:

- **Expiry**: Automated percentage discounts tied to product sets (by expiry tier)
- **Loyalty**: Per-customer group discounts tied to individual items (reward redemption)
- **Seniors**: Monthly scheduled discount tied to customer group (age-based)

The deletion path is already consolidated via `utils/square-catalog-cleanup.js` (BACKLOG-6, completed 2026-02-06). The creation paths are intentionally different — each system creates different object structures (different `pricing_rule_data`, different targeting mechanisms).

---

## 3. Tier Calculation Logic Outside `discount-service.js`

| # | Location | File:Line | What It Does | Duplicated? |
|---|----------|-----------|-------------|-------------|
| 1 | `inventory-service.js` | `services/catalog/inventory-service.js:449-453` | Calls `expiryDiscount.calculateDaysUntilExpiry()` and `expiryDiscount.determineTier()` | **NO** — delegates to discount-service.js |
| 2 | `expiry-audit.js` (frontend) | `public/js/expiry-audit.js:169-179` | `getTierFromDays()` — reimplements `determineTier()` in the browser | **YES** — duplicated logic |
| 3 | `analytics.js` (route) | `routes/analytics.js:170-174` | SQL `CASE WHEN` calculates `days_until_expiry` inline | **NO** — SQL-only, no tier determination |
| 4 | `reorder.js` (frontend) | `public/js/reorder.js:552,977-979` | Hardcoded threshold checks (`<= 0`, `<= 30`, `<= 89`) | **YES** — hardcoded tier boundaries |
| 5 | `expiry-discounts.js` (frontend) | `public/js/expiry-discounts.js:161,175` | Hardcoded day-range checks for CSS classes | **YES** — hardcoded tier boundaries |

### Details on Duplicated Logic

**Frontend `getTierFromDays()` in expiry-audit.js:169-179**:
This is a JavaScript reimplementation of the server's `determineTier()`. It loads tier ranges from the API on page load (line 118-125) and evaluates locally. This is acceptable because:
- It uses the API-loaded tier config (not hardcoded ranges)
- It's needed for real-time UI updates when staff changes expiry dates during audits
- It would be impractical to make a server round-trip for every date change

**Hardcoded thresholds in reorder.js:977-979**:
```javascript
const expiredCount = expiringItems.filter(i => i.days_until_expiry <= 0).length;
const auto50Count = expiringItems.filter(i => i.days_until_expiry > 0 && i.days_until_expiry <= 30).length;
const auto25Count = expiringItems.filter(i => i.days_until_expiry > 30 && i.days_until_expiry <= 89).length;
```
These hardcode the default tier boundaries (0, 30, 89) instead of reading from the API. If a merchant customizes their tier ranges, this frontend will show incorrect tier counts.

**Hardcoded thresholds in expiry-discounts.js:161,175**:
CSS class assignment uses hardcoded day ranges for color coding. Same risk as reorder.js.

---

## 4. Consolidation Recommendations

### Consolidate NOW (safe, in-scope)

| # | What | Risk | Action |
|---|------|------|--------|
| — | Nothing in-scope | — | See below |

**Rationale**: After thorough analysis, there is **no server-side tier calculation duplication** to consolidate. All backend callers already delegate to `discount-service.js:calculateDaysUntilExpiry()` and `discount-service.js:determineTier()`. The `inventory-service.js` call at line 449-453 is a proper import-and-call, not a reimplementation.

The frontend duplication (reorder.js hardcoded thresholds) is a real issue but it's a **frontend fix**, not a discount-service.js consolidation. It should be handled separately.

### Send Back to Tech Debt (not in scope for this PR)

| # | What | Backlog | Reason |
|---|------|---------|--------|
| 1 | Frontend hardcoded tier thresholds in `reorder.js:977-979` and `expiry-discounts.js:161,175` | **NEW: BACKLOG-32** | Frontend change, needs UI testing. Risk: merchants who customize tier ranges see wrong counts on reorder page |
| 2 | Square pricing rule CREATION path differences (expiry vs loyalty vs seniors) | Not needed | Intentionally different — each creates different object structures for different business purposes |
| 3 | Square pricing rule DELETION consolidation | **BACKLOG-6 — ALREADY DONE** | Completed 2026-02-06. All three systems use `deleteCatalogObjects()` from `utils/square-catalog-cleanup.js` |

---

## 5. Summary

| Area | Finding | Status |
|------|---------|--------|
| `variation_discount_status` writes | All 6 write paths are in `discount-service.js` | **Clean — no action needed** |
| Square pricing rule create | 3 systems create rules, each with different structures | **Intentional — no consolidation needed** |
| Square pricing rule delete | All 3 systems use shared `deleteCatalogObjects()` | **Already consolidated (BACKLOG-6)** |
| Server-side tier calculation | Only in `discount-service.js`, all callers import from there | **Clean — no action needed** |
| Frontend tier calculation | `expiry-audit.js` uses API-loaded config (OK). `reorder.js` and `expiry-discounts.js` hardcode thresholds (BUG) | **New backlog item BACKLOG-32** |

**Bottom line**: The existing tech debt comment in `clearExpiryDiscountForReorder()` (line 1697-1701) referencing "three known paths" for discount cleanup is **outdated**. The `deleteCatalogObjects()` consolidation (BACKLOG-6) was completed on 2026-02-06. Both the expiry system and loyalty system now use the shared utility. The tech debt comment should be updated.
