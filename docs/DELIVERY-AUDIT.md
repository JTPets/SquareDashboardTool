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

## 2. Order Lifecycle

### 2a. How Orders Enter the System

There are **four ingestion paths**:

| # | Path | Entry Point | Trigger | Initial Status |
|---|------|-------------|---------|----------------|
| 1 | **Webhook auto-ingest** | `order-delivery.js:ingestDeliveryOrder()` → `delivery-service.js:ingestSquareOrder()` | Square `order.updated` webhook fires, `auto_ingest_ready_orders` setting is true, order has DELIVERY/SHIPMENT fulfillment with an address | `pending` (or `completed` if Square state is COMPLETED) |
| 2 | **Fulfillment webhook auto-ingest** | `order-delivery.js:handleFulfillmentDeliveryUpdate()` → `autoIngestFromFulfillment()` → `delivery-service.js:ingestSquareOrder()` | Square `order.fulfillment.updated` webhook fires with non-terminal fulfillment state (not COMPLETED/CANCELED/FAILED), auto-ingest enabled | `pending` |
| 3 | **Manual creation** | `routes/delivery.js:POST /orders` → `delivery-service.js:createOrder()` | User clicks "Add Order" in delivery.html, fills in customer name + address | `pending` |
| 4 | **Manual sync** | `routes/delivery.js:POST /sync` → `delivery-service.js:ingestSquareOrder()` | User clicks "Sync from Square" button, searches last N days of OPEN/COMPLETED orders with DELIVERY/SHIPMENT fulfillments | `pending` (OPEN orders) or `completed` (existing orders updated to match Square COMPLETED state) |

**Deduplication**: Square-linked orders use `ON CONFLICT (square_order_id, merchant_id)` upsert. Manual orders (null `square_order_id`) are excluded from the partial unique index and cannot conflict.

**Customer refresh**: Orders ingested from DRAFT-state Square orders or with "Unknown Customer" are flagged with `needs_customer_refresh = TRUE`. The `refreshDeliveryOrderCustomerIfNeeded()` webhook handler updates customer data when the order transitions from DRAFT → OPEN.

### 2b. All Possible Status Values

From the CHECK constraint in `schema.sql:1309-1311`:

```
status IN ('pending', 'active', 'skipped', 'delivered', 'completed')
```

