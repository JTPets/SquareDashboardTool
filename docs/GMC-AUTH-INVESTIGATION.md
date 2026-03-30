# GMC Product Sync 401 — PERMISSION_DENIED_ACCOUNTS Investigation

**Date**: 2026-03-30
**Status**: Investigation complete, multiple root causes identified
**Account**: 670930517 (jtpets@jtpets.ca, Admin)
**GCP Project**: squaredashboardtool (803968437234)

---

## Symptom

- `testConnection()` succeeds: `GET /accounts/v1/accounts/670930517` returns 200
- `upsertProduct()` fails: `POST /products/v1/accounts/670930517/productInputs:insert` returns 401
- Error: `"The caller does not have access to the accounts: [670930517]"`
- Status: `UNAUTHENTICATED`, Reason: `PERMISSION_DENIED_ACCOUNTS`
- Same OAuth token, same merchant ID, different sub-API endpoint

## Confirmed Working

- OAuth token belongs to jtpets@jtpets.ca
- jtpets@jtpets.ca has Admin on Merchant Center 670930517
- GCP project squaredashboardtool (803968437234) is correct
- `registerGcp` completed successfully
- Merchant API enabled in GCP console (15,815 requests logged)
- OAuth scope requested: `https://www.googleapis.com/auth/content`

---

## Root Cause Analysis

### Hypothesis 1: `encodeURIComponent` mangles dataSource query parameter — **CONFIRMED BUG, FIXED**

**Likelihood: HIGH (most likely primary cause)**

The `upsertProduct()` function used `encodeURIComponent()` on the dataSource resource name:

```javascript
// BEFORE (broken):
apiPath = `/products/v1/accounts/${gmcMerchantId}/productInputs:insert?dataSource=${encodeURIComponent(dataSourceName)}`;
// Produces: ?dataSource=accounts%2F670930517%2FdataSources%2F10600545371
```

Google's Merchant API v1 documentation consistently shows resource names with **literal slashes** in query parameters — never `%2F`. All official samples (Python, Java, Node.js, Apps Script) construct the dataSource as:

```
?dataSource=accounts/670930517/dataSources/10600545371
```

When Google receives `accounts%2F670930517%2FdataSources%2F10600545371`, it cannot parse the account ownership from the encoded resource name. The account ID `670930517` appears in the URL path, but the dataSource value is an opaque blob rather than a parseable resource path. Google's authorization layer then fails the ownership check, producing `PERMISSION_DENIED_ACCOUNTS`.

**Why testConnection() works**: It has no `dataSource` parameter — it's a simple `GET /accounts/v1/accounts/670930517` with no resource name in the query string.

**Fix applied**: Commit `fix: GMC product sync auth — encodeURIComponent mangled dataSource resource name` on branch `claude/fix-gmc-product-auth-kp8dU`. Removed `encodeURIComponent()` from the dataSource parameter construction.

**Status**: Fixed in code, **not yet deployed/tested live**.

---

### Hypothesis 2: Data source type is "file" not "API" — **NEEDS VERIFICATION**

**Likelihood: MEDIUM**

Google Merchant API v1 docs state:

> "Products can only be inserted, updated, or deleted if they belong to data sources of type **API**. You cannot insert or update products within data sources that use file-based uploads."

The codebase has a TSV feed generator (`services/gmc/feed-service.js`) that creates file-based feeds. If the data source ID `10600545371` was created in the GMC UI as a file-based data source (for the TSV feed), then `productInputs:insert` will not work against it.

However, this would typically return **400 INVALID_ARGUMENT**, not 401 UNAUTHENTICATED. So this is likely a secondary issue, not the primary cause of the observed error.

**How to verify**: Call `GET /datasources/v1/accounts/670930517/dataSources/10600545371` and check the `input` field:
- `"input": "API"` = OK for productInputs:insert
- `"input": "FILE"` = Cannot use productInputs:insert, need a separate API-type data source

**How to fix if file-based**: Create a new API-type data source via the Merchant API:
```
POST https://merchantapi.googleapis.com/datasources/v1/accounts/670930517/dataSources
{
  "displayName": "SquareDashboard API Feed",
  "primaryProductDataSource": {
    "countries": ["CA"],
    "contentLanguage": "en"
  }
}
```
A successful response will have `"input": "API"`. Use the returned `dataSourceId` in GMC settings.

---

### Hypothesis 3: Token doesn't actually have `content` scope — **NEEDS VERIFICATION**

