# Work Items — Consolidated Master List

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Validated**: 2026-03-20
**Total Open Items**: ~41


Single source of truth for all open work. Items sourced from TECHNICAL_DEBT.md, CLAUDE.md backlog, code audits, and code TODOs. Organized by priority tier.

### Purge Log — 2026-03-20 Cleanup Batch (BACKLOG-9, BACKLOG-34, BACKLOG-40, EXPIRY-REORDER-AUDIT)

**BACKLOG-9 DOCUMENTED** — Audited all module-level in-memory state across services/, utils/, and jobs/. Findings: (1) `sync-queue.js` already persists to DB with startup recovery. (2) `platform-settings.js` cache, `square-inventory.js` invoices scope cache, `square-discount-catalog-service.js` currency cache are all read-through caches that self-heal on first miss after restart. (3) `committed-inventory-reconciliation-job.js` consecutiveZeroDeletions is monitoring-only. All acceptable losses documented with `// BACKLOG-9:` comments in each file.

**BACKLOG-34 DOCUMENTED** — Added "Square Variation ID Reuse on POS Reorder" section to docs/ARCHITECTURE.md under Square API Integration. Documents the behavior (Square deletes/recreates variations with new IDs on POS reorder), impact on historical data, current mitigations (soft-delete, item-level aggregation), and future roadmap.

**BACKLOG-40 INVESTIGATED** — exceljs v4.4.0 is used in exactly 2 files: `services/vendor/catalog-service.js` (XLSX reading for vendor catalog import) and `routes/purchase-orders.js` (XLSX export for POs). Features used are minimal (basic workbook/worksheet/cell read/write, bold font, number formats). No npm audit vulnerabilities found. CSV parsing is 100% custom (no external library). Lighter alternatives exist (node-xlsx, xlsx/SheetJS) but exceljs is working and has no active security issues. **Recommendation**: No swap needed today. Re-evaluate if deprecated transitive deps become security risks. Effort estimate unchanged (S).

**EXPIRY-REORDER-AUDIT FIXED** — Added lightweight hook in PO receiving flow (`routes/purchase-orders.js`) that flags `needs_manual_review = TRUE` on `variation_discount_status` for received items with active AUTO25/AUTO50 expiry discount tiers. Non-blocking (catch + warn on failure). Pattern matches BACKLOG-58 inventory webhook handler. 3 tests added.

### Purge Log — 2026-03-20 Shared Utility Extraction (BACKLOG-23, 25, 26, 27)

**BACKLOG-23 FIXED** — Created `public/js/utils/format-currency.js` with `formatCurrency(cents)`, `formatDollars(dollars, decimals)`, and `formatNumber(num)`. Replaced inline currency/number formatting across 14 JS files. All standardized to 'en-CA' locale.

**BACKLOG-25 FIXED** — Created `services/catalog/location-service.js` with `hasLocations`, `getLocationById`, `getActiveLocationIds`, `getActiveLocationCount`, `getFirstActiveLocation`. Replaced inline location queries in 5 route files (merchants, purchase-orders, gmc, sync, cycle-counts).

**BACKLOG-26 FIXED** — Extended `public/js/utils/date-format.js` with `formatDateTime()` for timestamp formatting. Replaced inline date formatting in 13 JS files.

**BACKLOG-27 FIXED** — Standardized all `toLocaleString()`/`toLocaleDateString()` calls to 'en-CA' locale via shared utilities. Eliminated 60+ inconsistent inline calls.

### Purge Log — 2026-03-20 Validation (BACKLOG-89, DB-5, Google tokens)

**BACKLOG-89 FIXED** — Removed dead `supplier_item_number` column from `variations` table. Two SQL COALESCE fallbacks in `loyalty-reports.js` updated to use `vv.vendor_code` directly. Field removed from `variation-service.js` allowlist, `schema.sql`, and `schema-manager.js`. Migration `002_drop_supplier_item_number.sql` drops the column.

**DB-5 NOT DEAD** — `subscription_plans.square_plan_id` is actively used in `routes/subscriptions.js` (4 refs) and `utils/square-subscriptions.js` (7 refs). Column is live. Marked as investigated, no action needed.

