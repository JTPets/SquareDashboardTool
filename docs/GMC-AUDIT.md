# GMC System Audit

**Date**: 2026-03-29
**Scope**: Full audit of Google Merchant Center integration
**Status**: In Progress (Sections 1-5 complete)

---

## 1. Surface Area Map

| File | Lines | Responsibility | Dependencies | Issues Noted |
|------|-------|----------------|--------------|--------------|
| `services/gmc/index.js` | 35 | Re-exports feed-service and merchant-service; backward-compat spread | `feed-service`, `merchant-service` | Spread re-export can silently shadow keys if both modules export the same name |
| `services/gmc/feed-service.js` | 602 | TSV feed generation (product + local inventory), GMC settings CRUD, brand/taxonomy import, location settings | `utils/database`, `utils/logger`, `fs`, `path` | `importBrands()` (line 321) missing `merchant_id` parameter — inserts brands without merchant scoping (global brands table). File is 602 lines (over 300 limit) |
| `services/gmc/merchant-service.js` | 1101 | Merchant API v1 calls: product upsert, batch sync, local inventory, connection test, sync logging | `googleapis`, `utils/database`, `utils/logger`, `config/constants` | **CRITICAL**: `getAuthClient()` reads encrypted tokens from DB without decrypting them (see Section 2). Token refresh handler saves plaintext tokens back without encrypting. File is 1101 lines (over 300 limit). Local inventory sync functions exported in module.exports comment says "removed" but code still exists (lines 701-925) — dead code confusion |
| `routes/gmc.js` | 992 | 32 API endpoints: feed, settings, brands, taxonomy, location settings, local inventory, GMC API sync | `services/gmc/*`, `services/square`, `services/catalog/location-service`, `middleware/*`, `utils/*` | File is 992 lines (over 300 limit). `PUT /settings` (line 199) duplicates `saveSettings()` logic inline instead of calling service. `GET /taxonomy` (line 519) missing `requireMerchant` — google_taxonomy is global but no merchant scoping on read |
| `utils/google-auth.js` | 420 | OAuth2 flow: auth URL generation, state validation, token exchange, token storage with AES-256-GCM encryption, token refresh with decryption, auto-rotation of plaintext tokens | `googleapis`, `utils/database`, `utils/logger`, `utils/token-encryption` | File is 420 lines (over 300 limit). This is the CORRECT auth implementation — uses `encryptToken()`/`decryptToken()`. But `merchant-service.js` does NOT use this module at all (see Section 2) |
| `middleware/validators/gmc.js` | 298 | Input validation for all 32 GMC routes using express-validator | `express-validator`, `middleware/validators/index` | `updateSettings` (line 49) only checks `settings` is an object — no key/value validation; arbitrary keys accepted. `updateApiSettings` (line 261) same issue — allows saving any key to `gmc_settings`, including potential injection of unexpected config |
| `routes/google-oauth.js` | 127 | OAuth connect/callback endpoints: `/api/google/auth`, `/api/google/callback`, `/api/google/status`, `/api/google/disconnect` | `utils/google-auth` | Not in scope list but critical to auth flow. This file correctly uses `google-auth.js` |
| `jobs/sync-job.js` | 216 | Scheduled GMC product sync for all merchants via cron (`GMC_SYNC_CRON_SCHEDULE`) | `services/gmc/merchant-service`, `utils/database` | Calls `syncProductCatalog()` which uses broken `getAuthClient()` — cron sync will fail with encrypted tokens |
| `jobs/cron-scheduler.js` | ~101 | Cron scheduler — registers GMC sync if `GMC_SYNC_CRON_SCHEDULE` env var is set | `jobs/sync-job` | GMC sync only enabled by env var — no UI toggle |
| `public/gmc-feed.html` | 1221 | Frontend UI for GMC feed management: feed preview, brand management, taxonomy mapping, API sync, location settings, Google OAuth connect | Inline `<script>` | 1221-line monolith HTML file. Likely has inline JS (not split to external file properly) |
| `public/js/gmc-feed.js` | 1568 | Frontend JavaScript for GMC feed page: API calls, UI state management, tab navigation | Fetch API, DOM | 1568 lines — very large frontend file |
| `config/constants.js` | — | Provides `RETRY.MAX_ATTEMPTS` (3) and `RETRY.BASE_DELAY_MS` (1000ms) used by merchant-service | — | No GMC-specific config in constants.js |
| `.env.example` | — | GMC env vars: `GMC_SYNC_CRON_SCHEDULE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | — | No env var for GMC Merchant ID or Data Source ID (stored in DB `gmc_settings` table instead) |
| `database/schema.sql` | — | Defines: `brands`, `google_taxonomy`, `category_taxonomy_mapping`, `item_brands`, `gmc_settings`, `gmc_feed_history` | — | `gmc_sync_logs`, `gmc_location_settings`, `google_oauth_tokens` are NOT in schema.sql — only created by `schema-manager.js` at runtime. Schema.sql is out of sync with actual schema |
| `utils/schema-manager.js` | — | Creates at runtime: `gmc_location_settings`, `google_oauth_tokens`, `gmc_sync_logs`, `oauth_states`; handles migration of `google_oauth_tokens` from `user_id` to `merchant_id` | — | These tables should be in schema.sql for fresh-install parity |

### Database Tables (GMC-related)

| Table | Created In | Purpose | Has merchant_id |
|-------|-----------|---------|-----------------|
| `brands` | schema.sql | Product brands | Yes |
| `google_taxonomy` | schema.sql | Google product taxonomy categories | No (global) |
| `category_taxonomy_mapping` | schema.sql | Maps Square categories to Google taxonomy | Yes |
| `item_brands` | schema.sql | Item-to-brand associations | Yes |
| `gmc_settings` | schema.sql | Key-value settings per merchant | Yes |
| `gmc_feed_history` | schema.sql | Feed generation history | Yes |
| `gmc_location_settings` | schema-manager.js | Google store codes per location | Yes |
| `gmc_sync_logs` | schema-manager.js | API sync history and status | Yes |
| `google_oauth_tokens` | schema-manager.js | OAuth2 access/refresh tokens (encrypted) | Yes |
| `oauth_states` | schema.sql | CSRF state for OAuth flow | Yes |

---

## 2. Authentication Flow & v1 Auth Bug

### 2.1 OAuth Connect Flow

1. **User clicks "Connect Google Account"** on `gmc-feed.html`
2. **Frontend** calls `GET /api/google/auth` (in `routes/google-oauth.js`)
3. **Backend** (`utils/google-auth.js:getAuthUrl()`) generates auth URL:
   - Creates OAuth2 client with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
   - Generates cryptographically random state (256-bit, stored in `oauth_states` table with 10-min expiry)
   - Requests scope: **`https://www.googleapis.com/auth/content`**
   - Forces `prompt: 'consent'` and `access_type: 'offline'` to ensure refresh token
