# Work Items — Consolidated Master List

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Validated**: 2026-03-15
**Total Open Items**: ~65


Single source of truth for all open work. Items sourced from TECHNICAL_DEBT.md, CLAUDE.md backlog, code audits, and code TODOs. Organized by priority tier.

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

## Active Bugs (P0)

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| BACKLOG-61 | GMC v1beta → v1 migration — Google Merchant API v1beta discontinued Feb 28 2026. All product upserts failing with 409 ABORTED. Live store organic Google Shopping visibility broken. Services still use v1beta endpoints. | `services/gmc/merchant-service.js` | M | 2026-03-09 |

---

## Critical Priority

### Security

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| CRIT-1 (audit) | Subscription endpoint gaps — POST endpoints now rate-limited, but **GET /api/subscriptions/status** still unauthenticated with no rate limit. Leaks subscription info by email. | `routes/subscriptions.js:559` | S | 2026-03-10 |
| CRIT-2 (audit) | Subscription routes have no `merchant_id` scoping — `promo_codes`, `subscription_payments`, `subscription_events`, `subscription_plans` tables all lack `merchant_id` column. Promo codes usable cross-tenant. | `routes/subscriptions.js`, `database/schema.sql` | M | 2026-03-10 |
| CRIT-3 (audit) | 288 innerHTML assignments in frontend JS — systematic XSS surface across 34 files. Multi-tenant data rendered without escaping. | `public/js/` (34 files) | L | 2026-03-10 |
| CRIT-4 (audit) | Subscription tables missing tenant isolation — `promo_codes`, `subscription_payments`, `subscription_events`, `subscription_plans`, `platform_settings` have no `merchant_id`. `oauth_states.merchant_id` allows NULL. | `database/schema.sql` | M | 2026-02-28 |
| CRIT-5 | 12 loyalty-admin files hardcode Square API version `'2025-01-16'` instead of using `config/constants.js` (`'2025-10-16'`). 9-month version gap. | 12 files in `services/loyalty-admin/` | S | 2026-03-10 |

---

## High Priority

### Business

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| BACKLOG-50 | Post-trial conversion — $1 first month. Decide Stripe vs Square for SaaS billing. | New system | L | 2026-02-01 |
| BACKLOG-39 | Vendor bill-back tracking — `vendor_billbacks` table, reporting view for claim submission. Revenue recovery feature. | New table + routes | L | 2026-02-01 |

---

## Medium Priority

### Loyalty System

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| BACKLOG-69 | Extract duplicate discount fix pattern — same recreate-discount logic repeated 3 times in validation checks. | `discount-validation-service.js:238-257, 297-322, 350-375` | S | 2026-03-15 |
| BACKLOG-71 | Extract `_analyzeOrders` from `order-history-audit-service.js` for independent testing. | `order-history-audit-service.js:240-314` | S | 2026-03-15 |
| BACKLOG-70 | `syncRewardDiscountPrices` only updates upward — price cap stays inflated if catalog price drops. | `discount-validation-service.js:124-217` | S | 2026-03-15 |

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

### Data Integrity

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| Backfill | Historical `loyalty_purchase_events` with incorrect quantity — pre-2026-03-07 dedup bug. Requires runtime DB inspection. | `purchase-service.js` | M | 2026-03-07 |

### Database

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| DB-6 | ~~Missing `ON DELETE CASCADE` on user_id foreign keys~~ **FIXED 2026-03-17** — Added `ON DELETE CASCADE` to 7 user_id FKs: `oauth_states`, `delivery_routes`, `delivery_audit_log`, `loyalty_offers`, `loyalty_redemptions`, `loyalty_audit_logs`, `delivery_route_tokens`. Migration 072. Note: `password_reset_tokens` already had CASCADE (via schema-manager.js); `delivery_orders` has no user_id FK. | `database/schema.sql`, `migrations/072_add_cascade_user_fks.sql` | S | 2026-02-28 |
| DB-7 | ~~Timestamp inconsistency: bare `TIMESTAMP` vs `TIMESTAMPTZ` columns~~ **FIXED 2026-03-17** — Converted 66 columns across 31 tables to `TIMESTAMPTZ`. Also fixed 40 occurrences in `schema-manager.js`. Migration 073. | `database/schema.sql`, `utils/schema-manager.js`, `migrations/073_timestamp_to_timestamptz.sql` | M | 2026-02-28 |

