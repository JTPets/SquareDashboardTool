# Package 2b: `services/square/api.js` Monolith Split Plan

**Author**: Claude (automated analysis)
**Date**: 2026-02-28
**Status**: DRAFT — awaiting approval before Phase 2 implementation
**Baseline**: 42 suites, 977 tests, CI green on main

---

## 1. Current State

`services/square/api.js` is **4,947 lines** exporting **38 functions** (34 public + 4 internal-only).
`services/square/index.js` is a passthrough: `module.exports = require('./api')`.
`utils/square-api.js` is a deprecated backward-compat shim: `module.exports = require('../services/square')`.

### 1.1 All Exported Functions (38)

| # | Function | Lines | Domain |
|---|----------|-------|--------|
| 1 | `syncLocations` | 229–273 (45) | Locations |
| 2 | `migrateVendorFKs` | 280–297 (18) | Vendors (internal helper) |
| 3 | `reconcileVendorId` | 304–340 (37) | Vendors (internal helper) |
| 4 | `syncVendors` | 347–429 (83) | Vendors |
| 5 | `syncCatalog` | 436–745 (310) | Catalog Sync |
| 6 | `deltaSyncCatalog` | 759–1071 (313) | Catalog Sync |
| 7 | `_updateDeltaTimestamp` | 1079–1090 (12) | Catalog Sync (private) |
| 8 | `syncCategory` | 1097–1109 (13) | Catalog Sync (helper) |
| 9 | `syncImage` | 1116–1132 (17) | Catalog Sync (helper) |
| 10 | `syncItem` | 1140–1264 (125) | Catalog Sync (helper) |
| 11 | `ensureVendorsExist` | 1275–1339 (65) | Vendors |
| 12 | `syncVariation` | 1347–1586 (240) | Catalog Sync (helper) |
| 13 | `syncInventory` | 1593–1686 (94) | Inventory |
| 14 | `syncSalesVelocity` | 1694–1882 (189) | Sales Velocity |
| 15 | `syncSalesVelocityAllPeriods` | 1895–2216 (322) | Sales Velocity |
| 16 | `updateSalesVelocityFromOrder` | 2236–2383 (148) | Sales Velocity |
| 17 | `getSquareInventoryCount` | 2392–2434 (43) | Inventory |
| 18 | `setSquareInventoryCount` | 2446–2502 (57) | Inventory |
| 19 | `setSquareInventoryAlertThreshold` | 2514–2636 (123) | Inventory |
| 20 | `syncCommittedInventory` | 2651–3052 (402) | Inventory (Committed) |
| 21 | `fullSync` | 3059–3135 (77) | Orchestration |
| 22 | `fixLocationMismatches` | 3143–3355 (213) | Diagnostics |
| 23 | `fixInventoryAlerts` | 3364–3529 (166) | Diagnostics |
| 24 | `enableItemAtAllLocations` | 3538–3598 (61) | Diagnostics |
| 25 | `listCustomAttributeDefinitions` | 3610–3657 (48) | Custom Attributes |
| 26 | `upsertCustomAttributeDefinition` | 3671–3744 (74) | Custom Attributes |
| 27 | `updateCustomAttributeValues` | 3754–3831 (78) | Custom Attributes |
| 28 | `batchUpdateCustomAttributeValues` | 3840–3947 (108) | Custom Attributes |
| 29 | `initializeCustomAttributes` | 3956–4059 (104) | Custom Attributes |
| 30 | `pushCasePackToSquare` | 4067–4107 (41) | Custom Attributes |
| 31 | `pushBrandsToSquare` | 4115–4155 (41) | Custom Attributes |
| 32 | `pushExpiryDatesToSquare` | 4163–4232 (70) | Custom Attributes |
| 33 | `deleteCustomAttributeDefinition` | 4240–4279 (40) | Custom Attributes |
| 34 | `updateVariationPrice` | 4289–4373 (85) | Pricing |
| 35 | `batchUpdateVariationPrices` | 4381–4556 (176) | Pricing |
| 36 | `updateVariationCost` | 4568–4739 (172) | Pricing |
| 37 | `batchUpdateCatalogContent` | 4750–4903 (154) | Catalog Content |
| 38 | `cleanup` | 58–60 (3) | Lifecycle |

