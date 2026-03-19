# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Work Items](./WORK-ITEMS.md) | [Priorities](./PRIORITIES.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Updated**: 2026-03-19

Known issues that are logged but not yet scheduled. These are not blocking any feature work — they represent latent risks, code smells, or minor correctness issues to address when touching nearby code.

---

## Summary

| Category | Open Items |
|----------|-----------|
| Loyalty System (CRIT/HIGH) | 6 |
| Loyalty System (MED) | 7 |
| Security (Low) | 6 |
| Database | 4 |
| Error Handling | 1 |
| Performance | 7 |
| Dead Code | 1 |
| Logging | 2 |
| Config | 3 |
| Frontend | 1 |
| Architecture | 4 |
| Multi-Tenant Gaps | 4 |
| Expiry Discount | 3 |
| Square Online Store | 4 |
| Code Quality Observations | 4 |
| **Total** | **~57** |

---

## Loyalty System — Critical/High (from Loyalty Audit 2026-03-09)

### CRIT-1: Race Condition — Concurrent Webhooks Create Duplicate Rewards

**File**: `services/loyalty-admin/reward-progress-service.js:308-333`
**Issue**: Two concurrent webhooks can both earn the same reward and both attempt to create a new `in_progress` row. Partial unique index catches at DB level, but no error handling for the violation — transaction throws, purchase silently lost.
**Fix**: `ON CONFLICT ... DO UPDATE` or catch unique violation and re-fetch.

### CRIT-2: No Row-Level Locking on Purchase Events During Progress Calculation

**File**: `services/loyalty-admin/reward-progress-service.js:36-48`
**Issue**: Quantity calculation reads unlocked purchase events. Two concurrent transactions can both read same rows, both conclude threshold met, both lock same events. Double-earning of rewards possible.
**Fix**: Add `FOR UPDATE` to quantity calculation query, or advisory lock on `(merchantId, offerId, squareCustomerId)`.

### CRIT-3: Purchase INSERT Lacks ON CONFLICT for Idempotency Key

**File**: `services/loyalty-admin/purchase-service.js:88-99, 142-157`
**Issue**: Idempotency check is SELECT then INSERT with no ON CONFLICT. Concurrent calls with same key both pass SELECT, second INSERT throws.
**Fix**: Add `ON CONFLICT (merchant_id, idempotency_key) DO NOTHING RETURNING *`.

### HIGH-1: Double Redemption Detection Window

**Files**: `order-loyalty.js:275`, `reward-service.js:481-678`
**Issue**: `detectRewardRedemptionFromOrder()` reads earned rewards without locking, then `redeemReward()` starts new transaction with FOR UPDATE. Between read and lock, another webhook can detect same reward.
**Fix**: Handle already-redeemed status gracefully in `redeemReward()`.

### HIGH-2: All Loyalty Errors Silently Swallowed

**File**: `order-loyalty.js:310-317`
**Issue**: Entire `processLoyalty` wrapped in try/catch that logs but never re-throws. Transient DB error permanently loses order's loyalty data.
**Fix**: Re-throw or implement dead-letter queue.

### HIGH-3: Refund Processing Not Atomic Across Line Items

**File**: `purchase-service.js:276-437`
**Issue**: Each refund line item gets independent transaction. If item 2 of 3 fails, item 1 committed, item 3 skipped.
**Fix**: Add `transactionClient` option, wrap all items in single transaction.

### HIGH-5: schema.sql Out of Sync With Live Database

**File**: `database/schema.sql:1559-1560`
**Issue**: schema.sql has old UNIQUE constraint; migration 024 replaced with partial unique index WHERE status = 'in_progress'. Building from schema.sql creates wrong constraint.

### HIGH-6: Refund-Triggered Revocation Doesn't Clean Up Square Discount

**File**: `purchase-service.js:342-408`
**Issue**: Refund causing earned reward revocation updates DB but does NOT call `cleanupSquareCustomerGroupDiscount()`. Customer retains active discount in Square POS.

---

## Loyalty System — Medium

| ID | File | Description |
|----|------|-------------|
| MED-1 | `reward-progress-service.js:261-289` | Async Square discount creation fires as detached `.then()` — orphans on rollback |
| MED-2 | `expiration-service.js:46-81` | Expiration loop exits on first error — one bad record prevents processing all remaining |
| MED-3 | `order-loyalty.js`, `reward-service.js` | N+1 queries in redemption detection — per-discount query |
| MED-4 | `customer-summary-service.js:22-111` | 6 sequential queries in customer summary update |
| MED-5 | Database schema | No DB-level state transition enforcement on `loyalty_rewards.status` |
| MED-6 | `reward-service.js:271-285` | Ambiguous LIMIT 1 in free-item reward matching |
| MED-7 | `order-intake.js:188-197` | Partial commit on per-item error — failed variation permanently lost |

### Open Loyalty Audit Items (LA-*)

