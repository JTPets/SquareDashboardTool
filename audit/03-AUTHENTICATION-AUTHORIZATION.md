# Section 3: AUTHENTICATION & AUTHORIZATION

**Rating: PASS**

## 3.1 Route Inventory & Auth Coverage

**PASS**

282 routes across 40 route files audited. Every route has appropriate auth middleware.

### Public Routes (Intentionally Unauthenticated)

| Route | Method | Auth Mechanism | Purpose |
|-------|--------|---------------|---------|
| `/api/auth/login` | POST | loginRateLimit | Login |
| `/api/auth/logout` | POST | None (session optional) | Logout |
| `/api/auth/me` | GET | None (checks manually) | Auth status check |
| `/api/auth/forgot-password` | POST | Rate limit | Password reset request |
| `/api/auth/reset-password` | POST | passwordResetRateLimit | Reset with token |
| `/api/auth/verify-reset-token` | GET | None | Token validity check |
| `/api/square/oauth/callback` | GET | None (redirect from Square) | OAuth callback |
| `/api/google/callback` | GET | None (redirect from Google) | OAuth callback |
| `/api/gmc/feed.tsv` | GET | Token-based OR session | GMC feed for Google |
| `/api/gmc/local-inventory-feed.tsv` | GET | Token-based OR session | Local inventory feed |
| `/api/driver/:token/*` | GET/POST | Token-based (5 routes) | Contract driver access |
| `/api/square/payment-config` | GET | None | Public Square SDK config |
| `/api/subscriptions/plans` | GET | None | Plan list |
| `/api/subscriptions/status` | GET | subscriptionRateLimit | Status by email |
| `/api/subscriptions/create` | POST | subscriptionRateLimit | Create subscription |
| `/api/subscriptions/promo/validate` | POST | promoRateLimit | Validate promo code |
| `/api/webhooks/square` | POST | webhookRateLimit + HMAC | Webhook receiver |
| `/api/health` | GET | None | Health check |

All public routes are appropriate for their function.

### Auth Middleware Stack

All non-public API routes pass through `apiAuthMiddleware` (`server.js:277-305`), which calls `requireAuthApi`. This is a global catch-all — routes don't need individual `requireAuth` calls for basic auth (though most add it explicitly for clarity).

### Admin Routes

21+ routes require `requireAuth` + `requireAdmin`. These include merchant management, user management, log viewing, catalog health debugging, and subscription plan setup.

---

## 3.2 Auth Bypass Vectors

**PASS**

### Finding 3.2.1 — No auth bypass via parameter manipulation

Checked for:
- No route accepts `?admin=true` or similar privilege escalation params
- No route uses `req.query.role` or `req.body.role` to elevate privileges
- User role is set from DB on login (`routes/auth.js:137-141`), never from request

### Finding 3.2.2 — Public path whitelist is prefix-matched

**Severity: LOW**

`server.js:279-295,299`:
```javascript
if (publicPaths.includes(req.path) || req.path.startsWith('/driver/')) {
    return next();
}
```

The `/driver/` prefix match is safe because all driver routes require a token parameter. However, the `publicPaths` list uses exact match (`includes`), which is correctly restrictive.

---

## 3.3 Session/Token Handling

**PASS**

### Session Configuration (`server.js:184-197`)

| Setting | Value | Assessment |
|---------|-------|-----------|
| `secure` | `'auto'` | Auto-detects HTTPS via X-Forwarded-Proto |
| `httpOnly` | `true` | JavaScript cannot access session cookie |
| `sameSite` | `'lax'` | CSRF protection for cross-site requests |
| `name` | `'sid'` | Changed from default `connect.sid` (fingerprinting reduction) |
| `proxy` | `true` | Trusts reverse proxy (Cloudflare) |
| `resave` | `false` | Prevents session race conditions |
| `saveUninitialized` | `false` | No empty sessions created |

### Session Fixation Protection

**PASS** — `routes/auth.js:127-129`:
```javascript
// SECURITY: Regenerate session ID to prevent session fixation attacks
req.session.regenerate(async (err) => { ... });
```

Session ID is regenerated on every successful login.

### Session Store

Uses PostgreSQL via `connect-pg-simple` — sessions stored server-side, not in cookies.

### Session Secret

**PASS** — Production requires `SESSION_SECRET` env var (`server.js:202-206`). Development falls back to `crypto.randomBytes(64)` — random per restart, which means sessions don't persist across restarts (acceptable for dev).

### Logout

**PASS** — `routes/auth.js:194-198`:
```javascript
req.session.destroy((err) => {
    res.clearCookie('sid');
    sendSuccess(res, {});
});
```

Session destroyed and cookie cleared.

### Trust Proxy

`server.js:134`: `app.set('trust proxy', 1)` — trusts 1 hop. Appropriate for Cloudflare setup. Rate limiting uses `req.ip` which respects this setting.

---

## 3.4 Rate Limiting Inventory

**PASS**

### Global Rate Limiter

`server.js:143`: `app.use(configureRateLimit())` — applies to ALL routes.

| Config | Value |
|--------|-------|
| Window | 15 minutes |
| Max requests | 100 per window per IP |
| Skip | `/api/health`, `/api/ai-autofill/*` |

### Endpoint-Specific Rate Limiters

| Limiter | Window | Max | Key | Used On |
|---------|--------|-----|-----|---------|
| `loginRateLimit` | 15 min | 5 | IP + email | `/auth/login` |
| `passwordResetRateLimit` | 15 min | 5 | Token prefix | `/auth/reset-password` |
| `webhookRateLimit` | 1 min | 100 | Square merchant ID | `/webhooks/square` |
| `deliveryRateLimit` | 1 min | 30 | User ID or IP | Driver endpoints |
| `deliveryStrictRateLimit` | 5 min | 10 | User ID or IP | Expensive delivery ops |
| `sensitiveOperationRateLimit` | 1 hour | 5 | Merchant ID or IP | Token regeneration |
| `subscriptionRateLimit` | 1 hour | 5 | IP | Subscription create/status |

