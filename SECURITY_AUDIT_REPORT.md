# Security Audit Report: Square Dashboard Tool
**Audit Date:** 2026-01-04
**Auditor:** Claude Security Review
**Severity Levels:** CRITICAL | HIGH | MEDIUM | LOW | INFO

---

## Executive Summary

This audit reviewed the multi-tenant Square Dashboard Tool for common security vulnerabilities. The codebase shows **good overall security practices** including:
- Parameterized SQL queries (preventing SQL injection)
- Field whitelisting for mass assignment protection
- HTML escaping in most frontend templates
- Proper session configuration with httpOnly cookies
- Rate limiting on login endpoints
- Idempotency keys for Square API calls

However, several issues were identified that should be addressed.

---

## CRITICAL Findings

### 1. Cross-Tenant Data Exposure in Debug Endpoint
**Location:** `server.js:3343-3347`

**Risk Found:**
The `/api/debug/merchant-data` endpoint returns information about ALL merchants in the system to any authenticated user.

**How a bad actor would exploit it:**
Any authenticated user can call `GET /api/debug/merchant-data` and see the `id`, `business_name`, `square_merchant_id`, `is_active`, and `created_at` for every merchant in the system. This reveals:
- How many other businesses use the platform
- Business names (competitive intelligence)
- Internal IDs that could be used for targeted attacks

**Code Fix:**
```javascript
// server.js:3343-3347 - REMOVE or restrict to admin only
// Current code (VULNERABLE):
const allMerchants = await db.query(`
    SELECT id, business_name, square_merchant_id, is_active, created_at
    FROM merchants
    ORDER BY id
`);

// Fixed: Either remove entirely or add admin check
app.get('/api/debug/merchant-data', requireAuth, requireAdmin, requireMerchant, async (req, res) => {
    // ... and remove the allMerchants query for non-admin users
```

---

## HIGH Findings

### 2. Webhook Signature Verification is Optional
**Location:** `server.js:8781-8804`

**Risk Found:**
The Square webhook endpoint allows bypassing signature verification if `SQUARE_WEBHOOK_SIGNATURE_KEY` is not set, or if `WEBHOOK_SIGNATURE_VERIFY` is set to `'false'`.

**How a bad actor would exploit it:**
An attacker could send fake webhook events to manipulate subscription status, trigger unwanted syncs, or inject malicious data. They would POST to `/api/webhooks/square` with crafted payloads pretending to be from Square.

**Code Fix:**
```javascript
// server.js:8782 - Make signature verification mandatory in production
const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
if (!signatureKey) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('CRITICAL: Webhook received but SQUARE_WEBHOOK_SIGNATURE_KEY not configured');
        return res.status(500).json({ error: 'Webhook verification not configured' });
    }
    logger.warn('Development mode: Webhook signature verification skipped');
}
// Remove the WEBHOOK_SIGNATURE_VERIFY bypass option entirely
```

### 3. Missing requireAuth on Multiple Endpoints
**Location:** Various endpoints in `server.js`

**Risk Found:**
Several endpoints use `requireMerchant` without `requireAuth`. While `requireMerchant` implicitly requires authentication (via `loadMerchantContext`), this is confusing and could break if middleware order changes.

**Affected Endpoints:**
- `/api/categories` (line 1403)
- `/api/items` (line 1427)
- `/api/variations` (line 1467)
- `/api/sync-history` (line 1312)
- `/api/inventory` (line 2748)
- `/api/low-stock` (line 2857)
- `/api/vendors` (line 4943)
- `/api/locations` (line 5449)
- `/api/sales-velocity` (line 5475)
- `/api/reorder-suggestions` (line 5544)
- `/api/purchase-orders` (POST/GET/PATCH - lines 7079, 7161, 7205, 7256)

**Code Fix:**
```javascript
// Always use requireAuth explicitly before requireMerchant
app.get('/api/categories', requireAuth, requireMerchant, async (req, res) => {
```

### 4. AUTH_DISABLED Environment Variable
**Location:** `server.js:146`

**Risk Found:**
There's an `AUTH_DISABLED` environment variable that can completely bypass authentication.

**How a bad actor would exploit it:**
If accidentally set in production (e.g., from a dev config copy), all protected pages become accessible without login.

**Code Fix:**
```javascript
// Add a production safety check
const authEnabled = process.env.AUTH_DISABLED !== 'true';
if (!authEnabled && process.env.NODE_ENV === 'production') {
    logger.error('CRITICAL: AUTH_DISABLED=true in production! Forcing auth enabled.');
    authEnabled = true;
}
```

