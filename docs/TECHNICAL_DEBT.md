# Technical Debt — Known Issues

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Roadmap](./ROADMAP.md) | [Architecture](./ARCHITECTURE.md)

**Last Updated**: 2026-03-08
**Consolidated from**: AUDIT-2026-02-28, CODEBASE_AUDIT_2026-02-25, API-SPLIT-PLAN, MULTI-TENANT-AUDIT, SQUARE-API-AUDIT-2026-03-07, MULTI-TENANT-GAPS-2026-03-08

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

### ~~BUG: `order.refunds` guard prevents loyalty return processing~~ RESOLVED

**Files**: `services/webhook-handlers/order-handler/index.js:514`, `services/webhook-handlers/order-handler/order-loyalty.js:304`
**Issue**: Both files guard `processOrderRefundsForLoyalty()` with `if (order.refunds && order.refunds.length > 0)`. However, `processOrderRefundsForLoyalty()` (in `services/loyalty-admin/webhook-processing-service.js:348`) processes `order.returns` (line-item returns), NOT `order.refunds` (payment refunds). These are different Square API concepts: `order.refunds` = monetary refunds on tenders, `order.returns` = line items returned to inventory. When a customer returns items without a monetary refund (exchange, store credit), the guard fails and loyalty point adjustments never happen.
**Fix**: Changed both guards to check `order.returns?.length > 0` instead of `order.refunds`. Added tests: order with returns but no refunds triggers loyalty processing; order with refunds but no returns does not. Downstream `processOrderRefundsForLoyalty()` already correctly uses `order.returns` (LA-3 fix).
**Source**: Square API audit (2026-03-07), resolved 2026-03-08

### ~~RISK: `vendor_information` field name may be wrong in catalog sync~~ FALSE POSITIVE

**Files**: `services/square/square-catalog-sync.js:977`, `services/square/square-pricing.js:247,292`
**Issue**: Reads vendor data from `item_variation_data.vendor_information`. The Square REST API documentation lists the field as `item_variation_vendor_infos` on `CatalogItemVariation`, not `vendor_information`.
**Resolution**: **FALSE POSITIVE** — verified 2026-03-07 by live Square API call. The field `vendor_information` exists on `item_variation_data` alongside `item_variation_vendor_infos`. Vendor data is not at risk.
**Source**: Square API audit (2026-03-07)

### Velocity return revenue uses wrong nested property (harmless due to fallback)

**File**: `services/square/square-velocity.js:140-141,474-475`
**Issue**: `returnItem.return_amounts?.total_money?.amount` — `return_amounts` is a property of `OrderReturn` (the parent object), not `OrderReturnLineItem`. The property is always undefined on the return line item, falling through to the correct fallback `returnItem.total_money?.amount`. Functionally correct but shows confusion about the Square data shape.
**Impact**: None — fallback is correct. Risk if someone removes the "unnecessary" fallback.
**Source**: Square API audit (2026-03-07)

### Velocity return location ternary is a no-op

**File**: `services/square/square-velocity.js:131-132`
**Issue**: `const locationId = returnItem.source_line_item_uid ? order.location_id : order.location_id;` — both branches return the same value. The ternary is dead code.
**Impact**: None — functionally correct, just confusing.
**Source**: Square API audit (2026-03-07)

### `loyalty-reports.js` vendor JOIN missing `merchant_id` filter

**File**: `services/reports/loyalty-reports.js:188,539`
**Issue**: `LEFT JOIN variation_vendors vv ON pe.variation_id = vv.variation_id` and `LEFT JOIN variation_vendors vv ON v.id = vv.variation_id` — both JOINs omit `AND vv.merchant_id = $N`. Violates the multi-tenant pattern. No data leakage in practice (Square variation IDs are globally unique), but inconsistent with the codebase's security model.
**Impact**: Low — theoretical multi-tenant violation only.
**Source**: Square API audit (2026-03-07)

### `loyalty-reports.js` uses `parseInt()` on SDK BigInt money amounts

**File**: `services/reports/loyalty-reports.js:251,258,261,549,606`
**Issue**: Fetches orders via `squareClient.orders.get()` (SDK), which returns `Money.amount` as BigInt in SDK v43+. Uses `parseInt(amount)` which works via implicit BigInt→String→Number conversion, but is not the standard pattern. Should use `Number()` for clarity and safety.
**Impact**: Low — works correctly but fragile. Would break if BigInt string representation changes.
**Source**: Square API audit (2026-03-07)

### `discount-service.js` `updateDiscountAppliesTo` is effectively a no-op