4. **User** redirected to Google consent screen
5. **Google** redirects to `GET /api/google/callback` with `code` and `state`
6. **Backend** (`routes/google-oauth.js`) validates state via `google-auth.js:validateAuthState()`:
   - Checks state exists in DB, not expired, not used
   - Marks state as used immediately (prevents replay)
   - Returns `merchantId` and `userId` from state record
7. **Backend** exchanges code for tokens via `google-auth.js:exchangeCodeForTokens()`
8. **Tokens are encrypted** with AES-256-GCM via `utils/token-encryption.js` before storage
9. **Stored in** `google_oauth_tokens` table (access_token, refresh_token, expiry_date, scope)

### 2.2 Token Storage

| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `access_token` | TEXT | Yes (AES-256-GCM) | Encrypted since SEC-6 |
| `refresh_token` | TEXT | Yes (AES-256-GCM) | Preserved on refresh (COALESCE) |
| `token_type` | TEXT | No | Always "Bearer" |
| `expiry_date` | TEXT | No | Unix timestamp (ms) |
| `scope` | TEXT | No | Granted scopes |
| `merchant_id` | INTEGER | No | FK to merchants, UNIQUE |

### 2.3 Token Refresh

**Two separate implementations exist** — this is the root of the auth bug:

#### Path A: `utils/google-auth.js:getAuthenticatedClient()` (CORRECT)
1. Calls `loadTokens(merchantId)` which:
   - Reads encrypted tokens from DB
   - **Decrypts** via `decryptToken()` (detects encrypted format via `isEncryptedToken()`)
   - Auto-rotates any legacy plaintext tokens to encrypted (fire-and-forget)
2. Sets decrypted credentials on OAuth2 client
3. Registers `tokens` event listener that calls `saveTokens()`:
   - `saveTokens()` **encrypts** new tokens before writing to DB
4. Google's OAuth2 client auto-refreshes when `expiry_date` has passed

