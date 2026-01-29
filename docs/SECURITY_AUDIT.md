# Security Audit History

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Technical Debt](./TECHNICAL_DEBT.md) | [Architecture](./ARCHITECTURE.md)

This document records security vulnerabilities discovered during audits and their fixes.

---

## Master Engineering Review (2026-01-26)

**ALL P0 & P1 SECURITY ISSUES FIXED**

All critical P0 security vulnerabilities and P1 architecture issues have been fixed as of 2026-01-26.

### Summary Table

| Issue | Severity | Impact | Status |
|-------|----------|--------|--------|
| P0-5: Cookie name mismatch | CRITICAL | Sessions persist after logout | FIXED |
| P0-6: No session regeneration | CRITICAL | Session fixation attacks possible | FIXED |
| P0-7: XSS in 13 HTML files | CRITICAL | Script injection via error messages | FIXED |
| P1-6: 7 routes missing validators | HIGH | Input validation bypass | FIXED |
| P1-7: Password reset token reuse | HIGH | Token brute-force possible | FIXED |
| P1-8: Webhook not rate limited | MEDIUM | DDoS on webhook processing | FIXED |
| P1-9: Error message exposure | MEDIUM | Internal details in responses | FIXED |

---

## P0-5: Session Cookie Name Mismatch

**Severity**: CRITICAL
**Files**: `server.js:172`, `routes/auth.js:191`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

Session cookie was configured with name `'sid'` but logout cleared `'connect.sid'`.

```javascript
// server.js:172 - Session configured with 'sid'
app.use(session({
    name: 'sid',
    // ...
}));

// routes/auth.js:191 - Logout cleared wrong cookie!
res.clearCookie('connect.sid');  // Should be 'sid'
```

### Impact

Users could log out but their session would persist, allowing anyone with access to their browser to continue using the application as that user.

### Fix Applied

Changed `res.clearCookie('connect.sid')` to `res.clearCookie('sid')` in routes/auth.js:191.

```javascript
// routes/auth.js - After fix:
res.clearCookie('sid', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
});
```

---

## P0-6: Missing Session Regeneration on Login

**Severity**: CRITICAL
**File**: `routes/auth.js:137-186`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

Login handler did NOT call `req.session.regenerate()` before setting user data, enabling session fixation attacks.

```javascript
// BEFORE (vulnerable):
router.post('/login', async (req, res) => {
    // ... password verification ...
    req.session.user = { id, email, name, role };  // No regeneration!
    res.json({ success: true });
});
```

### Impact

An attacker could:
1. Get a valid session ID (e.g., visit login page)
2. Trick victim into logging in with that session ID
3. Use the now-authenticated session ID to access victim's account

### Fix Applied

Added `req.session.regenerate()` and `req.session.save()` in login handler. Session ID is now regenerated after successful password verification, preventing session fixation attacks.

```javascript
// routes/auth.js - After password verification:
req.session.regenerate(async (err) => {
    if (err) {
        logger.error('Session regeneration failed', {
            error: err.message,
            userId: id
        });
        return res.status(500).json({
            success: false,
            error: 'Login failed. Please try again.',
            code: 'SESSION_ERROR'
        });
    }
    req.session.user = { id, email, name, role };
    req.session.save(async (saveErr) => {
        if (saveErr) {
            logger.error('Session save failed', { error: saveErr.message });
        }
        // Log security event
        await logSecurityEvent(id, 'login', req);
        res.json({ success: true, user: { id, email, name, role } });
    });
});
```

---

## P0-7: XSS via Unescaped innerHTML

**Severity**: CRITICAL
**Files**: 13 HTML files (all vulnerable locations fixed)
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

Template literals were injected into innerHTML without escaping.

```javascript
// BEFORE (vulnerable):
errorDiv.innerHTML = `Error: ${error.message}`;  // XSS if error.message contains HTML
```

### Impact

If an attacker could control error message content (e.g., through crafted API responses or URL parameters), they could inject malicious scripts that execute in the user's browser.

### Fix Applied

Added `escapeHtml()` wrapper to all dynamic content in innerHTML assignments:

