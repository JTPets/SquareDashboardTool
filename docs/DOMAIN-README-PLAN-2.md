# Domain README Plan — Batch 2

> Generated: 2026-04-02. Branch: claude/domain-readme-outlines-batch-1-p1KRN
> Covers: Vendor, Expiry Discounts, GMC, Inventory, Seniors Discount

---

## 1. Vendor (`services/vendor/` + `services/vendor-dashboard.js`)

**Files** (6 files, 3,142 lines)

| File | Lines |
|------|-------|
| vendor/catalog-service.js | 1,620 |
| vendor/match-suggestions-service.js | 544 |
| vendor-dashboard.js _(orphan — root services/)_ | 508 |
| vendor/catalog-create-service.js | 451 |
| vendor/index.js | 19 |

**Tables owned:** vendors, vendor_catalog_items, vendor_match_suggestions, variation_vendors

**Routes:** `routes/vendor-catalog.js`, `routes/vendor-match-suggestions.js`

**Top 3 business rules:**
1. Bulk item creation deduplicates by UPC against existing catalog before calling Square; batched at 100 items per API call; tax IDs fetched once per bulk operation (not per item); optional `tax_ids` override available (BACKLOG-88)
2. CSV/XLSX import auto-detects column mappings; matched variations generate suggested vendor links for staff review — never auto-linked (BACKLOG-90); `variation_vendors` link inserted on UPC match (BACKLOG-97)
3. Vendor status derived from live stats in priority order: `has_oos` → `below_min` → `ready` → `needs_order` → `ok`; minimum order threshold comparison only fires when cost data is present; reorder value computed in JS via shared `reorder-math.js` (BACKLOG-14)

**Dependencies on other domains:** Square (`square-client` for catalog object lookups), Merchant (`settings-service` for config and default supply days), Catalog (`reorder-math` for reorder quantity calculations)

**Known issues (BACKLOG):**
- BACKLOG-88: Optional `tax_ids` parameter added to `bulkCreateSquareItems` for caller override
- BACKLOG-90: Vendor link suggestions tracked for staff review; auto-link removed
- BACKLOG-97: `variation_vendors` row inserted when UPC match found during import
- BACKLOG-112: Cross-vendor deduplication and visibility flags (Phase 3) — in progress in `catalog-service.js`
- BACKLOG-114: Cross-vendor match suggestions generated when item appears in multiple vendor catalogs (`match-suggestions-service.js`)

---

## 2. Expiry Discounts (`services/expiry/`)

**Files** (2 files, 2,134 lines)

| File | Lines |
|------|-------|
| discount-service.js | 2,114 |
| index.js | 20 |

**Tables owned:** expiry_discount_tiers, expiry_discount_settings, expiry_discount_audit_log, variation_discount_status, variation_expiration

**Routes:** `routes/expiry-discounts.js`

**Top 3 business rules:**
1. Tiers are ordered by `priority DESC`; discounted price = `original_price × (1 − discount_percent/100)`; re-apply is skipped if variation is already at the correct tier and price to suppress noisy `DISCOUNT_APPLIED` audit entries on daily re-runs (BACKLOG-57)
2. Discount automation manages Square catalog discount objects (pricing rule + product set); expiry and loyalty discount infrastructure now share the same Square object pattern (BACKLOG-6, completed 2026-02-06)
3. Units sold at discounted price are tracked per variation for expiry quantity accounting (BACKLOG-94); data flows in via order event webhooks in `order-handler/index.js`

**Dependencies on other domains:** Square (discount catalog API calls; lazy-loaded to break circular dependency with `services/square`)

**Known issues (BACKLOG):**
- BACKLOG-57: Idempotent re-apply — skip when tier + price already match; prevents audit log noise on daily automation runs
- BACKLOG-94: Expiry discount quantity sales tracking added; `discount-service.js` exposes tracking function called by webhook order handler

---

## 3. GMC (`services/gmc/`)

**Files** (3 files, 1,438 lines)

| File | Lines |
|------|-------|
| merchant-service.js | 800 |
| feed-service.js | 603 |
| index.js | 35 |

