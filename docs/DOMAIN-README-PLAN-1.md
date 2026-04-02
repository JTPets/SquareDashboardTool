# Domain README Plan — Batch 1

> Generated: 2026-04-02. Branch: claude/domain-readme-outlines-batch-1-p1KRN
> Covers: Loyalty, Catalog, Square Integration, Delivery, Webhook Handlers

---

## 1. Loyalty (`services/loyalty-admin/`)

**Files** (40 files, 10,771 lines)

| File | Lines |
|------|-------|
| reward-service.js | 742 |
| customer-identification-service.js | 621 |
| square-discount-service.js | 548 |
| discount-validation-service.js | 472 |
| order-history-audit-service.js | 434 |
| square-discount-catalog-service.js | 377 |
| refund-service.js | 377 |
| reward-progress-service.js | 366 |
| customer-admin-service.js | 358 |
| index.js | 355 |
| redemption-audit-service.js | 352 |
| offer-admin-service.js | 313 |
| purchase-service.js | 302 |
| order-intake.js | 294 |
| backfill-service.js | 291 |
| variation-admin-service.js | 275 |
| reward-split-service.js | 262 |
| backfill-orchestration-service.js | 261 |
| square-api-client.js | 259 |
| redemption-query-service.js | 249 |
| square-customer-group-service.js | 236 |
| expiration-service.js | 235 |
| customer-cache-service.js | 231 |
| square-sync-service.js | 228 |
| loyalty-event-prefetch-service.js | 200 |
| customer-search-service.js | 191 |
| webhook-processing-service.js | 187 |
| shared-utils.js | 185 |
| audit-stats-service.js | 181 |
| line-item-filter.js | 166 |
| settings-service.js | 140 |
| audit-service.js | 132 |
| loyalty-queries.js | 129 |
| order-processing-service.js | 124 |
| customer-details-service.js | 124 |
| customer-summary-service.js | 123 |
| customer-refresh-service.js | 123 |
| square-sync-retry-service.js | 116 |
| square-reward-service.js | 81 |
| manual-entry-service.js | 75 |
| constants.js | 56 |

**Tables owned:** loyalty_rewards, loyalty_purchase_events, loyalty_offers, loyalty_qualifying_variations, loyalty_customers, loyalty_processed_orders, loyalty_settings, loyalty_redemptions, loyalty_audit_logs, loyalty_customer_summary

**Routes:** `routes/loyalty.js`, `routes/loyalty/*` (8 files)

**Top 3 business rules:**
1. Redemption is full-only — no partial rewards; one reward = one free unit of same size group as earned
2. Every earned reward requires a valid Square customer-group discount object; invalid/deleted discounts are auto-recreated via `recreateDiscountIfInvalid` (BACKLOG-69)
3. `MAX_REDEMPTIONS_PER_ORDER` cap prevents runaway point accumulation on a single order; all matched rewards iterated as an array, not singular (BACKLOG-59)

**Dependencies on other domains:** Square (all Square API calls routed through `square-api-client.js`)

**Known issues (BACKLOG):**
- BACKLOG-9: In-memory discount catalog cache lost on PM2 restart — rebuilds on first call per merchant
- BACKLOG-59: Multiple redemptions per order now handled (array iteration); affects reward-service, redemption-audit-service, and webhook handlers
- BACKLOG-68: Square discount object cleanup after redemption — partial; failures logged but non-fatal
- BACKLOG-70: Price cap sync now bi-directional (discount amount ↔ catalog price)
- BACKLOG-72: Dead lookup wrapper functions removed from index.js

---

## 2. Catalog (`services/catalog/`)

**Files** (10 files, 4,125 lines)

| File | Lines |
|------|-------|
| inventory-service.js | 844 |
| reorder-service.js | 819 |
| catalog-health-service.js | 740 |
| variation-service.js | 659 |
| audit-service.js | 497 |
| location-health-service.js | 212 |
| item-service.js | 113 |
| reorder-math.js | 108 |
| location-service.js | 82 |
| index.js | 51 |

**Tables owned:** items, variations, categories, images, variation_location_settings, inventory_counts, committed_inventory, catalog_location_health

**Routes:** `routes/catalog.js`, `routes/catalog-health.js`, `routes/catalog-location-health.js`, `routes/analytics.js`

**Top 3 business rules:**
1. Available quantity = `inventory_counts.quantity` − `committed_inventory.quantity`; `days_until_stockout` uses available quantity divided by 91-day daily average velocity
2. Reorder threshold = `supply_days` + `safety_days`; both values are configurable per merchant via `merchant_settings` (defaults: 45 days supply, 7 days safety)
3. Vendor codes stored in `variation_vendors` table only — `supplier_item_number` column was dropped (BACKLOG-89); `location-service.js` centralises location queries (BACKLOG-25)

**Dependencies on other domains:** Square (catalog sync, pricing, custom attributes, locations), Merchant (location list, settings), Expiry (`bundle-calculator` used by `reorder-service`)

**Known issues (BACKLOG):**
- BACKLOG-25: `location-service.js` extracted to eliminate duplicate location queries across 6+ services
- BACKLOG-64: `sold_out` inventory mismatch audit count planned in `audit-service.js` (stub present, not yet active)
- BACKLOG-89: `supplier_item_number` column dropped; `variation-service.js` updated to remove references

---

## 3. Square Integration (`services/square/`)

**Files** (11 files, 5,785 lines)