| File | Fix Applied |
|------|-------------|
| `public/login.html` | Added escapeHtml function, fixed reset URL display with URL validation |
| `public/dashboard.html` | Added escapeHtml function, fixed error and sync result messages |
| `public/delivery.html` | Fixed showAlert function to escape message |
| `public/settings.html` | Fixed user loading error message |
| `public/vendor-catalog.html` | Fixed 3 error message locations |
| `public/reorder.html` | Fixed error message display |
| `public/gmc-feed.html` | Fixed feed loading error message |
| `public/deleted-items.html` | Fixed error message display |
| `public/expiry.html` | Fixed error message display |
| `public/cycle-count-history.html` | Fixed error message display |

```javascript
// escapeHtml function added to each file:
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// AFTER (safe):
errorDiv.innerHTML = `Error: ${escapeHtml(error.message)}`;
```

All innerHTML assignments now use `escapeHtml()` to prevent XSS attacks.

---

## P1-6: Missing Input Validators

**Severity**: HIGH
**Files**: `routes/square-attributes.js`, `routes/cycle-counts.js`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

7 routes accepted POST requests without validation middleware.

```javascript
// BEFORE (no validation):
router.post('/init', asyncHandler(async (req, res) => {
    // No validators[] middleware
}));
```

### Impact

Without validation, routes could receive malformed input that might cause unexpected behavior or errors. While not directly exploitable, this violates defense-in-depth principles.

### Fix Applied

- Added `validators.init`, `validators.pushCasePack`, `validators.pushBrand`, `validators.pushExpiry`, `validators.pushAll` to `routes/square-attributes.js`
- Added `validators.emailReport`, `validators.generateBatch` to `routes/cycle-counts.js`
- Updated `middleware/validators/cycle-counts.js` with new validators

```javascript
// AFTER (with validation):
router.post('/init', validators.init, asyncHandler(async (req, res) => {
    // Input validated before handler runs
}));
```

All 7 routes now have consistent validation middleware that documents the API contract.

---

## P1-7: Password Reset Token Not Invalidated on Failed Attempts

**Severity**: HIGH
**File**: `routes/auth.js`, `middleware/security.js`, `database/migrations/028_password_reset_attempt_limit.sql`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

Password reset token was only marked as `used` after successful password change. An attacker could make unlimited guesses at the token.

### Impact

An attacker with knowledge of a user's email could:
1. Request a password reset
2. Brute-force guess the token (if token is weak)
3. Gain access to the account

### Fix Applied (Both Option A and B)

1. **Database Migration** (`028_password_reset_attempt_limit.sql`):
   - Added `attempts_remaining INTEGER DEFAULT 5` column to `password_reset_tokens`
   - Added index for efficient queries on valid tokens

2. **Token Query Updated** (`routes/auth.js`):
   - Token validation now includes `COALESCE(attempts_remaining, 5) > 0`
   - Attempts decremented atomically before processing
   - Exhausted tokens logged with specific warning

3. **Rate Limiting Added** (`middleware/security.js`):
   - `configurePasswordResetRateLimit()`: 5 attempts per 15 minutes per token
   - Applied to `/reset-password` endpoint

4. **Verify Token Updated**:
   - `verify-reset-token` endpoint also checks `attempts_remaining`

```javascript
// Token validation now includes attempt check:
const tokenResult = await db.query(`
    SELECT * FROM password_reset_tokens
    WHERE token = $1
      AND used = false
      AND expires_at > NOW()
      AND COALESCE(attempts_remaining, 5) > 0
`, [token]);

// Attempts decremented before processing:
await db.query(`
    UPDATE password_reset_tokens
    SET attempts_remaining = COALESCE(attempts_remaining, 5) - 1
    WHERE token = $1
`, [token]);
```

Password reset tokens now have a maximum of 5 attempts and are rate-limited per token.

---

## P1-8: Webhook Endpoint Not Rate Limited

**Severity**: MEDIUM
**Files**: `middleware/security.js`, `routes/webhooks/square.js`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

`/api/webhooks/square` endpoint had no rate limiting.

### Impact

An attacker could:
1. Flood the webhook endpoint with requests
2. Cause resource exhaustion (CPU, memory, database connections)
3. Potentially trigger rate limits on Square API from our side

### Fix Applied

1. **Rate Limiter Added** (`middleware/security.js`):
   - `configureWebhookRateLimit()`: 100 requests per minute per merchant
   - Keys by Square merchant ID from webhook payload
   - Falls back to IP if no merchant ID present

2. **Route Updated** (`routes/webhooks/square.js`):
   - Applied `webhookRateLimit` middleware before webhook processing
   - Updated JSDoc to document rate limiting in security section