#### Path B: `services/gmc/merchant-service.js:getAuthClient()` (BROKEN)
1. Reads tokens directly from DB via raw SQL: `SELECT * FROM google_oauth_tokens WHERE merchant_id = $1`
2. **Does NOT decrypt** — passes encrypted ciphertext directly as `access_token` and `refresh_token`
3. Sets these encrypted blobs as OAuth2 credentials
4. Registers `tokens` event listener that:
   - Saves the new `access_token` and `expiry_date` directly to DB
   - **Does NOT encrypt** the new token before saving
   - **Does NOT preserve** the refresh_token (only updates access_token + expiry_date)

**This means:**
- Every GMC API call (sync, test connection, data source info) passes an AES-256-GCM ciphertext blob as the Bearer token
- Google rejects it with `401 UNAUTHENTICATED` because the "token" is encrypted gibberish
- If the googleapis library somehow triggers a refresh using the encrypted refresh_token, that also fails
- If a refresh DID succeed, it would save the new access_token in **plaintext** (breaking the encryption guarantee)

### 2.4 `merchantApiRequest()` — How API Calls Are Made

```
merchantApiRequest(auth, method, path, body)
```

1. Gets access token via `auth.getAccessToken()` — this calls Google's OAuth2 client which returns the (encrypted) token as-is
2. Sets `Authorization: Bearer <encrypted_ciphertext>` header
3. Makes HTTP fetch to `https://merchantapi.googleapis.com{path}`
4. Retries on 429 (rate limit) and 5xx (server errors); does NOT retry 4xx (including 401)
5. The 401 is treated as a non-retryable client error and thrown immediately

### 2.5 The v1beta to v1 URL Migration

| Component | v1beta URL (worked before Feb 28 2026) | v1 URL (current code) |
|-----------|---------------------------------------|----------------------|
| Account info | `merchantapi.googleapis.com/accounts/v1beta/accounts/{id}` | `merchantapi.googleapis.com/accounts/v1/accounts/{id}` |
| Data source | `merchantapi.googleapis.com/datasources/v1beta/accounts/{id}/dataSources/{dsId}` | `merchantapi.googleapis.com/datasources/v1/accounts/{id}/dataSources/{dsId}` |
| Product insert | `merchantapi.googleapis.com/products/v1beta/accounts/{id}/productInputs:insert` | `merchantapi.googleapis.com/products/v1/accounts/{id}/productInputs:insert` |
| Local inventory | `merchantapi.googleapis.com/inventories/v1beta/accounts/{id}/products/{product}/localInventories:insert` | `merchantapi.googleapis.com/inventories/v1/accounts/{id}/products/{product}/localInventories:insert` |

The URL migration from `v1beta` to `v1` is correct — Google deprecated v1beta on Feb 28, 2026.

### 2.6 Scope Analysis

The OAuth scope requested is:
```
https://www.googleapis.com/auth/content
```

The API being called is:
```
https://merchantapi.googleapis.com/...
```

**Does the `content` scope cover `merchantapi.googleapis.com`?**

The `content` scope was originally for the Content API for Shopping (`www.googleapis.com/content/v2.1/...`). When Google introduced the Merchant API (`merchantapi.googleapis.com`), they maintained backward compatibility — the same `content` scope grants access to the new Merchant API endpoints.

The code comment at `merchant-service.js:23-24` states:
> "The 'content' scope covers both Content API and Merchant API v1 — no re-auth needed."

And at `google-auth.js:19-20`:
> "Scope: content — covers both legacy Content API and Merchant API v1."

**This is correct.** Google's Merchant API documentation confirms that the `content` scope covers the new API. The scope is NOT the problem.

### 2.7 ROOT CAUSE: 401 UNAUTHENTICATED

**The 401 error is NOT caused by the v1beta-to-v1 migration or a scope mismatch.**

**Root cause: `merchant-service.js:getAuthClient()` passes AES-256-GCM encrypted ciphertext as the Bearer token instead of the actual OAuth access token.**

The chain of failure:

1. `google-auth.js:saveTokens()` correctly encrypts tokens before storage (SEC-6 hardening)
2. `merchant-service.js:getAuthClient()` was written BEFORE token encryption was added (or was never updated to account for it)
3. `getAuthClient()` reads raw DB values and passes them directly to `oauth2Client.setCredentials()`
4. The "access_token" is actually `enc:v1:<iv>:<authTag>:<ciphertext>` — not a valid Google token
5. `merchantApiRequest()` calls `auth.getAccessToken()` which returns this ciphertext
6. Google receives `Authorization: Bearer enc:v1:...` and returns `401 UNAUTHENTICATED`