| ID | Sev | Description |
|----|-----|-------------|
| LA-14 | P2 | `processExpiredWindowEntries` error handler misleadingly appears to roll back committed rows |
| LA-16 | P2 | Manual entry sets $0 price — can't calculate discount cap |
| LA-17 | P2 | `buildDiscountMap` swallows DB errors — could double-count redemption items |
| LA-18 | P2 | Five files use raw `fetch()` instead of `SquareApiClient` — no rate-limit retry |
| LA-21 | P2 | Multi-threshold rollover with split-row edge cases untested |
| LA-27 | P2 | Loyalty event prefetch returns partial data silently on API failures |

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

### RISK: Delta sync does not mark child variations as deleted

**File**: `services/square/square-catalog-sync.js:612-629`
**Issue**: Delta sync marks item deleted, zeros inventory, but does NOT set `is_deleted = TRUE` on variation rows.
**Priority**: Medium — orphaned variations appear in reorder suggestions.

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

## Security (Low Severity)

| ID | File | Description |
|----|------|-------------|
| S-5 | `routes/auth.js:655` | Password reset token exposed in non-production response |
| S-7 | `routes/square-oauth.js:320` | Missing `requireMerchant` on OAuth revoke route |
| S-8 | `server.js:459-472` | Health endpoint exposes heap/node version to unauthenticated users |
| S-9 | Project-wide | No CSRF token middleware — relies on SameSite + CORS only |
| S-11 | `routes/square-oauth.js:242-244` | Session not regenerated after merchant binding on OAuth callback |
| SEC-8 | `utils/database.js` | `batchUpsert` interpolates column names — not user-controlled but violates rule |

---

## Database

| ID | Description |
|----|-------------|
| DB-1 | 14 core tables have nullable `merchant_id` — add NOT NULL constraint |
| DB-2 | Missing composite index on `inventory_counts(merchant_id, location_id, state)` |
| DB-3 | Schema drift — `schema.sql` missing indexes from migration 005 |
| DB-4 | `expiry_discount_audit_log.merchant_id` allows NULL |
| DB-5 | Potentially dead column `subscription_plans.square_plan_id` |

---

## Error Handling

| ID | File | Description |
|----|------|-------------|
| ERR-10 | `utils/database.js` | Pool error handler calls `process.exit(-1)` on transient DB errors |

---

## Performance

| ID | File | Description |
|----|------|-------------|
| PERF-1 | `square-velocity.js` | N+1 INSERT — per-variation sequential inserts during velocity sync |
| PERF-6 | `routes/analytics.js:147-278` | Reorder suggestions: 9-table JOIN, 3 correlated subqueries, no LIMIT |
| PERF-7 | `routes/bundles.js:340-359` | N+1 bundle component inserts |
| P-3 | `middleware/merchant.js:210` | `SELECT *` on merchants for every `getSquareClientForMerchant()` |
| P-5 | `services/gmc/merchant-service.js:57-70` | Google OAuth token listener duplicated on every call — leaks listeners |
| P-7 | `middleware/merchant.js:19-20` | `clientCache` Map has no max size or LRU eviction |
| P-8 | `services/sync-queue.js:232-242` | Follow-up syncs block sequentially |

---

## Dead Code / Cleanup

| ID | File | Description |
|----|------|-------------|
| O-1 | `services/square/square-pricing.js` | `updateVariationPrice` exported but never called |

---

## Logging

| ID | Description |
|----|-------------|
| L-2 | 10 locations missing `merchantId` in error logs |
| L-3 | 32 frontend JS files have `console.log` visible to end users (180 calls) |

---

## Config

| ID | Description |
|----|-------------|
| C-1 | ~20 hardcoded timeouts, batch sizes, retention limits — should be in `config/constants.js` |
| C-4 | Backups not encrypted at rest, no post-backup verification, local only |
| I-2 | Dual Square API version constants — `2025-10-16` vs `2025-01-16` across 19 loyalty-admin files |

---

## Frontend

| ID | Description |
|----|-------------|
| FE-1 | 79 of 183 `fetch()` calls missing `response.ok` check |

---

## Architecture

| ID | File | Description |
|----|------|-------------|
| A-3 | `middleware/merchant.js` ↔ `routes/square-oauth.js` | Circular dependency — mitigated via deferred `require()` |
| O-4 | `services/square/square-pricing.js` | Scoping bug — `catch` references var from `try` block |
| O-5 | `services/square/square-catalog-sync.js` | Business logic leaking into API sync layer |
| O-6 | `services/square/square-velocity.js` | Soft coupling to loyalty-admin via lazy `require()` |

---

## Multi-Tenant Gaps (from audit 2026-03-08)

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
| TEST-28 | `subscriptions.test.js` — 849 lines testing JS operators, not application code. Rewrite needed |
| T-1 | Financial/loyalty services have partial coverage (purchase-service, reward-service) |
| T-3 | Many routes untested — prioritize analytics.js, catalog.js, loyalty.js |
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