**Not exported but used internally**:
- `getMerchantToken` (67–108) — exported, shared infra
- `makeSquareRequest` (116–215) — exported, shared infra
- `sleep` (220–222) — internal utility
- `generateIdempotencyKey` — re-exported from `utils/idempotency`
- `pruneInvoicesScopeCache` (40–47) — internal timer callback
- `merchantsWithoutInvoicesScope` — in-memory cache (module-level state)
- `invoicesCachePruneInterval` — timer handle (module-level state)

---

## 2. Consumer Dependency Map

### 2.1 Import Paths

Consumers import via three paths (all resolve to the same module):
- `require('../services/square')` — canonical (via index.js passthrough)
- `require('../services/square/api')` — direct (3 files)
- `require('../utils/square-api')` — deprecated shim (17 files)

### 2.2 Functions Used Per Consumer

| Consumer File | Functions Used |
|---|---|
| **server.js** | `cleanup`, `initializeCustomAttributes` |
| **routes/sync.js** | `syncLocations`, `syncVendors`, `syncCatalog`, `syncInventory`, `syncSalesVelocity`, `syncSalesVelocityAllPeriods`, `fullSync` |
| **routes/cycle-counts.js** | `getSquareInventoryCount`, `setSquareInventoryCount` |
| **routes/square-attributes.js** | `listCustomAttributeDefinitions`, `initializeCustomAttributes`, `upsertCustomAttributeDefinition`, `deleteCustomAttributeDefinition`, `updateCustomAttributeValues`, `pushCasePackToSquare`, `pushBrandsToSquare`, `pushExpiryDatesToSquare` |
| **routes/square-oauth.js** | `initializeCustomAttributes` |
| **routes/gmc.js** | `updateCustomAttributeValues`, `batchUpdateCustomAttributeValues` |
| **routes/vendor-catalog.js** | `batchUpdateVariationPrices` |
| **routes/delivery.js** | `generateIdempotencyKey` |
| **routes/subscriptions.js** | `makeSquareRequest`, `generateIdempotencyKey` |
| **routes/ai-autofill.js** | `batchUpdateCatalogContent` |
| **services/webhook-handlers/order-handler.js** | `updateSalesVelocityFromOrder` |
| **services/webhook-handlers/inventory-handler.js** | `syncInventory` |
| **services/webhook-handlers/catalog-handler.js** | `deltaSyncCatalog` |
| **services/catalog/audit-service.js** | `fixLocationMismatches`, `enableItemAtAllLocations`, `fixInventoryAlerts` |
| **services/catalog/variation-service.js** | `updateCustomAttributeValues`, `setSquareInventoryAlertThreshold`, `updateVariationCost` |
| **services/catalog/inventory-service.js** | `updateCustomAttributeValues` |
| **services/seniors/seniors-service.js** | `generateIdempotencyKey` |
| **services/expiry/discount-service.js** | `getMerchantToken`, `makeSquareRequest`, `generateIdempotencyKey` (lazy-loaded) |
| **services/loyalty-admin/shared-utils.js** → re-exports `getSquareApi()` | — |
| **services/loyalty-admin/square-discount-service.js** | `getMerchantToken`, `makeSquareRequest` (via `getSquareApi()`) |
| **utils/square-catalog-cleanup.js** | `getMerchantToken`, `makeSquareRequest` (lazy-loaded) |
| **jobs/webhook-retry-job.js** | `syncCatalog`, `syncInventory`, `syncVendors`, `syncLocations` |
| **jobs/committed-inventory-reconciliation-job.js** | `syncCommittedInventory` |

### 2.3 Summary: Function Usage Frequency