**Why the token is "fresh" (just re-authed) but still fails:** Re-authentication goes through `google-auth.js:exchangeCodeForTokens()` which correctly encrypts. The encrypted token is saved. Then `merchant-service.js:getAuthClient()` reads the encrypted blob and uses it as-is.

**Secondary bugs in the same code path:**

1. **Token refresh handler saves plaintext** (`merchant-service.js:67-73`): If Google's library somehow refreshes the token, the new access_token is saved without encryption, breaking the SEC-6 guarantee
2. **Refresh token not preserved on refresh** (`merchant-service.js:67-73`): The UPDATE only sets `access_token` and `expiry_date` — if the refresh_token also changes (Google can rotate refresh tokens), the new value is lost
3. **Duplicate auth implementation**: Two completely separate OAuth client factories exist (`google-auth.js:getAuthenticatedClient` and `merchant-service.js:getAuthClient`). The merchant-service version should be deleted and replaced with the google-auth.js version

**Fix:** Replace `merchant-service.js:getAuthClient()` with a call to `google-auth.js:getAuthenticatedClient()`. This eliminates the duplicate implementation, uses proper decryption, and fixes the token refresh handler.

---

## 3. API Endpoint Map

### 3.1 Merchant API Functions

| Function | Full URL | HTTP Method | Google v1 Spec Endpoint | Schema Match? | Issues |
|----------|----------|-------------|------------------------|---------------|--------|
| `testConnection()` | `merchantapi.googleapis.com/accounts/v1/accounts/{gmcMerchantId}` | GET | `accounts.accounts.get` | **Yes** — path matches `accounts/v1/accounts/{name}` | None — straightforward account lookup |
| `getDataSourceInfo()` | `merchantapi.googleapis.com/datasources/v1/accounts/{gmcMerchantId}/dataSources/{dataSourceId}` | GET | `accounts.dataSources.get` | **Yes** — path matches `datasources/v1/accounts/{parent}/dataSources/{name}` | Catch block references `path` variable from try scope — throws ReferenceError, masking original error (line 325) |
| `upsertProduct()` | `merchantapi.googleapis.com/products/v1/accounts/{gmcMerchantId}/productInputs:insert?dataSource=accounts/{id}/dataSources/{dsId}` | POST | `accounts.productInputs.insert` | **Partial** — see 3.2 below | Catch block references `apiPath` from try scope — same ReferenceError bug (line 368). `dataSource` query param format is correct per spec |
| `batchUpsertProducts()` | (calls `upsertProduct` N times) | — | No batch endpoint in v1 | **N/A** — Google Merchant API v1 has no batch endpoint | Processes sequentially in chunks of 10 concurrent. For large catalogs (500+ items) this will be slow and may hit rate limits |
| `updateLocalInventory()` | `merchantapi.googleapis.com/inventories/v1/accounts/{gmcMerchantId}/products/{productName}/localInventories:insert` | POST | `accounts.products.localInventories.insert` | **Partial** — see 3.3 below | NOT exported (dead code since line 1099 comment). Product name format `local~en~CA~{offerId}` may be wrong — see 3.3 |
| `syncProductCatalog()` | (orchestrator — calls `getDataSourceInfo` + `batchUpsertProducts`) | — | — | — | Queries products, builds GMC format, syncs ONLINE channel only |
| `syncLocationInventory()` | (orchestrator — calls `batchUpdateLocalInventory`) | — | — | — | NOT exported (dead code) |
| `syncAllLocationsInventory()` | (orchestrator — calls `syncLocationInventory` per location) | — | — | — | NOT exported (dead code) |

### 3.2 `buildMerchantApiProduct()` — Schema Comparison

Output shape (from line 443-478):

```javascript
{
    offerId: string,           // Required ✓
    channel: "ONLINE",         // Required ✓ (enum: ONLINE, LOCAL)
    feedLabel: string,         // Optional ✓ (only if configured)
    contentLanguage: string,   // Optional ✓ (only if configured)
    attributes: {
        title: string,                  // Required ✓
        description: string,            // Required ✓
        link: string,                   // Required ✓
        imageLink: string,              // Required ✓
        availability: string,           // Required ✓ ("in_stock" | "out_of_stock")
        condition: string,              // Required ✓ ("new")
        price: {
            amountMicros: string,       // Required ✓ (string of integer)
            currencyCode: string        // Required ✓ ("CAD")
        },
        gtin: string | undefined,       // Optional ✓
        brand: string | undefined,      // Optional ✓
        googleProductCategory: string   // Optional ✓
    }
}
```