**Tables owned:** gmc_settings, gmc_feed_history, gmc_location_settings, gmc_sync_logs, google_taxonomy, category_taxonomy_mapping

**Routes:** `routes/gmc.js`

**Top 3 business rules:**
1. GMC OAuth tokens are stored AES-256-GCM encrypted (SEC-6); all token reads go through `google-auth.js:getAuthenticatedClient` which decrypts before use and re-encrypts on refresh — bypassing this (reading raw from DB) caused 401 errors (GMC-BUG-001)
2. Product feeds are generated as TSV files; `feed-service.js` produces both a primary product feed and a local inventory feed; slugs are normalised and TSV special characters escaped before write
3. All API calls use Google Merchant API v1 (not Content API); schema migrated from v1beta → v1 (BACKLOG-61) after Google deprecated v1beta on 2026-02-28

**Dependencies on other domains:** Square (`square-locations` for store codes), Catalog (`location-service` for feed population)

**Known issues (BACKLOG):**
- BACKLOG-61: v1beta → v1 API migration complete; both `merchant-service.js` and feed paths updated; no v1beta calls remain

---

## 4. Inventory (`services/inventory/`)

**Files** (3 files, 1,013 lines)

| File | Lines |
|------|-------|
| auto-min-max-service.js | 631 |
| cycle-count-service.js | 364 |
| index.js | 18 |

**Tables owned:** count_sessions, count_queue_daily, count_queue_priority, count_history, min_max_audit_log, min_stock_audit

**Routes:** `routes/cycle-counts.js`, `routes/min-max-suppression-routes.js`

**Top 3 business rules:**
1. Three recommendation rules, Rule 3 always wins: `OVERSTOCKED` (days_of_stock > 90 AND min > 0 → min−1), `SOLDOUT_FAST_MOVER` (qty=0, velocity≥0.15/day, min < ⌈vel×30⌉ → min+1), `EXPIRING` (tier ∈ AUTO25/AUTO50/EXPIRED → 0)
2. Eligibility guards skip a variation if: `min_stock_pinned = TRUE` (merchant override, never auto-adjust), item created < 91 days ago (insufficient history), or velocity IS NULL/0 (no data for Rules 1 & 2)
3. Weekly cron has two safety guardrails: (a) abort if `sales_velocity` not updated in 7+ days (stale data), (b) circuit breaker aborts if reductions would exceed 20% of all items with `min > 0`; recent-sales check uses `loyalty_purchase_events.purchased_at` (cross-domain read, no write)

**Dependencies on other domains:** Reads `loyalty_purchase_events` for `last_sold_at` (cross-domain read); reads `expiry_discount_tiers` for expiry tier classification

**Known issues (BACKLOG):**
- BACKLOG-106: `auto-min-max-service.js` serves both the manual review API and the weekly cron job (v2 design)

---

## 5. Seniors Discount (`services/seniors/`)

**Files** (3 files, 986 lines)

| File | Lines |
|------|-------|
| seniors-service.js | 813 |
| age-calculator.js | 122 |
| index.js | 51 |

**Tables owned:** seniors_discount_config, seniors_group_members, seniors_discount_audit_log

**Routes:** `routes/seniors.js`

**Top 3 business rules:**
1. Eligibility threshold is age ≥ 60, calculated in `America/Toronto` timezone; date arithmetic uses `Intl.DateTimeFormat` with `formatToParts` (not `toLocaleDateString`) to avoid ICU/full-icu locale gaps on Raspberry Pi Node builds
2. One-time Square object setup is idempotent: creates customer group → discount catalog object → product set → pricing rule in order, skipping any step where the Square ID is already populated in `seniors_discount_config`
3. Group membership is event-driven: birthday updates arrive via Square `customer.updated` webhooks; `SeniorsService` adds or removes the customer from the Square group based on recalculated age eligibility

**Dependencies on other domains:** Loyalty (`SquareApiClient` from `loyalty-admin/square-api-client` for all Square API calls), Square (`generateIdempotencyKey` from `square/api`)

**Known issues (BACKLOG):** None found in seniors service files.