| Function | # Consumers |
|---|---|
| `makeSquareRequest` | 4 (subscriptions, expiry/discount-service, loyalty-admin/square-discount-service, square-catalog-cleanup) |
| `getMerchantToken` | 3 (expiry/discount-service, loyalty-admin/square-discount-service, square-catalog-cleanup) |
| `generateIdempotencyKey` | 4 (delivery, subscriptions, seniors-service, expiry/discount-service) |
| `updateCustomAttributeValues` | 4 (square-attributes, gmc, variation-service, inventory-service) |
| `initializeCustomAttributes` | 3 (server.js, square-attributes, square-oauth) |
| `syncCatalog` | 2 (sync, webhook-retry-job) |
| `syncInventory` | 2 (sync, inventory-handler + webhook-retry-job) |
| `syncLocations` | 2 (sync, webhook-retry-job) |
| `syncVendors` | 2 (sync, webhook-retry-job) |
| All other functions | 1 each |

---

## 3. Proposed Module Split

### 3.1 Module Map

```
services/square/
├── index.js                      (facade — re-exports all modules, backward compat)
├── square-client.js              (shared infrastructure)
├── square-catalog-sync.js        (catalog sync — full + delta)
├── square-inventory.js           (inventory counts, alerts, committed inventory)
├── square-velocity.js            (sales velocity sync + incremental updates)
├── square-vendors.js             (vendor sync + reconciliation)
├── square-locations.js           (location sync)
├── square-custom-attributes.js   (custom attribute CRUD + push helpers)
├── square-pricing.js             (price + cost updates, catalog content)
├── square-diagnostics.js         (fix location mismatches, alerts, enable items)
└── square-sync-orchestrator.js   (fullSync orchestration)
```

### 3.2 Function Assignment Per Module

#### `square-client.js` — Shared Infrastructure (~120 lines)
**Functions**:
- `getMerchantToken(merchantId)` — token decryption + legacy migration
- `makeSquareRequest(endpoint, options)` — HTTP client with retry/rate-limit
- `sleep(ms)` — delay utility
- `cleanup()` — timer cleanup for graceful shutdown
- Re-export: `generateIdempotencyKey` from `utils/idempotency`

**Module-level state**:
- `SQUARE_BASE_URL`, `MAX_RETRIES`, `RETRY_DELAY_MS`
- `merchantsWithoutInvoicesScope` cache + prune timer
- `INVOICES_SCOPE_CACHE_TTL`

**Consumers**: 8 files (direct) + all other square modules (internal)

---

#### `square-locations.js` — Location Sync (~50 lines)
**Functions**:
- `syncLocations(merchantId)`

**Internal deps**: `square-client.js` (getMerchantToken, makeSquareRequest, sleep)
**Consumers**: routes/sync.js, jobs/webhook-retry-job.js

---

#### `square-vendors.js` — Vendor Sync (~230 lines)
**Functions**:
- `syncVendors(merchantId)`
- `ensureVendorsExist(vendorIds, merchantId)`
- `migrateVendorFKs(client, oldId, newId, merchantId)` (internal)
- `reconcileVendorId(vendor, vendorParams, merchantId)` (internal)

**Internal deps**: `square-client.js`
**Consumers**: routes/sync.js, jobs/webhook-retry-job.js, (also called internally by square-catalog-sync.js and square-pricing.js)

---

#### `square-catalog-sync.js` — Catalog Sync (~900 lines)
**Functions**:
- `syncCatalog(merchantId)` — full catalog sync
- `deltaSyncCatalog(merchantId)` — delta/incremental sync
- `syncCategory(obj, merchantId)` (internal)
- `syncImage(obj, merchantId)` (internal)
- `syncItem(obj, categoryName, merchantId)` (internal)
- `syncVariation(obj, merchantId)` (internal)
- `_updateDeltaTimestamp(merchantId, latestTime)` (private)

**Internal deps**: `square-client.js`, `square-vendors.js` (ensureVendorsExist)
**Consumers**: routes/sync.js, services/webhook-handlers/catalog-handler.js, jobs/webhook-retry-job.js

