# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Roadmap](./ROADMAP.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-04
**Consolidated from**: AUDIT-2026-02-28, CODEBASE_AUDIT_2026-02-25, API-SPLIT-PLAN, MULTI-TENANT-AUDIT

Known issues that are logged but not yet scheduled. These are not blocking any feature work — they represent latent risks, code smells, or minor correctness issues to address when touching nearby code.

---

## Observed Code Issues

### BUG: `processRefund` non-deterministic idempotency key allows duplicate refund inserts

**File**: `services/loyalty-admin/purchase-service.js:~673`
**Issue**: The refund idempotency key includes `Date.now()`, making it `refund:${orderId}:${varId}:${qty}:${Date.now()}`. If the same refund webhook fires twice (common with Square — 4-5 webhooks per event), each gets a unique key and BOTH are inserted into `loyalty_purchase_events`. This double-decrements the customer's loyalty progress. Compare with `processQualifyingPurchase` which correctly uses a deterministic key: `${orderId}:${varId}:${qty}`.
**Impact**: Medium — duplicate refund records cause over-counted refunds, potentially revoking rewards that should remain earned. Low frequency (~2 refunds/day per BACKLOG-35), but each refund could be double-counted.
**Fix**: Remove `Date.now()` from the idempotency key. Use `refund:${squareOrderId}:${variationId}:${quantity}` (deterministic, matching the purchase pattern).
**Source**: Discovered during T-3 test writing (2026-03-04)

### OAuth `/connect` error handler uses global error handler instead of redirect

**File**: `routes/square-oauth.js`
**Issue**: After wrapping `/connect` with `asyncHandler` (ERR-1/2 fix), the manual try/catch was removed. Previously, errors redirected the user to `/dashboard.html?error=...`. Now errors pass to Express's global error handler, which returns JSON. The `/callback` route retains its try/catch for Square-specific error message building.
**Impact**: Users hitting an OAuth connect error see a JSON error response instead of being redirected to the dashboard. Low likelihood — requires DB failure or missing env vars.
**Source**: Observed during ERR-1/2 fix (2026-03-04)

### `reconcileVendorId` silent no-op

**File**: `services/square/square-vendors.js` (originally `api.js:304-340`)
**Issue**: When a vendor already exists with the same `square_vendor_id`, `reconcileVendorId` returns early without logging. If the caller expects it to update stale vendor data (e.g., name changes), the update silently doesn't happen.
**Impact**: Vendor name changes in Square may not propagate to local DB until a full vendor sync.
**Source**: API-SPLIT-PLAN observation

### `totalSynced++` inflates on error path

**File**: `services/square/square-catalog-sync.js` (sync counter logic)
**Issue**: The `totalSynced` counter increments before confirming the database write succeeded. If the DB INSERT/UPDATE fails for a specific item, the counter still increments, making the sync summary log show more items synced than actually persisted.
**Impact**: Misleading sync logs. No data corruption — the item is simply missing from the DB while the log says it was synced.
**Source**: Observed during API split

### Vendor constraint errors log as error not warn

**File**: `services/square/square-vendors.js`
**Issue**: When a vendor upsert hits a unique constraint (race condition between concurrent syncs), it logs at ERROR level. This is actually an expected, handled condition — should be WARN or INFO.
**Impact**: Noise in error logs; may trigger false alarms if error log monitoring is added.
**Source**: Observed during vendor sync testing

### `hashResetToken` duplicated in `auth.js` and `subscriptions.js`

**File**: `routes/auth.js`, `routes/subscriptions.js`
**Issue**: The `hashResetToken(token)` helper (SHA-256 hash for password reset tokens) is defined identically in both files. Should be extracted to a shared utility (e.g., `utils/password.js`).
**Impact**: Low — two identical 3-line functions. Risk of drift if one is changed without the other.
**Source**: Observed during SEC-7 fix (2026-03-04)

