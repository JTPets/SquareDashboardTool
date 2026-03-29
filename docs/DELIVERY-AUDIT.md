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
## 3. Route Generation

### 3a. Order Selection

**Query** (`delivery-service.js:611-621`):
```sql
SELECT * FROM delivery_orders
WHERE merchant_id = $1 AND status = 'pending'
  AND geocoded_at IS NOT NULL
```

**Eligibility criteria** — all three must be true:
1. `status = 'pending'` — only unassigned orders
2. `geocoded_at IS NOT NULL` — address must be geocoded (has lat/lng)
3. `merchant_id = $1` — tenant isolation

### 3b. Manual Include / Exclude

| Capability | Supported | How |
|-----------|-----------|-----|
| **Include specific orders** | Yes | Pass `orderIds` array in options → appends `AND id = ANY($2)` to the WHERE clause (line 618-620). Only orders matching the eligibility criteria AND in the array are selected. |
| **Exclude specific orders** | **No** | No exclusion mechanism exists. To exclude orders, you must either change their status away from `pending` or remove their geocode. There is no `excludeIds` parameter. |

### 3c. Start / End Point Source

| Point | Source | Fallback |
|-------|--------|----------|
| **Start** | `delivery_settings.start_address_lat/lng` per merchant (line 817-821) | None — throws `'Start address not geocoded'` if missing |
| **End** | `delivery_settings.end_address_lat/lng` per merchant (line 831-835) | Returns to start point if end not configured: `coordinates.push(coordinates[0])` |

Start/end are **per-merchant**, not per-route. Set once in delivery settings, used for all routes.

### 3d. ORS Integration

**Endpoint**: `POST https://api.openrouteservice.org/optimization` (VROOM-based TSP solver)

**API key priority** (`delivery-service.js:802`):
1. Merchant setting `openrouteservice_api_key` (decrypted from `ors_api_key_encrypted` via AES-256-GCM)
2. Environment variable `OPENROUTESERVICE_API_KEY`
3. If neither → fallback to creation-time ordering (no optimization)

**Request shape** (`delivery-service.js:845-857`):
```json
{
  "jobs": [
    { "id": 1, "location": [lng, lat], "service": 300 },
    { "id": 2, "location": [lng, lat], "service": 300 }
  ],
  "vehicles": [{
    "id": 1,
    "profile": "driving-car",
    "start": [startLng, startLat],
    "end": [endLng, endLat]
  }]
}
```

- **Service time**: Hardcoded 300 seconds (5 min) per stop
- **Vehicle profile**: `driving-car` (hardcoded)
- **Single vehicle**: Only one vehicle/driver supported per route
- **Coordinates**: `[lng, lat]` order (GeoJSON convention)

**Response handling** (`delivery-service.js:867-878`):
- Extracts `routes[0].steps` filtered to `type === 'job'`
- Maps step job IDs back to order IDs: `orderCoords[step.job - 1].id`
- Distance converted from meters to km (`/ 1000`)
- Duration converted from seconds to minutes (`/ 60`, rounded)

**Error handling** (`delivery-service.js:638-648, 888-891`):
- `optimizeRoute()` throws on ORS errors
- `generateRoute()` catches the throw and falls back to creation-time ordering:
  ```js
  orderedIds: pendingOrders.map(o => o.id)  // insertion order
  ```
- Sets `distance: null, duration: null` on fallback (no estimates available)

### 3e. Geocoding

**Endpoint**: `GET https://api.openrouteservice.org/geocode/search` (Pelias-based)

**Query params**: `api_key={key}&text={encodedAddress}&size=1` — returns single best match.

**Batch geocoding** (`geocodePendingOrders`, line 949-985):
- Selects orders with `geocoded_at IS NULL`, limited to `$2` (default 10)
- Processes sequentially with 100ms sleep between requests (naive rate limiting)
- Updates `address_lat`, `address_lng`, `geocoded_at` per order

**Inline geocoding** (`ingestSquareOrder`, line 1544-1561):
- Each ingested order is geocoded immediately after creation
- Failure does not block order creation (catch-and-log)

### 3f. Route Generation Flow (Summary)

```
generateRoute(merchantId, userId, options)
  │
  ├─ 1. Check for existing active route (getActiveRoute)
  │     └─ If exists and !force → throw error
  │
  ├─ 2. Load merchant settings (start/end addresses)
  │     └─ If no start address → throw error
  │
  ├─ 3. Query eligible orders (pending + geocoded + optional ID filter)
  │     └─ If 0 orders → throw error
  │
  ├─ 4. Call optimizeRoute(settings, orders)
  │     ├─ No API key → fallback to creation order
  │     ├─ ORS POST /optimization → TSP-optimized order
  │     └─ ORS error → fallback to creation order
  │
  └─ 5. Transaction:
        ├─ Cancel existing active route (if force=true)
        ├─ INSERT delivery_routes record
        ├─ UPDATE each order: route_id, route_position, status='active'
        └─ COMMIT
```
## 4. Security

### 4a. SQL Query Audit — `delivery-service.js`

Every SQL query was reviewed for parameterization and `merchant_id` filtering.