---

#### `square-inventory.js` — Inventory Management (~600 lines)
**Functions**:
- `syncInventory(merchantId)` — bulk inventory sync
- `getSquareInventoryCount(catalogObjectId, locationId, merchantId)`
- `setSquareInventoryCount(catalogObjectId, locationId, quantity, reason, merchantId)`
- `setSquareInventoryAlertThreshold(catalogObjectId, locationId, threshold, options)`
- `syncCommittedInventory(merchantId)` — invoice-based committed inventory reconciliation

**Internal deps**: `square-client.js`
**Module-level state**: `merchantsWithoutInvoicesScope` cache (move from square-client or keep here — see note below)
**Consumers**: routes/sync.js, routes/cycle-counts.js, services/webhook-handlers/inventory-handler.js, services/catalog/variation-service.js, jobs/committed-inventory-reconciliation-job.js

**Note**: The `merchantsWithoutInvoicesScope` cache is only used by `syncCommittedInventory`. Keep it in this module.

---

#### `square-velocity.js` — Sales Velocity (~700 lines)
**Functions**:
- `syncSalesVelocity(periodDays, merchantId)` — single-period sync
- `syncSalesVelocityAllPeriods(merchantId, maxPeriod, options)` — optimized multi-period sync
- `updateSalesVelocityFromOrder(order, merchantId)` — incremental from webhook

**Internal deps**: `square-client.js`
**Consumers**: routes/sync.js, services/webhook-handlers/order-handler.js

---

#### `square-custom-attributes.js` — Custom Attribute Management (~500 lines)
**Functions**:
- `listCustomAttributeDefinitions(options)`
- `upsertCustomAttributeDefinition(definition, options)`
- `updateCustomAttributeValues(catalogObjectId, customAttributeValues, options)`
- `batchUpdateCustomAttributeValues(updates, options)`
- `initializeCustomAttributes(options)`
- `pushCasePackToSquare(options)`
- `pushBrandsToSquare(options)`
- `pushExpiryDatesToSquare(options)`
- `deleteCustomAttributeDefinition(definitionIdOrKey, options)`

**Internal deps**: `square-client.js`
**Consumers**: server.js, routes/square-attributes.js, routes/square-oauth.js, routes/gmc.js, services/catalog/variation-service.js, services/catalog/inventory-service.js

---

#### `square-pricing.js` — Price, Cost & Content Updates (~600 lines)
**Functions**:
- `updateVariationPrice(variationId, newPriceCents, currency, merchantId)`
- `batchUpdateVariationPrices(priceUpdates, merchantId)`
- `updateVariationCost(variationId, vendorId, newCostCents, currency, options)`
- `batchUpdateCatalogContent(merchantId, updates)`

**Internal deps**: `square-client.js`, `square-vendors.js` (ensureVendorsExist, used by updateVariationCost)
**Consumers**: routes/vendor-catalog.js, routes/ai-autofill.js, services/catalog/variation-service.js

---

#### `square-diagnostics.js` — Fix & Audit Operations (~450 lines)
**Functions**:
- `fixLocationMismatches(merchantId)`
- `fixInventoryAlerts(merchantId)`
- `enableItemAtAllLocations(itemId, merchantId)`

**Internal deps**: `square-client.js`
**Consumers**: services/catalog/audit-service.js

---

#### `square-sync-orchestrator.js` — Full Sync Coordination (~80 lines)
**Functions**:
- `fullSync(merchantId)` — orchestrates all sync operations in sequence

**Internal deps**: `square-locations.js`, `square-vendors.js`, `square-catalog-sync.js`, `square-inventory.js`, `square-velocity.js`
**Consumers**: routes/sync.js

---

#### `index.js` — Facade / Re-export (~60 lines)
Re-exports all public functions from all modules. Provides backward compatibility — no consumer changes needed initially. Existing `const { syncCatalog } = require('../services/square')` continues to work.

