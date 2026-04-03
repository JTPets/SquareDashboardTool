# Purchase Orders Extraction Plan

**Source**: `routes/purchase-orders.js` (894 lines)  
**Goal**: Extract business logic into `services/purchase-orders/` leaving thin route handlers.

---

## 1. Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/purchase-orders` | Create PO (with vendor min check, expiry clear, batch item insert) |
| GET | `/api/purchase-orders` | List POs, optional `?status=` and `?vendor_id=` filters |
| GET | `/api/purchase-orders/:id` | Get single PO with line items and vendor codes |
| PATCH | `/api/purchase-orders/:id` | Update DRAFT PO header and/or replace all items |
| POST | `/api/purchase-orders/:id/submit` | DRAFT → SUBMITTED; sets order_date and expected_delivery_date |
| POST | `/api/purchase-orders/:id/receive` | Record received qty; updates vendor costs; SUBMITTED → RECEIVED/PARTIAL |
| DELETE | `/api/purchase-orders/:id` | Delete DRAFT PO (cascade deletes items) |
| GET | `/api/purchase-orders/:po_number/export-csv` | Square-format CSV export with BOM |
| GET | `/api/purchase-orders/:po_number/export-xlsx` | Square-format XLSX export via ExcelJS |

---

## 2. DB Queries by Endpoint