**File**: `services/expiry/discount-service.js:660-738`
**Issue**: The `updateDiscountAppliesTo` function accepts `variationIds` but never includes them in the Square API request body (lines 699-710). The request only re-sends the existing `discount_data` unchanged. The actual work of applying discounts to specific items is done by `upsertPricingRule`, not this function. The function name and JSDoc are misleading.
**Impact**: Low — function is not called from critical paths (callers use `upsertPricingRule` directly).
**Source**: Square API audit (2026-03-07)

### `discount-service.js` `filterValidVariations` silently assumes all valid on error

**File**: `services/expiry/discount-service.js:967-974`
**Issue**: When the Square batch-retrieve API call fails, the catch block includes ALL variations as valid to "avoid data loss". This means API failures (rate limiting, network errors) cause deleted/invalid variations to be included in pricing rules, potentially applying discounts to non-existent catalog items.
**Impact**: Low — Square will reject pricing rules referencing non-existent objects, but errors won't surface until the pricing rule upsert.
**Source**: Square API audit (2026-03-07)

### ~~BUG: `discount-service.js` missing `merchant_id` filter on 3 UPDATE queries~~ RESOLVED (2026-03-08)

**File**: `services/expiry/discount-service.js:367-371,820-825,886-892`
**Issue**: Three UPDATE statements on `variation_discount_status` filter only by `variation_id` without `AND merchant_id = $N`: (1) line 370 in `evaluateAllVariations` updating `days_until_expiry`, (2) line 824 in `applyDiscounts` setting `discounted_price_cents`, (3) line 891 removing discount. Violates the multi-tenant pattern — same class as LA-10.
**Fix**: Added `AND merchant_id = $N` to all three UPDATE queries. 3 tests in `falsy-zero-bugs.test.js`.

### ~~BUG: `discount-service.js` `daysUntilExpiry || null` converts 0 to null~~ RESOLVED (2026-03-08)

**File**: `services/expiry/discount-service.js:430`
**Issue**: `event.daysUntilExpiry || null` — the `||` operator treats `0` as falsy. When an item expires today (`daysUntilExpiry = 0`), the value is stored as NULL in the `expiry_discount_audit_log`. This loses the distinction between "expires today" and "no expiry date set".
**Fix**: Changed `daysUntilExpiry || null`, `oldPriceCents || null`, and `newPriceCents || null` to use `??` (nullish coalescing). 3 tests in `falsy-zero-bugs.test.js`.

### ~~BUG: `logAuthEvent` inserts auth_audit_log without merchant_id~~ RESOLVED (2026-03-08)

**File**: `middleware/auth.js:99-108`, `routes/auth.js` (14 call sites), `routes/square-oauth.js` (2 call sites)
**Issue**: `logAuthEvent()` INSERT omitted `merchant_id`, producing NULL rows. Migration 065 added NOT NULL constraint on `auth_audit_log.merchant_id`, so all future inserts would throw.
**Fix**: Added `merchantId` to `logAuthEvent` params and SQL. When not provided, auto-resolves from `user_merchants` using `userId`. Skips INSERT (with logger warning) when no merchant resolvable (e.g., login_failed for non-existent user). Updated all 16 call sites in `routes/auth.js` and `routes/square-oauth.js` to pass `merchantId` where available. 3 tests in `audit-fixes.test.js`.

### PROBABLE BUG: `loyalty-reports.js` silently omits redemption order section on fetch failure

**File**: `services/reports/loyalty-reports.js:633-639`
**Issue**: When the Square API call to fetch the redemption order fails, the catch block logs at `debug` level and continues. The vendor receipt is generated without the "REDEMPTION ORDER" section — the entire record of what free item was given is missing. The receipt appears complete to the user/vendor but is silently missing the most important part.
**Impact**: Medium — vendor receives a receipt that looks complete but omits the free item details. No indication of failure. A vendor reviewing costs would not know data is missing.
**Priority**: Medium — should show error placeholder or warning when redemption order fetch fails.
**Source**: Square API audit (2026-03-07)

### `loyalty-reports.js` CSV export references unselected columns

**File**: `services/reports/loyalty-reports.js:1045,1053`
**Issue**: `generateRedemptionsCSV` accesses `r.redemption_type` (line 1045, defaults to `'STANDARD'`) and `r.admin_notes` (line 1053, defaults to `''`), but the SQL query `getRedemptionsForExport` (lines 300-363) does not SELECT either column. Both are always undefined, producing hardcoded defaults in every CSV row.
**Impact**: Low — CSV always shows "STANDARD" for type and empty for notes regardless of actual data. Data silently missing from exports.
**Source**: Square API audit (2026-03-07)

### RISK: Delta sync does not mark child variations as deleted

