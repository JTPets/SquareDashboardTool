# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Roadmap](./ROADMAP.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-07
**Consolidated from**: AUDIT-2026-02-28, CODEBASE_AUDIT_2026-02-25, API-SPLIT-PLAN, MULTI-TENANT-AUDIT

Known issues that are logged but not yet scheduled. These are not blocking any feature work — they represent latent risks, code smells, or minor correctness issues to address when touching nearby code.

---

## Observed Code Issues

### Historical loyalty_purchase_events with incorrect quantity (needs backfill)

**Files**: `services/loyalty-admin/order-intake.js`, `services/loyalty-admin/purchase-service.js`
**Issue**: Before the 2026-03-07 fix, when Square POS produced multiple line items with the same `catalog_object_id` in a single order (e.g., 3 bags scanned individually → 3 line items each with `quantity: "1"`), the old idempotency key `orderId:variationId:quantity` caused only the first line item to be recorded. The rest were silently deduped. This resulted in `quantity = 1` in `loyalty_purchase_events` when the actual purchase was 3+ units.
**Fix applied**: Order-intake now aggregates line items by `variationId` before calling `processQualifyingPurchase`. Idempotency key changed to `orderId:variationId` (quantity removed). New orders are recorded correctly.
**Remaining work**: Historical rows in `loyalty_purchase_events` still have under-counted quantities. A backfill script is needed to: (1) fetch affected orders from Square API, (2) re-aggregate line items, (3) UPDATE quantity and total_price_cents for existing events where the recorded quantity is less than the actual total. Must also recalculate reward progress for affected customers. Scope: all `loyalty_purchase_events` rows where the order had multiple line items for the same variation.
**Impact**: Customer reward progress may be behind — customers who should have earned rewards sooner may still be in_progress. Danny Booth case: 30 total units across 10 visits, only 12 recorded with quantity=1.
**Priority**: Medium — affects reward accuracy for existing customers. New purchases are correct after the fix.
**Source**: Production bug report (2026-03-07)

### ~~BUG: `processRefund` non-deterministic idempotency key allows duplicate refund inserts~~ RESOLVED (2026-03-06)

**File**: `services/loyalty-admin/purchase-service.js`
**Issue**: The refund idempotency key included `Date.now()`, making it `refund:${orderId}:${varId}:${qty}:${Date.now()}`. Duplicate refund webhooks got unique keys and both inserted, double-decrementing loyalty progress.
**Fix**: Removed `Date.now()` from idempotency key. Now uses deterministic `refund:${squareOrderId}:${variationId}:${quantity}` matching the purchase pattern. Added pre-INSERT idempotency check (SELECT before transaction) matching `processQualifyingPurchase`. 2 new tests verify dedup and deterministic key.
**Source**: Discovered during T-3 test writing (2026-03-04), fixed 2026-03-06

### ~~E-1: Fire-and-forget email missing `.catch()` in DB error handler~~ RESOLVED (2026-03-06)

**File**: `server.js:1048`
**Issue**: `emailNotifier.sendCritical('Database Connection Lost', err)` was called without `.catch()` inside `db.pool.on('error')`. During a DB outage, if the email also fails, this creates an unhandled promise rejection that could crash the process.
**Fix**: Added `.catch(emailErr => logger.error('Failed to send DB error email', { error: emailErr.message }))`.

### ~~BACKLOG-36: Phantom velocity rows never self-correct~~ RESOLVED (2026-03-06)

**File**: `services/square/square-velocity.js`
**Issue**: `syncSalesVelocity` and `syncSalesVelocityAllPeriods` only upserted variations found in orders. Variations that stopped selling retained stale velocity rows forever, inflating reorder suggestions.
**Fix**: Added `DELETE FROM sales_velocity WHERE variation_id NOT IN (processed keys) AND merchant_id AND period_days` after each upsert batch. When no sales exist for a period, all rows for that period/merchant are deleted.

### ~~BACKLOG-35: Sales velocity does not subtract refunds~~ RESOLVED (2026-03-06)

**File**: `services/square/square-velocity.js`
**Issue**: Both sync functions counted `order.line_items` quantities but ignored `order.returns[].return_line_items`, making net sales slightly inflated on refunded items (~2 refunds/day at JTPets).
**Fix**: After processing line items, both functions now iterate `order.returns` and subtract `return_line_items` quantities and revenue. Net values are floored at 0 to prevent negative velocity. The incremental `updateSalesVelocityFromOrder` (webhook path) is not changed — it only processes new orders, not historical refunds. The daily reconciliation sync corrects any drift.

### Incremental velocity update does not subtract refunds

