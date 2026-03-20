# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Updated**: 2026-03-20

Known issues that are logged but not yet scheduled. These are not blocking any feature work — they represent latent risks, code smells, or minor correctness issues to address when touching nearby code.

---

## Summary

| Category | Open Items |
|----------|-----------|
| Code Quality Observations | 9 |
| Expiry Discount | 3 |
| Square Online Store | 4 |
| Database | 1 |
| Performance | 4 |
| Logging | 1 |
| Config | 2 |
| Architecture | 3 |
| Multi-Tenant Gaps | 5 |
| Testing | 1 |
| Service Test Audit (LOW) | 3 |
| **Total** | **~36** |

---

## Code Quality Observations

### Historical loyalty_purchase_events with incorrect quantity (needs backfill)

**Files**: `services/loyalty-admin/order-intake.js`, `purchase-service.js`
**Issue**: Before 2026-03-07 fix, multiple line items with same `catalog_object_id` were deduped incorrectly. Historical rows have under-counted quantities. Backfill script needed.
**Priority**: Medium — affects reward accuracy for existing customers.

### Incremental velocity update does not subtract refunds

**File**: `services/square/square-velocity.js:updateSalesVelocityFromOrder`
**Issue**: Webhook-triggered incremental uses additive SQL. Refunds not handled until daily full sync.
**Impact**: Minor — velocity slightly inflated between daily syncs.

### OAuth `/connect` error handler uses global error handler instead of redirect

**File**: `routes/square-oauth.js`
**Issue**: After asyncHandler wrapping, errors go to global handler (JSON) instead of dashboard redirect.
**Impact**: Low — requires DB failure or missing env vars.

### `reconcileVendorId` silent no-op

**File**: `services/square/square-vendors.js`
**Issue**: Existing vendor returns early without updating. Vendor name changes don't propagate until full sync.

### `totalSynced++` inflates on error path

**File**: `services/square/square-catalog-sync.js`
**Issue**: Counter increments before confirming DB write succeeded. Sync logs overcount.

### Vendor constraint errors log as ERROR not WARN

**File**: `services/square/square-vendors.js`
**Issue**: Expected unique constraint race condition logs at ERROR level.

### Velocity return revenue uses wrong nested property (harmless due to fallback)

**File**: `services/square/square-velocity.js:140-141,474-475`
**Issue**: `return_amounts` property always undefined on return line item. Correct fallback `total_money` is used.

### OSS locale sweep — remaining frontend hardcoded locale

**Scope**: `public/js/` files still have hardcoded `'en-CA'` and `'CAD'` in `toLocaleString()` calls. Backend fixed; frontend needs merchant context API.

### Legacy plaintext Google OAuth tokens persist until refresh

**File**: `utils/google-auth.js`
**Issue**: Pre-SEC-6 tokens remain as plaintext. Self-heal on next token refresh. Only JTPets affected.

---

## Expiry Discount Automation

| ID | Description |
|----|-------------|
| EXPIRY-REORDER-AUDIT | Clearance items receiving new PO/restock should be flagged for re-audit. No trigger exists |
| BACKLOG-57 | Daily re-apply noise — logs DISCOUNT_APPLIED even when tier unchanged |
| BACKLOG-58 | Inventory increase should trigger expiry re-verification for AUTO25/AUTO50 items |

---

## Square Online Store Gaps

| ID | Description |
|----|-------------|
| BACKLOG-64 | `sold_out` flag not reconciled with inventory = 0 |
| BACKLOG-65 | Website catalog categories not synced |
| BACKLOG-63 | Product image captions not populated (SEO/accessibility) |
| BACKLOG-61 | GMC v1beta deprecated — Google Shopping feed broken since Feb 28 2026 (**P0**) |

---

## Database

| ID | Description |
|----|-------------|
| DB-5 | Potentially dead column `subscription_plans.square_plan_id` |

---

## Performance

| ID | File | Description |
|----|------|-------------|
| PERF-6 | `services/catalog/reorder-service.js:135+` | Reorder suggestions: 11-table JOIN, 4 correlated subqueries |
| PERF-7 | `routes/bundles.js:340-359` | N+1 bundle component inserts |
| P-5 | `services/gmc/merchant-service.js:65-80` | Google OAuth token listener duplicated on every call — leaks listeners |
| P-8 | `services/sync-queue.js:232-242` | Follow-up syncs block sequentially |

---

## Logging

| ID | Description |
|----|-------------|
| L-2 | 10 locations missing `merchantId` in error logs |

---

## Config

| ID | Description |
|----|-------------|
| C-1 | ~20 hardcoded timeouts, batch sizes, retention limits — should be in `config/constants.js` |
| C-4 | Backups not encrypted at rest, no post-backup verification, local only |

---

## Architecture

| ID | File | Description |
|----|------|-------------|
| A-3 | `middleware/merchant.js` ↔ `routes/square-oauth.js` | Circular dependency — mitigated via deferred `require()` |
| O-4 | `services/square/square-pricing.js` | Scoping bug — `catch` references var from `try` block |
| O-5 | `services/square/square-catalog-sync.js` | Business logic leaking into API sync layer |

---

## Multi-Tenant Gaps (from audit 2026-03-08) — Documented, TODO(pre-franchise)

| ID | Severity | Description |
|----|----------|-------------|
| MT-6 | Degrades | Sync interval configuration is global, not per-merchant |
| MT-7 | Degrades | `DAILY_COUNT_TARGET` cycle count target is global |
| MT-8 | Cosmetic | Shared log files across all merchants (tags work, but flat files don't scale) |
| MT-9 | Degrades | Health check picks arbitrary merchant for Square status |
| MT-11 | Cosmetic | Single global `TOKEN_ENCRYPTION_KEY` for all merchants |

---

## Testing

| ID | Description |
|----|-------------|
| T-4 | Background jobs mostly untested |

---

## Service Test Audit 2026-03-15 (Batch 2) — Open Bugs

| Severity | File | Description |
|----------|------|-------------|
| LOW | `catalog-service.js:962` | `regeneratePriceReport` crashes if `db.query` returns undefined |
| LOW | `delivery-service.js:1175` | `_decryptOrsKey` swallows decryption errors — geocoding silently fails |
| LOW | `delivery-service.js:1914` | `backfillUnknownCustomers` inconsistent response shape |

---

## Grading History

| Date | Grade | Notes |
|------|-------|-------|
| 2026-03-15 | A+ | 4,035 tests / 187 suites / 0 failures. Loyalty: 857+ tests. 119 new tests in session. |
| 2026-03-04 | A+ | All P0-P2 complete. Test coverage and file size violations remain for A++ |
| 2026-02-19 | A+ | P0 7/7, P1 9/9, P2 6/6. API optimization 4/4 |
| 2026-01-26 | A | P0-5,6,7 fixed. P1-6,7,8,9 fixed. Master engineering review |

**Target A++ requirements**: Comprehensive test coverage, file size compliance, zero known security issues.