### Security

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| ~~SEC-14~~ | ~~`resolveImageUrls` missing `merchant_id` filter~~ — **FIXED 2026-03-17**. Added `merchant_id` param to `resolveImageUrls` and `batchResolveImageUrls`; updated all 8 callers. | `utils/image-utils.js` | S | 2026-02-28 |

### Multi-Tenant Gaps

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| MT-4 | GMC debug files overwrite across merchants — hardcoded `gmc-product-sync-debug.log` not merchant-scoped. | S | 2026-03-08 |
| MT-5 | GMC feed TSV file default filename not merchant-scoped (`gmc-feed.tsv`). | S | 2026-03-08 |
| MT-6 | Sync interval configuration is global, not per-merchant. | S | 2026-03-08 |
| MT-7 | `DAILY_COUNT_TARGET` cycle count target from env var is global, not per-merchant. | S | 2026-03-08 |
| MT-8 | Shared log files across all merchants — `app-*.log` and `error-*.log` not segregated. | S | 2026-03-08 |
| MT-9 | Health check picks arbitrary merchant for Square status via `LIMIT 1`. | S | 2026-03-08 |
| MT-11 | Single global `TOKEN_ENCRYPTION_KEY` for all merchants — no per-merchant key derivation. | S | 2026-03-08 |
| MT-12 | `merchants.subscription_status` never auto-transitions from trial. Middleware handles dynamically but column is stale for reporting. | S | 2026-03-08 |
| MT-13 | GMC module-level `upsertProductState` debug state shared across concurrent merchant syncs. | S | 2026-03-08 |

### Testing

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| T-4 | Background jobs mostly untested — 2 of 16 jobs have tests (`cron-scheduler`, `trial-expiry-job`). 13 jobs untested. | `jobs/` | L | 2026-02-25 |


## Low Priority

### Performance

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| PERF-6 | Reorder suggestions query: 11-table JOIN with 4 correlated subqueries. Moved from `routes/analytics.js` to `services/catalog/reorder-service.js:135+` but still complex. | `services/catalog/reorder-service.js` | M | 2026-02-28 |
| P-5 | Google OAuth token listener — guard (`listenerCount`) prevents duplication, but same pattern repeated across calls. | `services/gmc/merchant-service.js:65-80` | S | 2026-02-25 |
| P-8 | Follow-up syncs fire-and-forget — async but not fully non-blocking within request handler. | `services/sync-queue.js:232-242` | S | 2026-02-25 |

### Error Handling

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| E-4 | Audit logging silently swallows errors (by design — "should not break main operations"). | `services/loyalty-admin/audit-service.js:66-73` | S | 2026-02-25 |

### Dead Code / Cleanup

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| DEAD-6-12 | 10 "EXTRACTED" section comments in `server.js` (lines 617-691). Dead imports removed but comments remain. | `server.js` | S | 2026-02-28 |
| CQ-3 | Velocity return location ternary is a no-op — both branches return `order.location_id`. | `square-velocity.js:132` | S | 2026-03-10 |
| CQ-4 | `updateDiscountAppliesTo` exported but never called (0 callers outside definition). | `services/expiry/discount-service.js:675` | S | 2026-03-10 |
| BACKLOG-72 | Dead code — 3 customer lookup wrappers with 0 callers, documented as dead. | `customer-admin-service.js` | S | 2026-03-15 |
| Dead | `'EXPIRED'` in `includes()` array unreachable — EXPIRED tier has `auto_apply: false`, but check requires `is_auto_apply = true`. | `services/expiry/discount-service.js:1831` | S | 2026-03-15 |

### Logging

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| L-1 | Critical startup paths use `console.error()` instead of Winston logger (3 occurrences in `server.js`). | S | 2026-02-25 |

### Frontend

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| FE-2 | `showToast()` duplicated across 9 files — no shared utility. | S | 2026-02-28 |
| FE-3 | `escapeHtml()` still duplicated in 2 files (`delivery-settings.js`, `upgrade.js`) — not using global `utils/escape.js`. | S | 2026-02-28 |
| FE-4 | `formatDate()` variants duplicated across 7 files. | S | 2026-02-28 |