**File**: `services/square/square-velocity.js:updateSalesVelocityFromOrder`
**Issue**: The webhook-triggered incremental velocity update (`updateSalesVelocityFromOrder`) uses additive SQL (`total_quantity_sold + $4`). It does not handle refund events. When a refund occurs, the velocity is slightly inflated until the next full sync corrects it. This is acceptable because: (1) refunds are ~2/day, (2) the daily reconciliation sync runs `syncSalesVelocityAllPeriods` which now subtracts refunds correctly.
**Impact**: Minor — velocity slightly inflated for refunded items between daily syncs.
**Source**: Observed during BACKLOG-35 fix (2026-03-06)

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

### Currency hardcoded to CAD in loyalty discount catalog objects

**File**: `services/loyalty-admin/square-discount-catalog-service.js` (line ~68)
**Issue**: `createRewardDiscount` hardcodes `currency: 'CAD'` in the `maximum_amount_money` field of the DISCOUNT catalog object. For multi-tenant SaaS with merchants outside Canada, this must be pulled from merchant config (e.g., `merchants.currency` or Square location settings).
**Impact**: None currently — all merchants are Canadian. Will break for non-CAD merchants.
**Source**: Observed during square-discount-service.js split (2026-03-06)

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

## Expiry Discount Automation

| ID | Description |
|----|-------------|
| EXPIRY-REORDER-AUDIT | When a clearance/expiry-discounted item receives a new purchase order or restock event, it should be flagged for re-audit. Current system applies discounts based on expiry tier but has no trigger to re-evaluate when new inventory arrives for a discounted item. Risk: items stay on clearance pricing after being actively restocked. Trigger should be: new PO created OR inventory count increases for a variation currently in an expiry discount tier. |

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
| ~~O-7~~ | ~~`routes/analytics.js:97-876`~~ | ~~`GET /api/reorder-suggestions` handler is ~780 lines inline~~ **RESOLVED** (2026-03-06): Extracted to `services/catalog/reorder-service.js` (5 exported functions). Route handler is now 10 lines. 33 unit tests + 31 route tests pass. |
| ~~O-8~~ | ~~`routes/loyalty/processing.js:85-128`~~ | ~~`POST /manual-entry` has 44 lines inline business logic~~ **RESOLVED** (2026-03-06): Extracted to `services/loyalty-admin/manual-entry-service.js`. Route is now 10 lines. 8 unit tests. |
| ~~O-9~~ | ~~`routes/loyalty/square-integration.js`~~ | ~~`POST /create-square-reward` has 51 lines inline state-transition logic~~ **RESOLVED** (2026-03-06): Extracted to `services/loyalty-admin/square-reward-service.js`. Route is now 10 lines. 6 unit tests. |
| ~~O-10~~ | ~~`routes/loyalty/settings.js`~~ | ~~`GET /settings` has direct DB query~~ **RESOLVED** (2026-03-06): Added `getSettings()` to `services/loyalty-admin/settings-service.js`. Route is now 3 lines. 3 unit tests. |

---

## Testing

| ID | File | Description |
|----|------|-------------|
| T-1 | `__tests__/routes/oauth-trial.test.js` | Test suite fails with `Cannot find module 'square'` — Square SDK not available in test environment. Tests pass locally when SDK is installed. Fix: add `square` to `devDependencies` or mock it in the test setup before this matters for real CI/CD pipeline. |
| T-2 | `services/webhook-handlers/order-handler/` | **SPLIT COMPLETE** (2026-03-06): 1,425-line monolith split into `index.js` (~545 lines orchestration) + 5 focused modules: `order-normalize.js`, `order-cart.js`, `order-velocity.js`, `order-delivery.js`, `order-loyalty.js`. 88 tests pass with zero assertion changes. **BUG-1 FIXED**: raw `fetch()` replaced with SDK. **BUG-2 FIXED**: redundant lazy require removed. **RISK-3 FIXED**: payment path calls `checkOrderForRedemption` before `processLoyaltyOrder`. **VELOCITY FIXED**: wrapped in try/catch, logs at WARN. **RISK-1 TESTED**: multi-discount N+1 query — acceptable at current volume. |
| T-3 | `services/loyalty-admin/purchase-service.js` | 21 tests (2026-03-06). ~850 lines. **BUG FIXED** (2026-03-06): `processRefund` idempotency key no longer uses `Date.now()` — now deterministic, with pre-INSERT dedup check matching purchase path. 2 new tests cover dedup and deterministic key verification. |
| T-4 | `services/loyalty-admin/reward-service.js` | 31 tests added (2026-03-04). ~680 lines. No bugs found. Flag: exceeds 300-line limit; detection strategies (catalog ID, free item, discount amount) could be separate modules. |
| T-5 | `services/loyalty-admin/square-discount-service.js` | 39 tests added (2026-03-04). ~1,465 lines. No bugs found. Flag: 5x over 300-line limit; contains CRUD, orchestration, validation, sync, and customer notes — at least 3 separate concerns. |
| T-6 | `routes/analytics.js` + `services/catalog/reorder-service.js` | 31 route tests + 33 service unit tests (2026-03-06). Covers sales-velocity and reorder-suggestions endpoints. No bugs found. O-7 resolved — handler extracted to service. |
| T-7 | `routes/catalog.js` | 52 tests added (2026-03-06). Covers all 19 endpoints. No bugs found. Clean thin-facade pattern — all logic delegated to catalogService. |
| T-8 | `routes/loyalty/` | 48 tests added (2026-03-06). Covers offers (10), rewards (5), processing (11), customers (12), cross-cutting auth (10). No bugs found. ~~Flags: O-8, O-9, O-10~~ all RESOLVED (2026-03-06). |
| T-9 | `services/loyalty-admin/manual-entry-service.js` | 8 tests (2026-03-06). O-8 extraction. No bugs found. |
| T-10 | `services/loyalty-admin/square-reward-service.js` | 6 tests (2026-03-06). O-9 extraction. No bugs found. |
| T-11 | `services/loyalty-admin/settings-service.js` | 3 tests (2026-03-06). O-10 extraction — getSettings(). No bugs found. |