| Status | Meaning |
|--------|---------|
| `pending` | Ready for route assignment. Order is in the queue awaiting the next route generation. |
| `active` | Assigned to an active route. Driver can see and act on this order. |
| `skipped` | Driver skipped this stop (couldn't deliver). Still attached to the route. |
| `delivered` | POD photo captured. Intermediate state between driver action and admin completion. |
| `completed` | Fully done. Square fulfillment synced (if applicable). Terminal state. |

### 2c. Status Transition Map

| From | To | Function | File:Line | Trigger |
|------|----|----------|-----------|---------|
| *(new)* | `pending` | `createOrder()` | `delivery-service.js:337` | Webhook ingest, manual creation, or sync (for OPEN Square orders) |
| *(new)* | `completed` | `createOrder()` | `delivery-service.js:1455` | `ingestSquareOrder()` when Square order state is already COMPLETED |
| `pending` | `active` | `generateRoute()` | `delivery-service.js:684-689` | Route generation assigns pending orders to route |
| `active` | `skipped` | `skipOrder()` | `delivery-service.js:490` | Driver or admin skips a stop |
| `active` | `delivered` | `savePodPhoto()` | `delivery-service.js:1063` | POD photo uploaded (sets status to `delivered`) |
| `active` | `completed` | `completeOrder()` | `delivery-service.js:518-519` | Admin marks order complete via route view |
| `delivered` | `completed` | `completeOrder()` | `delivery-service.js:518-519` | Admin marks delivered order as fully complete |
| `skipped` | `pending` | `finishRoute()` | `delivery-service.js:754-758` | Route finished — skipped orders rolled back to pending |
| `active` | `pending` | `finishRoute()` | `delivery-service.js:754-758` | Route finished — still-active orders rolled back to pending |
| `*` (not completed) | `completed` | `handleSquareOrderUpdate()` | `delivery-service.js:1580-1585` | Square webhook reports order COMPLETED |
| `*` (not completed) | `completed` | `ingestSquareOrder()` | `delivery-service.js:1362-1366` | Re-ingest finds Square order is now COMPLETED |
| `pending`/`active` | *(deleted)* | `handleSquareOrderUpdate()` | `delivery-service.js:1592-1604` | Square webhook reports order CANCELED |
| `pending` | *(deleted)* | `deleteOrder()` | `delivery-service.js:464-480` | Manual order deleted by user (only if no `square_order_id` and not completed/delivered) |
| `*` (any) | `completed` | sync route handler | `routes/delivery.js:859-863` | Sync finds existing order where Square state is COMPLETED but local status differs |
| `*` (any) | `delivered` | `savePodPhoto()` | `delivery-service.js:1063` | POD upload unconditionally sets `delivered` **regardless of current status** |

### 2d. State Machine Diagram

```
                         ┌──────────────────────────────────────────────────┐
                         │           Square webhook: COMPLETED              │
                         │      (handleSquareOrderUpdate / ingest)          │
                         ▼                                                  │
    ┌─────────┐    generateRoute()    ┌─────────┐    completeOrder()    ┌───┴──────┐
    │         │ ──────────────────►   │         │ ──────────────────►   │          │
    │ pending │                       │ active  │                       │completed │
    │         │ ◄──────────────────   │         │                       │ (terminal│
    └────┬────┘    finishRoute()      └────┬────┘                       │  state)  │
         │         (rollback)              │                            └───▲──────┘
         │                                 │                                │
         │                                 │ skipOrder()                    │
         │                                 ▼                                │
         │                           ┌──────────┐   finishRoute()          │
         │              ◄────────────│  skipped  │──(rollback to pending)   │
         │                           └──────────┘                          │
         │                                                                 │
         │                                 │ savePodPhoto()                │
         │                                 ▼                               │
         │                           ┌──────────┐   completeOrder()        │
         │                           │ delivered │─────────────────────────►│
         │                           └──────────┘                          │
         │                                                                 │
         │  Square webhook: CANCELED                                       │
         │  (deletes if pending/active)                                    │
         ▼                                                                 │
    ┌──────────┐                                                           │
    │ (deleted)│     Note: 'completed' can be reached from ANY status      │
    └──────────┘     via Square webhook or sync                            │

    Entry points:
    ─ Webhook auto-ingest ──────► pending (or completed if Square=COMPLETED)
    ─ Manual creation ──────────► pending
    ─ Manual sync ──────────────► pending (or completed)
```

### 2e. finishRoute() Behavior by Status

`finishRoute()` at `delivery-service.js:721-793` operates within a transaction:

| Order Status on Route | What finishRoute() Does | Result |
|----------------------|-------------------------|--------|
| `completed` | **Nothing** — not matched by `WHERE status IN ('skipped', 'active')` | Stays `completed`, keeps `route_id` reference |
| `skipped` | Rolls back to `pending`, clears `route_id`, `route_position`, `route_date` | Order re-enters queue |
| `active` | Rolls back to `pending`, clears `route_id`, `route_position`, `route_date` | Order re-enters queue |
| **`delivered`** | **NOTHING** — not matched by the WHERE clause | **BUG: stays `delivered` with stale `route_id` pointing to a now-finished route** |

### 2f. Force-Regenerate Behavior

`generateRoute()` at `delivery-service.js:594-712` with `force: true`:

1. Finds existing active route via `getActiveRoute()` (line 599)
2. If `force` is true, does NOT throw the "already exists" error (line 600)
3. **Cancels the old route**: `UPDATE delivery_routes SET status = 'cancelled' WHERE id = $1` (line 657-659)
4. **Only selects `pending` orders**: `WHERE status = 'pending' AND geocoded_at IS NOT NULL` (line 612-614)
5. Sets selected orders to `status = 'active'` with new `route_id` (line 684-689)

**Critical gap**: When the old route is cancelled, **orders on that route are NOT touched**. Orders in `active`, `skipped`, or `delivered` status on the old route remain in those statuses with a `route_id` pointing to a now-cancelled route. They are **orphaned** — not on any active route, and not `pending` so they won't be picked up by the next route generation.

### 2g. Route Planning WHERE Clause

```sql
SELECT * FROM delivery_orders
WHERE merchant_id = $1 AND status = 'pending'
  AND geocoded_at IS NOT NULL
```

Only `status = 'pending'` orders are eligible. This **excludes**:
- `active` — orders still on a cancelled/finished route
- `skipped` — orders on a cancelled route (only rolled back by `finishRoute()`, not by force-regenerate cancellation)
- `delivered` — orders with POD but not yet completed (never rolled back by anything)
- `completed` — terminal state (correct exclusion)

### 2h. The Gap — Stuck Orders

Three scenarios produce permanently stuck orders:

**Scenario 1: Force-regenerate orphans (`active`/`skipped` on cancelled route)**
1. Route A is active with orders in `active`/`skipped` status
2. User force-generates Route B → Route A is set to `cancelled`
3. Orders on Route A are NOT touched — they stay `active`/`skipped` with `route_id` = Route A
4. Route generation only picks `pending` orders → these orders are invisible to the scheduler
5. `finishRoute()` checks `route.status !== 'active'` and throws "Route is not active" → cannot finish Route A to roll them back
6. **Result**: Orders are permanently stuck

**Scenario 2: Delivered orders on finished route**
1. Driver uploads POD photo → order status becomes `delivered`
2. Admin finishes route → `finishRoute()` only rolls back `skipped` and `active` orders
3. `delivered` orders stay `delivered` with `route_id` pointing to finished route
4. They never become `pending` again and never become `completed` unless manually completed
5. **Result**: Orders stuck in `delivered` status, no longer visible in normal workflow

**Scenario 3: Cancelled order deletion ignores `skipped`/`delivered`**
1. Square webhook fires CANCELED for an order currently in `skipped` or `delivered` status
2. `handleSquareOrderUpdate()` only deletes if `status IN ('pending', 'active')`
3. `skipped` and `delivered` orders for a cancelled Square order remain in the system
4. **Result**: Zombie orders for cancelled Square orders
## 3. Route Generation — TODO
## 4. Security — TODO
## 5. Bug Registry

| ID | Severity | File:Line | Current Behavior | Expected Behavior | Suggested Fix |
|----|----------|-----------|-----------------|-------------------|---------------|
| DELIVERY-BUG-001 | **HIGH** | `delivery-service.js:650-660` | `generateRoute(force=true)` cancels old route record but leaves orders on that route in `active`/`skipped`/`delivered` status with stale `route_id`. These orders are orphaned — never picked up by future route generation (`WHERE status = 'pending'`) and cannot be rolled back via `finishRoute()` (rejects non-active routes). | Force-regenerate should roll back non-completed orders on the old route to `pending` (same as `finishRoute()` does) before cancelling it. | Add a statement inside the `if (existingRoute)` block: `UPDATE delivery_orders SET status = 'pending', route_id = NULL, route_position = NULL, route_date = NULL WHERE route_id = $1 AND status IN ('active', 'skipped', 'delivered')` |
| DELIVERY-BUG-002 | **HIGH** | `delivery-service.js:754-758` | `finishRoute()` rolls back `skipped` and `active` orders but **ignores `delivered` orders**. Orders with POD photos stay in `delivered` status with a `route_id` pointing to the now-finished route. They are invisible to the scheduler — neither pending nor completed. | `finishRoute()` should also handle `delivered` orders. Either roll them back to `pending` (unlikely desired — they have PODs), or auto-complete them (more appropriate since POD is captured). | Change `WHERE status IN ('skipped', 'active')` to `WHERE status IN ('skipped', 'active', 'delivered')` and auto-complete delivered orders instead of rolling back: add a separate UPDATE to set `delivered` → `completed` before finishing the route. |
| DELIVERY-BUG-003 | **MEDIUM** | `delivery-service.js:1592-1604` | `handleSquareOrderUpdate(CANCELED)` only deletes orders in `pending` or `active` status. Orders in `skipped` or `delivered` status for a cancelled Square order remain in the system as zombie records. | Cancellation should also remove `skipped` and `delivered` orders, or at minimum mark them completed/cancelled to prevent re-routing. | Expand the status check: `['pending', 'active', 'skipped', 'delivered'].includes(order.status)`. Consider soft-delete (set status to a new `cancelled` value) rather than hard delete to preserve audit trail for orders that had POD photos. |
| DELIVERY-BUG-004 | **MEDIUM** | `delivery-service.js:1063` | `savePodPhoto()` unconditionally sets order status to `delivered` regardless of current status. A `completed` order can be regressed to `delivered` if a POD is uploaded after completion. A `pending` order (not on any route) can be set to `delivered`. | POD upload should only set `delivered` if current status is `active` or if the order is on a route. Should refuse or warn if order is already `completed`. | Add a status guard: only transition to `delivered` if current status is `active`. For `completed` orders, save the POD photo but skip the status change. |
| DELIVERY-BUG-005 | **MEDIUM** | `routes/delivery.js:237-442` | `POST /orders/:id/complete` has no status guard — any order can be marked complete regardless of current status (`pending`, `skipped`, etc.). A pending order not on any route can be completed with Square fulfillment sync attempted. | Should only allow completing orders in `active`, `delivered`, or `skipped` status. Completing a `pending` order that was never on a route is likely a mistake. | Add a status whitelist check after fetching the order: reject if `order.status === 'pending'` or `order.status === 'completed'`. |
| DELIVERY-BUG-006 | **MEDIUM** | `delivery-service.js:489-498` | `skipOrder()` has no status guard — any order in any status can be skipped. It also hardcodes `previousStatus: 'active'` in the audit log regardless of actual previous status. | Should only allow skipping `active` orders (orders currently on a route). Audit log should record actual previous status. | Add guard: `if (order.status !== 'active') throw new Error('...')`. Pass actual `order.status` into the audit event `previousStatus` field. |
| DELIVERY-BUG-007 | **LOW** | `delivery-service.js:1294-1305` | `logAuditEvent()` never populates the `ip_address` or `user_agent` columns despite them existing in the schema. All audit records have NULL for these fields. | Audit trail should include IP and user-agent for accountability, especially for token-based driver actions. | Accept optional `req` parameter in `logAuditEvent()` and extract `req.ip` and `req.get('user-agent')`. Pass `req` from route handlers. |
| DELIVERY-BUG-008 | **LOW** | `delivery-service.js:1111-1142` | `cleanupExpiredPods()` function exists and works correctly, but is **never called** by any cron job. The `expires_at` column is populated but expired POD files accumulate forever on disk. | Should be invoked by a scheduled job (daily). | Add a `pod-cleanup-job.js` to `jobs/` and register it in `cron-scheduler.js`. |
| DELIVERY-BUG-009 | **LOW** | `routes/delivery.js:927` | `POST /backfill-customers` endpoint has no input validator — it goes straight to `asyncHandler` with only `requireAuth` and `requireMerchant`. All other delivery endpoints have validators. | Should have a validator, even if empty, for consistency and future-proofing. | Add `validators.backfillCustomers` (can be `[handleValidationErrors]` — no params to validate, but pattern is consistent). |
| DELIVERY-BUG-010 | **LOW** | `routes/driver-api.js:77-82,93-101,113-117` | Three authenticated share-management endpoints (`POST /route/:id/share`, `GET /route/:id/token`, `DELETE /route/:id/token`) use raw `res.json()` instead of `sendSuccess()`/`sendError()` response helpers. | Should use response helpers for consistent API contract (`{ success: true, ... }`). | Replace `res.json(...)` with `sendSuccess(res, ...)` and import `sendSuccess`/`sendError` from `utils/response-helper`. |
| DELIVERY-BUG-011 | **LOW** | `routes/driver-api.js:125-220` | All public driver endpoints use raw `res.json({ error: ... })` and `res.status(N).json(...)` instead of `sendError()`. Inconsistent error shape (`{ error }` vs `{ success: false, error, code }`). | Use `sendSuccess`/`sendError` for consistent API responses. | Import and use response helpers throughout `driver-api.js`. |
| DELIVERY-BUG-012 | **LOW** | `delivery-stats.js:164-167` | `resolveCustomerId()` logs customer phone number at debug level: `phone: order.phone`. PII in logs. | Phone numbers should not appear in log output per CLAUDE.md security rules. | Remove `phone` from the log context object, or replace with `hasPhone: !!order.phone`. |
| DELIVERY-BUG-013 | **INFO** | `delivery-service.js:493-495` | `skipOrder()` audit log always records `previousStatus: 'active'` as a hardcoded string rather than querying the actual previous status of the order. | Should record the real previous status for accurate audit trail. | Fetch order before update, capture `order.status`, then pass as `previousStatus` in audit details. |
## 6. Module Breakdown — TODO
## 7. CSS Findings — TODO
## 8. Test Coverage — TODO
## 9. Fix Plan — TODO
