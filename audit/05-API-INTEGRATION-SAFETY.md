# Section 5: API INTEGRATION SAFETY

**Rating: PASS**

## 5.1 Square API — Error Handling & Retries

**PASS**

### Retry Logic (`services/square/square-client.js:84-183`)

| Feature | Implementation |
|---------|---------------|
| Max retries | Configurable via `config/constants.js` (centralized) |
| Timeout | 30s per request via `AbortController` (line 103-104) |
| Rate limiting (429) | Respects `retry-after` header, retries automatically (lines 116-121) |
| Exponential backoff | `RETRY_DELAY_MS * 2^attempt` on transient errors (line 159) |
| Non-retryable errors | 400, 401, 409, `IDEMPOTENCY_KEY_REUSED`, `VERSION_MISMATCH` — thrown immediately (lines 128-145) |
| Timeout cleanup | `clearTimeout()` in `finally` block (line 177-179) |

This is a well-structured retry implementation. Timeout, backoff, and non-retryable error detection are all correct.

### Idempotency Keys

**PASS** — All Square write operations use `crypto.randomUUID()` via `utils/idempotency.js`. The key generation uses a prefix for debuggability (e.g., `webhook-create-${merchantId}`) but the UUID portion ensures uniqueness.

Sampled:
- `utils/square-webhooks.js:251` — `generateIdempotencyKey('webhook-create-...')`
- `utils/square-subscriptions.js:116` — `generateIdempotencyKey('plan-...')`
- `utils/square-subscriptions.js:209` — `generateIdempotencyKey('sub-...')`
- Square SDK write operations use `crypto.randomUUID()` directly per CLAUDE.md pattern

---

## 5.2 Square API — Token Management

**PASS**

### Token Encryption at Rest

`utils/token-encryption.js`:
- Algorithm: AES-256-GCM
- Key: 64-character hex (256-bit), validated on load (line 30)
- IV: Random 16 bytes per encryption via `crypto.randomBytes(16)`
- Format: `iv:authTag:ciphertext` (base64 encoded)
- Authentication tag prevents tampering

### Token Refresh (`utils/square-token.js:23-79`)

| Feature | Implementation |
|---------|---------------|
| Refresh trigger | Token within 1 hour of expiry (line 230 in `middleware/merchant.js`) |
| New token encryption | Both access and refresh tokens encrypted before DB storage (lines 66-68) |
| Null refresh token handling | Preserves existing refresh token if Square doesn't return a new one (line 68) |

### Finding 5.2.1 — Token refresh has no race condition protection

**Severity: LOW**

`middleware/merchant.js:234` and `routes/square-oauth.js:516` both check token expiry and call `refreshMerchantToken()`. If two concurrent requests for the same merchant hit the refresh window simultaneously, both will attempt to refresh the token. The second refresh may fail because Square invalidates the old refresh token after the first refresh succeeds.

No mutex, lock, or atomic compare-and-swap protects the refresh operation:

```javascript
// middleware/merchant.js:234
if (expiresAt < oneHourFromNow && m.square_refresh_token) {
    const refreshResult = await refreshMerchantToken(merchantId); // No lock
    accessToken = refreshResult.accessToken;
}
```

**Impact**: On a single-process PM2 deployment (current setup), the window is narrow. Under load or multi-process deployment, concurrent refreshes could cause intermittent auth failures until the next successful refresh.

**Fix**: Use a simple in-memory lock per merchantId (or PostgreSQL advisory lock for multi-process):
```javascript
const refreshLocks = new Map();
async function refreshWithLock(merchantId) {
    if (refreshLocks.has(merchantId)) return refreshLocks.get(merchantId);
    const promise = refreshMerchantToken(merchantId);
    refreshLocks.set(merchantId, promise);
    try { return await promise; } finally { refreshLocks.delete(merchantId); }
}
```

### Legacy Token Migration

**PASS** — `square-client.js:58-73` detects unencrypted legacy tokens via `isEncryptedToken()`, encrypts them transparently, and saves the encrypted version. Graceful migration path.

---

## 5.3 Square OAuth Flow

**PASS**

### CSRF Protection

`routes/square-oauth.js:86-99`:
- State parameter: `crypto.randomBytes(32).toString('hex')` — 256-bit entropy
- Stored in DB with 10-minute expiry (`STATE_EXPIRY_MINUTES = 10`)
- Validated on callback: must exist, not expired, not used (`used_at IS NULL`)
- Marked as used immediately after validation (line 170) — prevents replay
- User ID verified: callback checks `req.session.user.id === stateRecord.user_id` (line 159)

### Open Redirect Prevention