### ~~Velocity update error not caught in order handler~~ FIXED 2026-03-06

**Date logged**: 2026-03-06
**Resolved**: 2026-03-06 — wrapped in try/catch, logs at WARN, continues processing.
**File**: `services/webhook-handlers/order-handler.js:handleOrderCreatedOrUpdated`
**Issue**: `squareApi.updateSalesVelocityFromOrder()` was called without try/catch. If it threw (e.g., DB write failure), the error propagated up and prevented loyalty processing, delivery routing, and cart activity from executing.
**Fix**: Velocity update now wrapped in try/catch. Error logged at WARN level (velocity is non-critical). Delivery and loyalty processing continue uninterrupted. Test updated to verify loyalty still runs after velocity failure.

### ~~Historical `total_price_cents` NULL rows in `loyalty_purchase_events`~~ DONE 2026-03-04

**Date logged**: 2026-03-04
**Resolved**: 2026-03-04 — 146 rows backfilled.
**Files**: `services/loyalty-admin/purchase-service.js`, `services/loyalty-admin/order-intake.js`
**Issue**: The `total_price_cents` column (added in migration 025) was never populated prior to the 2026-03-04 fix. All rows inserted before that date have `total_price_cents = NULL`. New rows are now correctly populated as `quantity * unit_price_cents`.
**Fix**: Backfill query: `UPDATE loyalty_purchase_events SET total_price_cents = quantity * unit_price_cents WHERE total_price_cents IS NULL AND unit_price_cents IS NOT NULL;`

---

## Loyalty Audit 2026-03-07

Deep audit of the entire loyalty system (`services/loyalty-admin/`, `services/webhook-handlers/`, routes, and tests) performed after a quantity-aggregation bug survived code review because tests matched code logic instead of real Square order shapes. Findings are prioritized by severity and effort.

### P0 — Critical (Data Corruption / Silent Failures)

#### ~~LA-1: Dual processing path — `backfill-orchestration-service.js` bypasses `processLoyaltyOrder()` intake~~ RESOLVED (2026-03-07)

**Severity**: P0 | **Effort**: S
**Files**: `services/loyalty-admin/backfill-orchestration-service.js`, `services/loyalty-admin/order-intake.js`
**Issue**: `backfill-orchestration-service.js` called the legacy `processOrderForLoyalty()` instead of the consolidated `processLoyaltyOrder()`. The legacy path did not aggregate line items by variationId and did not write to `loyalty_processed_orders`.
**Fix**: Replaced `processOrderForLoyalty(orderForLoyalty, merchantId)` with `processLoyaltyOrder({ order, merchantId, squareCustomerId, source: 'backfill', customerSource })`. Removed the dead camelCase/snake_case `orderForLoyalty` transform block (LA-9). Raw Square order is now passed directly. 3 new tests verify correct call signature, source tag, and absence of camelCase transform.

#### ~~LA-2: `order-processing-service.js` also bypasses `processLoyaltyOrder()` intake~~ RESOLVED (2026-03-07)

**Severity**: P0 | **Effort**: S
**Files**: `services/loyalty-admin/order-processing-service.js`
**Issue**: `processOrderManually()` called `processOrderForLoyalty(order, merchantId)` (legacy path) instead of `processLoyaltyOrder()`.
**Fix**: Replaced with `processLoyaltyOrder({ order, merchantId, squareCustomerId: order.customer_id, source: 'manual', customerSource: 'order' })`. Return shape mapped from `{ alreadyProcessed, purchaseEvents }` to `{ processed }`. 2 new tests verify correct call signature and already-processed handling.