**Google tokens FIXED** — `utils/google-auth.js:loadTokens()` now force-rotates plaintext tokens to encrypted on read (fire-and-forget UPDATE) instead of waiting for next refresh cycle. Eliminates plaintext persistence window.

### Purge Log — 2026-03-20 Validation (O-4, Velocity, totalSynced, Velocity refund, OAuth /connect, Vendor log, 3 LOW bugs)

**O-4 FIXED** — Scoping bug in `square-pricing.js`: `currentVariationData` hoisted outside try block so catch block can safely reference it when error occurs before retrieve completes.

**Velocity FIXED** — `return_amounts` property was always undefined on return line items in `square-velocity.js`. Changed to use `returnItem.total_money?.amount` directly (the correct field).

**totalSynced FIXED** — Counter in `square-vendors.js` moved inside try block after confirmed DB write. Previously incremented outside try/catch, counting vendors even when reconcile silently returned.

**Velocity refund FIXED** — `updateSalesVelocityFromOrder` in `square-velocity.js` now subtracts refunded quantities/revenue, keeping incremental velocity accurate between daily full syncs.

**OAuth /connect FIXED** — Error handler in `routes/square-oauth.js` now redirects to dashboard with error query param instead of sending JSON via global error handler.

**Vendor log level FIXED** — Expected unique constraint race condition in `square-vendors.js` now logs at WARN instead of ERROR since it's expected behavior during concurrent syncs.

**3 LOW service bugs FIXED**:
- `services/vendor/catalog-service.js`: `regeneratePriceReport` null-guards `db.query` result to prevent crash if undefined.
- `services/delivery/delivery-service.js`: `_decryptOrsKey` error log now mentions geocoding impact.
- `services/delivery/delivery-service.js`: `backfillUnknownCustomers` empty-path return now includes `total` field for consistent response shape.

### Purge Log — 2026-03-20 Validation (CRIT-3, BACKLOG-69/70/71/74)

**CRIT-3 (audit) RESOLVED** — All innerHTML interpolations wrapped with escapeHtml() across 17 files (Phases 1-3B). Zero unescaped variable interpolations remain.

**BACKLOG-69 FIXED** — Extracted `recreateDiscountIfInvalid()` shared function, 3 call sites consolidated in discount-validation-service.js.

**BACKLOG-70 FIXED** — `syncRewardDiscountPrices` price cap now syncs both directions (increase and decrease).

**BACKLOG-71 FIXED** — `_analyzeOrders` renamed to `analyzeOrders()`, exported as public function with independent tests.

**BACKLOG-74 FIXED** — Promo code validation extracted to `services/promo-validation.js`, both routes use shared function.

### Purge Log — 2026-03-20 Validation (BUG-5, BUG-6, timestamp/type fixes)

**BUG-5 FIXED** — Fresh install detection removed from `scripts/migrate.js`. The incorrect "tables exist + no schema_migrations = fresh install → skip all migrations" branch was eliminated. New logic: create `schema_migrations` if absent, then run all pending migrations. A fresh install runs `001_fix_remaining_timestamps.sql`; production re-runs nothing (already applied).

**BUG-6 FIXED** — DB pool hang after migration runner exit. All early-exit paths in `scripts/migrate.js` now call `db.close()` before `process.exit()`, matching the pattern used by `validate-schema.js`.

**validate-schema.js** — `typeCompatible` updated: `time` and `time without time zone` treated as equivalent types (same pattern as the TIMESTAMP/TIMESTAMPTZ fix).

**migration 001** — `database/migrations/001_fix_remaining_timestamps.sql`: `delivery_route_tokens` CREATE TABLE + TIMESTAMP→TIMESTAMPTZ conversions for 10 columns across 5 tables.

### Purge Log — 2026-03-20 Validation (T-5)

**T-5 FIXED** — Migration runner + schema integrity + install verification:

