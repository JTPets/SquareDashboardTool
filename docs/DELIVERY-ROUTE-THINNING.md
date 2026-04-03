# Delivery Route Thinning Plan

**File**: `routes/delivery.js` — 942 lines → target ~150 lines  
**Services exist**: `services/delivery/` (12 sub-modules + index.js)

---

## Endpoints & Inline Logic

| Method | Path | Inline? | Target service |
|--------|------|---------|----------------|
| GET | /orders | No | — |
| POST | /orders | Yes (~25L) geocode after create | `delivery-orders.js` → `createOrderWithGeocode()` |
| GET | /orders/:id | No | — |
| PATCH | /orders/:id | Yes (~20L) re-geocode on address change | `delivery-orders.js` → `updateOrderWithRegeocode()` |
| DELETE | /orders/:id | No | — |
| POST | /orders/:id/skip | No | — |
| **POST** | **/orders/:id/complete** | **Yes (~200L) Square fulfillment state machine** | `delivery-square.js` → `completeFulfillments()` |
| GET | /orders/:id/customer | No (`deliveryStats.getCustomerInfo`) | — |
| PATCH | /orders/:id/customer-note | No | — |
| PATCH | /orders/:id/notes | Yes (~10L) get-then-update | `delivery-orders.js` → `updateOrderNotes()` |
| GET | /orders/:id/customer-stats | No (`deliveryStats.getCustomerStats`) | — |
| POST | /orders/:id/pod | No | — |
| GET | /pod/:id | Yes (~10L) fs.access + res.sendFile | `delivery-pod.js` → `servePodFile()` |
| POST | /route/generate | No | — |
| GET | /route/active | Yes (~5L) two chained calls | `delivery-routes.js` → `getActiveRouteWithOrders()` |
| GET | /route/:id | No | — |
| POST | /route/finish | No | — |
| POST | /geocode | No | — |
| GET | /settings | Yes (~8L) inline defaults object | `delivery-settings.js` → `getSettingsWithDefaults()` |
| PUT | /settings | Yes (~20L) geocode start/end addresses | `delivery-settings.js` → `updateSettingsWithGeocode()` |
| GET | /audit | No | — |
| GET | /stats | No | — |
| **POST** | **/sync** | **Yes (~100L) Square search + ingest loop** | `delivery-square.js` → `syncOrdersFromSquare()` |
| POST | /backfill-customers | No | — |

---

## Handlers: Inline vs. Service

- **Already thin** (delegate to service): 15/24 handlers  
- **Inline logic to extract**: 9 handlers  
- **Largest offenders**: `/complete` (200L, Square state machine) and `/sync` (100L, Square search loop) — both belong in `delivery-square.js` which currently only exports `ingestSquareOrder` and `handleSquareOrderUpdate`

---

## Test Coverage

**Covered** (have tests in `__tests__/routes/delivery.test.js`): 20/24 endpoints  
`/complete` additionally has deep coverage in `delivery-completion.test.js`

**Not covered at route level**:
- `PATCH /orders/:id/notes`
- `GET /orders/:id/customer-stats`
- `POST /orders/:id/pod`
- `GET /pod/:id`

---

## New Tests Needed

4 tests required (one per uncovered endpoint above).  
`/complete` and `/sync` need updated mocks once logic moves to service — existing tests remain valid.

---

## Extraction Summary

| Service file | New function(s) |
|---|---|
| `delivery-square.js` | `completeFulfillments(merchantId, order, squareClient)` |
| `delivery-square.js` | `syncOrdersFromSquare(merchantId, squareClient, locationIds, daysBack)` |
| `delivery-orders.js` | `createOrderWithGeocode(merchantId, data, apiKey)` |
| `delivery-orders.js` | `updateOrderWithRegeocode(merchantId, id, updates, apiKey)` |
| `delivery-orders.js` | `updateOrderNotes(merchantId, id, notes)` |
| `delivery-settings.js` | `getSettingsWithDefaults(merchantId)` |
| `delivery-settings.js` | `updateSettingsWithGeocode(merchantId, data)` |
| `delivery-routes.js` | `getActiveRouteWithOrders(merchantId, routeDate)` |
| `delivery-pod.js` | `servePodFile(pod, res)` |