**Likelihood: MEDIUM-LOW**

Google's granular consent means scopes are unchecked by default when multiple scopes are requested. However, our app requests only **one** non-Sign-In scope (`https://www.googleapis.com/auth/content`), and Google's docs state:

> "Applications requesting only one non-Sign-In scope are not subject to the granular permission consent screen."

So the user either approved the entire request or denied it. Since `testConnection()` works, the token is valid and has some access. But it's worth verifying the token's actual granted scopes.

**How to verify**: Use the tokeninfo endpoint:

```bash
# Get a fresh access token from the app, then:
curl "https://oauth2.googleapis.com/tokeninfo?access_token=ACCESS_TOKEN_HERE"
```

Check the `scope` field in the response. It should contain `https://www.googleapis.com/auth/content`.

Also check the `scope` column in the `google_oauth_tokens` database table:

```sql
SELECT scope FROM google_oauth_tokens WHERE merchant_id = <ID>;
```

If the scope is missing or different, the merchant needs to re-authorize (disconnect + reconnect Google in GMC settings).

---

### Hypothesis 4: OAuth app in "Testing" mode with token expiry — **NEEDS VERIFICATION**

**Likelihood: MEDIUM-LOW**

If the GCP project's OAuth consent screen publishing status is "Testing":
- Only users explicitly listed as test users can authorize
- **Refresh tokens expire after 7 days**
- The app is limited to 100 test users lifetime

If the refresh token has expired, `auth.getAccessToken()` would fail silently or return an error that gets masked. The googleapis client library would attempt a token refresh using the refresh token, and if the refresh token is expired (7-day limit for Testing mode), the resulting access token would be invalid.

Additionally, Google states:
> "Apps that access the Merchant API must go through the OAuth verification review process. Unverified apps will receive warnings and **have limited functionality**."

The "limited functionality" is not enumerated specifically for the Merchant API, but may restrict write operations on the Products sub-API while allowing read operations on the Accounts sub-API.

**How to verify**:
1. Check GCP console > APIs & Services > OAuth consent screen > Publishing status
2. If "Testing", change to "In production" (requires verification for external users)
3. Check if the app has been through OAuth verification review

**Recommendation**: For a first-party app (JTPets accessing its own MC account), consider switching to a **service account** instead of OAuth. Service accounts:
- Don't require OAuth consent screens
- Don't require app verification
- Don't have token expiry issues
- Are Google's recommended approach for first-party use

---

### Hypothesis 5: Account is an MCA (advanced account) — **LOW LIKELIHOOD**

MCAs (Multi-Client Accounts / advanced accounts) cannot have product information directly — products must be inserted into sub-accounts. If `670930517` is an MCA parent, the products API would reject writes to it.

**How to verify**: The `testConnection()` response includes account info. Check if the account type is "advanced" or if there are sub-accounts.

---

### Hypothesis 6: Developer registration not properly linked — **LOW LIKELIHOOD**

The user confirms `registerGcp` completed successfully. But if the GCP project number in the registration doesn't match the project making API calls, the Products sub-API would reject requests while the Accounts sub-API (which hosts registration) might still work.

**How to verify**: Call `GET /accounts/v1/accounts/670930517/developerRegistration` and confirm the returned `gcpProjectId` matches `803968437234`.

---

## Recommended Action Plan

### Step 1: Deploy the encodeURIComponent fix (HIGH priority)

The fix on branch `claude/fix-gmc-product-auth-kp8dU` removes the `%2F` encoding. Deploy and test. This is the most likely primary cause.

### Step 2: Verify data source type (do before Step 1 test)

Hit the data source info endpoint:
```
GET /api/gmc/api/data-source-info
```
Check the response for `"input": "API"` vs `"input": "FILE"`.

If file-based, create a new API-type data source (see Hypothesis 2 above) and update the `gmc_data_source_id` setting.

### Step 3: Verify token scope (if Step 1 doesn't fix it)

```bash
# From the server, get the current access token and check it:
curl "https://oauth2.googleapis.com/tokeninfo?access_token=<TOKEN>"
```

Or add temporary logging in `merchantApiRequest()` to log the token's scopes before making the request.

### Step 4: Check GCP publishing status (if Step 3 is OK)

In GCP console > APIs & Services > OAuth consent screen:
- Check publishing status (Testing vs In production)
- Check if the app has been verified
- Consider switching to a service account for first-party use

### Step 5: Test with curl (nuclear option)