`routes/square-oauth.js:41-46`:
```javascript
function isLocalPath(url) {
    if (!url || typeof url !== 'string') return false;
    return /^\/[^/\\]/.test(url) && !url.includes('://') && !/[\x00-\x1f]/.test(url);
}
```
- Rejects `//evil.com` (double slash)
- Rejects `\evil.com` (backslash)
- Rejects protocol-relative URLs
- Rejects control characters
- Redirect URL re-validated on callback (line 375) even though it was stored in DB

### Token Revocation

`routes/square-oauth.js:403-470`:
- Revokes token with Square API (best effort — logged but not blocking on failure)
- Overwrites access token with `'REVOKED'` string in DB
- Nulls refresh token
- Clears session merchant context
- Requires `requireMerchantRole('owner')` — only owners can disconnect

### Session Regeneration on OAuth

**PASS** — `routes/square-oauth.js:312-326`: Session regenerated after OAuth callback to prevent session fixation. User data and new merchant ID restored to fresh session.

---

## 5.4 Google OAuth Flow

**PASS**

`routes/google-oauth.js:78-115`:
- State-based CSRF protection via `googleAuth.validateAuthState(state)` (line 97)
- Merchant ID derived from DB record, not from state value (line 98)
- State marked as used to prevent replay
- Error details not exposed in redirect URL — uses generic `oauth_failed` code (line 113)
- `PUBLIC_APP_URL` used for post-OAuth redirect (not request hostname) — prevents redirect to attacker-controlled host

---

## 5.5 Webhook Signature Verification

**PASS**

`services/webhook-processor.js:77-96`:

