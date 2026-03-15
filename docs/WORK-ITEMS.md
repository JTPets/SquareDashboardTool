# Work Items — Consolidated Master List

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Priorities](./PRIORITIES.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md) | [Roadmap](./ROADMAP.md)

**Last Updated**: 2026-03-15
**Total Open Items**: ~95

Single source of truth for all open work. Items sourced from TECHNICAL_DEBT.md, CLAUDE.md backlog, code audits, and code TODOs. Organized by priority tier.

---

## Active Bugs (P0)

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| BACKLOG-61 | GMC v1beta → v1 migration — Google Merchant API v1beta discontinued Feb 28 2026. All product upserts failing with 409 ABORTED. Live store organic Google Shopping visibility broken. | `services/gmc/merchant-service.js` | M | 2026-03-09 |

---

## Critical Priority

### Loyalty Race Conditions

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| CRIT-1 | Race condition — concurrent webhooks create duplicate rewards. No error handling for unique violation; transaction throws, purchase silently lost. | `reward-progress-service.js:308-333` | M | 2026-03-09 |
| CRIT-2 | No row-level locking on purchase events during progress calculation. Double-earning of rewards possible. | `reward-progress-service.js:36-48` | M | 2026-03-09 |
| CRIT-3 | Purchase INSERT lacks ON CONFLICT for idempotency key. Concurrent calls with same key both pass SELECT, second INSERT throws. | `purchase-service.js:88-99, 142-157` | S | 2026-03-09 |

### Security

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| CRIT-1 (audit) | Unauthenticated subscription endpoints write to `users`/`subscribers`. `POST /create` creates user accounts with no auth/rate limit. `POST /promo/validate` brute-forceable. `GET /status` leaks subscription info by email. | `routes/subscriptions.js:148, :80, :553` | S | 2026-03-10 |
| CRIT-2 (audit) | Subscription routes have no `merchant_id` scoping — global database writes. Promo codes usable by any subscriber. | `routes/subscriptions.js:422-506` | M | 2026-03-10 |
| CRIT-3 (audit) | 288 innerHTML assignments in frontend JS — systematic XSS surface. Multi-tenant data rendered without escaping. | `public/js/` (all files) | L | 2026-03-10 |
| CRIT-4 (audit) | DB-1 — 14+ tables have nullable `merchant_id`. Bug in INSERT creates orphaned rows. | `database/schema.sql` | M | 2026-02-28 |
| CRIT-5 | 19 loyalty-admin files hardcode Square API version `'2025-01-16'` instead of using `config/constants.js` (`'2025-10-16'`). 9-month version gap. | 19 files in `services/loyalty-admin/` | S | 2026-03-10 |

---

## High Priority

