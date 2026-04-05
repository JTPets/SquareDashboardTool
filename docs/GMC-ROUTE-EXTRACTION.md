# GMC Route Extraction Plan

`routes/gmc.js` — 1,009 lines, 33 endpoints. Three services already exist (`feed-service.js` 603 lines, `merchant-service.js` 800 lines) totalling 1,403 lines. Roughly 60% of route handlers are thin wrappers; ~40% contain extractable inline logic.

---

## Endpoints & Handler Classification

| Method | Path | Handler | Should move to |
|--------|------|---------|----------------|
| GET | `/feed` | Thin → `gmcFeed.generateFeedData()` | — |
| GET | `/feed.tsv` | Inline: Basic Auth parsing (~25 lines) + token DB lookup | `feed-service` utility |
| GET | `/feed-url` | Inline: DB query for token | `feed-service.getFeedUrl()` |
| POST | `/regenerate-token` | Inline: `crypto` + DB update | `feed-service.regenerateToken()` |
| GET | `/settings` | Thin → `gmcFeed.getSettings()` | — |
| PUT | `/settings` | Inline: upsert loop over keys | `feed-service.saveSettings()` (already exists) |
| GET | `/brands` | Inline: direct DB query | `brand-service.listBrands()` (new) |
| POST | `/brands` | Inline: DB insert + 23505 check | `brand-service.createBrand()` (new) |
| POST | `/brands/import` | Thin → `gmcFeed.importBrands()` | — |
| PUT | `/items/:id/brand` | Inline: item check + DB upsert + Square sync (~60 lines) | `brand-service.assignBrand()` (new) |
| POST | `/brands/auto-detect` | Inline: name-matching algorithm + 3 DB calls (~90 lines) | `brand-service.autoDetect()` (new) |
| POST | `/brands/bulk-assign` | Inline: DB loop + Square batch sync (~80 lines) | `brand-service.bulkAssign()` (new) |
| GET | `/taxonomy` | Inline: ILIKE search query | `feed-service.listTaxonomy()` (new) |
| POST | `/taxonomy/import` | Thin → `gmcFeed.importGoogleTaxonomy()` | — |
| GET | `/taxonomy/fetch-google` | Inline: HTTP fetch + DB upsert loop (~40 lines) | `feed-service.fetchGoogleTaxonomy()` (new) |
| PUT | `/categories/:id/taxonomy` | Inline: cat check + DB upsert | `feed-service.mapCategoryTaxonomy()` (new) |
| DELETE | `/categories/:id/taxonomy` | Inline: DB delete | `feed-service.unmapCategoryTaxonomy()` (new) |
| GET | `/category-mappings` | Inline: JOIN query | `feed-service.getCategoryMappings()` (new) |
| PUT | `/category-taxonomy` | Inline: find-or-create category + upsert | `feed-service.mapCategoryTaxonomyByName()` (new) |
| DELETE | `/category-taxonomy` | Inline: category lookup + delete | `feed-service.unmapCategoryTaxonomyByName()` (new) |
| GET | `/location-settings` | Inline: JOIN query | `feed-service.getLocationSettings()` (already exists) |
| PUT | `/location-settings/:id` | Thin → `getLocationById()` + `gmcFeed.saveLocationSettings()` | — |
| GET | `/local-inventory-feed-url` | Inline: same DB query as `/feed-url` (duplicate) | merge with `feed-service.getFeedUrl()` |
| GET | `/local-inventory-feed` | Thin → `getLocationById()` + `gmcFeed.generateLocalInventoryFeed()` | — |
| GET | `/local-inventory-feed.tsv` | Inline: Basic Auth parsing (duplicate) + location loop | extract auth helper |
| GET | `/api-settings` | Thin → `gmcApi.getGmcApiSettings()` | — |
| PUT | `/api-settings` | Thin → `gmcApi.saveGmcApiSettings()` | — |
| POST | `/api/test-connection` | Thin → `gmcApi.testConnection()` | — |
| GET | `/api/data-source-info` | Inline: settings lookup + validation + `getDataSourceInfo()` | `merchant-service` (already proxied) |
| POST | `/api/sync-products` | Inline: fire-and-forget pattern (~10 lines) | keep in route (intentional async) |
| GET | `/api/sync-status` | Thin → `gmcApi.getLastSyncStatus()` | — |
| GET | `/api/sync-history` | Thin → `gmcApi.getSyncHistory()` | — |
| POST | `/api/register-developer` | Thin → `gmcApi.registerDeveloper()` | — |

---

## Key Findings

**Duplicates / smells in the route:**
1. Basic Auth parsing copied verbatim in `GET /feed.tsv` and `GET /local-inventory-feed.tsv` — extract to `utils/gmc-feed-auth.js`.
2. Token DB lookup (`SELECT gmc_feed_token FROM merchants WHERE id = $1`) repeated in `/feed-url` and `/local-inventory-feed-url`.
3. `PUT /settings` writes inline but `feed-service` already has `saveSettings()` — route should delegate.
4. `GET /location-settings` does an inline JOIN that duplicates `feed-service.getLocationSettings()`.

**Services that already absorb work:** ~18 of 33 handlers already delegate entirely to `feed-service` or `merchant-service`. The remaining ~15 contain real inline logic.

**New service file needed:** `services/gmc/brand-service.js` for `GET /brands`, `POST /brands`, `PUT /items/:id/brand`, `POST /brands/auto-detect`, `POST /brands/bulk-assign` (~330 lines of logic to extract).

---

## Cross-Domain Calls Inside Route

| Handler | External dependency |
|---------|-------------------|
| `PUT /items/:id/brand` | `squareApi.updateCustomAttributeValues()` |
| `POST /brands/bulk-assign` | `squareApi.batchUpdateCustomAttributeValues()` |
| `PUT /location-settings/:id` | `catalog/location-service.getLocationById()` |
| `GET /local-inventory-feed` | `catalog/location-service.getLocationById()` |
| `GET /taxonomy/fetch-google` | `fetch()` → google.com |
| All GMC API endpoints | `services/gmc/merchant-service.js` (Google Merchant API) |

---

## Test Plan

**Existing tests:** `__tests__/routes/gmc.test.js` — 23 describe blocks, ~28 test cases.

**Untested endpoints (12):**

| Endpoint | Risk |
|----------|------|
| `POST /brands/import` | Low — thin wrapper |
| `POST /taxonomy/import` | Low — thin wrapper |
| `GET /taxonomy/fetch-google` | **High** — external HTTP + DB write; no mock for fetch failure |
| `PUT /categories/:id/taxonomy` | Medium — tenant isolation, upsert |
| `DELETE /categories/:id/taxonomy` | Low |
| `PUT /category-taxonomy` | Medium — find-or-create logic, silent category creation |
| `DELETE /category-taxonomy` | Low |
| `GET /local-inventory-feed-url` | Low — duplicate of `/feed-url` |
| `GET /local-inventory-feed` | **High** — location validation + feed generation |
| `GET /local-inventory-feed.tsv` | **High** — Basic Auth + multi-location loop, no test for partial location failure |
| `GET /api/data-source-info` | Medium — validation path untested |
| `PUT /api-settings` | Low — thin wrapper |

**Estimated new tests needed:** ~18 (6 high-risk paths × ~2 cases + 6 medium × 1 case).

**Priority:** `GET /local-inventory-feed.tsv` (duplicated auth, multi-location loop, error silencing) → `GET /taxonomy/fetch-google` (external HTTP, no failure path) → `GET /local-inventory-feed` → `PUT /category-taxonomy` (silent category creation) → `GET /api/data-source-info` (400 branch).