| Feature | Implementation |
|---------|---------------|
| Algorithm | HMAC-SHA256 |
| Input | `notificationUrl + rawBody` (matches Square's spec) |
| Comparison | `crypto.timingSafeEqual()` (line 95) |
| Length check | Explicit length comparison before `timingSafeEqual` (line 91-93) |
| Null check | Returns `false` if signature missing or not a string (line 78-80) |
| Raw body | Preserved via `express.json({ verify })` in `server.js:146-157` |

The signature verification is correctly timing-safe — the early return on length mismatch does not leak timing information because Base64 HMAC-SHA256 outputs are always the same length for valid signatures.

### Webhook Idempotency

**PASS** — Two-layer dedup:
1. In-memory `Set` (`_processingEvents`) prevents concurrent processing of same event
2. DB `webhook_events.square_event_id` prevents historical reprocessing
3. Event cleared from in-memory set after processing completes (line 62-66)

---

## 5.6 Claude (Anthropic) API Integration

**PASS**

### API Key Storage

`routes/ai-autofill.js:41-63`:
- Key encrypted with AES-256-GCM (same `encryptToken` as Square tokens)
- Stored per-merchant in `merchant_settings.claude_api_key_encrypted`
- Validated format: must start with `sk-ant-`
- Key never returned to frontend — only a `hasKey` boolean status endpoint exists (line 69-80)

### API Call Safety (`services/ai-autofill-service.js:346-427`)

| Feature | Implementation |
|---------|---------------|
| Rate limit handling | 429 → retry with `retry-after` header, minimum 60s delay (line 404-406) |
| Auth errors | 401 → throw immediately, no retry (line 396-398) |
| Retry count | Configurable via `config/constants.js` |
| Response validation | Checks for `text` content type, parses JSON, validates `Array.isArray()` (lines 370-391) |
| JSON extraction fallback | Extracts JSON from markdown code blocks if direct parse fails (lines 379-384) |
| Batch cancellation | `signal.cancelled` checked between batches (lines 515, 531) |

### Finding 5.6.1 — No request timeout on Claude API calls

**Severity: MEDIUM**

`callClaudeApi()` (line 350) uses `fetch()` without an `AbortController` timeout. The Square API client has a 30s timeout (`square-client.js:103-104`), but the Claude API calls have none:

```javascript
// services/ai-autofill-service.js:350-366
const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({ ... })
    // No signal, no timeout
});
```

Claude API responses for content generation with max_tokens=4096 can take 30-60+ seconds. If the upstream hangs, the request will block indefinitely, holding a connection and memory for the SSE stream.

**Fix**: Add an AbortController with a generous timeout (e.g., 120s):
```javascript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120000);
try {
    const response = await fetch(CLAUDE_API_URL, { ...options, signal: controller.signal });
    // ...
} finally {
    clearTimeout(timeout);
}
```

---

## 5.7 OpenRouteService API Integration

**PASS**

`services/delivery/delivery-service.js:797-830`:
- API key loaded from encrypted merchant settings or env var fallback
- API key migration from plaintext to encrypted storage (lines 1163-1194)
- Graceful fallback if no API key configured (returns unoptimized order, line 801-806)
- Hardcoded base URL (`https://api.openrouteservice.org`) — no SSRF risk

---

## 5.8 Webhook Subscription Management — SSRF Vector

**NEEDS WORK**

### Finding 5.8.1 — notificationUrl accepts any URL, potential SSRF via Square

**Severity: LOW**

`routes/webhooks.js:82-93` and `utils/square-webhooks.js:230-284`:

The webhook registration endpoint accepts a `notificationUrl` from the user and passes it to Square's Webhook Subscriptions API. The validator (`middleware/validators/webhooks.js:13-19`) only checks URL format:

```javascript
.isURL({ protocols: ['http', 'https'], require_protocol: true })
```

This means a user could register `http://169.254.169.254/latest/meta-data/` as a notification URL. However:
- The URL is sent to Square, not fetched by this server — Square sends webhooks TO this URL
- Square validates webhook URLs themselves (must be HTTPS, reachable, returns 200)
- The request is scoped to the authenticated merchant's Square account

**Impact**: Minimal. The URL is registered with Square, not fetched server-side. Square's own validation prevents internal IP registration. Still, defense-in-depth suggests rejecting obviously internal URLs.

**Fix**: Add a blocklist check for private/internal IP ranges before sending to Square:
```javascript
const url = new URL(notificationUrl);
const hostname = url.hostname;
if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|localhost|0\.0\.0\.0)/i.test(hostname)) {
    throw new Error('Internal URLs are not allowed');
}
```

---

## 5.9 Error Information Leakage

**PASS**

### Global Error Handler (`server.js:632-682`)

| Environment | Behavior |
|-------------|----------|
| Production | Returns `getUserFriendlyMessage()` — generic messages. Error details omitted. |
| Development | Includes `details: err.message` |
| Stack traces | Never sent to client. Only logged server-side for 5xx errors. |

### OAuth Error Redirects

- Square OAuth: `error.message` exposed in redirect URL (`square-oauth.js:120`). This is the Square API error, not internal — acceptable for debugging OAuth setup.
- Google OAuth: Generic `oauth_failed` code only — no details in URL (line 113).

### Sync Route Error Collection

`routes/sync.js` collects `error.message` strings and returns them in the response. These are Square API errors (e.g., "UNAUTHORIZED", "NOT_FOUND"), not internal server details. The route requires authentication + merchant context, so the audience is the authenticated merchant viewing their own sync errors. Acceptable.

---

## 5.10 Subscription Billing API

**PASS**

`utils/square-subscriptions.js`:

| Feature | Implementation |
|---------|---------------|
| Token source | `SQUARE_ACCESS_TOKEN` env var (platform account, not merchant) |
| Idempotency | `generateIdempotencyKey()` on all write operations |
| Error handling | Checks `response.errors` array, throws with detail messages |
| No PCI data | Only Square IDs stored (customer_id, card_id, subscription_id) — no card numbers |
| Rate limiting | Inherits from `makeSquareRequest` retry logic |

---

## Summary

| Check | Result | Findings |
|-------|--------|----------|
| Square API retry/timeout | PASS | 30s timeout, exponential backoff, non-retryable error detection |
| Square API idempotency | PASS | crypto.randomUUID() on all writes |
| Token encryption at rest | PASS | AES-256-GCM, random IV, auth tag |
| Token refresh | PASS | Auto-refresh within 1hr of expiry |
| Square OAuth CSRF | PASS | 256-bit state, DB-stored, expiry, user verification |
| Square OAuth open redirect | PASS | isLocalPath() with comprehensive checks |
| Google OAuth | PASS | DB-validated state, merchant from DB not state |
| Webhook signature | PASS | HMAC-SHA256 with timingSafeEqual |
| Webhook idempotency | PASS | In-memory + DB dedup |
| Claude API key storage | PASS | AES-256-GCM encrypted, never returned to client |
| Claude API call safety | NEEDS WORK | Finding 5.6.1 |
| OpenRouteService | PASS | Encrypted key, hardcoded base URL |
| Webhook SSRF | PASS | URL sent to Square, not fetched locally |
| Error leakage | PASS | Production hides details |
| Subscription billing | PASS | Platform token, idempotent, no PCI data |

**Overall: PASS** — API integrations are well-implemented with proper retry logic, token encryption, CSRF protection, and timing-safe signature verification. One missing timeout on Claude API calls.

### Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| 5.2.1 | LOW | Token refresh has no mutex — concurrent requests may double-refresh |
| 5.6.1 | MEDIUM | Claude API calls have no request timeout (could block indefinitely) |
| 5.8.1 | LOW | Webhook notificationUrl accepts any URL (minimal impact — sent to Square, not fetched locally) |