### Loyalty System

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| HIGH-1 | Double redemption detection window — `detectRewardRedemptionFromOrder()` reads earned rewards without locking, another webhook can detect same reward. | `order-loyalty.js:275`, `reward-service.js:481-678` | S | 2026-03-09 |
| HIGH-2 | All loyalty errors silently swallowed — entire `processLoyalty` wrapped in try/catch that never re-throws. Transient DB error permanently loses order's loyalty data. | `order-loyalty.js:310-317` | S | 2026-03-09 |
| HIGH-3 | Refund processing not atomic across line items — each refund line item gets independent transaction. Partial commit on multi-item refund failure. | `purchase-service.js:276-437` | M | 2026-03-09 |
| HIGH-5 | schema.sql out of sync with live database — old UNIQUE constraint vs migration 024's partial unique index. | `database/schema.sql:1559-1560` | S | 2026-03-09 |
| HIGH-6 | Refund-triggered revocation doesn't clean up Square discount — customer retains active discount in Square POS. | `purchase-service.js:342-408` | S | 2026-03-09 |
| BACKLOG-67 | Square orphan audit tool — scan all loyalty customer groups/pricing rules, flag any with no matching active reward. | New tool needed | M | 2026-03-15 |
| BACKLOG-68 | Square discount cleanup on redemption — `redeemReward()` must call `cleanupSquareCustomerGroupDiscount()` after transitioning to redeemed. | `reward-service.js` | S | 2026-03-15 |

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
| MED-1 | Async Square discount creation fires as detached `.then()` — orphans on rollback. | `reward-progress-service.js:261-289` | S | 2026-03-09 |
| MED-2 | Expiration loop exits on first error — one bad record prevents processing remaining. | `expiration-service.js:46-81` | S | 2026-03-09 |
| MED-3 | N+1 queries in redemption detection — per-discount query. | `order-loyalty.js`, `reward-service.js` | S | 2026-03-09 |
| MED-4 | 6 sequential queries in customer summary update. | `customer-summary-service.js:22-111` | M | 2026-03-09 |
| MED-5 | No DB-level state transition enforcement on `loyalty_rewards.status`. | Database schema | M | 2026-03-09 |
| MED-6 | Ambiguous LIMIT 1 in free-item reward matching. | `reward-service.js:271-285` | S | 2026-03-09 |
| MED-7 | Partial commit on per-item error — failed variation permanently lost. | `order-intake.js:188-197` | S | 2026-03-09 |
| LA-14 | `processExpiredWindowEntries` error handler misleadingly appears to roll back committed rows. | `expiration-service.js` | S | 2026-03-09 |
| LA-16 | Manual entry sets $0 price — can't calculate discount cap. | `manual-entry-service.js` | S | 2026-03-09 |
| LA-17 | `buildDiscountMap` swallows DB errors — could double-count redemption items. | `line-item-filter.js` | S | 2026-03-09 |
| LA-18 | Five files use raw `fetch()` instead of `SquareApiClient` — no rate-limit retry. | 5 loyalty-admin files | M | 2026-03-09 |
| LA-21 | Multi-threshold rollover with split-row edge cases untested. | Tests needed | M | 2026-03-09 |
| LA-27 | Loyalty event prefetch returns partial data silently on API failures. | `loyalty-event-prefetch-service.js` | S | 2026-03-09 |
| BACKLOG-69 | Extract duplicate discount fix pattern in `discount-validation-service.js`. DRY fix. | `discount-validation-service.js` | S | 2026-03-15 |
| BACKLOG-71 | Extract `_analyzeOrders` from `order-history-audit-service.js` for independent testing. | `order-history-audit-service.js` | S | 2026-03-15 |
| BACKLOG-73 | Vendor receipt display bug — multi-redemption same order shows same line item as free for both. | `loyalty-reports.js` | M | 2026-03-15 |

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
| Backfill | Historical `loyalty_purchase_events` with incorrect quantity — pre-2026-03-07 dedup bug. | `purchase-service.js` | M | 2026-03-07 |
| BACKLOG-36 (velocity) | Delta sync does not mark child variations as deleted — orphaned variations appear in reorder suggestions. | `square-catalog-sync.js:612-629` | M | 2026-03-15 |

### Database

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| DB-2 | Missing composite index on `inventory_counts(merchant_id, location_id, state)`. | `database/schema.sql` | S | 2026-02-28 |
| DB-3 | Schema drift — `schema.sql` missing indexes from migration 005. | `database/schema.sql` | S | 2026-02-28 |
| DB-4 | `expiry_discount_audit_log.merchant_id` allows NULL. | `database/schema.sql` | S | 2026-02-28 |
| DB-5 | Potentially dead column `subscription_plans.square_plan_id`. | `database/schema.sql` | S | 2026-02-28 |
| DB-6 | Missing `ON DELETE CASCADE` on 14 tables — orphan rows on merchant deletion. | `database/schema.sql` | M | 2026-02-28 |
| DB-7 | Timestamp inconsistency: mix of `TIMESTAMP` and `TIMESTAMPTZ`. | `database/schema.sql` | M | 2026-02-28 |

### Testing

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| TEST-28 | `subscriptions.test.js` — 849 lines testing JS operators, not app code. Rewrite needed. | `__tests__/routes/subscriptions.test.js` | M | 2026-02-28 |
| T-1 | Financial/loyalty services have partial test coverage. | `purchase-service.js`, `reward-service.js` | L | 2026-02-25 |
| T-3 | Many routes untested — prioritize analytics.js, catalog.js, loyalty.js. | `routes/` | L | 2026-02-25 |
| T-4 | Background jobs mostly untested. | `jobs/` | L | 2026-02-25 |
| LOW-8 | 43% of loyalty-admin services have zero test coverage. | `services/loyalty-admin/` | L | 2026-03-09 |