```javascript
// index.js (facade)
const client = require('./square-client');
const locations = require('./square-locations');
const vendors = require('./square-vendors');
const catalogSync = require('./square-catalog-sync');
const inventory = require('./square-inventory');
const velocity = require('./square-velocity');
const customAttrs = require('./square-custom-attributes');
const pricing = require('./square-pricing');
const diagnostics = require('./square-diagnostics');
const orchestrator = require('./square-sync-orchestrator');

module.exports = {
    ...client,
    ...locations,
    ...vendors,
    ...catalogSync,
    ...inventory,
    ...velocity,
    ...customAttrs,
    ...pricing,
    ...diagnostics,
    ...orchestrator
};
```

---

## 4. Dependency Graph

```
square-client.js  ◄───────────────────────────────────────────────────┐
    │                                                                   │
    ├──► square-locations.js                                            │
    ├──► square-vendors.js                                              │
    │       │                                                           │
    │       ├──► square-catalog-sync.js  (uses ensureVendorsExist)      │
    │       └──► square-pricing.js       (uses ensureVendorsExist)      │
    │                                                                   │
    ├──► square-inventory.js                                            │
    ├──► square-velocity.js                                             │
    ├──► square-custom-attributes.js                                    │
    └──► square-diagnostics.js                                          │
                                                                        │
square-sync-orchestrator.js  ──► locations, vendors, catalog-sync, ─────┘
                                  inventory, velocity
```

**Key constraint**: No circular dependencies. All arrows point downward to `square-client.js`.
The only cross-module dependency is `square-vendors.js` being imported by `square-catalog-sync.js` and `square-pricing.js` for `ensureVendorsExist`.

---

## 5. Splitting Order

The order is determined by: fewest cross-dependencies first, most isolated modules first, highest-risk modules last.

### Phase 2a — Extract `square-client.js` (FIRST — all others depend on it)
**Risk**: LOW — pure infrastructure, no business logic
**Effort**: S
**Approach**: Extract `getMerchantToken`, `makeSquareRequest`, `sleep`, `cleanup`, re-export `generateIdempotencyKey`. Update `api.js` to import from `square-client.js` instead of defining inline. All external consumers still import via `index.js` — no changes needed.

### Phase 2b — Extract `square-locations.js`
**Risk**: LOW — self-contained, 1 function, no internal callers except fullSync
**Effort**: S
**Approach**: Move `syncLocations`. Update fullSync to import from new module.
**Consumers**: 2 (routes/sync.js, jobs/webhook-retry-job.js) — both via index.js facade

### Phase 2c — Extract `square-vendors.js`
**Risk**: LOW — self-contained cluster (sync + reconcile + ensureVendorsExist)
**Effort**: S
**Approach**: Move 4 functions. Other modules (catalog-sync, pricing) will import `ensureVendorsExist` from this module.
**Consumers**: 2 external + 2 internal cross-module

### Phase 2d — Extract `square-diagnostics.js`
**Risk**: LOW — self-contained, single consumer (audit-service.js)
**Effort**: S
**Approach**: Move 3 fix/audit functions.
**Consumers**: 1 (services/catalog/audit-service.js)

### Phase 2e — Extract `square-custom-attributes.js`
**Risk**: LOW — self-contained cluster, no dependencies on other square modules
**Effort**: M
**Approach**: Move 9 functions.
**Consumers**: 6 files

### Phase 2f — Extract `square-pricing.js`
**Risk**: MEDIUM — `updateVariationCost` has error handling that references `currentVariationData` outside try block (see observation O-4). Cross-dependency on `square-vendors.js`.
**Effort**: M
**Approach**: Move 4 functions. Wire `ensureVendorsExist` import from `square-vendors.js`.
**Consumers**: 3 files