| File | Lines |
|------|-------|
| square-catalog-sync.js | 1,088 |
| square-velocity.js | 909 |
| square-inventory.js | 848 |
| square-custom-attributes.js | 844 |
| square-diagnostics.js | 585 |
| square-pricing.js | 576 |
| square-vendors.js | 395 |
| square-client.js | 203 |
| api.js | 107 |
| square-sync-orchestrator.js | 106 |
| square-locations.js | 70 |
| index.js | 54 |

**Tables owned:** locations, sales_velocity, sync_history

**Routes:** `routes/square-oauth.js`, `routes/square-attributes.js`, `routes/sync.js`

**Top 3 business rules:**
1. Delta sync falls back to full sync automatically when > 100 objects are returned (`DELTA_SYNC_FALLBACK_THRESHOLD`); full sync builds item/variation maps in one pass before upserting
2. Velocity idempotency: a 120s TTL in-process cache (`recentlyProcessedVelocityOrders`) prevents double-counting when `order.updated` and `order.fulfillment.updated` both fire for the same completed order
3. Refunded quantities subtracted from velocity totals at both full-sync and incremental-webhook time (BACKLOG-35); vendor–variation mapping wrapped in a transaction DELETE + INSERT for atomicity (BACKLOG-62)

**Dependencies on other domains:** Used by almost all other domains; no upstream service dependencies — Square is a leaf in the dependency graph

**Known issues (BACKLOG):**
- BACKLOG-9: Negative lookup cache in `square-inventory.js` lost on PM2 restart — rebuilds on first API call per merchant
- BACKLOG-35: Refund subtraction logic present; full sync and webhook incremental path both apply it
- BACKLOG-36: Stale velocity rows for variations no longer in Square orders not yet automatically purged
- BACKLOG-64: `sold_out` flag sync added to `square-catalog-sync.js`

---

## 4. Delivery (`services/delivery/`)

**Files** (13 files, 2,748 lines)

| File | Lines |
|------|-------|
| delivery-routes.js | 451 |
| delivery-stats.js | 394 |
| delivery-orders.js | 364 |
| delivery-tokens.js | 332 |
| delivery-square.js | 279 |
| delivery-pod.js | 197 |
| delivery-gtin.js | 173 |
| delivery-settings.js | 149 |
| delivery-geocoding.js | 106 |
| delivery-backfill.js | 90 |
| delivery-audit.js | 77 |
| delivery-service.js | 58 |
| delivery-utils.js | 56 |
| index.js | 22 |

**Tables owned:** delivery_orders, delivery_routes, delivery_route_tokens, delivery_pod, delivery_settings, delivery_audit_log

**Routes:** `routes/delivery.js`, `routes/driver-api.js`

**Top 3 business rules:**
1. Route optimization calls OpenRouteService (ORS) API; generated routes are enriched with GTIN product data for the driver app view
2. `delivery_orders` joins `loyalty_customers` on `square_customer_id` to surface customer notes — a read-only cross-domain join; delivery never writes loyalty tables
3. Driver proof-of-delivery (POD) captured as photo path in `delivery_pod`; orders transition through status states (`pending` → `completed` / `skipped`) tracked in `delivery_audit_log`

**Dependencies on other domains:** Loyalty (`customer-details-service` checks loyalty status for delivery order creation)

**Known issues (BACKLOG):** None found in delivery service files.

---

## 5. Webhook Handlers (`services/webhook-handlers/`)

**Files** (12 files + order-handler sub-dir, 4,085 lines)

| File | Lines |
|------|-------|
| catalog-handler.js | 565 |
| order-handler/index.js | 551 |
| loyalty-handler.js | 544 |
| inventory-handler.js | 508 |
| order-handler/order-loyalty.js | 461 |
| order-handler/order-delivery.js | 359 |
| subscription-handler.js | 296 |
| index.js | 216 |
| customer-handler.js | 204 |
| order-handler/order-velocity.js | 132 |
| order-handler/order-normalize.js | 105 |
| order-handler/order-cart.js | 89 |
| oauth-handler.js | 55 |

**Tables owned:** webhook_events

**Routes:** `routes/webhooks.js`, `routes/webhooks/square.js`

**Top 3 business rules:**
1. Committed inventory sync is driven exclusively by invoice webhooks (`inventory-handler.js`); order webhooks no longer trigger committed sync — a daily reconciliation job provides safety net (BACKLOG-10)
2. Order handler fans out to five sub-modules in sequence: `order-normalize` → `order-cart` → `order-velocity` → `order-delivery` → `order-loyalty`; each sub-module is independently testable
3. Loyalty event handler (`loyalty-handler.js`) is a recovery path — catches orders where the customer was linked to a loyalty account *after* the initial order webhook arrived (late-binding customer identification)

**Dependencies on other domains:** Loyalty (order intake, customer cache), Expiry (discount-service on order events), Delivery (order updates), Cart (activity recording), Seniors (discount on order events), Square (SDK for order normalization), Subscriptions (subscription-bridge), Infrastructure (sync-queue for catalog tasks)

**Known issues (BACKLOG):**
- BACKLOG-10: Committed inventory sync moved to invoice webhooks; legacy debounced order-triggered sync removed
- BACKLOG-11: `customer.created` event now handled by `customer-handler.js`
- BACKLOG-58: Inventory increases on AUTO25/AUTO50 items trigger expiry re-audit in `inventory-handler.js`
- BACKLOG-59: Reward redemption detection iterates an array of redemptions per order (was singular)
- BACKLOG-94: Expiry discount quantity sales tracked on order events in `order-handler/index.js`