### Security (Medium)

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| S-5 | Password reset token exposed in non-production response. | `routes/auth.js:655` | S | 2026-02-28 |
| S-7 | Missing `requireMerchant` on OAuth revoke route. | `routes/square-oauth.js:320` | S | 2026-02-28 |
| S-8 | Health endpoint exposes heap/node version to unauthenticated users. | `server.js:459-472` | S | 2026-02-28 |
| S-9 | No CSRF token middleware — relies on SameSite + CORS only. | Project-wide | M | 2026-02-28 |
| S-11 | Session not regenerated after merchant binding on OAuth callback. | `routes/square-oauth.js:242-244` | S | 2026-02-28 |
| SEC-8 | `batchUpsert` interpolates column names — not user-controlled but violates parameterization rule. | `utils/database.js` | S | 2026-02-28 |
| SEC-14 | `resolveImageUrls` missing `merchant_id` filter. | `services/gmc/feed-service.js` | S | 2026-02-28 |

### Multi-Tenant Gaps

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| MT-4 | GMC debug files overwrite across merchants — not merchant-scoped. | S | 2026-03-08 |
| MT-5 | GMC feed TSV file default filename not merchant-scoped. | S | 2026-03-08 |
| MT-6 | Sync interval configuration is global, not per-merchant. | S | 2026-03-08 |
| MT-7 | `DAILY_COUNT_TARGET` cycle count target is global. | S | 2026-03-08 |
| MT-8 | Shared log files across all merchants. | S | 2026-03-08 |
| MT-9 | Health check picks arbitrary merchant for Square status. | S | 2026-03-08 |
| MT-10 | Setup script defaults to merchant ID 1. | S | 2026-03-08 |
| MT-11 | Single global `TOKEN_ENCRYPTION_KEY` for all merchants. | S | 2026-03-08 |
| MT-12 | Subscription status never auto-transitions from trial. | S | 2026-03-08 |
| MT-13 | GMC module-level debug state shared across merchants. | S | 2026-03-08 |

---

## Low Priority

### Performance

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| PERF-1 | N+1 INSERT — per-variation sequential inserts during velocity sync. | `square-velocity.js` | M | 2026-02-28 |
| PERF-6 | Reorder suggestions: 9-table JOIN, 3 correlated subqueries, no LIMIT. | `routes/analytics.js:147-278` | M | 2026-02-28 |
| PERF-7 | N+1 bundle component inserts. | `routes/bundles.js:340-359` | S | 2026-02-28 |
| P-3 | `SELECT *` on merchants for every `getSquareClientForMerchant()`. | `middleware/merchant.js:210` | S | 2026-02-25 |
| P-5 | Google OAuth token listener duplicated on every call — leaks listeners. | `services/gmc/merchant-service.js:57-70` | S | 2026-02-25 |
| P-7 | `clientCache` Map has no max size or LRU eviction. | `middleware/merchant.js:19-20` | S | 2026-02-25 |
| P-8 | Follow-up syncs block sequentially. | `services/sync-queue.js:232-242` | S | 2026-02-25 |

### Error Handling

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| ERR-10 | Pool error handler calls `process.exit(-1)` on transient DB errors. | `utils/database.js` | S | 2026-02-28 |
| E-4 | Audit logging silently swallows errors. | `services/loyalty-admin/audit-service.js:66-73` | S | 2026-02-25 |

### Dead Code / Cleanup

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| DEAD-6-12 | 7 dead imports + dead `podUpload` config + ~75 lines of "EXTRACTED" comments. | `server.js` | S | 2026-02-28 |
| O-1 | `updateVariationPrice` exported but never called. | `services/square/square-pricing.js` | S | 2026-02-25 |
| CQ-3 | Velocity return location ternary is a no-op — both branches return `order.location_id`. | `square-velocity.js:131-132` | S | 2026-03-10 |
| CQ-4 | `updateDiscountAppliesTo` is a 78-line no-op function. | `services/expiry/discount-service.js:660-738` | S | 2026-03-10 |
| BACKLOG-72 | Dead code — 3 customer lookup wrappers with 0 callers. | `customer-admin-service.js` | S | 2026-03-15 |
| Dead | `'EXPIRED'` in `includes()` array unreachable due to short-circuit. | `services/expiry/discount-service.js:1816` | S | 2026-03-15 |

### Logging

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| L-1 | Critical startup paths use `console.error()` instead of Winston logger. | S | 2026-02-25 |
| L-2 | 10 locations missing `merchantId` in error logs. | S | 2026-02-25 |
| L-3 | 32 frontend JS files have `console.log` visible to end users (180 calls). | M | 2026-02-25 |