### Legacy plaintext Google OAuth tokens persist until refresh

**File**: `utils/google-auth.js`
**Issue**: Existing Google OAuth tokens stored before SEC-6 remain as plaintext in the `google_oauth_tokens` table. The `loadTokens` function handles both encrypted and plaintext formats via `isEncryptedToken()` check. Tokens are re-encrypted on next refresh (via the `client.on('tokens')` listener). No migration script was written to bulk-encrypt existing tokens.
**Impact**: Low — only affects merchants who connected Google before the fix. Tokens will self-heal on next API call that triggers a refresh. Only one merchant (JTPets) currently has Google OAuth connected.
**Source**: Observed during SEC-6 fix (2026-03-04)

### ~~Vendor webhook handler used event reference ID instead of vendor ID~~ RESOLVED (2026-03-05)

**File**: `services/webhook-handlers/catalog-handler.js`
**Issue**: The `_handleVendorChange` handler extracted the vendor ID from `entityId` (which maps to `event.data.id` — the Square event reference UUID), not the actual vendor ID at `data.object.vendor.id`. This caused vendor ID oscillation: the handler would see a UUID as a "new" vendor ID, migrate all FK references to it, then the next sync would try to re-insert the real Square vendor ID and hit the unique constraint — triggering an infinite migration loop.
**Fix**: Changed `vendorId` extraction to use `vendor.id` (from `data.vendor.id`, i.e. `event.data.object.vendor.id`) instead of `entityId`. Added explanatory comment. Updated test fixture to use a different `entityId` from `vendor.id` to prove the fix.
**Source**: Discovered via vendor ID oscillation in production (2026-03-05)

### ~~Popup report window has inline `<script>` blocked by CSP~~ RESOLVED (2026-03-04)

**File**: `public/js/vendor-catalog.js`
**Issue**: The `openReportWindow()` function generated an HTML document written to a popup via `window.open()` + `document.write()`. The generated HTML contained an inline `<script>` block for CSV download functionality, which was blocked by CSP after S-4 removed `'unsafe-inline'` from `scriptSrc`.
**Fix**: Removed the inline `<script>` block entirely. CSV download and print buttons now use event listeners attached programmatically from the opener window after `document.write()` completes. The CSV is generated via Blob URL + temporary `<a>` element click. No new files needed — fix is self-contained in `vendor-catalog.js`.
**Source**: Observed during S-4 audit (2026-03-04), fixed 2026-03-04

---

## Security (Low Severity)

| ID | File | Description |
|----|------|-------------|
| S-5 | `routes/auth.js:655` | Password reset token exposed in non-production response — change check to positive opt-in (`NODE_ENV === 'development'`) |
| S-7 | `routes/square-oauth.js:320` | Missing `requireMerchant` on OAuth revoke route — uses manual access check instead |
| S-8 | `server.js:459-472` | Health endpoint exposes heap memory, node version, uptime, webhook failures to unauthenticated users |
| S-9 | Project-wide | No CSRF token middleware — relies on SameSite + CORS only |
| S-11 | `routes/square-oauth.js:242-244` | Session fixation window on OAuth callback — session not regenerated after merchant binding |
| SEC-8/9 | `utils/database.js` | `batchUpsert`/`MerchantDB.update` interpolate column names — not user-controlled, but violates parameterization rule |
| SEC-14 | `services/gmc/feed-service.js` | `resolveImageUrls` missing `merchant_id` filter on image lookup |

---

## Database

| ID | File | Description |
|----|------|-------------|
| DB-2 | `database/schema.sql` | Missing composite index on `inventory_counts(merchant_id, location_id, state)` |
| DB-3 | `database/schema.sql` vs migrations | Schema drift — `schema.sql` missing indexes from migration 005 (multi-tenant). Fresh deploy differs from migrated DB |
| DB-4 | `database/schema.sql:867-880` | `expiry_discount_audit_log.merchant_id` allows NULL — should be NOT NULL |
| DB-5 | `database/schema.sql:1053` | Potentially dead column `subscription_plans.square_plan_id` — not referenced anywhere |
| DB-6 | 14 core tables | Missing `ON DELETE CASCADE` — orphan rows possible on merchant deletion |
| DB-7 | Multiple tables | Timestamp inconsistency: mix of `TIMESTAMP` and `TIMESTAMPTZ` column types |

