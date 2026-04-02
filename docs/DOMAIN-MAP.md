# Domain Boundary Map

> Generated: 2026-04-02. Reflects current codebase state.
> Purpose: Guide modular architecture decisions and identify split candidates.

---

## Table 1: Services by Domain

| Domain | Directory / File | Files | Total Lines | Tables Owned | Route Files |
|--------|-----------------|-------|-------------|--------------|-------------|
| **Loyalty** | `services/loyalty-admin/` | 40 | 10,771 | loyalty_rewards, loyalty_purchase_events, loyalty_offers, loyalty_qualifying_variations, loyalty_customers, loyalty_processed_orders, loyalty_settings, loyalty_redemptions, loyalty_audit_logs, loyalty_customer_summary | routes/loyalty/\* (8 files), routes/loyalty.js |
| **Loyalty Reports** | `services/reports/` | 3 | 2,554 | _(reads loyalty tables — no owned writes)_ | routes/loyalty/reports.js |
| **Square Integration** | `services/square/` | 11 | 5,785 | locations, sales_velocity, sync_history | routes/square-oauth.js, routes/square-attributes.js, routes/sync.js |
| **Catalog** | `services/catalog/` | 10 | 4,125 | items, variations, categories, images, variation_location_settings, inventory_counts, committed_inventory, catalog_location_health | routes/catalog.js, routes/catalog-health.js, routes/catalog-location-health.js, routes/analytics.js |
| **Webhook Handlers** | `services/webhook-handlers/` | 12 | 4,085 | webhook_events | routes/webhooks.js, routes/webhooks/square.js |
| **Delivery** | `services/delivery/` | 13 | 2,748 | delivery_orders, delivery_routes, delivery_route_tokens, delivery_pod, delivery_settings, delivery_audit_log | routes/delivery.js, routes/driver-api.js |
| **Vendor** | `services/vendor/`, `services/vendor-dashboard.js` | 5 | 3,142 | vendors, vendor_catalog_items, vendor_match_suggestions, variation_vendors | routes/vendor-catalog.js, routes/vendor-match-suggestions.js |
| **Expiry Discounts** | `services/expiry/` | 2 | 2,134 | expiry_discount_tiers, expiry_discount_settings, expiry_discount_audit_log, variation_discount_status, variation_expiration | routes/expiry-discounts.js |
| **GMC** | `services/gmc/` | 3 | 1,438 | gmc_settings, gmc_feed_history, gmc_location_settings, gmc_sync_logs, google_taxonomy, category_taxonomy_mapping | routes/gmc.js |
| **Inventory** | `services/inventory/` | 3 | 1,013 | count_sessions, count_queue_daily, count_queue_priority, count_history, min_max_audit_log, min_stock_audit | routes/cycle-counts.js, routes/min-max-suppression-routes.js |
| **Seniors Discount** | `services/seniors/` | 3 | 986 | seniors_discount_config, seniors_group_members, seniors_discount_audit_log | routes/seniors.js |
| **Cart** | `services/cart/` | 2 | 485 | cart_activity | routes/cart-activity.js |
| **Bundles** | `services/bundle-service.js`, `services/bundle-calculator.js` | 2 | 625 | bundle_definitions, bundle_components | routes/bundles.js |
| **AI Autofill** | `services/ai-autofill-service.js` | 1 | 664 | _(none — delegates to Square API + catalog)_ | routes/ai-autofill.js |
| **Staff** | `services/staff/` | 2 | 306 | staff_invitations, user_merchants, users | routes/staff.js |
| **Merchant** | `services/merchant/`, `services/platform-settings.js` | 3 | 367 | merchants, merchant_settings, platform_settings | routes/merchants.js, routes/settings.js, routes/admin.js |
| **Subscriptions** | `services/subscription-bridge.js`, `services/promo-validation.js` | 2 | 293 | subscribers, subscription_plans, subscription_payments, subscription_events, promo_codes, promo_code_uses | routes/subscriptions.js |
| **Label** | `services/label/` | 1 | 282 | label_templates | routes/labels.js |
| **Infrastructure** | `services/sync-queue.js`, `services/webhook-processor.js` | 2 | 726 | _(none directly)_ | _(none — called by other services)_ |

**Tables unowned / shared reads:** `purchase_orders`, `purchase_order_items` (written inline in `routes/purchase-orders.js`; no owning service), `oauth_states` (written inline in `routes/square-oauth.js`)

---

## Table 2: Cross-Domain Dependencies