**vs Google Merchant API v1 `ProductInput` spec:**

| Field | Spec | Code | Match? |
|-------|------|------|--------|
| `offerId` | string, required | ✓ | Yes |
| `channel` | enum (ONLINE, LOCAL), required | ✓ ONLINE only | Yes |
| `feedLabel` | string, optional | ✓ conditional | Yes |
| `contentLanguage` | string, optional | ✓ conditional | Yes |
| `attributes.title` | string | ✓ | Yes |
| `attributes.description` | string | ✓ | Yes |
| `attributes.link` | string (URL) | ✓ | Yes |
| `attributes.imageLink` | string (URL) | ✓ but may be undefined | **Issue**: if no image, sends `undefined` which serializes as missing key — Google may reject |
| `attributes.availability` | string | ✓ lowercase values | **Issue**: Google v1 spec expects lowercase (`in_stock`), code sends lowercase — OK |
| `attributes.condition` | string | ✓ | Yes |
| `attributes.price.amountMicros` | string (int64) | ✓ `Math.round(...).toString()` | Yes |
| `attributes.price.currencyCode` | string | ✓ | Yes |
| `attributes.gtin` | string | ✓ optional | Yes |
| `attributes.brand` | string | ✓ optional | Yes |
| `attributes.googleProductCategory` | string | ✓ optional | Yes |
| `attributes.adult` | boolean | ✗ missing | **Gap**: feed TSV includes `adult`, API sync does not |
| `attributes.isBundle` | boolean | ✗ missing | **Gap**: feed TSV includes `is_bundle`, API sync does not |
| `attributes.identifierExists` | boolean | ✗ missing | **Gap**: products without GTIN should set `identifierExists: false` to avoid disapproval |

**Key issues:**
1. Products without images send `imageLink: undefined` — may cause `MISSING_IMAGE_LINK` disapproval
2. Products without GTIN don't set `identifierExists: false` — may cause `MISSING_IDENTIFIER` disapproval
3. `adult` and `is_bundle` are in the TSV feed but NOT in the API sync — inconsistency between the two sync paths

### 3.3 `updateLocalInventory()` — Schema Comparison

Request body (from line 717-721):

```javascript
{
    storeCode: string,
    availability: string,    // e.g. "IN_STOCK" (uppercased)
    quantity: string         // e.g. "42" (stringified integer)
}
```

**vs Google Merchant API v1 `LocalInventory` spec:**

| Field | Spec | Code | Match? |
|-------|------|------|--------|
| `storeCode` | string, required | ✓ | Yes |
| `availability` | string | `.toUpperCase().replace('_', '_')` | **Bug**: the replace is a no-op (`_` → `_`). But the uppercasing is wrong — Google v1 expects lowercase `in_stock`, not `IN_STOCK` |
| `quantity` | string (int64) | ✓ `.toString()` | Yes |
| `price` | `Price` object | ✗ missing | Optional but recommended — local price may differ from online |

**Product name format issue:**

The product name is built as: `local~{lang}~{feed}~{productId}` (line 714)

Google's product name format for local inventory is: `{channel}~{contentLanguage}~{feedLabel}~{offerId}`

- The channel prefix for local inventory lookups should reference the ONLINE product: `online~en~CA~{offerId}` — you're inserting local inventory FOR an online-channel product
- Code uses `local~en~CA~{offerId}` — this references a LOCAL-channel product, which may not exist if products are only synced to ONLINE channel (which they are — see `syncProductCatalog` line 646)
- If the product was only pushed as ONLINE, the `local~` prefix won't match any known product, and Google will reject with NOT_FOUND

**Defaults hardcoded:**
- `contentLanguage` defaults to `'en'` (line 712) — should match what the product was synced with
- `feedLabel` defaults to `'CA'` (line 713) — should match what the product was synced with
- If products were synced WITHOUT feedLabel/contentLanguage (both are optional in `buildMerchantApiProduct`), these defaults may not match

### 3.4 Dead Code Summary

~330 lines of local inventory sync code exist but are NOT exported (lines 701-1034):
- `updateLocalInventory()` — single product local inventory update
- `batchUpdateLocalInventory()` — parallel batch with concurrency=10
- `syncLocationInventory()` — sync all products for one location
- `syncAllLocationsInventory()` — sync all locations with logging