---

## Error Handling

| ID | File | Description |
|----|------|-------------|
| ERR-10 | `utils/database.js` | Pool error handler calls `process.exit(-1)` on transient DB errors — should retry or log and continue |
| E-4 | `services/loyalty-admin/audit-service.js:66-73` | Audit logging silently swallows errors — intentional, but no fallback buffer for failed audit writes |

---

## Performance

| ID | File | Description |
|----|------|-------------|
| PERF-1 | `services/square/square-velocity.js` | N+1 INSERT — per-variation sequential inserts during velocity sync. Use batch INSERT with `unnest()` |
| PERF-6 | `routes/analytics.js:147-278` | Reorder suggestions: 9-table JOIN with 3 correlated subqueries, no LIMIT clause. Unbounded result set |
| PERF-7 | `routes/bundles.js:340-359` | N+1 bundle component inserts — 10-component bundle makes 10 sequential INSERTs |
| P-3 | `middleware/merchant.js:210` | `SELECT *` on merchants table for every `getSquareClientForMerchant()` call — fetches unused encrypted tokens |
| P-4 | `services/square/` (7 locations) | Square API pagination loops have no `MAX_ITERATIONS` guard |
| P-5 | `services/gmc/merchant-service.js:57-70` | Google OAuth token listener duplicated on every `getAuthClient()` call — leaks listeners |
| P-7 | `middleware/merchant.js:19-20` | `clientCache` (Map) has no maximum size or LRU eviction — grows unbounded with merchant count |
| P-8 | `services/sync-queue.js:232-242` | Follow-up syncs block sequentially — could fire async |

---

## Dead Code / Cleanup

| ID | File | Description |
|----|------|-------------|
| DEAD-6-12 | `server.js` | 7 dead imports + dead `podUpload` config + ~75 lines of "EXTRACTED" comments — ~100 lines removable |
| DC-1 | `utils/*.js` (9 files) | Backward-compatibility re-export stubs. 3 single-consumer stubs (`loyalty-reports.js`, `vendor-catalog.js`, `google-sheets.js`) could be eliminated by updating their one caller |
| O-1 | `services/square/square-pricing.js` | `updateVariationPrice` exported but never imported or called anywhere — dead export |

---

## Logging

| ID | File | Description |
|----|------|-------------|
| L-1 | `server.js:1098`, `utils/database.js:2362` | Critical startup paths use `console.error()` instead of Winston logger — bypasses structured logging pipeline |
| L-2 | 10 locations across services | Missing `merchantId` in error logs — impossible to determine affected tenant in multi-tenant context |
| L-3 | 32 frontend JS files (180 calls) | `console.log` visible to end users in DevTools — reveals API response shapes, error details |

---

## Config

| ID | File | Description |
|----|------|-------------|
| C-1 | ~20 locations | Hardcoded timeouts, batch sizes, retention limits across service files — should be in `config/constants.js` |
| C-3 | `server.js:59-73` | Only `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` validated at startup — other critical secrets fail at runtime |
| C-4 | `jobs/backup-job.js` | Backups not encrypted at rest, no post-backup verification, local only (no off-site copy) |
| I-2 | `services/square/api.js:25` vs `shared-utils.js:18` | Dual Square API version constants — `2025-10-16` vs `2025-01-16` |

---

## Frontend