### Code Quality

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| CQ-6 | `hashResetToken` duplicated in `auth.js` and `subscriptions.js`. | `routes/auth.js:19`, `routes/subscriptions.js:41` | S | 2026-03-10 |
| CQ-10 | `filterValidVariations` returns all variations on API failure — fails open instead of safe. | `services/expiry/discount-service.js:974-981` | S | 2026-03-10 |
| Velocity | `return_amounts` property always undefined on return line item — harmless, fallback used. | `square-velocity.js:140-141,474-475` | S | 2026-03-15 |
| Vendor | `reconcileVendorId` silent no-op — vendor name changes don't propagate until next full sync. | `services/square/square-vendors.js:53-80` | S | 2026-03-15 |
| Google | Legacy plaintext Google OAuth tokens persist until refresh — migration guard in place, new tokens encrypted. JTPets only. | `utils/google-auth.js:275` | S | 2026-03-15 |

### Architecture

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| A-3 | Circular dependency — `middleware/merchant.js` ↔ `routes/square-oauth.js` via deferred `require()`. | Multiple | S | 2026-02-25 |
| O-5 | Business logic leaking into API sync layer — vendor sync logic embedded in catalog sync. | `services/square/square-catalog-sync.js` | M | 2026-02-25 |

### Config

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| C-1 | ~20 hardcoded timeouts, batch sizes, retention limits — should be in `config/constants.js`. | M | 2026-02-25 |
| C-4 | Backups not encrypted at rest, no post-backup verification, local only. | M | 2026-02-25 |

### Features (Low)

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| BACKLOG-8 | Vendor management — pull vendor data from Square Vendors API. | M | 2026-02-01 |
| BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook. | S | 2026-02-19 |
| BACKLOG-12 | Driver share link validation failure. | S | 2026-01-01 |
| BACKLOG-43 | Min/Max stock per item per location — investigate Square thresholds first. | S | 2026-02-01 |
| BACKLOG-66 | Customer email bounce tracking for loyalty notifications. | S | 2026-03-15 |

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
| BACKLOG-23 | Currency formatting — no shared helper (DEDUP G-3). | S | 2026-02-17 |
| BACKLOG-25 | Location lookup queries repeated across 6 routes (DEDUP G-5). | S | 2026-02-17 |
| BACKLOG-26 | Date string formatting pattern repeated 12 times (DEDUP G-7). | S | 2026-02-17 |
| BACKLOG-27 | Inconsistent toLocaleString() — 60 uses, mixed locales (DEDUP G-8). | S | 2026-02-17 |
| BACKLOG-34 | Doc: Square reuses variation IDs on POS reorder delete/recreate. | S | 2026-02-24 |
| BACKLOG-40 | exceljs pulls deprecated transitive deps — evaluate lighter library. | S | 2026-03-01 |
| BACKLOG-9 | In-memory global state — PM2 restart recovery. | S | 2026-01-26 |
| BACKLOG-46 | QuickBooks daily sync. | L | 2026-02-01 |
| BACKLOG-47 | Multi-channel inventory sync — Shopify, WooCommerce, BigCommerce. | XL | 2026-02-01 |
| BACKLOG-48 | Clover POS integration. | XL | 2026-02-01 |
| BACKLOG-49 | Stripe payment integration. | L | 2026-02-01 |
| BACKLOG-57 | Expiry discount daily re-apply noise — unnecessary Square API calls and audit log entries. | S | 2026-03-15 |
| BACKLOG-58 | Inventory increase should trigger expiry re-verification for AUTO25/AUTO50 items. | S | 2026-03-15 |
| EXPIRY-REORDER-AUDIT | Clearance items receiving new PO/restock should be flagged for re-audit. No trigger exists. | S | 2026-03-15 |

---

## Summary by Priority

| Tier | Count |
|------|-------|
| Active Bugs (P0) | 1 |
| Critical | 5 |
| High | 2 |
| Medium | ~31 |
| Low | ~26 |
| Nice to Have | 16 |
| **Total** | **~65** |

**Validation delta**: ~95 → ~65 items. **46 items purged** (confirmed fixed in code). **~30 items remain from original audit**; remainder are features and backlog items.
