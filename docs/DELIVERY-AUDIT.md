# Delivery Module Audit

## 1. Surface Area Map

### Backend Files

| File | Lines | Responsibility | Dependencies | Issues Noted |
|------|-------|----------------|--------------|--------------|
| `services/delivery/index.js` | 20 | Barrel re-export of `delivery-service.js` | `delivery-service.js` | None |
| `services/delivery/delivery-service.js` | 2,031 | Core delivery logic: order CRUD, route generation/optimization (ORS), geocoding, POD photo storage, settings management, audit logging, Square order ingestion, route share tokens, customer backfill | `utils/database`, `utils/logger`, `utils/token-encryption`, `middleware/merchant`, `services/loyalty-admin/customer-details-service` | **Over 300-line limit (2,031 lines)** — violates CLAUDE.md file-length rule. Contains 7 distinct responsibilities (orders, routes, geocoding, POD, settings, audit, tokens). `cleanupExpiredPods()` exists but is never called by any cron job — expired POD photos are never deleted. Global `ORS_API_KEY` from env is a fallback but `POD_STORAGE_DIR` env var is not documented in `.env.example`. `geocodePendingOrders` uses a 100ms sleep between requests — naive rate limiting. |
| `services/delivery/delivery-stats.js` | 393 | Customer info/stats from Square, dashboard stats (order counts by status, active route, today's completions) | `utils/database`, `utils/logger`, `delivery-service.js`, `middleware/merchant` | `getCustomerStats` makes 3 parallel Square API calls per order — no caching, potentially slow on route view. `resolveCustomerId` logs PII (phone) at debug level. `BigInt(1)` used for limit in customer search — unusual. |
| `routes/delivery.js` | 937 | REST API: 24 endpoints for orders, routes, POD, geocoding, settings, audit, stats, sync, customer backfill | `services/delivery`, `services/delivery/delivery-stats`, `middleware/auth`, `middleware/merchant`, `middleware/security`, `middleware/validators/delivery`, `utils/file-validation`, `utils/response-helper`, `services/square` | **Over 300-line limit (937 lines).** `POST /orders/:id/complete` handler (lines 237–442) contains ~200 lines of Square fulfillment state-machine logic that belongs in a service, not a route. Inconsistent indentation in the complete handler (extra nesting). `POST /backfill-customers` has no validator. Three driver-api endpoints (`/route/:id/share`, `/route/:id/token`, `/route/:id/token DELETE`) use `res.json()` directly instead of `sendSuccess`/`sendError` response helpers. |
| `routes/driver-api.js` | 222 | Public token-based driver endpoints (8 endpoints): get route, complete/skip order, upload POD, finish route; plus 3 authenticated share-management endpoints | `services/delivery`, `middleware/auth`, `middleware/merchant`, `middleware/security`, `utils/file-validation`, `middleware/validators/driver-api` | All public endpoints use raw `res.json()` instead of `sendSuccess`/`sendError` response helpers — inconsistent with project convention. Error responses return `{ error: ... }` instead of `{ success: false, error: ... }`. |
| `middleware/validators/delivery.js` | 385 | Input validation for all delivery route endpoints (18 validator arrays) | `express-validator`, `middleware/validators/index` | Well-structured. No issues noted. |
| `middleware/validators/driver-api.js` | 127 | Input validation for driver API endpoints (8 validator arrays) | `express-validator`, `middleware/validators/index` | Token validated as 64-char hex — good. No issues noted. |
| `services/webhook-handlers/order-handler/order-delivery.js` | 359 | Webhook integration: auto-ingest delivery orders, handle cancellation/completion, refresh customer data on state changes, fulfillment updates | `services/delivery`, `middleware/merchant`, `services/loyalty-admin/customer-details-service`, `./order-normalize` | Well-structured. Proper error isolation (each handler catches individually). |

### Frontend Files

| File | Lines | Responsibility | Dependencies | Issues Noted |
|------|-------|----------------|--------------|--------------|
| `public/delivery.html` | 584 | Delivery scheduler dashboard: order list (pending/active/completed tabs), stats, route banner, add/edit order modals | `js/event-delegation.js`, `js/utils/escape.js`, `js/delivery.js`, `js/feature-check.js` | **Has inline `<style>` block (lines 7–371, ~365 lines)** — violates CLAUDE.md CSS rule ("no new `<style>` blocks"). Missing `toast.js` and `format-currency.js` utility includes. Missing `shared.css` link. |
| `public/delivery-route.html` | 698 | Driver route view (authenticated): stop cards, POD upload, customer note edit, route sharing modals | `js/event-delegation.js`, `js/utils/escape.js`, `js/utils/date-format.js`, `js/utils/toast.js`, `js/delivery-route.js`, `js/feature-check.js`, `css/shared.css` | **Has inline `<style>` block (lines 7–552, ~546 lines)** — violates CLAUDE.md CSS rule. Proper utility script order. |
| `public/delivery-history.html` | 385 | Delivery history: date-range filter, order cards with POD thumbnails, POD photo modal | `js/event-delegation.js`, `js/utils/escape.js`, `js/utils/date-format.js`, `js/delivery-history.js`, `js/feature-check.js` | **Has inline `<style>` block (lines 7–308, ~302 lines).** Missing `toast.js` utility include. Missing `shared.css` link. |
| `public/delivery-settings.html` | 313 | Delivery settings form: route addresses, cutoff time, auto-ingest toggle, POD retention, ORS API key | `js/event-delegation.js`, `js/utils/escape.js`, `js/delivery-settings.js`, `js/feature-check.js` | **Has inline `<style>` block (lines 7–183, ~177 lines).** Missing `shared.css` link. |
| `public/driver.html` | 643 | Public driver route view (token-based, no auth): stop cards, POD upload, finish route with driver name/notes | `js/event-delegation.js`, `js/utils/escape.js`, `js/utils/toast.js`, `js/utils/date-format.js`, `js/driver.js`, `css/shared.css` | **Has inline `<style>` block (lines 7–554, ~548 lines).** No `feature-check.js` (correct — public page). |
| `public/js/delivery.js` | 511 | Delivery scheduler client logic: load/render orders, tab switching, add/edit/delete order, generate route, geocode, sync from Square, 60s polling | None (vanilla JS, uses global `escapeHtml`) | `renderOrderList` builds HTML via template literals with `escapeHtml` — correct XSS prevention. 60s polling interval with visibility-change pause. No debounce on action buttons — rapid clicks could cause duplicate requests. |
| `public/js/delivery-route.js` | 759 | Driver route client logic: load/render route stops, customer stats badges, POD capture, complete/skip stops, customer note edit, route sharing, 60s polling | None (vanilla JS, uses global `escapeHtml`, `formatDateTime`, `showToast`) | **Over 300-line limit (759 lines).** `fetchAllCustomerStats` makes N API calls (batched 5 at a time) on every route load — expensive. `console.log` debug statements left in production code (lines 41–55, 536–537, 587). |
| `public/js/delivery-history.js` | 245 | History page client logic: date range filtering, load/render completed orders, POD modal viewer | None (vanilla JS, uses global `escapeHtml`, `formatDateTime`) | Clean implementation. No issues noted. |
| `public/js/delivery-settings.js` | 131 | Settings page client logic: load/save settings, geocode status display | None (vanilla JS, uses global `escapeHtml`) | Clean. API key field cleared on load (security-correct). |
| `public/js/driver.js` | 455 | Public driver client logic: token-based route loading, complete/skip/POD/finish actions, GPS capture, map links | None (vanilla JS, uses global `escapeHtml`, `escapeAttr`, `formatDate`, `showToast`) | `showToast` referenced but defined via `toast.js` include in HTML — coupling is implicit. No polling — driver must manually refresh. `stop-profile-note` CSS class used (line 197) but not defined in driver.html styles. |

### Database Schema (delivery tables)

| Table | Columns | Indexes | Notes |
|-------|---------|---------|-------|
| `delivery_orders` | `id` (UUID PK), `merchant_id` (FK merchants), `square_order_id`, `square_customer_id`, `customer_name`, `address`, `address_lat`, `address_lng`, `phone`, `notes`, `customer_note`, `status` (CHECK: pending/active/skipped/delivered/completed), `route_id` (FK delivery_routes), `route_position`, `route_date`, `square_synced_at`, `geocoded_at`, `square_order_data` (JSONB), `square_order_state`, `needs_customer_refresh` (BOOLEAN), `created_at`, `updated_at` | `idx_delivery_orders_merchant_status` (merchant_id, status), `idx_delivery_orders_route_date` (merchant_id, route_date), `idx_delivery_orders_square_order` (UNIQUE, square_order_id + merchant_id, partial WHERE NOT NULL), `idx_delivery_orders_needs_geocoding` (partial WHERE geocoded_at IS NULL), `idx_delivery_orders_needs_refresh` (partial WHERE needs_customer_refresh = TRUE), `idx_delivery_orders_customer` (merchant_id, square_customer_id, partial WHERE NOT NULL) | `updated_at` trigger via `update_delivery_orders_updated_at()`. ON CONFLICT upsert for Square orders prevents duplicates. |
| `delivery_pod` | `id` (UUID PK), `delivery_order_id` (FK delivery_orders CASCADE), `photo_path`, `original_filename`, `file_size_bytes`, `mime_type`, `latitude`, `longitude`, `captured_at` (DEFAULT NOW), `expires_at` | `idx_delivery_pod_order` (delivery_order_id), `idx_delivery_pod_expires` (partial WHERE expires_at IS NOT NULL) | Retention tracked via `expires_at` but **no cleanup job exists** — `cleanupExpiredPods()` function in service is never invoked. |
| `delivery_settings` | `id` (SERIAL PK), `merchant_id` (FK merchants, UNIQUE), `start_address`, `start_address_lat`, `start_address_lng`, `end_address`, `end_address_lat`, `end_address_lng`, `same_day_cutoff` (DEFAULT '17:00'), `pod_retention_days` (DEFAULT 180), `auto_ingest_ready_orders` (DEFAULT TRUE), `openrouteservice_api_key` (deprecated plaintext), `ors_api_key_encrypted`, `created_at`, `updated_at` | Unique on merchant_id | Encrypt-on-read migration from `openrouteservice_api_key` to `ors_api_key_encrypted`. `updated_at` trigger reuses `update_delivery_orders_updated_at()` function name — confusing but functional. |
| `delivery_routes` | `id` (UUID PK), `merchant_id` (FK merchants), `route_date`, `generated_by` (FK users), `total_stops`, `total_distance_km`, `estimated_duration_min`, `started_at`, `finished_at`, `status` (CHECK: active/finished/cancelled), `route_geometry` (TEXT, optional GeoJSON), `waypoint_order` (TEXT[]), `created_at` | `idx_delivery_routes_merchant_date` (merchant_id, route_date), `idx_delivery_routes_active` (partial WHERE status = 'active') | `waypoint_order` stored as TEXT[] — redundant with `delivery_orders.route_position`. |
| `delivery_audit_log` | `id` (SERIAL PK), `merchant_id` (FK merchants CASCADE), `user_id` (FK users CASCADE), `action`, `delivery_order_id` (FK delivery_orders SET NULL), `route_id` (FK delivery_routes SET NULL), `details` (JSONB), `ip_address` (INET), `user_agent`, `created_at` | `idx_delivery_audit_merchant` (merchant_id, created_at DESC) | `ip_address` and `user_agent` columns exist but are **never populated** by `logAuditEvent()` — the function only writes merchant_id, user_id, action, order_id, route_id, details. |
| `delivery_route_tokens` | `id` (UUID PK), `merchant_id` (FK merchants CASCADE), `route_id` (FK delivery_routes CASCADE), `token` (VARCHAR(64) UNIQUE), `status` (CHECK: active/used/expired/revoked), `created_by` (FK users CASCADE), `expires_at`, `used_at`, `finished_at`, `driver_name`, `driver_notes`, `created_at` | `idx_route_tokens_token` (token), `idx_route_tokens_route` (route_id), `idx_route_tokens_merchant` (merchant_id, status), `idx_route_tokens_active_route` (UNIQUE route_id WHERE status = 'active') | Clean design. Single active token per route enforced by partial unique index. |

### Jobs

No delivery-specific cron jobs exist. Notable absence: **no POD cleanup job** despite `cleanupExpiredPods()` function and `expires_at` column.

### Summary Statistics

| Category | Count |
|----------|-------|
| Backend files | 8 |
| Frontend HTML pages | 5 |
| Frontend JS files | 5 |
| Validator files | 2 |
| Webhook handler files | 1 |
| Database tables | 6 |
| API endpoints (authenticated) | ~27 |
| API endpoints (public/token) | 5 |
| Total backend lines | ~4,894 |
| Total frontend lines | ~5,546 |
| Total lines (all delivery code) | ~10,440 |

---

## 2. Order Lifecycle — TODO
## 3. Route Generation — TODO
## 4. Security — TODO
## 5. Bug Registry — TODO
## 6. Module Breakdown — TODO
## 7. CSS Findings — TODO
## 8. Test Coverage — TODO
## 9. Fix Plan — TODO