| ID | Description |
|----|-------------|
| FE-1 | 79 of 183 `fetch()` calls missing `response.ok` check — silent failures on non-200 responses |
| FE-2 | `showToast()` duplicated across 7 files — no shared utility |
| FE-3 | `escapeJsString()` duplicated across 7 files |
| FE-4 | `formatDate()` variants duplicated across multiple files |

---

## Architecture (Informational)

| ID | File | Description |
|----|------|-------------|
| A-3 | `middleware/merchant.js` ↔ `routes/square-oauth.js` | Circular dependency — mitigated via deferred `require()` with comment. Extract `refreshMerchantToken()` to `utils/square-token.js` to eliminate |
| O-4 | `services/square/square-pricing.js` | Scoping bug in `updateVariationCost` — `catch` block references `currentVariationData` declared inside `try` block. Unreachable in practice but technically a `ReferenceError` risk |
| O-5 | `services/square/square-catalog-sync.js` | Business logic (brand extraction, expiry parsing) leaking into API sync layer — should be in service callbacks |
| O-6 | `services/square/square-velocity.js` | Soft coupling to loyalty-admin via lazy `require()` — intentional, documented |

---

## Testing

| ID | File | Description |
|----|------|-------------|
| T-1 | `__tests__/routes/oauth-trial.test.js` | Test suite fails with `Cannot find module 'square'` — Square SDK not available in test environment. Tests pass locally when SDK is installed. Fix: add `square` to `devDependencies` or mock it in the test setup before this matters for real CI/CD pipeline. |
| T-2 | `services/webhook-handlers/order-handler.js` | 57 tests added (2026-03-04). 1,316 lines, mixed responsibilities (velocity, loyalty, delivery, cart activity, refunds). Flag for split into handler-per-concern modules. |
| T-3 | `services/loyalty-admin/purchase-service.js` | 20 tests added (2026-03-04). ~840 lines. **BUG FOUND**: `processRefund` idempotency key uses `Date.now()` (line ~673), making it non-deterministic — duplicate refund webhooks get different keys and both insert, causing double-decremented loyalty progress. Purchase path uses deterministic keys correctly. Fix: remove `Date.now()` from refund idempotency key. |
| T-4 | `services/loyalty-admin/reward-service.js` | 31 tests added (2026-03-04). ~680 lines. No bugs found. Flag: exceeds 300-line limit; detection strategies (catalog ID, free item, discount amount) could be separate modules. |
| T-5 | `services/loyalty-admin/square-discount-service.js` | 39 tests added (2026-03-04). ~1,465 lines. No bugs found. Flag: 5x over 300-line limit; contains CRUD, orchestration, validation, sync, and customer notes — at least 3 separate concerns. |

### ~~Historical `total_price_cents` NULL rows in `loyalty_purchase_events`~~ DONE 2026-03-04

**Date logged**: 2026-03-04
**Resolved**: 2026-03-04 — 146 rows backfilled.
**Files**: `services/loyalty-admin/purchase-service.js`, `services/loyalty-admin/order-intake.js`
**Issue**: The `total_price_cents` column (added in migration 025) was never populated prior to the 2026-03-04 fix. All rows inserted before that date have `total_price_cents = NULL`. New rows are now correctly populated as `quantity * unit_price_cents`.
**Fix**: Backfill query: `UPDATE loyalty_purchase_events SET total_price_cents = quantity * unit_price_cents WHERE total_price_cents IS NULL AND unit_price_cents IS NOT NULL;`

---

## Grading History

| Date | Grade | Notes |
|------|-------|-------|
| 2026-03-04 | A+ | All P0-P2 complete. Test coverage and file size violations remain for A++ |
| 2026-02-19 | A+ | P0 7/7, P1 9/9, P2 6/6. API optimization 4/4 |
| 2026-01-26 | A | P0-5,6,7 fixed. P1-6,7,8,9 fixed. Master engineering review |

**Target A++ requirements**: Comprehensive test coverage (currently 28%), file size compliance (66 unapproved violations), zero known security issues.