| Function | Line | Query Type | Parameterized | merchant_id Filter | Notes |
|----------|------|-----------|---------------|-------------------|-------|
| `getOrders()` | 233-289 | SELECT dynamic | Yes (`$1`-`$N`) | Yes (`$1`) | Dynamic WHERE builder — all filters added via `$N` placeholders |
| `getOrderById()` | 303-312 | SELECT | Yes (`$1,$2`) | Yes (`$2`) | Also validates UUID format before query |
| `getOrderBySquareId()` | 323-328 | SELECT | Yes (`$1,$2`) | Yes (`$2`) | — |
| `createOrder()` | 359-389 | INSERT/UPSERT | Yes (`$1`-`$15`) | Yes (`$1`) | ON CONFLICT uses partial unique index with merchant_id |
| `updateOrder()` | 447-452 | UPDATE dynamic | Yes (`$N`) | Yes (last param) | Field names from allowedFields whitelist (code-controlled, not user input) |
| `deleteOrder()` | 466-473 | DELETE | Yes (`$1,$2`) | Yes (`$2`) | Also guards on `square_order_id IS NULL` and status |
| `getActiveRoute()` | 547-557 | SELECT + subqueries | Yes (`$1,$2`) | Yes (`$1`) | Subqueries on delivery_orders lack merchant_id but are scoped by `route_id` from merchant-filtered parent |
| `getRouteWithOrders()` | 569-572 | SELECT | Yes (`$1,$2`) | Yes (`$2`) | — |
| `generateRoute()` | 611-621 | SELECT | Yes (`$1`[,`$2`]) | Yes (`$1`) | Optional `orderIds` via `ANY($2)` |
| `generateRoute()` | 657-659 | UPDATE (cancel) | Yes (`$1`) | **No** | Safe: `existingRoute.id` from merchant-filtered `getActiveRoute()` |
| `generateRoute()` | 664-678 | INSERT route | Yes (`$1`-`$7`) | Yes (`$1`) | — |
| `generateRoute()` | 684-689 | UPDATE orders | Yes (`$1`-`$5`) | Yes (`$5`) | Per-order update within transaction |
| `finishRoute()` | 727-729 | SELECT route | Yes (`$1,$2`) | Yes (`$2`) | Within transaction |
| `finishRoute()` | 742-749 | SELECT stats | Yes (`$1`) | **No** | Safe: `routeId` from merchant-filtered SELECT above |
| `finishRoute()` | 754-758 | UPDATE orders | Yes (`$1`) | **No** | Safe: `routeId` from merchant-filtered SELECT above, within same transaction |
| `finishRoute()` | 762-766 | UPDATE route | Yes (`$1`) | **No** | Safe: same verified `routeId` |
| `geocodePendingOrders()` | 953-958 | SELECT | Yes (`$1,$2`) | Yes (`$1`) | — |
| `geocodePendingOrders()` | 967-970 | UPDATE | Yes (`$1,$2,$3`) | **No** | **CONCERN**: Updates by `id` only, no `merchant_id` re-check. Orders were selected with merchant_id but UPDATE lacks it. Low risk (IDs are UUIDs from the same query) but defense-in-depth violation. |
| `savePodPhoto()` | 1050-1059 | INSERT pod | Yes (`$1`-`$8`) | **No** (implicit) | `orderId` verified via `getOrderById(merchantId, orderId)` first. Pod table lacks merchant_id column — scoped via FK to delivery_orders. |
| `getPodPhoto()` | 1080-1085 | SELECT + JOIN | Yes (`$1,$2`) | Yes (`$2`) | Joins through delivery_orders for merchant_id check |
| `cleanupExpiredPods()` | 1112-1116 | SELECT | No params | **No** | System-wide cleanup (intentional — no merchant scope). No user input. |
| `cleanupExpiredPods()` | 1126,1134 | DELETE | Yes (`$1`) | **No** | By pod `id` from system query above. Intentional. |
| `getSettings()` | 1154-1157 | SELECT | Yes (`$1`) | Yes (`$1`) | — |
| `_decryptOrsKey()` | 1196-1200 | UPDATE (migration) | Yes (`$1,$2`) | Yes (`$2`) | Fire-and-forget encrypt-on-read |
| `updateSettings()` | 1243-1268 | INSERT/UPSERT | Yes (`$1`-`$11`) | Yes (`$1`) | ON CONFLICT (merchant_id) |
| `logAuditEvent()` | 1296-1300 | INSERT | Yes (`$1`-`$6`) | Yes (`$1`) | — |
| `getAuditLog()` | 1316-1342 | SELECT dynamic | Yes (`$1`-`$N`) | Yes (`$1`) | Dynamic WHERE builder |
| `ingestSquareOrder()` | via `createOrder` | INSERT/UPSERT | Yes | Yes | Delegates to `createOrder()` |
| `handleSquareOrderUpdate()` | via `updateOrder` | UPDATE | Yes | Yes | Delegates to `updateOrder()` |
| `handleSquareOrderUpdate()` | 1595-1598 | DELETE | Yes (`$1,$2`) | Yes (`$2`) | Direct delete for cancelled orders |
| `generateRouteToken()` | 1624-1627 | SELECT route | Yes (`$1,$2`) | Yes (`$2`) | Validates route belongs to merchant |
| `generateRouteToken()` | 1639-1643 | UPDATE revoke | Yes (`$1`) | **No** | Safe: `routeId` from merchant-filtered query above |
| `generateRouteToken()` | 1654-1659 | INSERT token | Yes (`$1`-`$5`) | Yes (`$1`) | — |
| `getRouteByToken()` | 1682-1697 | SELECT + JOINs | Yes (`$1`) | **No** | Intentional: public endpoint, token is the auth. No merchant_id filter needed. |
| `getRouteByToken()` | 1713-1715 | UPDATE expired | Yes (`$1`) | **No** | By token record `id` — safe |
| `getRouteByToken()` | 1726-1728 | UPDATE used_at | Yes (`$1`) | **No** | By token record `id` — safe |
| `revokeRouteToken()` | 1873-1877 | UPDATE | Yes (`$1,$2`) | Yes (`$2`) | — |
| `getActiveRouteToken()` | 1895-1901 | SELECT | Yes (`$1,$2`) | Yes (`$1`) | — |
| `backfillUnknownCustomers()` | 1914-1923 | SELECT | Yes (`$1`) | Yes (`$1`) | — |
| `finishRouteByToken()` | 1848-1852 | UPDATE token | Yes (`$1`-`$3`) | **No** | By token record `id` from validated `getRouteByToken()` — safe |