| Domain | Depends On | Reason |
|--------|-----------|--------|
| Catalog | Square | Catalog sync, pricing, custom attributes, locations |
| Catalog | Merchant | Location list, merchant context |
| Catalog | Expiry | `bundle-calculator` imported by `reorder-service` |
| Delivery | Loyalty | `customer-details-service` — checks loyalty status for delivery orders |
| GMC | Square | `square-locations` for store codes |
| GMC | Catalog | `location-service` for feed population |
| Vendor | Square | `square-client` for catalog object lookups |
| Vendor | Merchant | `settings-service` for merchant config |
| Vendor Dashboard | Catalog | `reorder-math` for reorder calculations |
| Vendor Dashboard | Merchant | `settings-service` |
| Expiry | Square | Square discount catalog API calls |
| Loyalty | Square | `square-api-client` — all Square API calls for loyalty go through this |
| Webhook Handlers | Loyalty | Order intake, customer identification, cache |
| Webhook Handlers | Expiry | `discount-service` — apply expiry on order events |
| Webhook Handlers | Delivery | Delivery order updates on order events |
| Webhook Handlers | Cart | `cart-activity-service` — records cart events |
| Webhook Handlers | Seniors | Seniors discount on order events |
| Webhook Handlers | Square | Square SDK calls for order normalization |
| Webhook Handlers | Subscriptions | `subscription-bridge` — subscription events |
| Webhook Handlers | Infrastructure | `sync-queue` — queues catalog sync tasks |
| Subscriptions | Square | Square subscription API calls |
| Sync (route) | Square | Full catalog sync trigger |
| Sync (route) | Webhook Handlers | `catalog-handler` reused for manual sync |
| Sync (route) | GMC | Feed rebuild on sync |
| Cycle Counts (route) | Square | Inventory adjustment calls |
| Purchase Orders (route) | Expiry | `discount-service` for expiry discount linkage |
| AI Autofill | Square | `square/api` for catalog reads |

---

## Table 3: Orphan Files (not in a clear domain directory)

| File | Lines | Belongs To | Action |
|------|-------|-----------|--------|
| `services/vendor-dashboard.js` | 508 | Vendor | Move into `services/vendor/` |
| `services/bundle-service.js` | 503 | Bundles | Create `services/bundles/` |
| `services/bundle-calculator.js` | 122 | Bundles | Move into `services/bundles/` |
| `services/ai-autofill-service.js` | 664 | AI Autofill | Create `services/ai-autofill/` or keep as singleton |
| `services/sync-queue.js` | 354 | Infrastructure | Create `services/infra/` or keep as singleton |
| `services/webhook-processor.js` | 372 | Webhook Handlers | Move into `services/webhook-handlers/` |
| `services/subscription-bridge.js` | 192 | Subscriptions | Create `services/subscriptions/` |
| `services/promo-validation.js` | 101 | Subscriptions | Move into `services/subscriptions/` |
| `services/platform-settings.js` | 97 | Merchant / Infrastructure | Move into `services/merchant/` or `services/infra/` |

**Route-level orphans (DB queries with no owning service):**
- `routes/purchase-orders.js` — directly queries `purchase_orders`, `purchase_order_items`; no owning service exists
- `routes/square-oauth.js` — directly queries `oauth_states`; should move to `services/square/` or `services/merchant/`

---

## Table 4: Oversized Files (> 300 lines) Needing Split

### Services