- **Part 0** — schema-manager.js drift fixes:
  - `merchants` table: timezone `America/New_York` → `America/Toronto`, currency `USD` → `CAD`, added `locale`, `custom_attributes_initialized_at`, `admin_email` columns, CHECK constraint now includes `platform_owner`
  - `oauth_states`: `merchant_id` now `NOT NULL`, `user_id` has `ON DELETE CASCADE`, added merchant index
  - `variation_expiration`: added `merchant_id NOT NULL`, composite `PRIMARY KEY (variation_id, merchant_id)`, merchant index
  - `variation_discount_status`: added `merchant_id NOT NULL`, composite PK, merchant index
  - `expiry_discount_tiers`: `merchant_id` now `NOT NULL`
  - `webhook_events` CREATE TABLE: retry columns now included for fresh installs
  - `subscribers` CREATE TABLE: `merchant_id NOT NULL`, `promo_code_id`, `discount_applied_cents`, `user_id` now in initial CREATE
  - Added 35+ missing table CREATE blocks: `sync_history`, `locations`, `vendors`, `categories`, `images`, `items`, `variations`, `variation_vendors`, `inventory_counts`, `committed_inventory`, `sales_velocity`, `variation_location_settings`, `purchase_orders`, `purchase_order_items`, `count_history/priority/daily/sessions`, all delivery tables, `bundle_definitions/components`, `loyalty_customers`, `loyalty_processed_orders`, `loyalty_audit_log`, seniors tables, `cart_activity`, `label_templates`, `catalog_location_health`, `platform_settings`
  - Loyalty table column drift fixed: `loyalty_offers` (vendor fields, reward_type), `loyalty_purchase_events` (trace_id, customer_source, indexes), `loyalty_rewards` (vendor_credit fields, square integration fields, sync_pending, 9 indexes + partial unique), `loyalty_audit_logs` (trace_id, cascade FKs), `loyalty_redemptions` (cascade FK)
- **Part 1** — migrations 003–075 archived to `database/migrations/archive/` with README
- **Part 2** — `scripts/migrate.js` migration runner created (fresh install detection, sequential execution, failure stops)
- **Part 3** — `__tests__/database/schema-integrity.test.js` created (table coverage, column coverage, CHECK constraints, migration conventions)
- **Part 4** — `scripts/deploy.sh` updated with `node scripts/migrate.js` step
- **Part 0B** — `scripts/validate-schema.js` created (read-only DB comparison report); `__tests__/scripts/validate-schema.test.js` and `__tests__/scripts/migrate.test.js` added
- **package.json**: added `"migrate": "node scripts/migrate.js"` script

### Purge Log — 2026-03-17/19 Validation

26 items confirmed FIXED and purged:
- **CRIT-1/2/4/5**: Rate limiting, merchant_id on subscription tables, API version centralized
- **SEC-14**: merchant_id filter on resolveImageUrls
- **DB-6/7**: CASCADE FKs on 7 tables, 66 TIMESTAMPTZ conversions
- **BUG-2/3/4**: Tax IDs on bulk create, health card CSP fix, unified audit+health UI
- **MT-4/5/10/12/13**: Debug files removed, feed filename scoped, merchant-id CLI param, trial auto-transition, module state removed
- **FE-2/3/4**: showToast, escapeHtml, formatDate extracted to shared utilities
- **CQ-3/4/6/10**: No-op ternary, dead function, hashResetToken dedup, filterValidVariations fail-safe
- **BACKLOG-72**: Dead customer lookup wrappers removed
- **DEAD-6-12, L-1, E-4**: Stale comments, console.error, audit logging reviewed
- **Dead EXPIRED**: Unreachable code removed

### Purge Log — 2026-03-15 Validation