### Phase 2g — Extract `square-inventory.js`
**Risk**: MEDIUM — `syncCommittedInventory` is the largest function (402 lines) and has module-level cache state (`merchantsWithoutInvoicesScope`)
**Effort**: M
**Approach**: Move 5 functions + the invoices scope cache + prune timer. The `cleanup()` in `square-client.js` will need to call this module's cleanup too.
**Consumers**: 5 files

### Phase 2h — Extract `square-velocity.js`
**Risk**: MEDIUM — `syncSalesVelocityAllPeriods` has a lazy-load of loyalty-admin (line 1915), creating a soft coupling. 322 lines.
**Effort**: M
**Approach**: Move 3 functions. Keep lazy-load as-is (it's already designed to avoid circular deps).
**Consumers**: 2 files

### Phase 2i — Extract `square-catalog-sync.js`
**Risk**: HIGH — largest functional cluster (~900 lines), 6 tightly coupled internal helpers, cross-dependency on `square-vendors.js`. `syncCatalog` and `deltaSyncCatalog` share 4 internal helpers.
**Effort**: L
**Approach**: Move 7 functions as a unit. Internal helpers stay private to this module. Wire `ensureVendorsExist` import.
**Consumers**: 3 files

### Phase 2j — Extract `square-sync-orchestrator.js` + finalize `index.js` facade
**Risk**: LOW — simple orchestration function, only wiring
**Effort**: S
**Approach**: Move `fullSync`. Convert `api.js` to facade (or delete and rename `index.js`). Update `utils/square-api.js` shim if needed. Final verification pass.
**Consumers**: 1 file (routes/sync.js)

---

## 6. Summary Table

| Module | Functions | Lines (est.) | Consumers | Internal Deps | Risk | Effort | Phase |
|--------|-----------|-------------|-----------|---------------|------|--------|-------|
| `square-client.js` | 5 | ~120 | 8 direct + all modules | none | LOW | S | 2a |
| `square-locations.js` | 1 | ~50 | 2 | client | LOW | S | 2b |
| `square-vendors.js` | 4 | ~230 | 2 ext + 2 int | client | LOW | S | 2c |
| `square-diagnostics.js` | 3 | ~450 | 1 | client | LOW | S | 2d |
| `square-custom-attributes.js` | 9 | ~500 | 6 | client | LOW | M | 2e |
| `square-pricing.js` | 4 | ~600 | 3 | client, vendors | MED | M | 2f |
| `square-inventory.js` | 5 | ~600 | 5 | client | MED | M | 2g |
| `square-velocity.js` | 3 | ~700 | 2 | client | MED | M | 2h |
| `square-catalog-sync.js` | 7 | ~900 | 3 | client, vendors | HIGH | L | 2i |
| `square-sync-orchestrator.js` | 1 | ~80 | 1 | all modules | LOW | S | 2j |
| `index.js` (facade) | 0 (re-exports) | ~60 | all consumers | all modules | LOW | S | 2j |
| **Total** | **42** | **~4,290** | | | | | |

---

## 7. Migration Strategy

### 7.1 Backward Compatibility

The `index.js` facade re-exports everything. **No consumer file needs to change its `require()` path during the split.** This is the key safety mechanism:

1. Extract module → update `index.js` to import from new module instead of `api.js`
2. All existing consumers still import from `services/square` or `utils/square-api` — both work
3. Optionally update consumers to import from specific modules later (separate PR, not blocking)

### 7.2 Per-Phase Workflow

For each phase (2a through 2j):
1. Create new module file
2. Move functions from `api.js` to new module
3. Update internal `require()` calls within moved code
4. Update `index.js` to import and re-export from new module
5. Run full test suite (42 suites, 977 tests)
6. Verify no circular dependencies: `node -e "require('./services/square')"`
7. Commit

### 7.3 Shim Cleanup (post-split)

After all phases complete:
- `api.js` should be deleted (or reduced to a comment pointing to `index.js`)
- `utils/square-api.js` shim remains for now (tracked separately — not part of this package)
- Consumer migration to specific module imports is optional and can happen on-touch

---

## 8. Observation Log

Issues discovered during investigation. **No fixes applied — investigation only.**

### O-1: Dead Export — `updateVariationPrice` (NEVER called)

**File**: `services/square/api.js:4289`
**Issue**: `updateVariationPrice` is exported but never imported or called anywhere in the codebase. Only `batchUpdateVariationPrices` is used (by `routes/vendor-catalog.js`).
**Severity**: LOW
**Recommendation**: Remove from exports during split. If needed later, re-add. No consumer impact.

### O-2: Functions Over 100 Lines (CLAUDE.md Rule Violation)

| Function | Lines | Module Target |
|----------|-------|---------------|
| `syncCatalog` | 310 | square-catalog-sync.js |
| `deltaSyncCatalog` | 313 | square-catalog-sync.js |
| `syncVariation` | 240 | square-catalog-sync.js |
| `syncItem` | 125 | square-catalog-sync.js |
| `syncSalesVelocity` | 189 | square-velocity.js |
| `syncSalesVelocityAllPeriods` | 322 | square-velocity.js |
| `updateSalesVelocityFromOrder` | 148 | square-velocity.js |
| `setSquareInventoryAlertThreshold` | 123 | square-inventory.js |
| `syncCommittedInventory` | 402 | square-inventory.js |
| `fixLocationMismatches` | 213 | square-diagnostics.js |
| `fixInventoryAlerts` | 166 | square-diagnostics.js |
| `batchUpdateCustomAttributeValues` | 108 | square-custom-attributes.js |
| `initializeCustomAttributes` | 104 | square-custom-attributes.js |
| `batchUpdateVariationPrices` | 176 | square-pricing.js |
| `updateVariationCost` | 172 | square-pricing.js |
| `batchUpdateCatalogContent` | 154 | square-pricing.js |

**16 functions exceed the 100-line rule.** During the split, these should be broken into smaller helpers within their new modules. Highest priority: `syncCommittedInventory` (402 lines) and `syncSalesVelocityAllPeriods` (322 lines).

### O-3: Inconsistent Import Paths

**17 files** import via the deprecated `utils/square-api.js` shim. Only **3 files** import directly from `services/square/api.js` or `services/square`. The shim works but adds indirection.

| Import Path | Count |
|---|---|
| `require('../utils/square-api')` | 17 files |
| `require('../services/square/api')` | 3 files |
| `require('../services/square')` | 0 files (other than index.js itself) |

**Recommendation**: After split, encourage `require('../services/square')` canonical path. Update on-touch.

### O-4: Scoping Bug in `updateVariationCost`

**File**: `services/square/api.js:4714`
**Issue**: The `catch` block references `currentVariationData` (line 4714: `const parentItemId = currentVariationData?.item_id || null`), but `currentVariationData` is declared inside the `try` block (line 4599). If the error occurs before that line, `currentVariationData` will be `undefined` and the reference will throw a `ReferenceError`. In practice this is unlikely because the code path only triggers on a specific Square error after the retrieve succeeds, but it's still a latent bug.
**Severity**: LOW (unreachable in practice, but technically incorrect)
**Recommendation**: Move `let currentVariationData` declaration before the retry loop, or use optional chaining on the variable.

### O-5: Business Logic Leaking into API Layer

**File**: `services/square/api.js:1229–1263` (inside `syncItem`)
**Issue**: `syncItem` contains brand extraction and `item_brands` table upsert logic. This is business logic (brand management) that belongs in a catalog service, not in the Square API wrapper.
**Severity**: LOW — functional, just misplaced
**Recommendation**: During catalog-sync extraction, consider extracting brand sync into a callback or separate helper.

**File**: `services/square/api.js:1507–1583` (inside `syncVariation`)
**Issue**: `syncVariation` contains custom attribute parsing (case_pack_quantity, expiration_date, does_not_expire, expiry_reviewed_at, expiry_reviewed_by) and writes to `variation_expiration` table. This is business logic for expiry management.
**Severity**: LOW — functional, just misplaced
**Recommendation**: Same approach — extract into helpers within the new module, or delegate to an expiry service.

### O-6: `syncSalesVelocityAllPeriods` Has Soft Coupling to Loyalty

**File**: `services/square/api.js:1912–1919`
**Issue**: `syncSalesVelocityAllPeriods` lazy-loads `services/loyalty-admin` for optional loyalty backfill. This creates a soft dependency from the Square API layer into the loyalty domain. The lazy-load prevents circular deps at module load time, but it's an architectural smell.
**Severity**: LOW — intentional design (disabled by default, `loyaltyBackfill = false`)
**Recommendation**: Keep as-is during split. Document the coupling. Long-term, extract to an event/hook pattern.

### O-7: `syncCommittedInventory` is 402 Lines — Largest Single Function

**File**: `services/square/api.js:2651–3052`
**Issue**: This function handles invoice fetching, status classification, stale row deletion, order line item processing, RESERVED_FOR_SALE aggregate rebuild, orphan detection, and match categorization — all in one function.
**Severity**: MEDIUM — hard to test individual steps, hard to reason about
**Recommendation**: During extraction to `square-inventory.js`, break into: `_fetchOpenInvoices()`, `_deleteStaleCommittedRows()`, `_processInvoiceLineItems()`, `_rebuildReservedForSale()`.

### O-8: Module-Level Mutable State

**File**: `services/square/api.js:36–52`
**Issue**: `merchantsWithoutInvoicesScope` (Map) and `invoicesCachePruneInterval` (setInterval) are module-level mutable state. During the split, this state must stay co-located with `syncCommittedInventory` (the only consumer). The `cleanup()` function must be updated to clear timers from all modules that have them.
**Severity**: LOW — works fine, just needs careful handling during split
**Recommendation**: Move cache + timer into `square-inventory.js`. Export a `cleanupInventory()` function. Have `square-client.js:cleanup()` call it, or have `index.js` aggregate all cleanup calls.

### O-9: `ensureVendorsExist` is Cross-Module Dependency

**File**: `services/square/api.js:1275`
**Issue**: Used internally by `syncVariation` (catalog-sync domain) and `updateVariationCost` (pricing domain). Both need to call it. Placing it in `square-vendors.js` is correct but creates the only cross-module dependency besides `square-client.js`.
**Severity**: INFO — unavoidable, well-scoped
**Recommendation**: Export from `square-vendors.js`, import in `square-catalog-sync.js` and `square-pricing.js`.

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Circular dependency introduced | LOW | HIGH | Dependency graph is acyclic by design. Verify with `node -e "require('./services/square')"` after each phase. |
| Test breakage from mock paths | MEDIUM | MEDIUM | Tests mock `../../utils/square-api` or `../../services/square/api`. The facade/shim ensures these still resolve. Run full suite after each phase. |
| Consumer imports break | LOW | HIGH | Facade re-exports everything. No consumer path changes needed. |
| Module-level state duplication | LOW | MEDIUM | Only `merchantsWithoutInvoicesScope` — moves to `square-inventory.js` only. |
| Merge conflicts with parallel work | MEDIUM | LOW | Pkg 2b has no blockers/dependents per REMEDIATION-PLAN.md. Coordinate timing with active PRs. |
| Performance regression from additional require() | NEGLIGIBLE | NONE | Node.js caches `require()` calls. No runtime cost. |

---

## 10. Definition of Done

- [ ] `services/square/api.js` reduced to <100 lines (facade only) or deleted
- [ ] All sub-modules under 1,000 lines (target <600 each)
- [ ] No circular dependencies (`node -e "require('./services/square')"` succeeds)
- [ ] All 42 test suites pass (977+ tests)
- [ ] `utils/square-api.js` shim still works
- [ ] No consumer file changes required (facade handles re-exports)
- [ ] Each sub-module has a clear JSDoc header describing its domain
- [ ] Functions >100 lines broken into helpers within their modules (best effort)
