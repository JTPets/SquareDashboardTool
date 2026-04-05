# Vendor Catalog Route Extraction Plan

**File**: `routes/vendor-catalog.js` (610 lines)  
**Date**: 2026-04-05

---

## Endpoints

| Method | Path | Logic location |
|--------|------|---------------|
| GET | `/api/vendors` | **Inline** — raw SQL query |
| GET | `/api/vendor-dashboard` | `vendor-dashboard.getVendorDashboard` |
| PATCH | `/api/vendors/:id/settings` | `vendor-dashboard.updateVendorSettings` |
| POST | `/api/vendor-catalog/import` | `vendorCatalog.importVendorCatalog` + **inline** file-type detection |
| POST | `/api/vendor-catalog/preview` | `vendorCatalog.previewFile` + **inline** file-type detection |
| POST | `/api/vendor-catalog/import-mapped` | `vendorCatalog.importWithMappings` + **inline** file-type detection |
| GET | `/api/vendor-catalog/field-types` | **Inline** — constant passthrough |
| GET | `/api/vendor-catalog` | `vendorCatalog.searchVendorCatalog` |
| GET | `/api/vendor-catalog/lookup/:upc` | `vendorCatalog.lookupByUPC` + **inline** DB query for `ourCatalogItem` |
| GET | `/api/vendor-catalog/batches` | `vendorCatalog.getImportBatches` |
| GET | `/api/vendor-catalog/batches/:batchId/report` | `vendorCatalog.regeneratePriceReport` |
| POST | `/api/vendor-catalog/batches/:batchId/archive` | `vendorCatalog.archiveImportBatch` |
| POST | `/api/vendor-catalog/batches/:batchId/unarchive` | `vendorCatalog.unarchiveImportBatch` |
| DELETE | `/api/vendor-catalog/batches/:batchId` | `vendorCatalog.deleteImportBatch` |
| GET | `/api/vendor-catalog/stats` | `vendorCatalog.getStats` |
| POST | `/api/vendor-catalog/push-price-changes` | **Inline** — validation loop + DB tenant check + `squareApi.batchUpdateVariationPrices` |
| GET | `/api/vendor-catalog/merchant-taxes` | **Fully inline** — direct Square API call (not in route header docs) |
| POST | `/api/vendor-catalog/confirm-links` | **Fully inline** — DB insert loop (not in route header docs) |
| POST | `/api/vendor-catalog/deduplicate` | `vendorCatalog.deduplicateVendorCatalog` |
| POST | `/api/vendor-catalog/create-items` | `catalog-create-service.bulkCreateSquareItems` |

---

## Inline Logic — Extraction Targets

### 1. `GET /api/vendors` (L49–67)
Simple `SELECT * FROM vendors` — move to `catalog-service.listVendors(merchantId, status)`.

### 2. File-type detection (L101–130, L154–181, L209–243)
Identical base64→buffer logic duplicated 3×. Extract to `utils/file-decode.js` helper `decodeFileData(data, fileType, fileName)`.

### 3. `GET /api/vendor-catalog/lookup/:upc` — ourCatalogItem (L316–329)
Inline SQL join across `variations/items/variation_vendors`. Move to `catalog-service.lookupOurItemByUPC(upc, merchantId)`.

### 4. `POST /api/vendor-catalog/push-price-changes` (L450–490)
Inline tenant verification query + validation loop. Move DB check to `catalog-service.verifyVariationsBelongToMerchant(ids, merchantId)`.

### 5. `GET /api/vendor-catalog/merchant-taxes` (L496–516)
Fully inline Square API call (dynamic `require`). Move to `catalog-service.getMerchantTaxes(merchantId)`.

### 6. `POST /api/vendor-catalog/confirm-links` (L524–551)
Fully inline DB insert loop. Move to `catalog-service.confirmVendorLinks(links, merchantId)`.

---

## Test Coverage

| Test file | Covers |
|-----------|--------|
| `__tests__/routes/vendor-catalog.test.js` | All 17 original endpoints inc. `confirm-links`, `deduplicate` |
| `__tests__/routes/vendor-catalog-create.test.js` | `create-items` (13 cases) |
| `__tests__/services/vendor/catalog-service.test.js` | Service unit tests |
| `__tests__/services/vendor/catalog-create-service.test.js` | Service unit tests |

**Gap**: `GET /api/vendor-catalog/merchant-taxes` — no route-level tests.

---

## Estimated New Tests Needed

| Target | Tests |
|--------|-------|
| `utils/file-decode.js` helper | ~4 (csv string, csv base64, xlsx, missing type fallback) |
| `catalog-service.listVendors` | ~3 (all, filtered by status, empty) |
| `catalog-service.lookupOurItemByUPC` | ~2 (match, no match) |
| `catalog-service.verifyVariationsBelongToMerchant` | ~2 (pass, fail cross-tenant) |
| `catalog-service.getMerchantTaxes` | ~3 (success, Square error returns empty, filters deleted) |
| `catalog-service.confirmVendorLinks` | ~3 (all succeed, partial failure, empty) |
| `GET /api/vendor-catalog/merchant-taxes` route | ~3 (success, Square failure graceful, auth) |
| **Total** | ~20 |