**File**: `services/square/square-catalog-sync.js:612-629`
**Issue**: When delta sync marks an item as deleted (line 615), it zeros inventory for all variations (lines 618-623) but does NOT set `is_deleted = TRUE` on the variation rows. Full sync handles variation deletion separately (lines 301-321), but delta sync assumes Square will emit individual variation deletion events. If Square only emits the parent item deletion, orphaned variation records remain with `is_deleted = FALSE` and will appear in queries filtering on that flag.
**Impact**: Medium — orphaned variation records could appear in reorder suggestions, expiry evaluations, and other queries that join on `variations.is_deleted = FALSE`.
**Priority**: Medium — data integrity risk during delta sync.
**Source**: Square API audit (2026-03-07)

### ~~`square-catalog-sync.js` `price_money.amount` of 0 becomes null~~ RESOLVED (2026-03-08)

**File**: `services/square/square-catalog-sync.js:929`
**Issue**: `data.price_money?.amount || null` — the `||` operator treats `0` as falsy. Free items (`amount = 0`) are stored with `price_cents = NULL` instead of `0`, misrepresenting them as having no price set.
**Fix**: Changed to `??` (nullish coalescing). Also fixed `unit_cost_money?.amount` on the same pattern. Tests in `falsy-zero-bugs.test.js`.

### ~~`square-catalog-sync.js` `inventory_alert_threshold` of 0 becomes null~~ RESOLVED (2026-03-08)

**File**: `services/square/square-catalog-sync.js:871,878,888-889,963`
**Issue**: Same `||` vs `??` pattern. If `inventory_alert_threshold` is `0` (meaning "alert when at zero stock"), it gets stored as `null`. Multiple locations in the variation sync use this pattern.
**Fix**: Changed all `inventory_alert_threshold || null` to `?? null` (both variation-level and location override). Tests in `falsy-zero-bugs.test.js`.

### ~~`discount-service.js` `timezone` parameter accepted but unused~~ (RESOLVED 2026-03-08)

**File**: `services/expiry/discount-service.js:97-110`
**Issue**: `calculateDaysUntilExpiry(expirationDate, timezone)` accepted a `timezone` parameter but used plain `new Date()`, ignoring it.
**Fix**: Rewrote to use `toLocaleDateString('en-CA', { timeZone })` for both expiry and now dates, producing timezone-correct YYYY-MM-DD strings before diffing. Tests in `audit-fixes.test.js`.

### ~~`discount-service.js` inventory_counts subquery missing `merchant_id` filter~~ (RESOLVED 2026-03-08)

**File**: `services/expiry/discount-service.js:1301-1306`
**Issue**: The inventory_counts subquery in `getDiscountStatusSummary` grouped across all merchants.
**Fix**: Added `AND merchant_id = $1` to the subquery. Tests in `audit-fixes.test.js`.

### `discount-service.js` EXPIRED in `clearExpiryDiscountForReorder` array is dead code

**File**: `services/expiry/discount-service.js:1816`
**Issue**: The check `!status.is_auto_apply || !['AUTO50', 'AUTO25', 'EXPIRED'].includes(status.tier_code)` includes `'EXPIRED'` in the array, but the EXPIRED tier has `is_auto_apply = false` by design. The `!status.is_auto_apply` guard short-circuits before the array check is reached, making `'EXPIRED'` unreachable in the array.
**Impact**: None — dead code only. Could mislead maintainers into thinking EXPIRED is auto-applied.
**Source**: Square API audit (2026-03-07)

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
| ~~P-4~~ | ~~`services/square/` (7 locations)~~ | ~~Square API pagination loops have no `MAX_ITERATIONS` guard~~ **RESOLVED** — all loops now have `MAX_PAGINATION_ITERATIONS` guard |
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

#### ~~LA-3: Refund processing does not handle `order.returns` (Square's actual refund shape)~~ RESOLVED (2026-03-07)

**Severity**: P0 | **Effort**: M
**Files**: `services/loyalty-admin/webhook-processing-service.js`
**Fix**: Rewrote `processOrderRefundsForLoyalty()` to iterate `order.returns[].return_line_items[]` (Square's actual shape). Removed `order.refunds[]` path entirely. Also removed dead-code `tender_id` loop (LA-6) and `refund.status` check (returns don't have status). Each `returnItem.uid` is passed as `returnLineItemUid` to `processRefund()` for unique idempotency (LA-5). 13 new tests in `webhook-refund-processing.test.js`.

#### ~~LA-4: Fire-and-forget `createSquareCustomerGroupDiscount()` can silently fail, leaving reward unsynced~~ RESOLVED (2026-03-08)

**Severity**: P0 | **Effort**: M
**Files**: `services/loyalty-admin/reward-progress-service.js`, `services/loyalty-admin/square-sync-retry-service.js`, `jobs/loyalty-sync-retry-job.js`
**Fix**: Added `square_sync_pending` boolean column to `loyalty_rewards` (migration 064). When `createSquareCustomerGroupDiscount()` fails (returns `success: false` or throws), the reward is flagged `square_sync_pending = TRUE` and logged at ERROR. A new cron job (`loyalty-sync-retry-job.js`, every 15 min) finds all pending rewards and retries discount creation. On success, the flag is cleared. The existing `syncRewardsToPOS` endpoint also flushes pending syncs before its normal bulk sync. 12 tests in `square-sync-retry.test.js`.