### 4b. SQL Query Audit — `delivery-stats.js`

| Function | Line | Query Type | Parameterized | merchant_id Filter | Notes |
|----------|------|-----------|---------------|-------------------|-------|
| `getLocationIds()` | 25-28 | SELECT | Yes (`$1`) | Yes (`$1`) | — |
| `getDashboardStats()` | 353-358 | SELECT (status counts) | Yes (`$1`) | Yes (`$1`) | — |
| `getDashboardStats()` | 362-368 | SELECT (completions) | Yes (`$1`) | Yes (`$1`) | — |

### 4c. SQL Query Audit — `routes/delivery.js` and `routes/driver-api.js`

**No direct SQL queries found.** Both route files delegate all database operations to the service layer (`services/delivery`). This is correct per CLAUDE.md architecture rules.

### 4d. Unparameterized Query Summary

**Zero unparameterized queries with user-controlled input.** All SQL uses `$N` placeholders.

The only queries without parameters are:
- `cleanupExpiredPods()` — system-wide cleanup, no user input
- Static string comparisons in WHERE clauses (e.g., `status = 'pending'`)

### 4e. Driver Token Scoping

Token-based public endpoints follow a consistent security pattern:

```
getRouteByToken(token)
  → Returns { merchant_id, route_id, valid, ... }
  → All subsequent operations use:
      getOrderById(tokenData.merchant_id, orderId)  ← merchant isolation
      AND order.route_id === tokenData.route_id      ← route scoping
```