### Finding 3.4.1 — AI autofill endpoints skip global rate limit

**Severity: MEDIUM**

`middleware/security.js:148-149`:
```javascript
// Skip for AI autofill — authenticated batch operations that make
// server-side API calls; throttled by Claude API limits, not ours
if (req.path.startsWith('/api/ai-autofill/')) return true;
```

While these routes require authentication + merchant context, skipping the global rate limit means a compromised session could hammer the Claude API endpoint without server-side throttling. The comment says "throttled by Claude API limits" but that's external — the app itself has no protection.

**Fix**: Add a dedicated rate limiter for AI autofill routes (e.g., 20 requests/minute per merchant).

### Finding 3.4.2 — Webhook rate limit keyed on unauthenticated payload data

**Severity: LOW**

`middleware/security.js:296-298`:
```javascript
keyGenerator: (req) => {
    const merchantId = req.body?.merchant_id || req.ip;
    return `webhook-${merchantId}`;
};
```

The rate limit key uses `merchant_id` from the request body BEFORE signature verification. An attacker could use a fake `merchant_id` to bypass rate limits for a real merchant, or target a specific merchant's rate limit bucket by spoofing their ID. Falls back to IP if no merchant_id, which is the safer default.

**Fix**: Use IP-only for webhook rate limiting (signature verification is the real gatekeeper), or apply rate limit after signature check.

---

## 3.5 Account Lockout

**PASS**

`routes/auth.js:24-26,88-103`:

| Setting | Value |
|---------|-------|
| Max failed attempts | 5 |
| Lockout duration | 30 minutes |
| Counter reset on success | Yes (`failed_login_attempts = 0`) |
| Lockout check before password verify | Yes (line 77) |

Account lockout works correctly:
1. Check if locked → 401
2. Verify password → if wrong, increment counter
3. If counter >= 5 → lock for 30 minutes
4. On success → reset counter and lockout

---

## 3.6 Password Handling

**PASS**

`utils/password.js`:

| Setting | Value |
|---------|-------|
| Algorithm | bcrypt |
| Salt rounds | 12 |
| Hash comparison | `bcrypt.compare()` (timing-safe) |

Bcrypt with 12 rounds is appropriate for a production web application.

---

## 3.7 Password Reset Flow

**PASS**

`routes/auth.js:612-730`:

| Feature | Implementation |
|---------|---------------|
| Token generation | `crypto.randomBytes(32)` — 256-bit entropy |
| Token storage | SHA-256 hash stored, plaintext sent to user (SEC-7) |
| Token expiry | 1 hour (`routes/auth.js:615`) |
| One-time use | `used_at IS NULL` check + `SET used_at = NOW()` |
| Attempt limiting | `attempts_remaining` column, decremented atomically before processing |
| Previous tokens | Deleted on new request (`DELETE FROM ... WHERE user_id = $1`) |
| Rate limiting | `passwordResetRateLimit` on reset endpoint |

This is a textbook-correct password reset implementation. SHA-256 hashed tokens prevent database breach from being escalated to account takeover.

---

## 3.8 Missing `requireWriteAccess` on Modification Routes

**Severity: LOW**

9 modification routes (POST/PUT/PATCH) have `requireAuth` + `requireMerchant` but lack `requireWriteAccess`:

| File | Route | Method |
|------|-------|--------|
| `catalog.js` | `/api/variations/:id/extended` | PATCH |
| `catalog.js` | `/api/variations/:id/min-stock` | PATCH |
| `catalog.js` | `/api/variations/:id/cost` | PATCH |
| `catalog.js` | `/api/variations/bulk-update-extended` | POST |
| `catalog.js` | `/api/expirations` | POST |
| `catalog.js` | `/api/expirations/pull` | POST |
| `catalog.js` | `/api/expirations/review` | POST |
| `delivery.js` | `/api/delivery/orders/:id/customer-note` | PATCH |
| `delivery.js` | `/api/delivery/orders/:id/notes` | PATCH |

**Impact**: If read-only users exist, they can modify these resources. Not a security breach (auth + tenant isolation still enforced), but violates principle of least privilege.

**Fix**: Add `requireWriteAccess` middleware to these routes.

---

## Summary

| Check | Result | Findings |
|-------|--------|----------|
| Route auth coverage | PASS | 282/282 routes have appropriate auth |
| Auth bypass vectors | PASS | No parameter-based privilege escalation |
| Session security | PASS | httpOnly, sameSite, regeneration, secure store |
| Session fixation | PASS | Regenerated on login |
| Logout | PASS | Session destroyed, cookie cleared |
| Rate limiting (global) | PASS | 100 req/15 min on all routes |
| Rate limiting (per-endpoint) | PASS | 7 specialized rate limiters |
| Account lockout | PASS | 5 attempts, 30-min lockout |
| Password hashing | PASS | bcrypt, 12 rounds |
| Password reset | PASS | Hashed tokens, 1hr expiry, attempt-limited |
| Write access control | NEEDS WORK | 9 routes missing requireWriteAccess |

**Overall: PASS** — Authentication and authorization are comprehensive. Session handling, password management, and rate limiting follow security best practices.

### Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| 3.4.1 | MEDIUM | AI autofill endpoints skip global rate limit with no substitute |
| 3.4.2 | LOW | Webhook rate limit keyed on unauthenticated body data |
| 3.8 | LOW | 9 modification routes missing `requireWriteAccess` |
| 3.2.2 | LOW | Public path whitelist uses prefix match for `/driver/` |