46 items confirmed FIXED and purged:
- **CRIT-1/2/3 (loyalty race conditions)**: ON CONFLICT, pg_advisory_xact_lock, idempotency all implemented
- **HIGH-1/2/3/5/6**: Row-level locking, error classification, atomic refunds, schema sync, discount cleanup all fixed
- **BACKLOG-67/68**: Square orphan audit tool built; redemption cleanup implemented
- **MED-1 through MED-7**: All loyalty issues fixed (detached .then, expiration loop, N+1 queries, customer summary, state transitions, LIMIT 1, partial commit)
- **LA-14/16/17/18/21/27**: All loyalty-admin issues resolved
- **BACKLOG-36/73**: Delta sync variation deletion fixed; vendor receipt bug fixed
- **DB-2/3/4**: Composite index added, schema drift fixed, nullable merchant_id fixed
- **S-5/7/8/9/11**: Password token, OAuth revoke, health endpoint, CSRF, session regeneration all fixed
- **SEC-8**: batchUpsert function removed
- **ERR-10**: process.exit(-1) removed from pool error handler
- **PERF-1, P-3, P-7**: Batch inserts, specific column SELECT, cache eviction all fixed
- **ARCH-4, O-1, O-6**: Dual HTTP clients unified; dead updateVariationPrice removed; lazy require documented
- **TEST-28, T-1, T-3, LOW-8**: Subscription tests rewritten; purchase/reward/route tests added; 40/41 loyalty-admin services tested
- **FE-1, SEC-12/13**: fetch() response.ok checks added; XSS in logs.js/delivery-settings.js fixed with escapeHtml
- **L-3**: console.log reduced from 32 to 8 frontend files

---

---

## High Priority

### Business

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| BACKLOG-50 | Post-trial conversion — $1 first month. Decide Stripe vs Square for SaaS billing. | New system | L | 2026-02-01 |
| BACKLOG-39 | Vendor bill-back tracking — `vendor_billbacks` table, reporting view for claim submission. Revenue recovery feature. | New table + routes | L | 2026-02-01 |
| BACKLOG-80 | Email alerts not visible — system sends from and to the same email (john@jtpets.ca), causing delivery/visibility issues. Fix: set up Cloudflare Email Routing (free) for alerts@sqtools.ca forwarding to admin inbox. Use Resend (free tier, 3,000/mo) or Mailgun (free tier, 1,000/day) as transactional sender via API. Update SMTP config in `.env` to use the transactional service. Then audit which error paths in `utils/email-notifier.js` send emails and which silently log only — ensure webhook failures, DB errors, and cron job failures all trigger alerts. Do NOT self-host email. | `utils/email-notifier.js`, `.env` | S | 2026-03-18 |
| BACKLOG-81 | Margin erosion alerts — alert when an item's actual margin drops from its previous margin due to a real change in the system. Triggers: (1) vendor cost updated in Square (via webhook or manual edit), (2) retail price changed in Square, (3) cost change accepted from vendor catalog import into live pricing. Does NOT trigger on vendor catalog imports alone since those are reference data until accepted. Track each variation's margin history (previous margin vs new margin). Alert when margin drops below the item's own previous margin by a configurable threshold (e.g., 5+ percentage points). To suppress false positives from temporary sales/promos, track last 4 price points — if the new price matches a previous temporary reduction, suppress. | New service + table, `services/catalog/` | M | 2026-03-18 |

---

## Medium Priority