---

## MEDIUM Findings

### 5. Session Secret Fallback
**Location:** `server.js:124`

**Risk Found:**
If `SESSION_SECRET` is not set, a random secret is generated. This means sessions are lost on restart and the secret is predictable in the same process.

**How a bad actor would exploit it:**
If they can restart the server and know the timing, they might predict the random value. More practically, this causes user frustration from lost sessions.

**Code Fix:**
```javascript
// Refuse to start in production without SESSION_SECRET
if (!process.env.SESSION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('FATAL: SESSION_SECRET must be set in production');
        process.exit(1);
    }
    logger.warn('SESSION_SECRET not set! Using random secret. Sessions will be lost on restart.');
}
```

### 6. Content Security Policy Disabled
**Location:** `middleware/security.js:17-18`

**Risk Found:**
CSP is completely disabled with a TODO comment. CSP is a critical defense against XSS attacks.

**Code Fix:**
```javascript
// Configure a proper CSP (example - adjust for your needs)
contentSecurityPolicy: {
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Gradually remove unsafe-inline
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://items-images-production.s3.us-west-2.amazonaws.com"],
        connectSrc: ["'self'", "https://connect.squareup.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
    }
}
```

---

## LOW Findings

### 7. Verbose Error Messages in Production
**Location:** Multiple endpoints

**Risk Found:**
Many endpoints return `error.message` directly to clients, which may reveal internal details.

```javascript
res.status(500).json({ error: error.message });
```

**Code Fix:**
```javascript
// Use generic error messages in production
const errorMessage = process.env.NODE_ENV === 'production'
    ? 'An error occurred'
    : error.message;
res.status(500).json({ error: errorMessage });
```

### 8. Debug Endpoints Not Behind Feature Flag
**Location:** `server.js:3315-3591`

**Risk Found:**
Multiple `/api/debug/*` endpoints exist that should be disabled in production or behind a feature flag.

**Code Fix:**
```javascript
// Wrap debug endpoints
if (process.env.ENABLE_DEBUG_ENDPOINTS === 'true') {
    app.get('/api/debug/merchant-data', ...);
    // etc
}
```

---

## INFO (Good Practices Observed)

### SQL Injection Protection
All SQL queries use parameterized queries:
```javascript
await db.query('SELECT * FROM items WHERE merchant_id = $1', [merchantId]);
```

### Mass Assignment Protection
Field updates use whitelists:
```javascript
const allowedFields = ['case_pack_quantity', 'stock_alert_min', ...];
for (const [key, value] of Object.entries(req.body)) {
    if (allowedFields.includes(key)) {
        // allowed
    }
}
```

### XSS Protection
Most frontend templates use `escapeHtml()`:
```javascript
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
```

### Idempotency Keys
Square API calls properly use idempotency keys:
```javascript
const idempotencyKey = generateIdempotencyKey(`cycle-count-${catalogObjectId}`);
```

### Session Security
Sessions use secure configuration:
- `httpOnly: true` (prevents JS access)
- `sameSite: 'lax'` (CSRF protection)
- `secure: 'auto'` (HTTPS in production)

### Tenant Isolation
Database queries consistently filter by `merchant_id`:
```javascript
WHERE po.id = $1 AND po.merchant_id = $2
```

---

## Recommendations Summary

| Priority | Issue | Action |
|----------|-------|--------|
| CRITICAL | Cross-tenant merchant data exposure | Remove or admin-restrict `/api/debug/merchant-data` |
| HIGH | Optional webhook signature | Make signature verification mandatory in production |
| HIGH | Missing requireAuth | Add `requireAuth` before all `requireMerchant` calls |
| HIGH | AUTH_DISABLED bypass | Add production safety check |
| MEDIUM | Session secret fallback | Refuse to start in production without secret |
| MEDIUM | CSP disabled | Implement Content Security Policy |
| LOW | Verbose errors | Generic error messages in production |
| LOW | Debug endpoints | Feature flag for debug endpoints |

---

## Next Steps

1. **Immediate (Today):** Fix the cross-tenant data exposure in `/api/debug/merchant-data`
2. **This Week:** Enable webhook signature verification, add requireAuth to all protected endpoints
3. **This Month:** Implement CSP, add production safety checks
4. **Ongoing:** Regular security reviews, dependency updates

---

*Report generated by Claude Security Audit*
