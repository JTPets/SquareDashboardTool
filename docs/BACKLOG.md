# Backlog — Open Work Items

> **Maintenance:** Add items when: audit surfaces gaps, security review finds issues, dogfooding identifies bugs. Close items by adding resolution note and date.
> See also: [QA-AUDIT.md](./QA-AUDIT.md), [DOMAIN-MAP.md](./DOMAIN-MAP.md)

> **Last Updated**: 2026-04-17 | Consolidated from WORK-ITEMS, PRIORITIES, TECHNICAL_DEBT, PRE-BETA-AUDIT, ROADMAP, QA-AUDIT S2, QA-AUDIT S5; BACKLOG-133/134/135 from delivery-square.js audit

---

## CRITICAL — Ship Blockers

| ID | Description | Effort |
|----|-------------|--------|

---

## HIGH — Pre-Launch

| ID | Description | Effort |
|----|-------------|--------|
| PRICING-UI | Pricing page shows per-module prices with individual CTAs but `subscribe.html` is all-or-nothing. Misleads customers. | S |
| SUB-UI-1 | No cancel subscription button. API exists (`POST /api/subscriptions/cancel`) but no UI. | S |
| SUB-UI-2 | No trial countdown banner. Merchants have no visibility into trial expiry. | S |
| SUB-UI-3 | No billing history page. Merchants can't see past charges. | M |
| BACKLOG-80 | Email alert infrastructure. Code built (`utils/alert-recipients.js`, 135 tests), sends from/to same email. Needs transactional sender (Resend/Mailgun) + Cloudflare Email Routing. | S |
| BACKLOG-50 | Post-trial conversion — $1 first month. Capture payment method, prove intent. Decide Stripe vs Square for SaaS billing. | L |
| BACKLOG-133 | **Delivery — `address_missing` tombstone status.** When `ingestSquareOrder` finds no address, it returns null and writes nothing — the Square order is invisible to operators and re-processed on every webhook/sync. Fix: insert a `delivery_orders` row with `status='address_missing'` before returning null (`delivery-square.js:109–117`) to block repeat processing and give operator visibility. Add retry mechanism (analogous to `needs_customer_refresh`) so that if the fulfillment is later updated with an address, the order is promoted to `pending`. Missed deliveries are possible without this. | M |

---

## MEDIUM

### Subscription Admin UI

| ID | Description | Effort |
|----|-------------|--------|
| SUB-UI-4 | Admin promo code management UI — API exists, no form | S |
| SUB-UI-5 | Admin feature toggle per merchant — no UI exists | S |
| SUB-UI-6 | Admin subscriber list with search/filter | S |

### Testing & Quality

| ID | Description | Effort |
|----|-------------|--------|
| BACKLOG-126 | **Add `requireWriteAccess` negative-path tests across all affected domains** — existing tests confirm authorized access works but do not verify read-only users are blocked from write endpoints. Affects 12+ domains: delivery, square-attributes, vendor-catalog, purchase-orders, cycle-counts, sync, bundles, expiry-discounts, labels, settings, webhooks, ai-autofill, vendor-match-suggestions. See QA-AUDIT.md S2 and S3 summary. | M |
| BACKLOG-129 | Static security analysis test suite (SQL injection, merchant_id, escapeHtml patterns) | M |
| BACKLOG-117 | Jest coverage reporting — visibility into coverage gaps | S |
| BACKLOG-118 | Integration test framework — real DB tests | M |
| CSS-5 | Extract inline `<style>` blocks from ~20 HTML pages into `shared.css` | M |

### Operational

| ID | Description | Effort |
|----|-------------|--------|
| BACKLOG-134 | **Delivery — COMPLETED SHIPMENT orders not in system are permanently unreachable.** `delivery-sync.js:74–83` logs debug and skips COMPLETED Square orders not in `delivery_orders`. If the address was available at completion time, there is no path to recover them. Fix: after the debug skip, check if the order has an address in `shipmentDetails.recipient.address` and if so, ingest it (with `status='completed'` to avoid routing it as a live delivery). | M |
| BACKLOG-135 | **Delivery — manual records without `square_order_id` break ingest deduplication.** If staff manually create a `delivery_orders` row without linking `square_order_id`, subsequent webhooks and syncs cannot detect the duplicate via `getOrderBySquareId` (`delivery-orders.js:120–127`). If Square later has an address in the fulfillment, a second `delivery_orders` row will be created for the same physical delivery. Fix: add a UI warning when creating manual orders for Square order IDs that already exist, or require `square_order_id` linkage when the Square order is known. | S |
| BACKLOG-107 | Reorder suggestions audit — 810-line service with silent exclusion bugs | S |
| BACKLOG-108 | Stale draft PO warning — old drafts suppress reorder items silently | M |
| BACKLOG-109 | Merchant-configurable auto min/max settings | M |
| BACKLOG-110 | Webhook-triggered PO receive prompt | M |
| FEAT-4 | Feature module Phase 4 — frontend page gating for locked modules | M |
| FEAT-5 | Feature module Phase 5 — billing integration (Stripe/Square) | L |
| OSS-LOCALE | Frontend hardcoded `en-CA`/`CAD` locale — needs merchant context API | S |