### Config

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| C-1 | ~20 hardcoded timeouts, batch sizes, retention limits — should be in `config/constants.js`. | M | 2026-02-25 |
| C-4 | Backups not encrypted at rest, no post-backup verification, local only. | M | 2026-02-25 |
| I-2 | Dual Square API version constants — `2025-10-16` vs `2025-01-16` across 19 files. | S | 2026-02-25 |

### Frontend

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| FE-1 | 79 of 183 `fetch()` calls missing `response.ok` check. | M | 2026-02-28 |
| FE-2 | `showToast()` duplicated across 7 files. | S | 2026-02-28 |
| FE-3 | `escapeJsString()` duplicated across 7 files. | S | 2026-02-28 |
| FE-4 | `formatDate()` variants duplicated across multiple files. | S | 2026-02-28 |
| SEC-12/13 | XSS in `logs.js` and `delivery-settings.js` — innerHTML without escaping. | S | 2026-02-28 |

### Code Quality

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| CQ-6 | `hashResetToken` duplicated in `auth.js` and `subscriptions.js`. | `routes/auth.js`, `routes/subscriptions.js` | S | 2026-03-10 |
| CQ-8 | `totalSynced++` inflates on error path. | `square-catalog-sync.js` | S | 2026-03-10 |
| CQ-9 | Vendor constraint errors log as ERROR not WARN. | `square-vendors.js` | S | 2026-03-10 |
| CQ-10 | `filterValidVariations` returns all variations on API failure. | `services/expiry/discount-service.js:967-974` | S | 2026-03-10 |
| Velocity | `return_amounts` property always undefined on return line item — harmless, fallback used. | `square-velocity.js:140-141,474-475` | S | 2026-03-15 |
| OAuth | `/connect` error handler uses global error handler instead of redirect. | `routes/square-oauth.js` | S | 2026-03-15 |
| Vendor | `reconcileVendorId` silent no-op — vendor name changes don't propagate. | `services/square/square-vendors.js` | S | 2026-03-15 |
| Google | Legacy plaintext Google OAuth tokens persist until refresh (JTPets only). | `utils/google-auth.js` | S | 2026-03-15 |
| BACKLOG-70 | `syncRewardDiscountPrices` only updates upward — price cap stays inflated if catalog price drops. | `discount-validation-service.js` | S | 2026-03-15 |

### Features (Low)

| ID | Description | Effort | Discovered |
|----|-------------|--------|------------|
| BACKLOG-8 | Vendor management — pull vendor data from Square Vendors API. | M | 2026-02-01 |
| BACKLOG-29 | Existing tenants missing `invoice.payment_made` webhook. | S | 2026-02-19 |
| BACKLOG-12 | Driver share link validation failure. | S | 2026-01-01 |
| BACKLOG-43 | Min/Max stock per item per location — investigate Square thresholds first. | S | 2026-02-01 |
| BACKLOG-66 | Customer email bounce tracking for loyalty notifications. | S | 2026-03-15 |

### Architecture

| ID | Description | File(s) | Effort | Discovered |
|----|-------------|---------|--------|------------|
| A-3 | Circular dependency — `middleware/merchant.js` ↔ `routes/square-oauth.js` via deferred `require()`. | Multiple | S | 2026-02-25 |
| O-4 | Scoping bug — `catch` references var from `try` block. | `services/square/square-pricing.js` | S | 2026-02-25 |
| O-5 | Business logic leaking into API sync layer. | `services/square/square-catalog-sync.js` | M | 2026-02-25 |
| O-6 | Soft coupling to loyalty-admin via lazy `require()`. | `services/square/square-velocity.js` | S | 2026-02-25 |
| ARCH-4 | Two Square API HTTP client implementations remain alongside SDK client. | `square-api-client.js`, `square-client.js`, `merchant.js` | M | 2026-03-10 |

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

## Expiry Discount Automation

| ID | Description | Effort |
|----|-------------|--------|
| EXPIRY-REORDER-AUDIT | Clearance items receiving PO/restock need re-audit trigger. | S |
| BACKLOG-57 | Daily re-apply noise — logs DISCOUNT_APPLIED even when tier unchanged. | S |
| BACKLOG-58 | Inventory increase should trigger expiry re-verification. | S |

---

## Summary by Priority

| Tier | Count |
|------|-------|
| Active Bugs (P0) | 1 |
| Critical | 8 |
| High | 9 |
| Medium | ~40 |
| Low | ~30 |
| Nice to Have | ~16 |
| **Total** | **~95** |