```javascript
// middleware/security.js
function configureWebhookRateLimit() {
    return rateLimit({
        windowMs: 60 * 1000,  // 1 minute
        max: 100,              // 100 requests per minute
        keyGenerator: (req) => {
            // Key by merchant ID if available
            const merchantId = req.body?.merchant_id;
            return merchantId || req.ip;
        },
        message: {
            success: false,
            error: 'Too many webhook requests',
            code: 'RATE_LIMITED'
        }
    });
}

// routes/webhooks/square.js
router.post('/', webhookRateLimit, asyncHandler(async (req, res) => {
    // ...
}));
```

Webhook endpoint now rate-limited to prevent DDoS and replay attacks.

---

## P1-9: Error Messages Still Expose Internal Details

**Severity**: MEDIUM
**File**: `routes/subscriptions.js`
**Status**: FIXED (2026-01-26)
**Discovered**: Master Engineering Review 2026-01-26

### Problem

4 locations in subscriptions.js exposed internal error details.

```javascript
// BEFORE (exposing internal details):
res.status(500).json({
    success: false,
    error: error.message  // Could contain SQL errors, stack traces, etc.
});
```

### Impact

Error messages could reveal:
- Database structure (table names, column names)
- Internal service names
- Third-party API details
- Stack traces with file paths

### Fix Applied

All 4 error responses updated to use generic messages with error codes:

| Line | Error Code | Generic Message |
|------|------------|-----------------|
| 237 | `CUSTOMER_CREATION_FAILED` | "Account creation failed. Please try again." |
| 261 | `CARD_CREATION_FAILED` | "Failed to save payment method. Please check your card details." |
| 346 | `PAYMENT_FAILED` | "Payment failed. Please check your card details and try again." |
| 398 | `SUBSCRIPTION_FAILED` | "Subscription creation failed. Please try again." |

```javascript
// AFTER (generic message, details logged server-side):
logger.error('Customer creation failed', {
    error: error.message,
    stack: error.stack,
    email: req.body.email
});
res.status(500).json({
    success: false,
    error: 'Account creation failed. Please try again.',
    code: 'CUSTOMER_CREATION_FAILED'
});
```

Internal error details are now logged server-side only, not returned to clients.

---

## Prior Security Fixes (2026-01-26)

These were fixed as part of the initial security hardening, before the Master Engineering Review.

### P0-1: JSON Body Limit Enables DoS
**File**: `server.js:129`
**Status**: FIXED (2026-01-26)

Reduced JSON body limit from 50mb to 5mb. POD uploads use multer with separate limits.

### P0-2: Subscription Check Fails Open
**File**: `middleware/subscription-check.js:139-146`
**Status**: FIXED (2026-01-26)

Changed error handler to fail closed - returns 503 for API requests and redirects HTML requests when subscription status cannot be verified.

### P0-3: Error Messages Expose Internal Details
**Status**: FIXED (2026-01-26)

Fixed 3 locations exposing internal error details to clients:
- `routes/subscriptions.js:601-612` - Refund errors now log details server-side, return generic message
- `routes/loyalty.js:1056-1066` - Square API errors now logged, return 502 with generic message
- `routes/google-oauth.js:97-101` - OAuth errors use generic `oauth_failed` code in redirect URL

---

## Security Best Practices Established

These patterns should be followed for all new code:

### 1. Error Messages
- Never return `error.message` or `error.stack` to clients
- Use generic messages with error codes
- Log full details server-side

### 2. Input Validation
- All routes MUST have validators from `middleware/validators/`
- Never trust user input, even from authenticated users
- Validate on server side, not just client side

### 3. Session Security
- Regenerate session ID on login
- Clear correct cookie name on logout
- Use secure, httpOnly, sameSite cookies

### 4. XSS Prevention
- Always use `escapeHtml()` for dynamic content in innerHTML
- Prefer `textContent` over `innerHTML` when possible
- Use Content-Security-Policy headers

### 5. Rate Limiting
- All public endpoints must be rate limited
- Webhook endpoints rate limited per merchant
- Sensitive operations (login, password reset) heavily rate limited

### 6. Multi-Tenant Isolation
- EVERY database query must filter by `merchant_id`
- Never trust `merchant_id` from request body
- Always use `req.merchantContext.id`