### Business Features (Post-Beta)

| ID | Description | Effort |
|----|-------------|--------|
| BACKLOG-39 | Vendor bill-back tracking + promo engine | L |
| BACKLOG-81 | Margin erosion tracking dashboard | L |
| BACKLOG-82 | Customer purchase intelligence — RFM scoring | L |
| BACKLOG-42 | Barcode scan-to-count for cycle counts | M |
| BACKLOG-44 | Purchase order generation with branding | M |
| BACKLOG-45 | Spreadsheet bulk upload | M |
| BACKLOG-51 | Demo account — read-only for sales | M |
| BACKLOG-55 | VIP customer auto-discounts (Square customer groups + pricing rules) | M |
| BACKLOG-63 | Caption auto-generation for Square Online Store images (Claude API) | M |
| BACKLOG-75 | Restore deleted items from local DB snapshot | M |
| BACKLOG-77 | Cart rescue tool — convert abandoned carts to invoices | M |
| BACKLOG-83 | Customer category visualizer — purchase trees by brand/category | M |
| BACKLOG-84 | Vendor performance scoring — fill rate, timeliness, price stability | M |
| BACKLOG-85 | Market basket analysis — product affinities for shelf placement | L |
| BACKLOG-86 | Waste tracking by expiry — log cost at pull-from-shelf | S |
| BACKLOG-92 | Category performance audit — dead stock and shrink management | M |
| BACKLOG-93 | Emergency expiry flag by UPC scan | M |
| BACKLOG-38 | Timed discount automation — apply/remove Square discounts on schedule | L |
| BACKLOG-53 | Employee KPI coaching dashboard | M |
| BACKLOG-54 | Employee auto-discounts via pricing rules | M |

---

## LOW

| ID | Description | Effort |
|----|-------------|--------|
| AUDIT-6.1 | Driver API routes bypass delivery feature gate (pre-franchise) | S |
| MT-6/7 | Global config should be per-merchant (sync interval, count target) | S |
| MT-8/9/11 | Shared logs, arbitrary health check, global encryption key | S |
| C-4 | Backups not encrypted at rest | M |
| BACKLOG-8 | Vendor API sync gaps (display + address fields) | S-M |
| BACKLOG-43 | Min/Max stock per item per location | S |
| BACKLOG-99 | PO inventory push to Square on receive | M |
| BACKLOG-130 | E2E browser test framework (Playwright/Cypress) | L |
| BACKLOG-40 | exceljs deprecated transitive deps (no active security issues) | S |
| BACKLOG-95 | Multi-location expiry/count scoping (pre-franchise) | L |
| BACKLOG-104 | GMC product schema completeness audit | S |
| BACKLOG-64 | Square `sold_out` flag not reconciled with inventory = 0 | M |
| BACKLOG-65 | Website catalog categories not synced | M |
| BACKLOG-1 | Frontend polling rate limits | S |
| BACKLOG-4 | Customer birthday sync for marketing | S |
| BACKLOG-66 | Customer email bounce tracking | S |
| BACKLOG-76 | Catalog attribute coverage audit | S |
| BACKLOG-105 | GMC product sync 401 investigation (shelved — TSV feed works) | S |

---

## FUTURE — Major Initiatives

| Initiative | Description | Effort |
|------------|-------------|--------|
| Sales Velocity Refactor | Replace Orders API velocity with `inventory_changes` table (5 phases). Eliminates ~40 API calls/sync. | L |
| Open-Source Readiness | Remove branding, centralize locale/currency/timezone, make AI prompts configurable | M |
| Unified Audit Logging | Single `audit_log` table replacing fragmented trails (pre-franchise) | M |
| Distributed Locking | Advisory locks for cron jobs before multi-instance deployment (pre-franchise) | M |
| CI/CD Pipeline | GitHub Actions `npm test` on push/PR + deploy script | S |
| Architecture Splits | Refactor-on-touch: 5 oversized route files, 40+ oversized services (see DOMAIN-MAP.md) | Ongoing |
| Future Integrations | QuickBooks sync (L), Multi-channel inventory (XL), Clover POS (XL), Stripe payments (L) | XL |

---

## Code TODOs

| Location | Description |
|----------|-------------|
| `order-loyalty.js:445` | Extract `handleLoyaltyError` |
| `schema-manager.js:339` | Replace placeholder URLs with per-merchant values (pre-franchise) |
| `schema-manager.js:623` | Move seed promo codes to separate script (pre-franchise) |

---

## Summary

| Priority | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 9 |
| MEDIUM | ~33 |
| LOW | ~18 |
| FUTURE | 7 initiatives |
| **Total** | **~60 open items** |

**Ship readiness**: Fix PRICING-UI + SUB-UI-1/2 (all S effort) to ship beta.

---

## Effort Key

| Code | Meaning |
|------|---------|
| S | Small — < 2 hours |
| M | Medium — half day to full day |
| L | Large — multi-day |
| XL | Week+ |