### P1 — High (Incorrect Behavior / Edge Cases)

#### ~~LA-5: `processRefund` idempotency key includes raw quantity — partial refunds can collide~~ RESOLVED (2026-03-07)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/purchase-service.js`
**Fix**: Idempotency key now uses `returnLineItemUid` (the return line item's `uid` from Square) when available: `refund:${orderId}:${variationId}:${returnLineItemUid}`. Falls back to quantity-based key for legacy callers. Two partial refunds of the same quantity now get distinct keys. 2 new tests in `purchase-service.test.js`.

#### ~~LA-6: `processOrderRefundsForLoyalty` uses dead-code `refund.tender_id` loop~~ RESOLVED (2026-03-07)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/webhook-processing-service.js`
**Fix**: Removed as part of LA-3 fix. The entire `order.refunds[]` iteration was replaced with `order.returns[]`. The `tender_id` loop and `refund.status` check are gone — returns are iterated directly.

#### ~~LA-7: Redemption detection Strategy 3 (discount amount) can false-positive on non-loyalty discounts~~ (RESOLVED 2026-03-08)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/reward-service.js`
**Issue**: `matchEarnedRewardByDiscountAmount()` summed `total_discount_money` across ALL qualifying line items regardless of discount source.
**Fix**: Added guard that verifies at least one order-level discount's `catalog_object_id` matches the reward's `square_discount_id` or `square_pricing_rule_id` before proceeding with amount matching. Non-loyalty discounts are now skipped. Tests in `audit-fixes.test.js`.

#### ~~LA-8: Customer note update has TOCTOU race on `version` field~~ (RESOLVED 2026-03-08)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/square-discount-service.js`
**Issue**: `updateCustomerRewardNote()` had no retry on 409 version conflict during GET-modify-PUT.
**Fix**: Wrapped entire GET-modify-PUT cycle in retry loop (max 2 retries). On 409, logs warning and re-fetches fresh customer version before retrying. Tests in `audit-fixes.test.js`.

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

#### ~~LA-11: `processRefund` uses its own window_end_date instead of looking up the original purchase's window~~ RESOLVED (2026-03-07)

**Severity**: P1 | **Effort**: S
**Files**: `services/loyalty-admin/purchase-service.js`
**Fix**: `processRefund()` now looks up the original `loyalty_purchase_events` row for this order+variation (matching by `square_order_id`, `variation_id`, `is_refund = FALSE`) and uses its `window_start_date` and `window_end_date`. Falls back to refund-date-based calculation with a `logger.warn()` if no original purchase is found. 2 new tests in `purchase-service.test.js`.

### P2 — Medium (Robustness / Test Gaps)

#### ~~LA-12: No test coverage for Square order `returns[]` (the actual refund shape)~~ RESOLVED (2026-03-07)

**Severity**: P2 | **Effort**: M
**Files**: `__tests__/services/loyalty-admin/webhook-refund-processing.test.js`
**Fix**: Added 13 tests using real Square `order.returns[].return_line_items[]` shape. Tests explicitly verify that `order.refunds[]` is NOT processed (regression test).

#### ~~LA-13: No pagination guard on Square API loops in backfill/catchup~~ (RESOLVED 2026-03-08)

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/backfill-service.js`, `services/loyalty-admin/order-history-audit-service.js`
**Issue**: Pagination loops had no MAX_ITERATIONS guard. Circular cursors could infinite-loop.
**Fix**: Added `MAX_PAGINATION_ITERATIONS` guard (from `config/constants.js`, value 500) to both files. Logs warning and breaks on exceeded. Tests in `audit-fixes.test.js`.

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

#### ~~LA-28: `discount-validation-service.js` `syncRewardDiscountPrices` returns `success: true` even when updates fail~~ RESOLVED (2026-03-07)

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/discount-validation-service.js:217`
**Fix**: Changed `return { success: true, ...results }` to `return { success: results.failed === 0, ...results }`. Function now correctly reports failure when discount price sync operations fail.

#### ~~LA-29: `backfill-orchestration-service.js` returns error object instead of throwing for no-locations~~ RESOLVED (2026-03-07)

**Severity**: P2 | **Effort**: S
**Files**: `services/loyalty-admin/backfill-orchestration-service.js:46-48`
**Fix**: Changed `return { error: 'No active locations found', processed: 0 }` to `throw new Error('No active locations found')` with `statusCode = 400`, consistent with the access token check on line 57-61.

### Summary Table

| ID | Severity | Effort | Description |
|----|----------|--------|-------------|
| ~~LA-1~~ | ~~P0~~ | ~~S~~ | ~~Backfill-orchestration bypasses `processLoyaltyOrder()`~~ **RESOLVED** (2026-03-07) |
| ~~LA-2~~ | ~~P0~~ | ~~S~~ | ~~`processOrderManually()` bypasses `processLoyaltyOrder()`~~ **RESOLVED** (2026-03-07) |
| ~~LA-3~~ | ~~P0~~ | ~~M~~ | ~~Refund processing uses wrong Square order shape (`refunds` vs `returns`)~~ **RESOLVED** (2026-03-07) |
| ~~LA-4~~ | ~~P0~~ | ~~M~~ | ~~Fire-and-forget Square discount creation — silent failure, no retry~~ **RESOLVED** (2026-03-08) |
| ~~LA-5~~ | ~~P1~~ | ~~S~~ | ~~Refund idempotency key collides on same-quantity partial refunds~~ **RESOLVED** (2026-03-07) |
| ~~LA-6~~ | ~~P1~~ | ~~S~~ | ~~Dead-code `tender_id` loop gates refund processing~~ **RESOLVED** (2026-03-07) |
| ~~LA-7~~ | ~~P1~~ | ~~S~~ | ~~Redemption Strategy 3 can false-positive on non-loyalty discounts~~ **RESOLVED** (2026-03-08) |
| ~~LA-8~~ | ~~P1~~ | ~~S~~ | ~~Customer note update has no retry on version conflict (409)~~ **RESOLVED** (2026-03-08) |
| ~~LA-9~~ | ~~P1~~ | ~~S~~ | ~~Backfill-orchestration builds hybrid camelCase/snake_case order~~ **RESOLVED** (2026-03-07) |
| ~~LA-10~~ | ~~P1~~ | ~~S~~ | ~~`processExpiredEarnedRewards` unlocks events without merchant_id filter~~ **RESOLVED** (2026-03-07) |
| ~~LA-11~~ | ~~P1~~ | ~~S~~ | ~~Refund uses fresh window dates instead of original purchase's window~~ **RESOLVED** (2026-03-07) |
| ~~LA-12~~ | ~~P2~~ | ~~M~~ | ~~No tests use real Square `order.returns[]` shape~~ **RESOLVED** (2026-03-07) |
| ~~LA-13~~ | ~~P2~~ | ~~S~~ | ~~No pagination guard on Square API loops~~ **RESOLVED** (2026-03-08) |
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
| ~~LA-28~~ | ~~P2~~ | ~~S~~ | ~~`syncRewardDiscountPrices` returns success:true even when updates fail~~ **RESOLVED** (2026-03-07) |
| ~~LA-29~~ | ~~P2~~ | ~~S~~ | ~~Backfill returns error object instead of throwing for no-locations~~ **RESOLVED** (2026-03-07) |

**Audit scope**: 36 source files in `services/loyalty-admin/`, 24 test files in `__tests__/services/loyalty-admin/`, 10 route modules in `routes/loyalty/`, 2 webhook handlers in `services/webhook-handlers/`.
**Audit trigger**: Quantity-aggregation bug (multiple line items with same `catalog_object_id`) survived code review because tests used simplified order shapes.

---

## Multi-Tenant Gaps

> **Audit date**: 2026-03-08
> **Scope**: Full codebase audit for single-tenant assumptions that will break in multi-tenant / franchise deployment.
> **Method**: Searched all `process.env.*` references (124 total), all cron jobs, all file I/O paths, all in-memory caches, and all external integration code.

### Summary

| Category | Findings | Blocks Franchise | Degrades | Cosmetic |
|----------|----------|-----------------|----------|----------|
| ENV credentials / config | 5 | 2 | 2 | 1 |
| File storage / debug logs | 2 | 0 | 2 | 0 |
| In-memory state | 1 | 0 | 1 | 0 |
| Email notifications | 1 | 1 | 0 | 0 |
| Business logic defaults | 2 | 0 | 1 | 1 |
| Cron / background jobs | 1 | 0 | 0 | 1 |
| Health check | 1 | 0 | 1 | 0 |
| **Total** | **13** | **3** | **7** | **3** |

### What's Already Correct

Before the findings, credit where it's due — the following are already properly multi-tenant:

- **Square OAuth tokens**: Per-merchant in `merchants.square_access_token` / `square_refresh_token` (encrypted AES-256-GCM), accessed via `getSquareClientForMerchant(merchantId)`.
- **Google OAuth tokens**: Per-merchant in `google_oauth_tokens` table with `merchant_id` FK, encrypted.
- **GMC account linking**: Per-merchant in `gmc_settings` and `gmc_location_settings` tables.
- **All database queries**: Consistently filter by `merchant_id` (verified across 24 route modules, ~257 routes).
- **All cron jobs**: Iterate all active merchants with per-merchant error isolation. None hardcode a single merchant.
- **All in-memory caches**: Keyed by `merchantId` or `orderId:merchantId` (verified: Square client cache, velocity dedup, loyalty dedup, sync queue, invoices scope cache).
- **POD photo storage**: Already namespaced by `${merchantId}/${orderId}/${fileId}` (`delivery-service.js:1030`).
- **Square OAuth app credentials** (`SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_OAUTH_REDIRECT_URI`): Correctly global — these are the SaaS platform's own Square app credentials, not per-merchant.
- **Google OAuth app credentials** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`): Correctly global — single Google Cloud project for the platform. Per-merchant tokens are stored in DB.
- **SaaS billing** (`SQUARE_ACCESS_TOKEN` in `utils/square-subscriptions.js`): Intentionally global — this is the platform's own Square account for subscription billing, separate from merchant accounts.

---

### MT-1: Webhook signature key is global (BLOCKS FRANCHISE)

**Severity**: Blocks franchise
**Files**: `services/webhook-processor.js:244`, `utils/square-webhooks.js:457-467`

**What it assumes**: A single `SQUARE_WEBHOOK_SIGNATURE_KEY` env var is used to verify all incoming Square webhooks. Square assigns a unique signature key per webhook subscription (i.e., per merchant).

**Current code**:
```javascript
// services/webhook-processor.js:244
const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();

// utils/square-webhooks.js:460
const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
```

**What breaks**: When merchant B onboards, their Square webhook subscription has a different signature key. Webhooks from merchant B will either fail signature validation (if using merchant A's key) or bypass verification entirely (if key is left unconfigured). Security risk: a single shared key means one merchant's key could be used to forge events for another.

**What it should do**: Store `square_webhook_signature_key` per-merchant in the `merchants` table (encrypted). During webhook processing, resolve the merchant from the event payload's `merchant_id` field first, then fetch that merchant's signature key for HMAC verification.

---

### MT-2: ~~Email notifications are global, single-recipient~~ (RESOLVED 2026-03-08)

**Resolution**: Added `admin_email` column to `merchants` table (migration 066). Populated from `business_email` where available. `email-notifier.js` updated: `sendCritical` reads `context.merchantId`, `sendAlert` accepts optional `options.merchantId`. Both resolve merchant `admin_email` via `_resolveRecipient()`, falling back to platform `EMAIL_TO` env var when null. Backup/system-level emails remain platform-only. 8 tests in `email-notifier.test.js`.

---

### MT-3: ~~OpenRouteService API key falls back to global~~ (RESOLVED 2026-03-08)

**Resolution**: Added `ors_api_key_encrypted` column to `delivery_settings` (migration 066). ORS keys are now stored encrypted with AES-256-GCM via existing `token-encryption` utils. `getSettings()` decrypts on read; `updateSettings()` encrypts before write. Encrypt-on-read migration transparently moves plaintext keys from `openrouteservice_api_key` to encrypted column. Global `OPENROUTESERVICE_API_KEY` env var retained as platform fallback for merchants without their own key. UI updated to note encryption. 6 tests in `delivery-ors-encryption.test.js`.

---

### MT-4: GMC debug files overwrite across merchants (DEGRADES)

**Severity**: Degrades
**Files**: `services/gmc/merchant-service.js:344`, `services/gmc/merchant-service.js:572`, `services/gmc/merchant-service.js:774`, `services/gmc/merchant-service.js:1024`

**What it assumes**: Debug log files are written to fixed paths (`output/gmc-product-sync-debug.log`, `output/gmc-local-inventory-debug.log`) with no merchant scoping.

**Current code**:
```javascript
// merchant-service.js:344
const debugFile = path.join(__dirname, '../../output/gmc-product-sync-debug.log');

// merchant-service.js:774
const debugFile = path.join(__dirname, '../../output/gmc-local-inventory-debug.log');
```

**What breaks**: When two merchants sync GMC products concurrently, one merchant's debug data overwrites the other's. Debug data contains product IDs and error details specific to each merchant.

**What it should do**: Include `merchantId` in the filename: `gmc-product-sync-debug-${merchantId}.log`. Or better, use the structured logger instead of debug files.

---

### MT-5: GMC feed TSV file is not merchant-scoped (DEGRADES)

**Severity**: Degrades
**Files**: `services/gmc/feed-service.js:291-310`

**What it assumes**: `saveTsvFile()` defaults to a single filename `gmc-feed.tsv` in `output/feeds/`. Callers must explicitly pass a merchant-scoped filename.

**Current code**:
```javascript
// feed-service.js:294
async function saveTsvFile(content, filename = 'gmc-feed.tsv') {
    const feedsDir = path.join(__dirname, '..', '..', 'output', 'feeds');
    const filePath = path.join(feedsDir, filename);
    await fs.writeFile(filePath, content, 'utf8');
}
```

**What breaks**: If any caller uses the default filename, merchant B's feed overwrites merchant A's. Feed contents include product data, pricing, and inventory levels.

**What it should do**: Require `merchantId` parameter and build the filename as `gmc-feed-${merchantId}.tsv`. Remove the default filename to prevent accidental cross-tenant overwrites.

---

### MT-6: Sync interval configuration is global, not per-merchant (DEGRADES)

**Severity**: Degrades
**Files**: `server.js:972-980`, `routes/sync.js:150-156`, `routes/sync.js:516-525`

**What it assumes**: Sync intervals (`SYNC_CATALOG_INTERVAL_HOURS`, `SYNC_INVENTORY_INTERVAL_HOURS`, etc.) are read from env vars and applied uniformly to all merchants.

**Current code**:
```javascript
// server.js:972-980
const intervals = {
    catalog: parseInt(process.env.SYNC_CATALOG_INTERVAL_HOURS || '3'),
    inventory: parseInt(process.env.SYNC_INVENTORY_INTERVAL_HOURS || '3'),
    // ... 5 more interval types
};
```

**What breaks**: Different merchants may need different sync frequencies based on their plan tier, catalog size, or Square API rate limits. A merchant with 50,000 SKUs syncing every 3 hours creates more load than one with 500 SKUs.

**What it should do**: Store per-merchant sync interval overrides in `merchants.settings` JSONB (the column already exists). Fall back to env defaults when no override is set. This also enables tiered sync frequencies for different subscription plans.

---

### MT-7: `DAILY_COUNT_TARGET` cycle count target is global (DEGRADES)

**Severity**: Degrades
**Files**: `routes/cycle-counts.js:41`, `services/inventory/cycle-count-service.js:32`

**What it assumes**: A single `DAILY_COUNT_TARGET` env var (default: 30) sets the daily cycle count target for all merchants.

**Current code**:
```javascript
// routes/cycle-counts.js:41
const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');

// cycle-count-service.js:32
const dailyTarget = parseInt(process.env.DAILY_COUNT_TARGET || '30');
```

**What breaks**: Merchants with vastly different catalog sizes need different targets. A store with 200 items wants to count 10/day; a warehouse with 10,000 wants 100/day.

**What it should do**: Store per-merchant in `merchants.settings` JSONB. A default already exists in `services/merchant/settings-service.js:28` — the route and service should read from merchant settings instead of env directly.

---

### MT-8: Shared log files across all merchants (COSMETIC)

**Severity**: Cosmetic
**Files**: `utils/logger.js:11-41`

**What it assumes**: All merchants write to the same log files (`output/logs/app-YYYY-MM-DD.log`, `output/logs/error-YYYY-MM-DD.log`).

**Current state**: Logs are tagged with `merchantId` in `defaultMeta`, so filtering is possible. But all data goes to the same files.

**What breaks**: Nothing functionally — log filtering works. However, at scale (50+ merchants), log volume becomes unmanageable in flat files. A merchant requesting their own audit trail must grep through shared logs.

**What it should do**: Acceptable for current scale. For franchise: consider structured log shipping (e.g., to a log aggregation service) with per-merchant dashboards. Not a code change — an ops decision.

---

### MT-9: Health check picks arbitrary merchant for Square status (DEGRADES)

**Severity**: Degrades
**Files**: `server.js:469-471`

**What it assumes**: The detailed health check verifies Square connectivity by picking one arbitrary merchant (`LIMIT 1`).

**Current code**:
```javascript
// server.js:469-471
const merchantResult = await db.query(
    'SELECT id FROM merchants WHERE square_access_token IS NOT NULL AND is_active = TRUE LIMIT 1'
);
```

**What breaks**: If the first merchant's Square token is expired but others are fine, the health check reports "connected" or vice versa. Gives misleading platform-wide status.

**What it should do**: Check connectivity for all active merchants (or a sample) and report per-merchant status. Return an aggregate health score (e.g., "4/5 merchants connected").

---

### MT-10: Setup script defaults to merchant ID 1 (COSMETIC)

**Severity**: Cosmetic
**Files**: `scripts/setup-seniors-discount.js:19, 27`

**What it assumes**: Default merchant ID is 1 (JTPets). Comment explicitly references JTPets.

**Current code**:
```javascript
// setup-seniors-discount.js:27
const merchantId = parseInt(process.argv[2] || '1', 10);
```

**What breaks**: Nothing in production (script is admin-only, requires explicit merchant ID for other merchants). But hardcoded defaults to merchant 1 are a code smell for multi-tenant.

**What it should do**: Make `merchantId` a required argument with no default. Print usage and exit if not provided.

---

### MT-11: `TOKEN_ENCRYPTION_KEY` is a single global key (COSMETIC)

**Severity**: Cosmetic (acceptable for current scale, note for franchise)
**Files**: `utils/token-encryption.js:28`

**What it assumes**: A single AES-256-GCM key encrypts all merchants' Square and Google OAuth tokens.

**Current code**:
```javascript
// token-encryption.js:28
const key = process.env.TOKEN_ENCRYPTION_KEY;
```

**What breaks**: If the key is compromised, all merchants' tokens are exposed. Single key = single point of failure for all tenant credentials.

**What it should do**: Acceptable for <50 merchants. For franchise scale: consider per-merchant key derivation using `PBKDF2(master_key, merchant_id)` so compromise of one derived key doesn't expose others. Or use a key management service (KMS).

---

### MT-12: Subscription status never auto-transitions (DEGRADES)

**Severity**: Degrades
**Files**: `server.js:892-921` (inline cron)

**What it assumes**: The subscription check cron logs warnings about expiring trials but never actually updates `merchants.subscription_status` from `'trial'` to `'expired'`. The `loadMerchantContext` middleware handles this dynamically by checking `trial_ends_at`, but the column stays stale.

**What breaks**: Admin reporting queries on `merchants.subscription_status` will show inaccurate data. A franchise admin dashboard showing "5 active trials" when 3 have actually expired is misleading.

**What it should do**: Add `UPDATE merchants SET subscription_status = 'expired' WHERE subscription_status = 'trial' AND trial_ends_at < NOW()` to the cron job. Already noted in CLAUDE.md as a known TODO.

---

### MT-13: GMC module-level debug state shared across merchants (DEGRADES)

**Severity**: Degrades
**Files**: `services/gmc/merchant-service.js:328-332`, `services/gmc/merchant-service.js:741-745`

**What it assumes**: Module-level objects `upsertProductState` and `localInventoryState` hold debug counters and logging flags shared across all merchants.

**Current code**:
```javascript
// merchant-service.js:328-332
const upsertProductState = {
    _logged: false,
    _debugCount: { ONLINE: 0, LOCAL: 0 },
    _successCount: { ONLINE: 0, LOCAL: 0 }
};

// merchant-service.js:741-745
const localInventoryState = {
    _loggedSuccess: false,
    _errorCount: 0,
    _debugCount: 0
};
```

**What breaks**: When two merchants sync GMC products concurrently, they share these counters and flags. Merchant A sets `_logged = true`, so merchant B's first-product debug logging is skipped. Error counts and success counts from both merchants are mixed together, producing misleading debug output. The `syncProductCatalog()` function resets counters per call (line ~566), but concurrent calls still interleave.

**What it should do**: Move state objects to local variables inside `syncProductCatalog()` and `syncAllLocationsInventory()`, passed as parameters to `upsertProduct()` and `updateLocalInventory()`. Or use a Map keyed by merchantId if cross-call tracking is needed.

---

### Not a Gap: Items Verified as Correct

| Item | Status | Notes |
|------|--------|-------|
| Square OAuth flow | Correct | Platform app credentials global; per-merchant tokens in DB |
| Google OAuth flow | Correct | Platform credentials global; per-merchant tokens in `google_oauth_tokens` |
| GMC account linking | Correct | Per-merchant in `gmc_settings` with `merchant_id` FK |
| SaaS subscription billing | Correct | Intentionally uses platform's own Square account |
| All cron jobs | Correct | All iterate `getAllActiveMerchants()` with per-merchant error isolation |
| All in-memory caches | Correct | All keyed by `merchantId` or `orderId:merchantId` |
| POD photo storage | Correct | Path includes `${merchantId}/${orderId}/` |
| Database queries | Correct | All filter by `merchant_id` |
| Webhook URL (`SQUARE_WEBHOOK_URL`) | Correct | Single endpoint for all merchants is the correct Square pattern |
| Square environment (`SQUARE_ENVIRONMENT`) | Correct | All merchants use same environment (production); sandbox is dev-only |
| `SUPER_ADMIN_EMAILS` | Correct | Platform-level admin list, not per-merchant |

---

## Grading History

| Date | Grade | Notes |
|------|-------|-------|
| 2026-03-04 | A+ | All P0-P2 complete. Test coverage and file size violations remain for A++ |
| 2026-02-19 | A+ | P0 7/7, P1 9/9, P2 6/6. API optimization 4/4 |
| 2026-01-26 | A | P0-5,6,7 fixed. P1-6,7,8,9 fixed. Master engineering review |

**Target A++ requirements**: Comprehensive test coverage (currently 28%), file size compliance (66 unapproved violations), zero known security issues.