The `module.exports` comment (line 1099) says "Local inventory sync removed — use TSV feed instead" but the code is still present. This is ~30% of the file.

---

## 4. Feed Generation Pipeline

### 4.1 Trigger Mechanisms

The TSV feed is generated **on-demand** — there is no pre-generated file or cron job for feed generation.

| Trigger | Endpoint | Auth | What happens |
|---------|----------|------|-------------|
| Google Merchant Center polling | `GET /api/gmc/feed.tsv?token=xxx` | Feed token (query param or HTTP Basic Auth) | Generates TSV from DB on every request |
| User preview (JSON) | `GET /api/gmc/feed` | Session auth | Returns JSON feed data |
| Local inventory polling | `GET /api/gmc/local-inventory-feed.tsv?token=xxx` | Feed token | Generates local inventory TSV on every request |
| Local inventory preview | `GET /api/gmc/local-inventory-feed` | Session auth | Returns JSON for one location |
| API push (products) | `POST /api/gmc/api/sync-products` | Session auth | Pushes products via Merchant API (broken — see Section 2) |
| Cron push (products) | `GMC_SYNC_CRON_SCHEDULE` env var | N/A (server-side) | Calls `syncProductCatalog()` for all merchants (broken — see Section 2) |

**There is NO Google Sheets integration.** The `google-auth.js` file was renamed from `google-sheets.js` but the module has never handled Sheets (per its own comment at line 8).

### 4.2 TSV Product Feed Format

Generated by `feed-service.js:generateTsvContent()` (line 244-286).

**Column order:**

| # | Column Name | Source | Required by GMC? |
|---|-------------|--------|-----------------|
| 1 | `id` | `variation_id` (Square variation ID) | Yes |
| 2 | `title` | `item_name~variation_name` or just `item_name` | Yes |
| 3 | `link` | `baseUrl + urlPattern` (configurable) | Yes |
| 4 | `description` | `item.description` | Yes |
| 5 | `gtin` | `variation.upc` | Conditional |
| 6 | `category` | `item.category_name` (Square category) | No (custom) |
| 7 | `image_link` | First image URL from `images` table | Yes |
| 8 | `additional_image_link` | Second image URL | No |
| 9 | `additional_image_link` | Third image URL | No |
| 10 | `condition` | Setting `default_condition` (default: "new") | Yes |
| 11 | `availability` | Computed from inventory count | Yes |
| 12 | `quantity` | Sum of `IN_STOCK` inventory across locations | No |
| 13 | `brand` | From `brands` table via `item_brands` join | Conditional |
| 14 | `google_product_category` | From `google_taxonomy` via `category_taxonomy_mapping` | Recommended |
| 15 | `price` | `"XX.XX CAD"` format (cents/100) | Yes |
| 16 | `adult` | Setting `adult_content` (default: "no") | Yes |
| 17 | `is_bundle` | Setting `is_bundle` (default: "no") | Yes |

**Issues with TSV format:**

1. **Duplicate column header**: Columns 8 and 9 both use header `additional_image_link` — Google expects `additional_image_link` as a single column with pipe-separated URLs, not two separate columns with the same name. This may cause Google to ignore the second image or reject the feed.
2. **`category` is not a GMC field**: Column 6 uses the Square category name as `category`, but GMC expects `google_product_category` (column 14) for categorization. `category` is not a recognized GMC column — Google will ignore it.
3. **`quantity` column**: Not a standard GMC product feed column. Google uses `availability` not quantity. Harmless (Google ignores unknown columns) but adds bloat.
4. **`title` uses `~` separator**: `item_name~variation_name` uses tilde — Google recommends dash or space separators for readability in Shopping ads.
5. **No `mpn` column**: If products have manufacturer part numbers but no GTIN, they need `mpn` + `brand` for identification. Missing MPN can cause disapprovals.
6. **Missing `shipping` and `tax` columns**: Required for many countries. For Canada, `tax` is usually handled at account level but `shipping` may be needed.

### 4.3 TSV Local Inventory Feed Format

Generated by `feed-service.js:generateLocalInventoryTsvContent()` (line 553-568).

| # | Column Name | Source | Required by GMC? |
|---|-------------|--------|-----------------|
| 1 | `store_code` | `gmc_location_settings.google_store_code` or location ID | Yes |
| 2 | `itemid` | `variation_id` | Yes |
| 3 | `quantity` | Sum of `IN_STOCK` at specific location | Yes |