#### LA-3: Refund processing does not handle `order.returns` (Square's actual refund shape)

**Severity**: P0 | **Effort**: M
**Files**: `services/loyalty-admin/webhook-processing-service.js:338-429`
**Issue**: `processOrderRefundsForLoyalty()` iterates `order.refunds[]` and looks for `refund.return_line_items[]`. But in Square's order model, line-item returns are on `order.returns[].return_line_items[]`, NOT `order.refunds[].return_line_items[]`. The `order.refunds` array contains *payment* refund data (tender info, amounts), not line-item-level returns. The `refund.return_line_items` property does not exist in the Square API spec.
**Impact**: Refunds are NEVER processed for loyalty. When a customer returns items, their purchase quantity is never decremented, and earned rewards are never revoked. Affects reward integrity.
**Evidence**: `grep -r 'order\.returns' services/loyalty-admin/` returns zero hits (only the velocity service handles `order.returns`).
**Fix**: Rewrite to iterate `order.returns[].return_line_items[]` and map to the correct properties (`catalog_object_id`, `quantity`, `return_line_items[].source_line_item_id`).

#### LA-4: Fire-and-forget `createSquareCustomerGroupDiscount()` can silently fail, leaving reward unsynced

**Severity**: P0 | **Effort**: M
**Files**: `services/loyalty-admin/reward-progress-service.js:257-285`
**Issue**: When a reward is earned, `createSquareCustomerGroupDiscount()` is called as fire-and-forget (`.then().catch()`), OUTSIDE the database transaction. If it fails:
1. The reward is marked 'earned' in the DB (committed)
2. No Square discount/pricing rule is created
3. The customer will NOT see the discount at POS
4. The `.catch()` logs at ERROR but there is no retry mechanism, no flag set for manual sync
**Impact**: Customer earns reward in our system but never sees it at POS. Silent failure — no admin notification.
**Fix**: Either: (a) add a `square_sync_status` column to `loyalty_rewards` and set it to 'pending', with a cron job to retry; or (b) make the call inside the transaction and roll back if it fails.

### P1 — High (Incorrect Behavior / Edge Cases)

#### LA-5: `processRefund` idempotency key includes raw quantity — partial refunds can collide

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/purchase-service.js:247`
**Issue**: The refund idempotency key is `refund:${squareOrderId}:${variationId}:${quantity}`. If a customer refunds 2 units, then later refunds 1 more unit of the same item from the same order, the keys differ (`refund:ord:var:2` vs `refund:ord:var:1`) so both inserts succeed. But if Square sends duplicate webhooks for the SAME 2-unit refund, idempotency works. The problem is more subtle: `quantity` is the raw input parameter, not the absolute value. Since `processRefund` negates it with `Math.abs(quantity) * -1`, but the key uses the original `quantity`, the key is `refund:ord:var:2` when quantity=2 and also `refund:ord:var:2` when quantity=-2. So sign is not an issue. However, two separate partial refunds of the same quantity on the same variation **will** collide (both generate `refund:ord:var:1`), silently dropping the second refund.
**Impact**: Second partial refund of the same size silently dropped. Customer keeps extra loyalty credit.
**Fix**: Include refund-specific unique data (Square refund ID or `refund.id`) in the idempotency key.

#### LA-6: `processOrderRefundsForLoyalty` uses dead-code `refund.tender_id` loop

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/webhook-processing-service.js:368`
**Issue**: `for (const tender of refund.tender_id ? [{ tender_id: refund.tender_id }] : [])` — this creates an array with a single dummy object if `tender_id` exists, or an empty array if not. This means if `refund.tender_id` is falsy (which it often is for Square refund objects), the inner loop NEVER executes and no refund line items are processed.
**Impact**: Refund processing is additionally gatekept by a property that may not exist on the refund object, making the already-broken refund path (LA-3) even more unreliable.
**Fix**: Remove the tender_id loop entirely — iterate `refund.return_line_items` directly (after fixing LA-3).

#### LA-7: Redemption detection Strategy 3 (discount amount) can false-positive on non-loyalty discounts

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/reward-service.js:393-449`
**Issue**: `matchEarnedRewardByDiscountAmount()` sums `total_discount_money` across ALL qualifying line items regardless of discount source. If a merchant runs a 30% off sale on a qualifying item and the sale discount happens to be >= 95% of the expected reward value, Strategy 3 will incorrectly mark the reward as redeemed. There is no check that the discount came from our loyalty system.
**Impact**: Earned rewards could be auto-redeemed by non-loyalty discounts, consuming the customer's reward without them receiving the intended free item.
**Fix**: Either: (a) cross-reference `applied_discounts[].discount_uid` against our known discount IDs before counting, or (b) only sum discounts that match our `catalog_object_id`.

#### LA-8: Customer note update has TOCTOU race on `version` field

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/square-discount-service.js:396-528`
**Issue**: `updateCustomerRewardNote()` does GET customer → read `version` → PUT with `version`. If any other process updates the customer between GET and PUT (e.g., a concurrent reward for another offer, customer profile update from Square), the PUT fails with a version mismatch (409). There is no retry logic.
**Impact**: Customer note doesn't get the reward notification line. The reward is still valid in our system and POS, but the clerk won't see the note at checkout.
**Fix**: Add retry-on-409 loop (max 3 attempts with fresh GET each time).