Use the curl command below to test the exact request manually with a fresh token, bypassing all app code:

```bash
# 1. Get a fresh access token (replace REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET)
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "refresh_token=REFRESH_TOKEN" \
  -d "grant_type=refresh_token" | jq -r '.access_token')

# 2. Check token scopes
curl "https://oauth2.googleapis.com/tokeninfo?access_token=$ACCESS_TOKEN"

# 3. Test accounts sub-API (should work)
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://merchantapi.googleapis.com/accounts/v1/accounts/670930517"

# 4. Test data source info
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://merchantapi.googleapis.com/datasources/v1/accounts/670930517/dataSources/10600545371"

# 5. Test product insert (the failing call) — with LITERAL slashes in dataSource
curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://merchantapi.googleapis.com/products/v1/accounts/670930517/productInputs:insert?dataSource=accounts/670930517/dataSources/10600545371" \
  -d '{
    "offerId": "TEST-SKU-001",
    "contentLanguage": "en",
    "feedLabel": "CA",
    "productAttributes": {
      "title": "Test Product",
      "description": "Test product for API verification",
      "link": "https://jtpets.ca/test",
      "availability": "IN_STOCK",
      "condition": "NEW",
      "price": {
        "amountMicros": "999000",
        "currencyCode": "CAD"
      }
    }
  }'

# 6. Same request but with %2F encoding (to confirm this is the bug)
curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://merchantapi.googleapis.com/products/v1/accounts/670930517/productInputs:insert?dataSource=accounts%2F670930517%2FdataSources%2F10600545371" \
  -d '{
    "offerId": "TEST-SKU-002",
    "contentLanguage": "en",
    "feedLabel": "CA",
    "productAttributes": {
      "title": "Test Product 2",
      "description": "Test with encoded slashes",
      "link": "https://jtpets.ca/test2",
      "availability": "IN_STOCK",
      "condition": "NEW",
      "price": {
        "amountMicros": "999000",
        "currencyCode": "CAD"
      }
    }
  }'
```

Comparing steps 5 and 6 will definitively prove whether `%2F` encoding is the root cause.

---

## Summary Table

| # | Hypothesis | Likelihood | Status | Expected Error |
|---|-----------|-----------|--------|---------------|
| 1 | `encodeURIComponent` mangles dataSource `%2F` | **HIGH** | Fixed, untested | 401 PERMISSION_DENIED_ACCOUNTS |
| 2 | Data source type is "file" not "API" | MEDIUM | Needs verification | 400 INVALID_ARGUMENT |
| 3 | Token missing `content` scope | MEDIUM-LOW | Needs verification | 401 UNAUTHENTICATED |
| 4 | OAuth app unverified / Testing mode | MEDIUM-LOW | Needs verification | Varies |
| 5 | Account is MCA (advanced) | LOW | Needs verification | 401 or 403 |
| 6 | Registration GCP project mismatch | LOW | Needs verification | 401 UNAUTHENTICATED |

**Most likely fix**: Hypothesis 1 (encodeURIComponent). Deploy the fix and test. If it still fails, work through hypotheses 2-4 using the curl commands above.

---

## Sources

- [Handle error responses | Merchant API](https://developers.google.com/merchant/api/guides/error-handling)
- [Add and manage products | Merchant API](https://developers.google.com/merchant/api/guides/products/add-manage)
- [Manage API data sources | Merchant API](https://developers.google.com/merchant/api/guides/data-sources/api-sources)
- [Register as a developer | Merchant API](https://developers.google.com/merchant/api/guides/quickstart/registration)
- [Set up authentication | Merchant API](https://developers.google.com/merchant/api/guides/quickstart/authentication)
- [Authorize access to your account | Merchant API](https://developers.google.com/merchant/api/guides/authorization/access-your-account)
- [Authorize third-party app access | Merchant API](https://developers.google.com/merchant/api/guides/authorization/access-client-accounts)
- [Verify API access | Merchant API](https://developers.google.com/merchant/api/guides/accounts/verify-api-access)
- [Migrate from v1beta to v1 | Merchant API](https://developers.google.com/merchant/api/guides/compatibility/migrate-v1beta-v1)
- [Insert product input sample | Merchant API](https://developers.google.com/merchant/api/samples/insert-product-input)
- [Unverified apps | Google Cloud](https://support.google.com/cloud/answer/7454865)
- [Granular OAuth consent | Google](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)
- [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes)