**Issues:**
1. **Missing `availability` column**: Google requires `availability` in local inventory feeds. Without it, Google cannot determine stock status.
2. **Missing `price` column**: If local pricing differs from online, this is needed. Optional but recommended.

### 4.4 Feed Data Source (SQL Query)

The main product feed query (feed-service.js line 109-156) joins:
- `variations` → `items` (product data)
- `item_brands` → `brands` (brand name)
- `category_taxonomy_mapping` → `google_taxonomy` (Google category)
- `inventory_counts` (stock quantity)
- `images` (image URLs via JSONB array)

**Filters:**
- `v.is_deleted = FALSE AND i.is_deleted = FALSE` — excludes deleted items
- `i.available_online = TRUE` — only items marked for online sale
- `v.merchant_id = $1` — multi-tenant isolation (correct)

**Performance concern:** The image URL resolution uses a correlated subquery with `jsonb_array_elements_text` + JOIN for every row. For large catalogs (1000+ variations), this generates on-demand for each HTTP request — no caching. Google may poll this every few hours.

### 4.5 Feed Working Status

**Yes, the TSV feed generation works despite the API being broken.** The TSV feed (`/api/gmc/feed.tsv`) uses `feed-service.js` which only reads from the database — it does NOT call the Merchant API and does NOT use `merchant-service.js:getAuthClient()`. The broken auth path only affects the API push (`/api/gmc/api/sync-products` and cron).

| Component | Working? | Why |
|-----------|----------|-----|
| TSV product feed | **Yes** | Database-only, no API auth needed |
| TSV local inventory feed | **Yes** | Database-only, no API auth needed |
| API product sync | **No** | Uses broken `getAuthClient()` |
| API connection test | **No** | Uses broken `getAuthClient()` |
| Cron sync | **No** | Uses broken `getAuthClient()` |

Google Merchant Center can still fetch the TSV feed if it's configured with the correct feed URL and token. The TSV-based feed is the working path; the API push path is entirely broken.

---

## 5. Security Findings