**POST /**
- SELECT `vendors` — ownership + `minimum_order_amount`
- SELECT COUNT `purchase_orders` — PO number sequence generation
- Transaction: INSERT `purchase_orders`; batch INSERT `purchase_order_items`
- SELECT `variation_discount_status` JOIN `expiry_discount_tiers`, `variations`, `items` — expiry check

**GET /**
- SELECT `purchase_orders` JOIN `vendors`, `locations` LEFT JOIN `purchase_order_items` — dynamic WHERE on status/vendor_id

**GET /:id**
- SELECT `purchase_orders` JOIN `vendors`, `locations`
- SELECT `purchase_order_items` JOIN `variations`, `items` LEFT JOIN `variation_vendors`

**PATCH /:id**
- SELECT `purchase_orders` — DRAFT guard
- Transaction: UPDATE `purchase_orders` header; DELETE `purchase_order_items`; INSERT `purchase_order_items` (loop N+1); UPDATE `purchase_orders` totals
- SELECT `purchase_orders` — return updated

**POST /:id/submit**
- UPDATE `purchase_orders` SET status='SUBMITTED', order_date, expected_delivery_date WHERE status='DRAFT' RETURNING *

**POST /:id/receive**
- SELECT `purchase_orders` — ownership check
- Transaction: UPDATE `purchase_order_items` received_quantity (loop); SELECT `purchase_orders` vendor_id; SELECT cost diffs from `purchase_order_items` LEFT JOIN `variation_vendors`; UPSERT `variation_vendors` (conditional per diff); SELECT received count; UPDATE `purchase_orders` status RECEIVED/PARTIAL
- UPDATE `variation_discount_status` SET needs_manual_review=TRUE (non-blocking, outside transaction)
- SELECT `purchase_orders` — return

**DELETE /:id**
- SELECT `purchase_orders` — existence + DRAFT guard
- DELETE `purchase_orders` (items cascade)

**export-csv / export-xlsx** (identical DB layer)
- SELECT `purchase_orders` JOIN `vendors`, `locations`
- SELECT `purchase_order_items` JOIN `variations`, `items` LEFT JOIN `variation_vendors`

---

## 3. Business Logic for Extraction

| Logic | Current location | Target service |
|-------|-----------------|----------------|
| Vendor minimum order validation (BACKLOG-91) | POST / inline | `po-service.js` → `validateVendorMinimum()` |
| PO number generation (`PO-YYYYMMDD-NNN`) | POST / inline | `po-service.js` → `generatePoNumber()` |
| Item subtotal calculation | POST / and PATCH / | `po-service.js` → `calculateSubtotal()` |
| Expiry discount clear + applyDiscounts trigger | POST / inline | `po-service.js` → `clearExpiryDiscountsForItems()` |
| Status transitions (DRAFT→SUBMITTED, →RECEIVED, →PARTIAL) | submit + receive inline | `po-service.js` |
| PATCH item replace (delete+insert) inside transaction | PATCH / inline | `po-service.js` → `replaceItems()` |
| Vendor cost sync on receive | POST /:id/receive inline | `po-receive-service.js` → `syncVendorCosts()` |
| All-received check + status update | POST /:id/receive inline | `po-receive-service.js` → `finalizeReceiveStatus()` |
| Expiry re-audit flag on receive (EXPIRY-REORDER-AUDIT) | POST /:id/receive inline | `po-receive-service.js` → `flagExpiryItems()` |
| CSV line building (Square format, BOM, CRLF) | export-csv inline | `po-export-service.js` → `buildCsvContent()` |
| XLSX workbook building (Square template layout) | export-xlsx inline | `po-export-service.js` → `buildXlsxWorkbook()` |

---

## 4. Cross-Domain Calls

- `services/expiry/discount-service`: `clearExpiryDiscountForReorder()`, `applyDiscounts()` (async background)
- `services/catalog/location-service`: `getLocationById()` — location ownership validation

---

## 5. Suggested Service File Breakdown

### `services/purchase-orders/po-service.js`
CRUD + status transitions.
- `createPurchaseOrder(merchantId, payload)` — validate, generate number, transaction, trigger expiry clear
- `listPurchaseOrders(merchantId, filters)` — dynamic query
- `getPurchaseOrder(merchantId, id)` — header + items
- `updatePurchaseOrder(merchantId, id, updates)` — DRAFT guard, header patch + item replace in transaction
- `submitPurchaseOrder(merchantId, id)` — single UPDATE
- `deletePurchaseOrder(merchantId, id)` — DRAFT guard + DELETE
- `validateVendorMinimum(vendor, items)` — pure, returns `{ok, shortfallCents, minimumCents}`
- `generatePoNumber(merchantId, client)` — sequence query
- `calculateSubtotal(items)` — pure

### `services/purchase-orders/po-receive-service.js`
Receive flow.
- `receiveItems(merchantId, poId, items)` — orchestrates transaction + expiry flag
- `syncVendorCosts(client, poId, items, merchantId)` — cost diff + upsert
- `finalizeReceiveStatus(client, poId, merchantId)` — count check + RECEIVED/PARTIAL
- `flagExpiryItems(poId, items, merchantId)` — non-blocking UPDATE vds

### `services/purchase-orders/po-export-service.js`
Export generation.
- `exportCsv(merchantId, poNumber)` → `{content, filename}`
- `exportXlsx(merchantId, poNumber)` → `{buffer, filename}`
- `buildCsvContent(po, items)` — pure, Square 12-column format with BOM
- `buildXlsxWorkbook(po, items)` — pure, Square template layout

---

## 6. Functions Extractable 1:1

These can be moved to the service with only minor signature changes; the route becomes a thin caller:

- `listPurchaseOrders` handler → `po-service.listPurchaseOrders()` — pure DB fetch
- `getPurchaseOrder` handler → `po-service.getPurchaseOrder()` — pure DB fetch
- `submitPurchaseOrder` handler → `po-service.submitPurchaseOrder()` — single UPDATE
- `deletePurchaseOrder` handler → `po-service.deletePurchaseOrder()` — guard + DELETE
- `buildCsvContent()` — pure function, no context needed
- `buildXlsxWorkbook()` — pure function, no context needed

Needs minor refactor (side effects or injected dependencies):
- `createPurchaseOrder` — calls location-service and discount-service; keep those calls in service or inject
- `updatePurchaseOrder` — item replace loop is N+1 INSERT; fix to batch on extraction (matches batch pattern in POST /)
- `receiveItems` — `syncVendorCosts` and `flagExpiryItems` should be extracted as sub-functions first

---

## 7. Test Coverage Audit

**Test file**: `__tests__/routes/purchase-orders.test.js` — **33 tests** across 9 route groups.

| Endpoint | Tests | Coverage |
|----------|-------|----------|
| Auth guards | 2 | ✅ Both guards covered |
| POST / | 7 | ✅ Success, zero-qty filter, vendor min block, force override, vendor 403, location 403, expiry check |
| GET / | 3 | ✅ List, status filter, vendor filter |
| GET /:id | 2 | ✅ Found with items, 404 |
| PATCH /:id | 3 | ✅ Success, 404, non-DRAFT 400 |
| POST /:id/submit | 3 | ✅ Success, non-DRAFT, not found |
| POST /:id/receive | 6 | ✅ Success, vendor cost update, cost match skip, expiry flag, expiry flag failure resilience, 404 |
| DELETE /:id | 3 | ✅ Success, 404, non-DRAFT 400 |
| GET export-csv | 2 | ✅ Success (content-type), 404 |
| GET export-xlsx | 2 | ✅ Success (content-type), 404 |

**Missing tests (route layer)**:
- `POST /`: all items zero-quantity → 400 (current test has mixed; pure-zero case untested)
- `POST /:id/receive`: PARTIAL status path (only RECEIVED tested)
- `PATCH /:id`: update header only (no items), update items only (no header fields)
- CSV/XLSX content correctness (column order, BOM, metadata rows) — only status code tested

**Service tests needed** (none exist yet):

| Service function | Priority | Notes |
|-----------------|----------|-------|
| `validateVendorMinimum()` | HIGH | Pure fn, easy to test; covers BACKLOG-91 edge cases |
| `receiveItems()` transaction | HIGH | Most complex; vendor cost sync + PARTIAL/RECEIVED branch |
| `syncVendorCosts()` | HIGH | Upsert logic; cost-match skip is already route-tested but isolated test needed |
| `flagExpiryItems()` non-blocking | MEDIUM | Resilience behaviour already tested at route level |
| `buildCsvContent()` | MEDIUM | Pure fn; column order, BOM, CRLF, GTIN tab-prefix |
| `buildXlsxWorkbook()` | MEDIUM | Pure fn; Square row layout correctness |
| `generatePoNumber()` | LOW | Simple sequence; covered implicitly |
| `createPurchaseOrder()` | HIGH | Expiry clear integration + minimum warning in response |

---

## Test Plan

**Existing tests**: 33 (all at route level, all passing)

**New tests needed (estimate)**: ~45
- `__tests__/services/purchase-orders/po-service.test.js` — ~20 tests
- `__tests__/services/purchase-orders/po-receive-service.test.js` — ~15 tests
- `__tests__/services/purchase-orders/po-export-service.test.js` — ~10 tests

**Highest-risk untested logic**:
1. **PARTIAL receive path** — status set to PARTIAL when not all items received; no test for this branch
2. **Vendor cost sync edge cases** — multi-item diffs, NULL current_vendor_cost treated as mismatch
3. **Vendor minimum validation** — force=false with exact minimum (boundary), zero minimum (skip), NULL minimum (skip)
4. **CSV column order / content** — Square import will silently misparse if columns shift

**Test file structure**:
```
__tests__/services/purchase-orders/
  po-service.test.js
  po-receive-service.test.js
  po-export-service.test.js
```