| Token Function | merchant_id Used | route_id Verified | Notes |
|---------------|-----------------|-------------------|-------|
| `completeOrderByToken()` | Yes (from token) | Yes (line 1775) | — |
| `skipOrderByToken()` | Yes (from token) | Yes (line 1798) | — |
| `savePodByToken()` | Yes (from token) | Yes (line 1822) | — |
| `finishRouteByToken()` | Yes (from token) | Implicit (finishes token's route) | — |
| `getRouteOrdersByToken()` | Yes (from token) | Yes (queries by routeId) | — |

**Token properties**: 64-char hex (256-bit entropy via `crypto.randomBytes(32)`), configurable expiry (default 24h), single active token per route (partial unique index), revocable by merchant.

### 4f. Hardcoded Values

| Value | Location | Risk |
|-------|----------|------|
| `ORS_BASE_URL = 'https://api.openrouteservice.org'` | Line 26 | **None** — stable API base URL, acceptable constant |
| `service: 300` (5 min per stop) | Line 849 | **Low** — not configurable per merchant. May not suit all delivery scenarios. |
| `profile: 'driving-car'` | Line 852 | **Low** — not configurable. Fine for current use (pet food delivery). |
| `expiresInHours = 24` | Line 1621 | **None** — default, overridable per request |
| `POD_STORAGE_DIR = 'storage/pod'` | Line 23 | **None** — env-overridable |
| `limit = 10` (geocode batch) | Line 949 | **Low** — parameter with default, overridable |
| `100ms` rate limit sleep | Line 981 | **Low** — naive rate limiting, not configurable |
| `'Unknown Customer'` sentinel | Lines 1392, 1467, 1918 | **Low** — used as comparison string in multiple places. A constant would be cleaner. |

No hardcoded merchant IDs, location IDs, coordinates, or secrets found.

### 4g. Additional Security Observations

1. **UUID validation**: `validateUUID()` called before `getOrderById()` and `savePodPhoto()` (lines 301, 1008). Prevents malformed ID injection.

2. **POD path traversal protection**: `getPodPhoto()` (line 1093-1101) resolves the file path and verifies it starts with the expected storage prefix. Correct implementation.

3. **POD magic byte validation**: `savePodPhoto()` (lines 1011-1019) checks JPEG/PNG/GIF/WebP magic bytes. File extension derived from detected type, not user input (line 1034).

4. **Rate limiting**: Public driver endpoints use IP-based rate limiting via `configureDeliveryRateLimit()` and `configureDeliveryStrictRateLimit()` (driver-api.js:38-39). POD upload uses the stricter limiter.

5. **Input validation**: All endpoints have express-validator middleware. Token format validated as 64-char hex regex.

6. **ORS API key at rest**: Encrypted with AES-256-GCM via `utils/token-encryption`. Encrypt-on-read migration from plaintext column. Key never logged.

7. **`updateOrder()` dynamic SET clause** (line 428-438): Field names come from a hardcoded `allowedFields` whitelist, not user input. The `snakeKey` conversion uses `key.replace(/[A-Z]/g, ...)` on object keys from internal callers. No SQL injection risk.

### 4h. Security Findings

| ID | Severity | Finding | Location |
|----|----------|---------|----------|
| SEC-1 | **LOW** | `geocodePendingOrders()` UPDATE lacks `merchant_id` in WHERE clause. Orders were selected with merchant_id but the UPDATE only uses `WHERE id = $3`. Defense-in-depth violation — add `AND merchant_id = $4`. | `delivery-service.js:967-970` |
| SEC-2 | **INFO** | `delivery-stats.js:164-167` logs customer phone at debug level (`phone: order.phone`). PII in logs. Same as BUG-012. | `delivery-stats.js:164` |
| SEC-3 | **INFO** | `routes/driver-api.js` public endpoints return `{ error: ... }` instead of `{ success: false, error: ... }` — inconsistent error shape could leak info about endpoint types. Same as BUG-011. | `routes/driver-api.js:129-134` |
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
## 6. Module Breakdown Map — `delivery-service.js` (2,031 lines)

Per CLAUDE.md refactor-on-touch policy: this file exceeds the 300-line limit by 7x. The table below documents extraction targets.

| # | Module Name | Responsibility | Line Range | Lines | Dependencies | Extraction Risk |
|---|-------------|---------------|------------|-------|-------------|-----------------|
| 1 | **Utilities** | `safeJsonStringify()`, `validateUUID()`, UUID regex, constants (`POD_STORAGE_DIR`, `ORS_BASE_URL`, `ORS_API_KEY`) | 1–55 | 55 | `token-encryption`, `path`, `fs`, `crypto`, `loyalty-admin/customer-details-service` | **Low** — Pure functions + constants. Extract to `delivery-utils.js`. The `getSquareCustomerDetails` import only used by Square Integration and Customer Backfill modules. |
| 2 | **GTIN Enrichment** | `enrichLineItemsWithGtin()`, `enrichOrdersWithGtin()` — UPC lookup for line items at ingest/display time | 56–213 | 158 | `utils/database` | **Low** — Self-contained. Only called by `ingestSquareOrder()` and `getRouteWithOrders()`. Extract to `delivery-gtin.js`. |
| 3 | **Order CRUD** | `getOrders()`, `getOrderById()`, `getOrderBySquareId()`, `createOrder()`, `updateOrder()`, `deleteOrder()`, `skipOrder()`, `markDelivered()`, `completeOrder()` | 214–532 | 319 | `utils/database`, Audit module (for `logAuditEvent`) | **Medium** — Core module. Many other modules depend on `getOrderById()`, `updateOrder()`, `createOrder()`. Extract to `delivery-orders.js`. Circular dependency risk with Audit module (both in same file currently). |
| 4 | **Route Management** | `getActiveRoute()`, `getRouteWithOrders()`, `generateRoute()`, `finishRoute()`, `optimizeRoute()` | 534–892 | 359 | `utils/database`, Order CRUD (for `getOrders`, `updateOrder`), Settings (for `getSettings`), GTIN Enrichment, Audit | **Medium** — Heavy cross-module coupling. `generateRoute()` uses Settings, Order CRUD, and ORS optimization. `finishRoute()` uses Order CRUD and Audit. Extract to `delivery-routes.js`. Will need imports from 3–4 sibling modules. |
| 5 | **Geocoding** | `geocodeAddress()`, `geocodePendingOrders()` | 894–985 | 92 | `utils/database`, Settings (for API key), external `fetch` | **Low** — Two functions, clean boundary. Only inbound dependency: `ingestSquareOrder()` calls `geocodeAddress()`. Extract to `delivery-geocoding.js`. |
| 6 | **POD Storage** | `savePodPhoto()`, `getPodPhoto()`, `cleanupExpiredPods()` | 987–1142 | 156 | `utils/database`, `fs`, `path`, `crypto`, Order CRUD (for `getOrderById`, `updateOrder`), Settings (for retention) | **Low** — Well-isolated I/O module. Extract to `delivery-pod.js`. |
| 7 | **Settings** | `getSettings()`, `_decryptOrsKey()`, `updateSettings()` | 1144–1279 | 136 | `utils/database`, `token-encryption` | **Low** — Self-contained. Many modules depend on this (Route, Geocoding, POD). Extract to `delivery-settings.js`. Should be extracted first since others depend on it. |
| 8 | **Audit** | `logAuditEvent()`, `getAuditLog()` | 1281–1344 | 64 | `utils/database` | **Very Low** — Minimal code, no dependencies on other delivery modules. Extract to `delivery-audit.js`. |
| 9 | **Square Integration** | `ingestSquareOrder()`, `handleSquareOrderUpdate()` | 1346–1606 | 261 | `utils/database`, Order CRUD, Geocoding, Settings, GTIN Enrichment, `loyalty-admin/customer-details-service` | **High** — Largest dependency fan-out. Calls into 5 other modules. Extract to `delivery-square.js`. Must be extracted after all its dependencies. |
| 10 | **Route Tokens** | `generateRouteToken()`, `getRouteByToken()`, `getRouteOrdersByToken()`, `completeOrderByToken()`, `skipOrderByToken()`, `savePodByToken()`, `finishRouteByToken()`, `revokeRouteToken()`, `getActiveRouteToken()` | 1608–1904 | 297 | `utils/database`, Order CRUD, Route Management, POD Storage | **Medium** — 9 functions but consistent pattern (validate token → delegate to core function). Extract to `delivery-tokens.js`. |
| 11 | **Customer Backfill** | `backfillUnknownCustomers()` | 1906–1979 | 74 | `utils/database`, Order CRUD, `loyalty-admin/customer-details-service` | **Very Low** — Single function, minimal coupling. Extract to `delivery-backfill.js` or merge into Square Integration. |

### Recommended Extraction Order

Extract in dependency order (leaves first):

1. **Settings** (no delivery-module deps) → `delivery-settings.js`
2. **Audit** (no delivery-module deps) → `delivery-audit.js`
3. **Utilities + GTIN** → `delivery-utils.js`, `delivery-gtin.js`
4. **Geocoding** → `delivery-geocoding.js`
5. **POD Storage** → `delivery-pod.js`
6. **Order CRUD** (depends on Audit) → `delivery-orders.js`
7. **Route Management** (depends on Orders, Settings) → `delivery-routes.js`
8. **Route Tokens** (depends on Orders, Routes, POD) → `delivery-tokens.js`
9. **Square Integration** (depends on everything) → `delivery-square.js`
10. **Customer Backfill** → fold into `delivery-square.js` or standalone

### Dependency Graph

```
Settings ◄── Route Management ◄── Route Tokens
   ▲              ▲                    ▲
   │              │                    │
Geocoding    Order CRUD ◄──────── Square Integration
   ▲              ▲                    │
   │              │                    │
   │         POD Storage               │
   │              ▲                    │
   │              │                    │
   └──── GTIN Enrichment ◄────────────┘
                  ▲
                  │
              Utilities
                  ▲
                  │
               Audit (independent)
```
## 7. CSS Findings

All five delivery HTML pages have inline `<style>` blocks, violating the CLAUDE.md rule: _"No new `<style>` blocks in HTML pages. All shared styles go in `public/css/shared.css`."_

### 7a. Inline Style Inventory

| File | `<style>` Lines | Line Count | `shared.css` Linked | Notes |
|------|----------------|-----------|---------------------|-------|
| `delivery.html` | 7–371 | 365 | **No** | Largest after route pages |
| `delivery-route.html` | 7–552 | 546 | Yes (line 553) | Largest style block of all delivery pages |
| `delivery-history.html` | 7–308 | 302 | **No** | — |
| `delivery-settings.html` | 7–183 | 177 | **No** | Smallest |
| `driver.html` | 7–554 | 548 | Yes (line 555) | Nearly identical to delivery-route.html styles |
| **Total** | — | **1,938** | 2 of 5 | — |

### 7b. Utility Script Chain Audit

CLAUDE.md required order: `escape.js` → `toast.js` → `format-currency.js` → `date-format.js` → page script.
Rule: _"Only include utilities the page's JS actually uses."_

| File | escape.js | toast.js | format-currency.js | date-format.js | Correct? | Issue |
|------|-----------|----------|--------------------|---------------|----------|-------|
| `delivery.html` | Yes (L578) | **No** | No | **No** | **Partial** | JS uses `escapeHtml` only — escape.js sufficient. No toast/date calls. OK. |
| `delivery-route.html` | Yes (L691) | Yes (L694) | No | Yes (L692) | **Yes** | JS uses `escapeHtml`, `showToast`, `formatDateTime`. All needed scripts present. |
| `delivery-history.html` | Yes (L380) | **No** | No | Yes (L381) | **Partial** | JS uses `formatDateTime` and `escapeHtml`. No toast calls — OK to omit. |
| `delivery-settings.html` | Yes (L308) | **No** | No | **No** | **Yes** | JS uses `escapeHtml` only. No toast/date/currency calls. OK. |
| `driver.html` | Yes (L636) | Yes (L638) | No | Yes (L640) | **Yes** | JS uses `escapeHtml`, `escapeAttr`, `showToast`, `formatDate`. All present. |

**No missing utility scripts detected.** Each page includes only what its JS actually calls. No `format-currency.js` needed (no currency formatting in delivery pages). Script order is correct where multiple utilities are included.

### 7c. Shared CSS Component Candidates

CSS classes duplicated across 3+ delivery pages that should be extracted to `shared.css`:

| Component | Classes | Found In | Approx Lines per File |
|-----------|---------|----------|----------------------|
| **Layout** | `.container`, `.header`, `.header h1` | All 5 pages | 15–25 |
| **Buttons** | `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-success`, `.btn-warning`, `.btn-danger` | All 5 pages | 30–50 |
| **Status badges** | `.status-active`, `.status-completed`, `.status-skipped`, `.status-delivered`, `.status-pending` | delivery.html, delivery-route.html, delivery-history.html, driver.html | 15–20 |
| **Modals** | `.modal-overlay`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer` | delivery.html, delivery-route.html, delivery-history.html, driver.html | 25–35 |
| **Stop cards** | `.stop-card`, `.stop-header`, `.stop-number`, `.stop-customer`, `.stop-address`, `.stop-phone`, `.stop-notes` | delivery-route.html, driver.html | 50–70 |
| **Progress bar** | `.progress-bar`, `.progress-fill` | delivery.html, delivery-route.html, driver.html | 10–15 |
| **Empty state** | `.empty-state` | delivery.html, delivery-route.html, delivery-history.html, driver.html | 8–12 |
| **Forms** | `.form-group`, `.form-label`, `.form-input` | delivery.html, delivery-settings.html | 15–20 |
| **Alerts** | `.alert`, `.alert-success`, `.alert-error` | delivery.html, delivery-settings.html, delivery-history.html | 8–12 |

**Estimated deduplication**: Extracting these shared components to `shared.css` would eliminate ~600–800 lines of duplicated CSS across the five files. Each file would retain only truly page-specific styles (estimated 50–150 lines each).

### 7d. delivery-route.html vs driver.html Overlap

These two pages share ~90% of their CSS (stop cards, status badges, progress bars, modals, POD styling). The main differences:
- `driver.html` has finish-route form styles
- `delivery-route.html` has customer stats badge styles and share modal styles

A shared `delivery-shared.css` for delivery-specific components (stop cards, status badges, progress) would collapse ~500 lines of duplication between just these two files.
## 8. Test Coverage

### Test Files

| File | Tests | Focus |
|------|-------|-------|
| `__tests__/services/delivery/delivery-service.test.js` | ~60 | Existing: CRUD, geocoding, POD, settings, ingestion, tokens, GTIN, backfill, audit |
| `__tests__/services/delivery/order-lifecycle.test.js` | 46 | **New (this audit)**: Status transitions, finishRoute per-status, force-regenerate orphans, route planning query, bug behavior snapshots |

### order-lifecycle.test.js Coverage Map

| Section | Tests | What's Covered |
|---------|-------|----------------|
| Order Creation — Initial Status | 5 | Manual order → pending, Square upsert, conflict handling, geocoded_at logic |
| Route Generation — Order Assignment | 3 | Pending → active, WHERE clause verification, orderIds filter |
| Route Planning Query — Status Filtering | 3 | Only pending selected, active/skipped/delivered/completed excluded, geocoded_at required |
| finishRoute() — Status-Specific | 8 | Skipped → pending, active → pending, completed untouched, **delivered ignored (BUG-002)**, field clearing, transaction BEGIN/COMMIT/ROLLBACK |
| Force-Regenerate — Cancelled Route | 4 | **Old route orders NOT reset (BUG-001)**, orphaned orders excluded from new route, force vs non-force |
| skipOrder — Status Guard | 3 | Happy path, **no status guard (BUG-006)**, **hardcoded previousStatus (BUG-013)** |
| completeOrder — Status Guard | 3 | Happy path, **no status guard (BUG-005)**, audit details |
| savePodPhoto — Status Transition | 2 | Active → delivered, **completed regresses to delivered (BUG-004)** |
| handleSquareOrderUpdate — Cancellation | 7 | Pending/active deleted, **skipped/delivered NOT deleted (BUG-003)**, completed safe, COMPLETED transition, no-op for unknown |
| deleteOrder — Guard Conditions | 4 | Manual delete, Square-linked blocked, completed blocked, merchant_id scoping |
| markDelivered | 1 | Status → delivered |
| Full Lifecycle Sequence | 1 | pending → delivered → completed happy path |

### Bug Behavior Snapshots

Tests that document current broken behavior (will fail when bugs are fixed):

| Bug ID | Test Description | Expected Fix Behavior |
|--------|-----------------|----------------------|
| BUG-001 | `cancels existing route but does NOT reset its orders` | Should reset old-route orders to pending |
| BUG-002 | `does NOT roll back delivered orders` | Should auto-complete delivered or roll back to pending |
| BUG-003 | `does NOT delete skipped/delivered order on CANCELED` | Should delete or mark cancelled |
| BUG-004 | `overwrites completed status with delivered — no guard` | Should skip status change for completed orders |
| BUG-005 | `allows completing a pending order — no status guard` | Should reject non-route orders |
| BUG-006 | `allows skipping a pending order — no status guard` | Should reject non-active orders |
| BUG-013 | `hardcodes previousStatus as active in audit log` | Should record actual previous status |

### Gaps — Not Yet Covered

| Area | Why | Priority |
|------|-----|----------|
| Route optimization (ORS integration) | Covered in delivery-service.test.js | — |
| POD photo validation (magic bytes) | Covered in delivery-service.test.js | — |
| Token-based driver operations | Covered in delivery-service.test.js | — |
| `routes/delivery.js` complete handler (200-line Square fulfillment logic) | Route-level integration test needed | Medium |
| `routes/driver-api.js` response format | Needs route-level test for sendSuccess/sendError | Low |
| Webhook handler `order-delivery.js` | Needs dedicated test file | Medium |
| Frontend JS (delivery.js, driver.js) | No framework for frontend testing | Low |
## 9. Proposed Fix Plan

### Phase 1: Stuck-Order Fix (DELIVERY-BUG-001, BUG-002, BUG-003)

**Goal**: Eliminate all stuck-order scenarios identified in Section 2h.

| Item | Detail |
|------|--------|
| **Files modified** | `services/delivery/delivery-service.js` |
| **Changes** | 1. `generateRoute()` (L656-660): Add `UPDATE delivery_orders SET status='pending', route_id=NULL, route_position=NULL, route_date=NULL WHERE route_id=$1 AND status IN ('active','skipped','delivered')` before cancelling old route. 2. `finishRoute()` (L754-758): Add separate UPDATE to set `delivered` → `completed` before rolling back `skipped`/`active`. 3. `handleSquareOrderUpdate()` (L1592-1604): Expand cancellation status check to include `skipped` and `delivered`. |
| **Risk** | **Medium** — touches core state machine. Must verify no order is silently lost. |
| **Effort** | Small — ~20 lines changed across 3 functions. |
| **Dependencies** | None — can be done first. |
| **Tests required** | Unit tests for each scenario: force-regenerate with active/skipped/delivered orders on old route; finishRoute with delivered orders; cancel webhook with skipped/delivered orders. Integration test: full lifecycle through force-regenerate. |

### Phase 2: Manual Order Selection for Routes

**Goal**: Allow merchants to exclude specific orders from route generation.

| Item | Detail |
|------|--------|
| **Files modified** | `services/delivery/delivery-service.js` (`generateRoute`), `middleware/validators/delivery.js`, `public/js/delivery.js`, `public/delivery.html` |
| **Changes** | 1. Add `excludeIds` parameter to `generateRoute()` options → `AND id != ANY($N)`. 2. Add validator for `excludeIds` (array of UUIDs). 3. Frontend: add checkboxes to order list, pass excluded order IDs to generate route API call. |
| **Risk** | **Low** — additive feature, no existing behavior changes. |
| **Effort** | Medium — backend ~15 lines, frontend ~40 lines (UI for checkboxes + wire-up). |
| **Dependencies** | Phase 1 (stuck-order fix) should land first so excluded orders don't get stuck. |
| **Tests required** | Unit test: generateRoute with excludeIds excludes correct orders. Integration test: generate route with 5 pending orders, exclude 2, verify 3 on route. |

### Phase 3: Per-Route Start/End Override

**Goal**: Allow overriding start/end points per route generation (currently per-merchant only).

| Item | Detail |
|------|--------|
| **Files modified** | `services/delivery/delivery-service.js` (`generateRoute`, `optimizeRoute`), `middleware/validators/delivery.js`, `routes/delivery.js` (generate route endpoint), `public/js/delivery.js`, `public/delivery.html` |
| **Changes** | 1. Accept optional `startLat/Lng`, `endLat/Lng` in `generateRoute()` options. 2. Pass overrides to `optimizeRoute()`, falling back to settings if not provided. 3. Store overrides in `delivery_routes` table (may need columns: `start_lat`, `start_lng`, `end_lat`, `end_lng`). 4. Frontend: optional address override fields in generate-route modal. |
| **Risk** | **Low** — additive, settings remain the default. |
| **Effort** | Medium — backend ~30 lines, frontend ~50 lines, possible schema change (4 nullable columns on delivery_routes). |
| **Dependencies** | None, but logically follows Phase 2. |
| **Tests required** | Unit: generate route with override coords uses them instead of settings. Unit: generate route without override uses settings as before. |

### Phase 4: delivery-service.js Monolith Split

**Goal**: Split `delivery-service.js` (2,031 lines) into ~10 modules per the Section 6 breakdown map.

| Item | Detail |
|------|--------|
| **Files modified** | `services/delivery/delivery-service.js` (split into new files), `services/delivery/index.js` (update barrel exports) |
| **New files** | `delivery-settings.js`, `delivery-audit.js` (already exists as `delivery-stats.js` — rename or new), `delivery-utils.js`, `delivery-gtin.js`, `delivery-geocoding.js`, `delivery-pod.js`, `delivery-orders.js`, `delivery-routes.js`, `delivery-tokens.js`, `delivery-square.js` |
| **Changes** | Extract modules per Section 6 extraction order. Update `index.js` to re-export from all modules. All existing callers import from `services/delivery` (barrel) so no external import paths change. |
| **Risk** | **Medium** — large refactor but purely structural (no logic changes). Circular dependency risk between Order CRUD ↔ Audit (both call each other). Must resolve by passing audit function as parameter or lazy require. |
| **Effort** | Large — ~2,031 lines reorganized into 10 files. Mechanical but tedious. |
| **Dependencies** | Phases 1–3 should land first to avoid merge conflicts during the split. |
| **Tests required** | Existing test suite must pass with zero changes (all public API unchanged). Add a barrel-export test verifying every function is still accessible from `require('services/delivery')`. |

### Phase 5: CSS Cleanup → shared.css

**Goal**: Eliminate inline `<style>` blocks from all 5 delivery HTML pages per CLAUDE.md rules.

| Item | Detail |
|------|--------|
| **Files modified** | `public/css/shared.css`, `public/delivery.html`, `public/delivery-route.html`, `public/delivery-history.html`, `public/delivery-settings.html`, `public/driver.html` |
| **New files** | `public/css/delivery-shared.css` (optional — for delivery-specific components like stop cards, status badges) |
| **Changes** | 1. Extract shared components (buttons, modals, status badges, layout, alerts, forms, progress bars, empty states) from inline styles into `shared.css`. 2. Extract delivery-specific shared components (stop cards, POD styles) into `delivery-shared.css`. 3. Move truly page-specific styles to page-specific CSS files or keep minimal inline blocks with justification comments. 4. Add `<link rel="stylesheet" href="/css/shared.css">` to the 3 pages missing it. |
| **Risk** | **Low** — visual-only changes. Risk of CSS specificity bugs or missing styles. |
| **Effort** | Large — ~1,938 lines of CSS to audit, deduplicate, and reorganize. |
| **Dependencies** | Independent of Phases 1–4. Can be done in parallel. |
| **Tests required** | Visual regression testing on all 5 pages. Verify: buttons, modals, status badges, stop cards, forms, alerts all render correctly. The existing `utility-script-tags.test.js` test should pass (no script changes needed). |

### Phase 6: Remaining Bug Registry Items

**Goal**: Address all remaining bugs from Section 5 not covered by Phases 1–5.

| Bug | Fix Summary | Files | Risk | Effort |
|-----|-------------|-------|------|--------|
| **BUG-004** (POD sets any status to delivered) | Add status guard in `savePodPhoto()`: only transition if `active`, skip status change if `completed` | `delivery-service.js` (or `delivery-pod.js` after Phase 4) | Low | Small (5 lines) |
| **BUG-005** (complete accepts any status) | Add status whitelist in `POST /orders/:id/complete` handler | `routes/delivery.js` | Low | Small (5 lines) |
| **BUG-006** (skip accepts any status) | Add status guard in `skipOrder()`, fix hardcoded `previousStatus` | `delivery-service.js` | Low | Small (5 lines) |
| **BUG-007** (audit log missing IP/user-agent) | Add optional `req` param to `logAuditEvent()`, pass from route handlers | `delivery-service.js`, `routes/delivery.js`, `routes/driver-api.js` | Low | Medium (touch many call sites) |
| **BUG-008** (POD cleanup never runs) | Create `jobs/pod-cleanup-job.js`, register in cron scheduler | New file + `jobs/cron-scheduler.js` | Low | Small |
| **BUG-009** (backfill missing validator) | Add empty validator array | `middleware/validators/delivery.js` | Very Low | Trivial |
| **BUG-010/011** (driver-api response format) | Replace `res.json()` with `sendSuccess`/`sendError` | `routes/driver-api.js` | Low | Small (15 lines) |
| **BUG-012** (PII in debug log) | Replace `phone: order.phone` with `hasPhone: !!order.phone` | `delivery-stats.js` | Very Low | Trivial |
| **BUG-013** (hardcoded previousStatus in audit) | Fetch order before update, pass real status | `delivery-service.js` | Very Low | Small (3 lines) |
| **SEC-1** (geocode UPDATE missing merchant_id) | Add `AND merchant_id = $4` to UPDATE WHERE clause | `delivery-service.js` | Very Low | Trivial |

| Item | Detail |
|------|--------|
| **Dependencies** | BUG-004/005/006/013 and SEC-1 should land before or with Phase 4 (monolith split) to avoid duplicate work. BUG-007 depends on Phase 4 (audit module extraction). BUG-010/011 are independent. |
| **Tests required** | Each bug fix needs a unit test proving the fix. BUG-008 needs integration test verifying cron invokes cleanup. |

### Phase Summary

| Phase | Priority | Effort | Risk | Dependencies |
|-------|----------|--------|------|-------------|
| **1. Stuck-order fix** | **Critical** | Small | Medium | None |
| **2. Manual order selection** | Medium | Medium | Low | Phase 1 |
| **3. Per-route start/end** | Medium | Medium | Low | None (logically after Phase 2) |
| **4. Monolith split** | Medium | Large | Medium | Phases 1–3 |
| **5. CSS cleanup** | Low | Large | Low | Independent |
| **6. Remaining bugs** | Mixed (see table) | Medium total | Low | Partial Phase 4 dependency |

### Recommended Execution Order

```
Phase 1 (critical)
  └──► Phase 2
         └──► Phase 3
                └──► Phase 6 (BUG-004/005/006/013, SEC-1)
                       └──► Phase 4 (monolith split)
                              └──► Phase 6 (BUG-007, BUG-008)

Phase 5 (parallel, independent)
Phase 6 (BUG-009/010/011/012 — independent, anytime)
```