| ID | Severity | File:Line | Description | Fix |
|----|----------|-----------|-------------|-----|
| SEC-GMC-1 | **CRITICAL** | `merchant-service.js:38-83` | `getAuthClient()` reads AES-256-GCM encrypted tokens from DB without decrypting. Passes ciphertext as Bearer token. All API operations fail with 401. | Replace with `google-auth.js:getAuthenticatedClient()` |
| SEC-GMC-2 | **HIGH** | `merchant-service.js:65-79` | Token refresh handler saves new access_token to DB in **plaintext** (no `encryptToken()` call). If a refresh ever succeeds, it breaks the SEC-6 encryption guarantee. Subsequent reads via `google-auth.js:loadTokens()` would detect plaintext and re-encrypt, but there's a window where tokens are unencrypted at rest. | Delete this handler; use `google-auth.js` which encrypts on refresh |
| SEC-GMC-3 | **HIGH** | `routes/gmc.js:443` | `POST /brands/bulk-assign` queries `SELECT id, name FROM brands WHERE id = ANY($1)` **without `merchant_id` filter**. A merchant can reference brand IDs belonging to another merchant, leaking brand names cross-tenant. | Add `AND merchant_id = $2` with `merchantId` parameter |
| SEC-GMC-4 | **MEDIUM** | `feed-service.js:321-336` | `importBrands(brandNames)` inserts into `brands` table **without `merchant_id`**. Route passes `merchantId` as second arg (line 237) but function signature ignores it. Brands are created as global (null merchant_id) or violate NOT NULL constraint. | Add `merchantId` parameter to function signature and use in INSERT |
| SEC-GMC-5 | **MEDIUM** | `routes/gmc.js:199-215` | `PUT /settings` accepts arbitrary keys in `settings` object. Validator only checks `settings` is an object. Attacker could inject keys like `gmc_merchant_id` or `gmc_data_source_id` to redirect sync to a different GMC account, or stuff the table with garbage keys. | Add allowlist of valid setting keys in validator |
| SEC-GMC-6 | **MEDIUM** | `routes/gmc.js:915-921` | `PUT /api-settings` same issue — accepts arbitrary settings keys. Could overwrite `gmc_merchant_id` to point API sync at attacker's Merchant Center account. | Add allowlist of valid API setting keys (`gmc_merchant_id`, `gmc_data_source_id`, `feed_label`, `content_language`, `currency`) |
| SEC-GMC-7 | **MEDIUM** | `merchant-service.js:315-317` | `getDataSourceInfo()` logs full API response with `JSON.stringify(response, null, 2)` — unbounded. Response could contain sensitive merchant data (account details, data source config). Other error paths truncate to 500 chars. | Truncate or redact response logging |
| SEC-GMC-8 | **MEDIUM** | `merchant-service.js:325` | `getDataSourceInfo()` catch block references `path` from try scope — throws ReferenceError, masking the original error and potentially crashing the process if not caught higher up. Same bug in `upsertProduct()` catch at line 368 with `apiPath`. | Declare `let path`/`let apiPath` before try block (like `testConnection()` does correctly at line 1040) |
| SEC-GMC-9 | **LOW** | `routes/gmc.js:519` | `GET /taxonomy` uses `requireAuth` but NOT `requireMerchant`. The `google_taxonomy` table is intentionally global (shared reference data), so this is not a data leak. But it breaks the middleware pattern — all `/api/gmc/*` routes should have consistent auth requirements. | Add `requireMerchant` for consistency, or document the exception |
| SEC-GMC-10 | **LOW** | `routes/gmc.js:544` | `POST /taxonomy/import` uses `requireAdmin` but NOT `requireMerchant`. Same pattern issue. Taxonomy is global data, so admin-only is correct, but inconsistent with other routes. | Document as intentional (global reference data, admin-only) |
| SEC-GMC-11 | **LOW** | `routes/gmc.js:555` | `GET /taxonomy/fetch-google` fetches from external URL (`google.com/basepages/...`) — no timeout, no response size limit. A slow/large response could tie up the request handler. | Add fetch timeout and response size limit |
| SEC-GMC-12 | **LOW** | `feed-service.js:343-362` | `importGoogleTaxonomy()` accepts user-provided `id` values for `google_taxonomy` table. Since IDs come from Google's official taxonomy file, they're expected to be integers, but no explicit integer validation in the function (validator only checks `taxonomy` is an array). | Add integer validation for `item.id` in the function |
| SEC-GMC-13 | **INFO** | `routes/gmc.js:80-128` | Feed token compared via SQL query (not timing-safe `crypto.timingSafeEqual`). Feed tokens are 256-bit random hex, so brute-force is infeasible regardless, but timing-safe comparison is best practice. | Consider timing-safe comparison for defense-in-depth |
| SEC-GMC-14 | **INFO** | `merchant-service.js:701-1034` | ~330 lines of unexported dead code (local inventory sync functions). Dead code increases attack surface audit burden and can mask bugs. Comment at line 1099 says "removed" but code is still present. | Delete dead code or re-export if still needed |

### SQL Parameterization Audit

All SQL queries across GMC files use parameterized queries (`$1, $2, ...`). No string concatenation or template literal interpolation in SQL was found. This is correct.

**Queries audited:**
- `feed-service.js`: 9 queries — all parameterized, all include `merchant_id` filter ✓
- `merchant-service.js`: 11 queries — all parameterized, all include `merchant_id` filter ✓
- `routes/gmc.js`: 14 queries — all parameterized, 13/14 include `merchant_id` filter (exception: `brands WHERE id = ANY($1)` at line 443 — SEC-GMC-3) ✗

### Token Handling Audit

| Location | Operation | Encrypted? | Issue |
|----------|-----------|-----------|-------|
| `google-auth.js:saveTokens()` | Write tokens to DB | ✓ Yes (AES-256-GCM) | Correct |
| `google-auth.js:loadTokens()` | Read tokens from DB | ✓ Decrypts + auto-rotates plaintext | Correct |
| `google-auth.js:getAuthenticatedClient()` | Set credentials on OAuth2 client | ✓ Uses decrypted tokens | Correct |
| `merchant-service.js:getAuthClient()` | Read tokens + set credentials | ✗ **No decryption** | **SEC-GMC-1** |
| `merchant-service.js:65-79` | Token refresh handler writes to DB | ✗ **No encryption** | **SEC-GMC-2** |
| `routes/gmc.js:164` | Regenerate feed token | N/A (different token — `crypto.randomBytes(32)`) | Correct — feed token is not an OAuth token |

## 6. Module Breakdown — TODO

## 7. Frontend Bugs — TODO

## 8. Bug Registry — TODO

## 9. Fix Plan — TODO