| File | Lines | Split Suggestion |
|------|-------|-----------------|
| `services/expiry/discount-service.js` | 2,114 | Split into: tier-calculator, audit-writer, variation-scanner |
| `services/vendor/catalog-service.js` | 1,620 | Split into: catalog-reader, catalog-importer, catalog-exporter |
| `services/reports/loyalty-reports.js` | 1,471 | Split into: summary-report, cohort-report, export-service |
| `services/square/square-catalog-sync.js` | 1,088 | Split into: sync-orchestrator, upsert-handler, delete-handler |
| `services/reports/brand-redemption-report.js` | 1,064 | Split into: brand-query, redemption-query, report-formatter |
| `services/square/square-velocity.js` | 909 | Split into: velocity-reader, velocity-writer, velocity-aggregator |
| `services/square/square-inventory.js` | 848 | Split by operation type: adjustments vs queries |
| `services/square/square-custom-attributes.js` | 844 | Split into: definition-manager, value-manager |
| `services/catalog/inventory-service.js` | 844 | Split into: count-reader, count-writer, reorder-evaluator |
| `services/catalog/reorder-service.js` | 819 | Split into: reorder-calculator, reorder-query, reorder-formatter |
| `services/seniors/seniors-service.js` | 813 | Split into: discount-calculator, group-manager, audit-writer |
| `services/gmc/merchant-service.js` | 800 | Split into: settings-manager, taxonomy-mapper, location-sync |
| `services/loyalty-admin/reward-service.js` | 742 | Split into: reward-query, reward-writer, reward-validator |
| `services/catalog/catalog-health-service.js` | 740 | Split into: health-scanner, health-writer, health-formatter |
| `services/ai-autofill-service.js` | 664 | Split into: ai-client, prompt-builder, result-mapper |
| `services/catalog/variation-service.js` | 659 | Split into: variation-query, variation-writer, variation-pricing |
| `services/inventory/auto-min-max-service.js` | 631 | Split into: min-max-calculator, suppression-manager, audit-writer |
| `services/loyalty-admin/customer-identification-service.js` | 621 | Split into: identifier, matcher, deduplicator |
| `services/gmc/feed-service.js` | 603 | Split into: feed-builder, feed-writer, feed-scheduler |
| `services/square/square-diagnostics.js` | 585 | Split into: diagnostics-runner, diagnostics-formatter |
| `services/square/square-pricing.js` | 576 | Split into: price-reader, price-writer |
| `services/webhook-handlers/catalog-handler.js` | 565 | Split into: item-handler, variation-handler, category-handler |
| `services/webhook-handlers/order-handler/index.js` | 551 | Split into: order-router, order-normalizer (already partially done) |
| `services/loyalty-admin/square-discount-service.js` | 548 | Split into: discount-creator, discount-validator, discount-syncer |
| `services/webhook-handlers/loyalty-handler.js` | 544 | Split into: event-router, event-processor, event-auditor |
| `services/vendor/match-suggestions-service.js` | 544 | Split into: suggestion-engine, suggestion-query |
| `services/webhook-handlers/inventory-handler.js` | 508 | Split into: adjustment-handler, alert-handler |
| `services/vendor-dashboard.js` | 508 | Move to `services/vendor/`; split into reader/writer |
| `services/bundle-service.js` | 503 | Split into: bundle-query, bundle-writer |
| `services/catalog/audit-service.js` | 497 | Split into: audit-writer, audit-query |
| `services/cart/cart-activity-service.js` | 475 | Split into: event-recorder, activity-query |
| `services/loyalty-admin/discount-validation-service.js` | 472 | Split into: validator, rule-engine |
| `services/webhook-handlers/order-handler/order-loyalty.js` | 461 | Split into: points-processor, reward-processor |
| `services/vendor/catalog-create-service.js` | 451 | Split into: creator, validator |
| `services/delivery/delivery-routes.js` | 451 | Split into: route-planner, route-optimizer |
| `services/loyalty-admin/order-history-audit-service.js` | 434 | Split into: backfill-scanner, audit-writer |
| `services/square/square-vendors.js` | 395 | Split into: vendor-reader, vendor-writer |
| `services/delivery/delivery-stats.js` | 394 | Split into: stats-query, stats-aggregator |
| `services/loyalty-admin/square-discount-catalog-service.js` | 377 | Split into: catalog-creator, catalog-updater |
| `services/loyalty-admin/refund-service.js` | 377 | Split into: refund-processor, refund-auditor |
| `services/webhook-processor.js` | 372 | Move to `services/webhook-handlers/processor.js` |
| `services/loyalty-admin/reward-progress-service.js` | 366 | Split into: progress-query, progress-calculator |
| `services/inventory/cycle-count-service.js` | 364 | Split into: session-manager, count-recorder |
| `services/delivery/delivery-orders.js` | 364 | Split into: order-query, order-writer |
| `services/webhook-handlers/order-handler/order-delivery.js` | 359 | Split into: delivery-checker, delivery-updater |
| `services/loyalty-admin/customer-admin-service.js` | 358 | Split into: customer-query, customer-writer |
| `services/loyalty-admin/index.js` | 355 | Reduce — index should only re-export, not contain logic |
| `services/sync-queue.js` | 354 | Split into: queue-writer, queue-processor |
| `services/loyalty-admin/redemption-audit-service.js` | 352 | Split into: audit-writer, audit-query |
| `services/delivery/delivery-tokens.js` | 332 | Split into: token-generator, token-validator |
| `services/loyalty-admin/offer-admin-service.js` | 313 | Split into: offer-query, offer-writer |
| `services/staff/staff-service.js` | 303 | Split into: invitation-service, user-role-service |
| `services/loyalty-admin/purchase-service.js` | 302 | Split into: purchase-recorder, purchase-query |

### Routes (all exceed 300 lines — routes should be thin)

| File | Lines | Note |
|------|-------|------|
| `routes/gmc.js` | 1,009 | Move business logic to `services/gmc/` |
| `routes/delivery.js` | 942 | Move business logic to `services/delivery/` |
| `routes/purchase-orders.js` | 894 | Create `services/purchase-orders/` |
| `routes/subscriptions.js` | 870 | Move business logic to `services/subscriptions/` |
| `routes/auth.js` | 785 | Move session/token logic to `services/auth/` |
| `routes/vendor-catalog.js` | 610 | Move business logic to `services/vendor/` |
| `routes/sync.js` | 588 | Move orchestration logic to `services/square/` |
| `routes/square-oauth.js` | 539 | Move oauth logic to `services/square/oauth-service.js` |
| `routes/expiry-discounts.js` | 488 | Move business logic to `services/expiry/` |
| `routes/cycle-counts.js` | 473 | Move business logic to `services/inventory/` |
| `routes/catalog.js` | 376 | Move business logic to `services/catalog/` |
| `routes/loyalty/reports.js` | 211 | Acceptable; thin enough |