### Features

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| BACKLOG-38 | Timed discount automation — apply/remove Square discounts on cron schedule. | New service + cron | L | 2026-02-01 |
| BACKLOG-41 | User access control with roles — manager, clerk, accountant. Required for multi-user SaaS. | New middleware + tables | L | 2026-02-01 |
| BACKLOG-42 | Barcode scan-to-count for cycle counts. | `public/js/cycle-count.js` | M | 2026-02-01 |
| BACKLOG-44 | Purchase order generation with branding — printable/emailable POs. | New service | M | 2026-02-01 |
| BACKLOG-45 | Spreadsheet bulk upload — import/update inventory via CSV or Google Sheets. | New route + service | M | 2026-02-01 |
| BACKLOG-51 | Demo account — read-only view for sales demos. | New middleware | M | 2026-02-01 |
| BACKLOG-55 | VIP customer auto-discounts via Square customer groups and pricing rules. | New service | M | 2026-03-15 |
| BACKLOG-63 | Caption auto-generation for Square Online Store product images using Claude API. | `services/gmc/` | M | 2026-03-15 |
| BACKLOG-64 | Audit Square `sold_out` flag vs inventory = 0 reconciliation. | New job | M | 2026-03-15 |
| BACKLOG-65 | Sync Square Online Store category assignments (website catalogs). | `square-catalog-sync.js` | M | 2026-03-15 |
| BACKLOG-53 | Employee KPI coaching dashboard. | New routes + service | M | 2026-02-01 |
| BACKLOG-54 | Employee auto-discounts via pricing rule scoped to employee group. | New service | M | 2026-02-01 |
| BACKLOG-4 | Customer birthday sync for marketing. | `customer-handler.js` | S | 2026-01-01 |
| BACKLOG-1 | Frontend polling rate limits. | `public/js/` | S | 2026-01-01 |
| BACKLOG-76 | Catalog attribute coverage audit — compare local DB schema (`items`, `variations` tables) against full Square `CatalogItem` and `CatalogItemVariation` object spec. Document every field Square sends that we don't store locally. Likely gaps: SEO title, SEO description, reporting category, item options, modifier lists, tax IDs, visibility settings, channel availability. Should be completed before BACKLOG-75. | `database/schema.sql`, `services/catalog/` | S | 2026-03-18 |
| BACKLOG-75 | Restore deleted items from local DB — `deleted_items` page already shows items removed from Square catalog. Add "Restore as New" which creates a new Square catalog item pre-populated from local DB snapshot. **Subtasks:** (1) Audit local schema coverage — compare columns in `variations` and `items` tables against all Square Catalog object fields, identify attributes we're NOT capturing today (depends on BACKLOG-76). (2) Expand catalog sync — if audit finds missing attributes, add them to delta/full sync so they're captured before deletion. (3) Restore as New — create a new Square catalog item pre-populated with name, UPC, category, reporting category, vendor, cost, price, description, SEO title, SEO description, images (if stored), tax assignments. Reuses bulk create pattern from `services/vendor/catalog-create-service.js`. (4) Seasonal item workflow — flag restored items as "reintroduced" for tracking. | `routes/`, `services/catalog/`, `services/vendor/catalog-create-service.js` | M | 2026-03-18 |
| BACKLOG-77 | Cart rescue tool — when a customer can't complete checkout online, staff currently has to manually recreate the entire order at the POS. Add customer identification (name, email, phone) to cart activity view and two actions: "Convert to Invoice" sends the customer a Square Invoice with a payment link they can complete themselves, "Complete at POS" converts the DRAFT order into a completed sale for in-store pickup. Shows full cart contents (items, quantities, prices). Real scenario: customer calls unable to checkout, staff converts cart to invoice in one click, customer gets a payment link via email. Uses Square Invoices API (already integrated for committed inventory). | New routes + service, `routes/`, `services/` | M | 2026-03-18 |
| BACKLOG-78 | Log viewer date picker — current logs page shows only today's logs. Add date selector to load previous days' archived/zipped logs. Also include PM2 process logs (`~/.pm2/logs/`) which currently aren't visible in the UI and roll over independently. | `routes/`, `public/js/` | M | 2026-03-18 |
| BACKLOG-79 | Cron job schedule audit — review all 16 background jobs and reschedule where possible to early morning (2–6 AM ET) so automation failures are visible in logs during business hours instead of being missed overnight or requiring next-day review. Document current vs proposed schedule. | `jobs/` | S | 2026-03-18 |
| BACKLOG-82 | Customer purchase intelligence — pet food is predictable consumption. Using order history and loyalty customer linking, build three views: (1) Purchase cycle baseline — average days between orders per customer, per product. A customer buying every 28 days who goes silent for 42 is a real signal. (2) RFM scoring — Recency, Frequency, Monetary value segmentation. A $800/5-order customer who goes quiet deserves intervention. A one-time discount buyer doesn't. (3) "Due to reorder" dashboard — surface customers past their predicted reorder window, ranked by value. Staff can call, email, or trigger a Square Marketing campaign. Future: automated reminders. All data already exists in loyalty_purchase_events and Square order history. | New service + routes | L | 2026-03-18 |
| BACKLOG-83 | Customer category visualizer — build customer purchase trees showing what categories, brands, and products each customer buys. Identify patterns (e.g., "raw food customer who also buys dehydrated treats"). Uses existing order history data linked to loyalty customers. Enables targeted recommendations and informed upselling. | New service + routes | M | 2026-03-18 |
| BACKLOG-84 | Vendor performance scoring — track and score each vendor on: order fill rate (items ordered vs received), delivery timeliness (scheduled vs actual), price stability (cost changes over time), credit note frequency, and minimum order ease. Display as a vendor scorecard in the vendor dashboard. Use data from purchase orders, vendor catalog imports, and receiving history. | New service + routes | M | 2026-03-18 |
| BACKLOG-85 | Market basket analysis — analyze order history to find product affinities (items frequently bought together). Inform shelf placement, bundle suggestions, and new store planograms. Critical for franchise expansion: teaches new operators what to stock and how to merchandise. Uses existing order line item data from Square Orders API. | New service + routes | L | 2026-03-18 |
| BACKLOG-86 | Waste tracking by expiry — when items reach the final expiry tier (pull from shelf), log the cost as waste. Report waste by vendor, category, brand, and time period. Inform future ordering decisions (don't overorder items with high waste rates). Connects to existing expiry discount system. | `services/expiry/`, new table | S | 2026-03-18 |
| BACKLOG-87 | Cycle count by vendor and category — current smart rotation prioritizes by value and recency but doesn't let merchants target specific vendors or categories. Add filter options to generate batches scoped to a single vendor (e.g., "count all Fromm products") or category (e.g., "count all dog treats"). Use case: receiving a vendor shipment and wanting to count just those items, or auditing a category after a planogram change. Extends existing batch generation. | `services/inventory/cycle-count-service.js` | S | 2026-03-19 |
| BACKLOG-88 | Tax selection on bulk item creation — currently `catalog-create-service.js` auto-applies ALL active merchant taxes to every created item. Add tax selection checkboxes to the "Create in Square" confirmation dialog showing each tax name and rate (fetched from Square). Pre-check all by default. Merchant unchecks taxes that don't apply to selected items. Supports merchants with multiple tax rates, tax-exempt items, or mixed tax jurisdictions. | `public/js/vendor-catalog.js`, `services/vendor/catalog-create-service.js` | S | 2026-03-19 |
| BACKLOG-90 | Vendor catalog match should create/update vendor links — when a vendor catalog import matches a UPC to an existing variation, check if `variation_vendors` has a row linking that variation to the importing vendor. If not, INSERT the vendor relationship with `vendor_code` and cost. If it exists, UPDATE the cost if changed. This enables multi-vendor price comparison on the reorder page. Currently a UPC match confirms the product exists but doesn't establish the vendor relationship, so the cheaper price from a secondary supplier is invisible to the reorder tool. Connects to existing "cheaper elsewhere" highlight on reorder suggestions. | `services/vendor/catalog-import-service.js`, `variation_vendors` table | S | 2026-03-19 |
| BACKLOG-91 | Purchase order minimum threshold should soft-block, not hard-block — current PO generation prevents orders under vendor minimums entirely. This should only hard-block automated PO generation (future auto-reorder). Manual PO creation should allow under-minimum orders with a warning ("Order is $X below $Y minimum — proceed anyway?"). Use case: adding a single urgent item or an add-on to a delivery already scheduled. | `routes/purchase-orders.js`, `services/purchase-orders/`, `public/js/purchase-orders.js` | S | 2026-03-20 |
| BACKLOG-92 | Category performance audit for dead stock and shrink management — identify underperforming categories or subcategories by combining sales velocity, margin, and inventory age. Example: canned cat food section is out of room. Tool surfaces slow movers (low velocity), low margin items, and items with high days-on-shelf. Actions: mark for clearance (triggers expiry discount system at a custom tier), flag as "do not reorder" (adds friction to PO generation for these items), or discontinue (remove from next vendor order). Builds on existing sales velocity, margin data, and expiry automation. Critical for space-constrained stores optimizing shelf allocation. | New service + routes, `services/expiry/`, `services/purchase-orders/` | M | 2026-03-20 |

### Data Integrity

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| Backfill | Historical `loyalty_purchase_events` with incorrect quantity — pre-2026-03-07 dedup bug. Requires runtime DB inspection. | `purchase-service.js` | M | 2026-03-07 |

### Multi-Tenant Gaps

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| MT-6 | Sync interval configuration is global, not per-merchant. | S | 2026-03-08 |
| MT-7 | `DAILY_COUNT_TARGET` cycle count target from env var is global, not per-merchant. | S | 2026-03-08 |
| MT-8 | Shared log files across all merchants — `app-*.log` and `error-*.log` not segregated. | S | 2026-03-08 |
| MT-9 | Health check picks arbitrary merchant for Square status via `LIMIT 1`. | S | 2026-03-08 |
| MT-11 | Single global `TOKEN_ENCRYPTION_KEY` for all merchants — no per-merchant key derivation. | S | 2026-03-08 |

### Testing

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| T-4 | Background jobs mostly untested — 2 of 16 jobs have tests (`cron-scheduler`, `trial-expiry-job`). 13 jobs untested. | `jobs/` | L | 2026-02-25 |


## Low Priority

### Performance

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| PERF-6 | Reorder suggestions query: 11-table JOIN with 4 correlated subqueries. Moved from `routes/analytics.js` to `services/catalog/reorder-service.js:135+` but still complex. | `services/catalog/reorder-service.js` | M | 2026-02-28 |
| ~~P-5~~ | ~~FIXED 2026-03-20~~ — Added `listenerCount` guard to `utils/google-auth.js:getAuthenticatedClient()` to match merchant-service pattern. Added error handling in listener. | `utils/google-auth.js`, `services/gmc/merchant-service.js` | S | 2026-02-25 |
| ~~P-8~~ | ~~FIXED 2026-03-20~~ — Documented why follow-up syncs must be sequential (pending flag depends on main sync completion). Pattern is already non-blocking via fire-and-forget. | `services/sync-queue.js:232-242` | S | 2026-02-25 |

### Dead Code / Cleanup

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| ~~BACKLOG-89~~ | ~~FIXED 2026-03-20~~ — `supplier_item_number` removed from schema, reports, allowlist. Migration `002_drop_supplier_item_number.sql` drops column. | `loyalty-reports.js`, `variation-service.js`, migration | S | 2026-03-19 |

### Code Quality

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| ~~Velocity~~ | ~~FIXED 2026-03-20~~ — `return_amounts` replaced with correct `total_money` field. | `square-velocity.js` | S | 2026-03-15 |
| Vendor | `reconcileVendorId` silent no-op — vendor name changes don't propagate until next full sync. | `services/square/square-vendors.js:53-80` | S | 2026-03-15 |
| ~~Google~~ | ~~FIXED 2026-03-20~~ — `loadTokens()` now force-rotates plaintext tokens to encrypted on read (fire-and-forget). | `utils/google-auth.js` | S | 2026-03-15 |

### Architecture

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| A-3 | Circular dependency — `middleware/merchant.js` ↔ `routes/square-oauth.js` via deferred `require()`. | Multiple | S | 2026-02-25 |
| ~~O-5~~ | ~~Business logic leaking into API sync layer — vendor sync logic embedded in catalog sync.~~ **FIXED 2026-03-20** — Extracted `syncVariationVendors()` to `square-vendors.js`. | `services/square/square-vendors.js` | M | 2026-02-25 |

### Config

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| ~~C-1~~ | ~~FIXED 2026-03-20~~ — Moved repeated magic numbers (MAX_RETRIES, RETRY_DELAY_MS, BATCH_SIZE, INTER_BATCH_DELAY_MS) to `config/constants.js`. Updated 10 callers. | M | 2026-02-25 |
| C-4 | Backups not encrypted at rest, no post-backup verification, local only. | M | 2026-02-25 |

### Features (Low)

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| BACKLOG-8 | Vendor management — pull vendor data from Square Vendors API. | M | 2026-02-01 |
| BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook. | S | 2026-02-19 |
| BACKLOG-12 | Driver share link validation failure. | S | 2026-01-01 |
| BACKLOG-43 | Min/Max stock per item per location — investigate Square thresholds first. | S | 2026-02-01 |
| BACKLOG-66 | Customer email bounce tracking for loyalty notifications. | S | 2026-03-15 |
| BACKLOG-61 | GMC v1beta → v1 migration — Google Merchant API v1beta discontinued Feb 28 2026. Product upserts failing with 409 ABORTED. Backup script running. Services still use v1beta endpoints. | M | 2026-03-09 |

### Code TODOs in Source

| Location | Description | Discovered |
|----------|-------------|------------|
| `services/webhook-handlers/order-handler/order-loyalty.js:445` | `TODO: Suggested extraction — handleLoyaltyError` | 2026-03-10 |
| `utils/schema-manager.js:339` | `TODO(pre-franchise): Replace placeholder URLs with per-merchant onboarding values` | 2026-03-15 |
| `utils/schema-manager.js:623` | `TODO(pre-franchise): Move seed promo codes to a separate seed script` | 2026-03-15 |

---

## Backlog — Nice to Have

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| BACKLOG-3 | Response format standardization. | M | 2026-01-01 |
| BACKLOG-17 | Customer lookup helpers duplicated (DEDUP L-4). | M | 2026-02-17 |
| ~~BACKLOG-23~~ | ~~Currency formatting — no shared helper (DEDUP G-3).~~ **FIXED 2026-03-20** | S | 2026-02-17 |
| ~~BACKLOG-25~~ | ~~Location lookup queries repeated across 6 routes (DEDUP G-5).~~ **FIXED 2026-03-20** | S | 2026-02-17 |
| ~~BACKLOG-26~~ | ~~Date string formatting pattern repeated 12 times (DEDUP G-7).~~ **FIXED 2026-03-20** | S | 2026-02-17 |
| ~~BACKLOG-27~~ | ~~Inconsistent toLocaleString() — 60 uses, mixed locales (DEDUP G-8).~~ **FIXED 2026-03-20** | S | 2026-02-17 |
| ~~BACKLOG-34~~ | ~~Doc: Square reuses variation IDs on POS reorder delete/recreate.~~ **DOCUMENTED 2026-03-20** — Added to ARCHITECTURE.md. | S | 2026-02-24 |
| ~~BACKLOG-40~~ | ~~exceljs pulls deprecated transitive deps — evaluate lighter library.~~ **INVESTIGATED 2026-03-20** — No swap needed; no active vulnerabilities. Re-evaluate if transitive deps become security risks. | S | 2026-03-01 |
| ~~BACKLOG-9~~ | ~~In-memory global state — PM2 restart recovery.~~ **DOCUMENTED 2026-03-20** — All in-memory state audited; all are self-healing caches or already DB-persisted. Comments added. | S | 2026-01-26 |
| BACKLOG-46 | QuickBooks daily sync. | L | 2026-02-01 |
| BACKLOG-47 | Multi-channel inventory sync — Shopify, WooCommerce, BigCommerce. | XL | 2026-02-01 |
| BACKLOG-48 | Clover POS integration. | XL | 2026-02-01 |
| BACKLOG-49 | Stripe payment integration. | L | 2026-02-01 |
| ~~BACKLOG-57~~ | ~~FIXED 2026-03-20~~ — `applyDiscounts()` now skips DB update and DISCOUNT_APPLIED audit log when variation is already at correct tier and price. | S | 2026-03-15 |
| ~~BACKLOG-58~~ | ~~FIXED 2026-03-20~~ — Inventory webhook handler now flags AUTO25/AUTO50 items for manual review (`needs_manual_review=TRUE`) when inventory changes. Next cron run re-evaluates. | S | 2026-03-15 |
| ~~EXPIRY-REORDER-AUDIT~~ | ~~Clearance items receiving new PO/restock should be flagged for re-audit. No trigger exists.~~ **FIXED 2026-03-20** — PO receive route flags AUTO25/AUTO50 items for manual review. | S | 2026-03-15 |

---

## Summary by Priority

| Tier | Count |
|------|-------|
| Critical | 0 |
| High | 4 |
| Medium | ~25 |
| Low | ~17 |
| Nice to Have | 16 |
| **Total** | **~44** |

**Validation delta**: ~95 → ~65 → ~49 → ~44 → ~37 → ~34 items. **87 items purged** across five validations (2026-03-15: 46 items, 2026-03-17/19: 26 items, 2026-03-20: 5 items, 2026-03-20b: 7 items, 2026-03-20c: 3 items).
