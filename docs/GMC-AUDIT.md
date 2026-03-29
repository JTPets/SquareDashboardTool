# GMC System Audit

**Date**: 2026-03-29
**Scope**: Full audit of Google Merchant Center integration
**Status**: In Progress (Sections 1-2 complete)

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

## 3. API Endpoint Map — TODO

## 4. Feed Pipeline — TODO

## 5. Security — TODO

## 6. Module Breakdown — TODO

## 7. Frontend Bugs — TODO

## 8. Bug Registry — TODO

## 9. Fix Plan — TODO