#### ~~LA-9: Backfill-orchestration creates a hybrid camelCase/snake_case order object~~ RESOLVED (2026-03-07)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/backfill-orchestration-service.js`
**Issue**: Lines 202-216 built an `orderForLoyalty` object with BOTH `customer_id` and `customerId`, BOTH `line_items` and `lineItems`.
**Fix**: Removed as part of LA-1 fix. Raw Square order is now passed directly to `processLoyaltyOrder()`. Test confirms no camelCase `lineItems` property is present on the passed order.

#### ~~LA-10: `processExpiredEarnedRewards` unlocks purchase events without merchant_id filter~~ **RESOLVED** (2026-03-07)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/expiration-service.js:142-146`
**Issue**: `UPDATE loyalty_purchase_events SET reward_id = NULL WHERE reward_id = $1` — no `AND merchant_id = $2` filter. If reward IDs are sequential integers across merchants (they are — it's a serial primary key), this could theoretically unlock purchase events from a different merchant in a shared-ID scenario. Currently single-tenant so no practical risk, but violates the CLAUDE.md rule "EVERY query must filter by `merchant_id`".
**Impact**: Multi-tenant isolation violation. Theoretical data leak between tenants.
**Fix**: Added `AND merchant_id = $2` to the UPDATE WHERE clause. Also added `AND pe.merchant_id = $1` to the NOT EXISTS subquery in the expired rewards SELECT. 8 tests in `expiration-service.test.js`.

#### LA-11: `processRefund` uses its own window_end_date instead of looking up the original purchase's window

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/purchase-service.js:274-277`
**Issue**: When processing a refund, `windowEndDate` is calculated from `refundDate + offer.window_months`. But the refund should use the window dates from the ORIGINAL purchase event it's offsetting, not calculate new ones. A refund 11 months after purchase with a 12-month window will get window dates that extend 12 months past the refund, not the original purchase's window.
**Impact**: Refund events get incorrect window dates. The `updateRewardProgress` SUM query filters by `window_end_date >= CURRENT_DATE`, so a refund with an artificially extended window will keep being counted long after the original purchase has expired. The net effect is that refunds "persist" longer than the purchases they offset.
**Fix**: Look up the original purchase event's `window_start_date` and `window_end_date` and use those.

### P2 — Medium (Robustness / Test Gaps)

#### LA-12: No test coverage for Square order `returns[]` (the actual refund shape)

**Severity**: P2 | **Effort**: M
**Files**: `__tests__/services/loyalty-admin/` (all test files)
**Issue**: No test file creates a mock Square order with `order.returns[].return_line_items[]` — the actual Square API shape for line-item refunds. Tests for `processOrderRefundsForLoyalty` use `order.refunds[].return_line_items[]` which matches the code but not reality (see LA-3).
**Impact**: Tests pass but don't catch that the refund path is completely broken.
**Fix**: Add tests using real Square order shapes with `returns[]`.

#### LA-13: No pagination guard on Square API loops in backfill/catchup

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/backfill-service.js:180-223`, `services/loyalty-admin/backfill-orchestration-service.js:95-237`, `services/loyalty-admin/order-history-audit-service.js:154-197`
**Issue**: All three files have `do { ... cursor = data.cursor; } while (cursor)` loops with no MAX_ITERATIONS guard. A Square API bug or circular cursor could cause an infinite loop, each iteration making an API call.
**Impact**: Could exhaust Square API rate limits or cause process hang.
**Fix**: Add `MAX_PAGES = 100` constant and break with a warning log if exceeded.

#### LA-14: `processExpiredWindowEntries` commits per-row but rolls back ALL rows on error

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/expiration-service.js:43-80`
**Issue**: The function iterates `expiredResult.rows` and calls `BEGIN`/`COMMIT` per row inside a single client connection. But the catch block calls `ROLLBACK` on the shared client — if row N fails, rows 1..(N-1) are already committed and cannot be rolled back. The ROLLBACK only affects the current failed transaction.
**Impact**: Partial processing is silently committed. Not a bug per se (each row's COMMIT is correct), but the error handler is misleading — it appears to roll back everything but actually only rolls back the current row.
**Fix**: Either use `db.transaction()` helper per row, or change the catch block to only log (the individual COMMITs already handle success).

#### LA-15: `webhook-processing-service.js` duplicates line-item evaluation logic from `order-intake.js`

**Severity**: P2 | **Effort**: M
**Files**: `services/loyalty-admin/webhook-processing-service.js:118-317`, `services/loyalty-admin/order-intake.js:99-414`
**Issue**: `processOrderForLoyalty()` in `webhook-processing-service.js` contains ~200 lines of line-item evaluation, discount detection, and free-item skipping logic that is duplicated (with slight differences) in `order-intake.js`. The two implementations can drift — for example, `order-intake.js` aggregates by variationId (the fix), but `webhook-processing-service.js` does not.
**Impact**: Bug fixes applied to one path don't automatically apply to the other. The quantity bug (LA-1/LA-2) is an example of this drift.
**Fix**: After LA-1 and LA-2 are fixed (all callers use `processLoyaltyOrder`), `processOrderForLoyalty` in `webhook-processing-service.js` becomes dead code. Remove it and update exports.

#### LA-16: Manual entry bypasses line-item aggregation — double-counting possible

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/manual-entry-service.js:41`
**Issue**: `processManualEntry()` calls `processQualifyingPurchase()` directly (not through `processLoyaltyOrder`). If an admin manually enters the same order+variation twice, the idempotency key (`orderId:variationId`) will catch it. However, manual entries set `unitPriceCents: 0`, so the `totalPriceCents` will be 0 in the DB. This means manual entries contribute to reward progress but show $0 in purchase history, and the discount cap calculation (`MAX(unit_price_cents)`) will ignore them.
**Impact**: Discount cap correctly ignores $0 entries, but customer-facing audit trails show $0 purchases. If the only qualifying purchases are manual, the reward discount cannot be created (LA-4's $0 guard triggers).
**Fix**: Accept `unitPriceCents` as optional param in manual entry, or look up catalog price.

#### LA-17: `buildDiscountMap` in `order-intake.js` silently swallows DB errors

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/order-intake.js:289-303`
**Issue**: The try/catch around the loyalty discount IDs query (lines 289-303) catches DB errors and logs at WARN, then continues with an empty `ourLoyaltyDiscountIds` set. This means if the DB query fails, ALL items (including loyalty redemption items) will be counted toward reward progress.
**Impact**: During a DB blip, a redemption order could double-count items — the free item that was the reward gets counted as a new qualifying purchase.
**Fix**: Either re-throw the error (fail the order processing), or at minimum check `orderUsedOurDiscount` before processing items.

#### LA-18: Loyalty catchup uses raw `fetch()` instead of Square SDK

**Severity**: P2 | **Effort**: M
**Files**: `services/loyalty-admin/backfill-service.js:198-206`, `services/loyalty-admin/backfill-orchestration-service.js:118-126`, `services/loyalty-admin/order-history-audit-service.js:172-180`, `services/loyalty-admin/order-processing-service.js:46-52`, `services/loyalty-admin/redemption-audit-service.js:28-35`
**Issue**: Five files use raw `fetchWithTimeout()` for Square API calls instead of the Square SDK or `SquareApiClient`. This means they don't get automatic 429 rate-limit retry, don't use the same API version header as the SDK, and maintain their own token decryption.
**Impact**: Rate-limit errors during backfill cause the entire operation to fail instead of retrying. Inconsistent API version headers across the codebase.
**Fix**: Migrate to `SquareApiClient` (already available in `square-api-client.js`).

#### LA-19: `loyalty_purchase_events` has no index on `(merchant_id, offer_id, square_customer_id, window_end_date)`

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/reward-progress-service.js:35-47` (query), `database/schema.sql`
**Issue**: The `updateRewardProgress()` function runs this query pattern on every purchase: `SELECT SUM(quantity) FROM loyalty_purchase_events WHERE merchant_id=$1 AND offer_id=$2 AND square_customer_id=$3 AND window_end_date >= CURRENT_DATE AND reward_id IS NULL`. This is a 5-column filter with no composite index. As the table grows, this becomes increasingly slow.
**Impact**: Increasing latency on every webhook-triggered purchase. Currently manageable at JTPets volume (~500 events), but will be a problem at scale.
**Fix**: `CREATE INDEX idx_lpe_reward_progress ON loyalty_purchase_events (merchant_id, offer_id, square_customer_id, window_end_date) WHERE reward_id IS NULL;`

#### LA-20: Redemption detection runs twice on the order webhook path

**Severity**: P2 | **Effort**: S
**Files**: `services/webhook-handlers/order-handler/order-loyalty.js:235`, `services/webhook-handlers/order-handler/order-loyalty.js:289`
**Issue**: `processLoyalty()` calls `checkOrderForRedemption()` at line 235 (for pre-check logging), then calls `detectRewardRedemptionFromOrder()` at line 289 (to actually redeem). Both functions run the same 3-strategy detection logic against the same order. This means:
1. Two DB queries per discount to check `loyalty_rewards` (Strategy 1)
2. Two full `matchEarnedRewardByFreeItem` scans (Strategy 2)
3. Two full `matchEarnedRewardByDiscountAmount` scans (Strategy 3)
**Impact**: Doubled DB load and Square API latency on every order with discounts.
**Fix**: Remove `checkOrderForRedemption()` pre-check or have it set a flag that `detectRewardRedemptionFromOrder()` can reuse.

#### LA-21: No test coverage for multi-threshold reward rollover with split-row edge cases

**Severity**: P2 | **Effort**: M
**Files**: `__tests__/services/loyalty-admin/purchase-split-row.test.js`
**Issue**: The split-row test covers basic split scenarios, but doesn't test:
1. A purchase of 30 units toward a "buy 12" offer (should earn 2 rewards with 6 rollover)
2. A split row where `excessQty` is 0 (exact match — no excess child created)
3. A refund that spans across a split boundary
4. Concurrent split-row operations on the same customer
**Impact**: Multi-threshold rollover logic is complex and under-tested.

#### LA-22: `isOrderAlreadyProcessed` in `order-intake.js` checks different tables than `isOrderAlreadyProcessedForLoyalty` in `backfill-service.js`

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/order-intake.js:256-268`, `services/loyalty-admin/backfill-service.js:44-51`
**Issue**: `order-intake.js` checks BOTH `loyalty_processed_orders` AND `loyalty_purchase_events`. `backfill-service.js` checks ONLY `loyalty_purchase_events`. An order that was processed but had zero qualifying items would be in `loyalty_processed_orders` (with `result_type='non_qualifying'`) but NOT in `loyalty_purchase_events`. The backfill would re-process it.
**Impact**: Backfill re-processes non-qualifying orders on every run, wasting API calls (fetching order from Square) and DB queries.
**Fix**: Backfill's `isOrderAlreadyProcessedForLoyalty` should also check `loyalty_processed_orders`.

#### LA-23: Currency hardcoded to CAD in loyalty discount creation

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/square-discount-catalog-service.js` (already noted in TECHNICAL_DEBT.md)
**Note**: Already logged above. Including here for completeness of the loyalty audit.

#### LA-24: `updateCustomerSummary` called after reward revocation in `processRefund` but NOT in `processExpiredEarnedRewards`

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/expiration-service.js:94-189`
**Issue**: When `processExpiredEarnedRewards` revokes a reward due to expiration, it cleans up Square objects and logs audit events, but never calls `updateCustomerSummary()`. The customer's denormalized summary (total rewards, active status) becomes stale.
**Impact**: Customer summary shows stale reward count after expiration. Admin dashboard may show incorrect loyalty status.
**Fix**: Add `updateCustomerSummary(client, merchantId, reward.square_customer_id, reward.offer_id)` after revocation.

#### ~~LA-25: Vendor lookup in `offer-admin-service.js` lacks merchant_id filter (tenant isolation)~~ **RESOLVED** (2026-03-07)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/offer-admin-service.js:57`, `services/loyalty-admin/offer-admin-service.js:181`
**Issue**: `createOffer()` and `updateOffer()` both query `SELECT name, contact_email FROM vendors WHERE id = $1` without `AND merchant_id = $2`. The `vendors` table has a `merchant_id` column. A merchant could reference a vendor belonging to a different merchant by guessing/supplying a vendor ID. Violates the CLAUDE.md rule "EVERY query must filter by `merchant_id`".
**Impact**: Multi-tenant isolation violation. Merchant A could attach Merchant B's vendor to their loyalty offer.
**Fix**: Added `AND merchant_id = $2` to both vendor lookup queries in `createOffer()` and `updateOffer()`. 10 tests in `offer-admin-service.test.js`.

#### LA-26: `searchLoyaltyEvents` and `searchCustomers` in `SquareApiClient` silently truncate to first page

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/square-api-client.js:188-205`
**Issue**: Both methods return `data.events || []` / `data.customers || []` without handling Square's pagination cursor. If results exceed the page limit (typically 50), only the first page is returned. Callers (audit, backfill, prefetch) receive incomplete data with no signal that results were truncated.
**Impact**: Audit and backfill operations may miss loyalty events or customers if a merchant has >50 results. The `prefetchRecentLoyaltyEvents` service handles its own pagination via raw `fetch()`, but any caller using `SquareApiClient.searchLoyaltyEvents()` gets truncated results.
**Fix**: Add paginated variants or return `{ results, cursor, hasMore }` so callers can decide to paginate.

#### LA-27: Loyalty event prefetch returns partial data silently on API failures

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/loyalty-event-prefetch-service.js:118-149`
**Issue**: The loyalty account fetch loop catches errors per account and continues. If 50% of account fetches fail (network blip, rate limit), the function returns with half the `loyaltyAccounts` map missing. Callers (`backfill-orchestration-service.js`) use this map for customer identification fallback with no awareness that data is incomplete.
**Impact**: During API instability, backfill silently skips customer identification for failed accounts, resulting in fewer orders being processed for loyalty.
**Fix**: Return `{ events, loyaltyAccounts, failedAccountIds }` so callers can log or retry.

### Summary Table

| ID | Severity | Effort | Description |
|----|----------|--------|-------------|
| ~~LA-1~~ | ~~P0~~ | ~~S~~ | ~~Backfill-orchestration bypasses `processLoyaltyOrder()`~~ **RESOLVED** (2026-03-07) |
| ~~LA-2~~ | ~~P0~~ | ~~S~~ | ~~`processOrderManually()` bypasses `processLoyaltyOrder()`~~ **RESOLVED** (2026-03-07) |
| LA-3 | P0 | M | Refund processing uses wrong Square order shape (`refunds` vs `returns`) |
| LA-4 | P0 | M | Fire-and-forget Square discount creation — silent failure, no retry |
| LA-5 | P1 | S | Refund idempotency key collides on same-quantity partial refunds |
| LA-6 | P1 | S | Dead-code `tender_id` loop gates refund processing |
| LA-7 | P1 | S | Redemption Strategy 3 can false-positive on non-loyalty discounts |
| LA-8 | P1 | S | Customer note update has no retry on version conflict (409) |
| ~~LA-9~~ | ~~P1~~ | ~~S~~ | ~~Backfill-orchestration builds hybrid camelCase/snake_case order~~ **RESOLVED** (2026-03-07) |
| ~~LA-10~~ | ~~P1~~ | ~~S~~ | ~~`processExpiredEarnedRewards` unlocks events without merchant_id filter~~ **RESOLVED** (2026-03-07) |
| LA-11 | P1 | S | Refund uses fresh window dates instead of original purchase's window |
| LA-12 | P2 | M | No tests use real Square `order.returns[]` shape |
| LA-13 | P2 | S | No pagination guard on Square API loops |
| LA-14 | P2 | S | Expiration error handler misleadingly appears to roll back committed rows |
| LA-15 | P2 | M | Duplicated line-item evaluation logic between two processing paths |
| LA-16 | P2 | S | Manual entry sets $0 price — can't calculate discount cap |
| LA-17 | P2 | S | `buildDiscountMap` swallows DB errors — could double-count redemption items |
| LA-18 | P2 | M | Five files use raw `fetch()` instead of `SquareApiClient` — no rate-limit retry |
| LA-19 | P2 | S | Missing composite index on `loyalty_purchase_events` for reward progress query |
| LA-20 | P2 | S | Redemption detection runs twice per order webhook |
| LA-21 | P2 | M | Multi-threshold rollover with split-row edge cases untested |
| LA-22 | P2 | S | Two idempotency check functions check different tables |
| LA-23 | P2 | S | Currency hardcoded to CAD (duplicate of existing finding) |
| LA-24 | P2 | S | Missing `updateCustomerSummary` call after expiration revocation |
| ~~LA-25~~ | ~~P1~~ | ~~S~~ | ~~Vendor lookup in `offer-admin-service.js` lacks merchant_id filter~~ **RESOLVED** (2026-03-07) |
| LA-26 | P2 | S | `SquareApiClient` search methods silently truncate to first page |
| LA-27 | P2 | S | Loyalty event prefetch returns partial data silently on API failures |

**Audit scope**: 36 source files in `services/loyalty-admin/`, 24 test files in `__tests__/services/loyalty-admin/`, 10 route modules in `routes/loyalty/`, 2 webhook handlers in `services/webhook-handlers/`.
**Audit trigger**: Quantity-aggregation bug (multiple line items with same `catalog_object_id`) survived code review because tests used simplified order shapes.

---

## Grading History

| Date | Grade | Notes |
|------|-------|-------|
| 2026-03-04 | A+ | All P0-P2 complete. Test coverage and file size violations remain for A++ |
| 2026-02-19 | A+ | P0 7/7, P1 9/9, P2 6/6. API optimization 4/4 |
| 2026-01-26 | A | P0-5,6,7 fixed. P1-6,7,8,9 fixed. Master engineering review |

**Target A++ requirements**: Comprehensive test coverage (currently 28%), file size compliance (66 unapproved violations), zero known security issues.
