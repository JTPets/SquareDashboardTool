# Authentication & Authorization Security Audit

**Date**: 2026-04-09
**Scope**: Every auth/permission check across entire codebase
**Auditor**: Automated security review

---

## Table of Contents

1. [Public Endpoints](#1-public-endpoints)
2. [Missing Middleware](#2-missing-middleware)
3. [Missing merchant_id Filters](#3-missing-merchant_id-filters)
4. [Staff Invitation Security](#4-staff-invitation-security)
5. [Password & Session Security](#5-password--session-security)
6. [Findings Summary](#6-findings-summary)

---

## 1. Public Endpoints

### 1.1 Intentionally Public (Correct)

These endpoints are deliberately unauthenticated and have appropriate protections:

| Endpoint | Purpose | Protection |
|----------|---------|------------|
| `POST /api/auth/login` | User login | loginRateLimit (5/15min per IP+email) |
| `POST /api/auth/logout` | User logout | No auth needed (destroys session) |
| `GET /api/auth/me` | Session check | Returns 401 if not authenticated |
| `POST /api/auth/forgot-password` | Password reset request | Anti-enumeration (always returns success) |
| `POST /api/auth/reset-password` | Password reset | passwordResetRateLimit (5/15min per token) |
| `GET /api/auth/verify-reset-token` | Validate reset token | Read-only check |
| `GET /api/square/oauth/callback` | Square OAuth callback | State parameter validation |
| `GET /api/google/callback` | Google OAuth callback | State parameter validation |
| `GET /api/staff/validate-token` | Staff invite validation | Token-based auth |
| `POST /api/staff/accept` | Accept staff invite | Token-based auth |
| `GET /api/driver/:token` | Driver route view | Token-based auth, deliveryRateLimit |
| `POST /api/driver/:token/orders/:id/complete` | Driver mark complete | Token-based auth, deliveryRateLimit |
| `POST /api/driver/:token/orders/:id/skip` | Driver skip order | Token-based auth, deliveryRateLimit |
| `POST /api/driver/:token/orders/:id/pod` | Driver upload POD | Token-based auth, deliveryStrictRateLimit |
| `POST /api/driver/:token/finish` | Driver finish route | Token-based auth, deliveryRateLimit |
| `GET /api/gmc/feed.tsv` | GMC product feed | Token/Basic auth (custom) |
| `GET /api/gmc/local-inventory-feed.tsv` | GMC inventory feed | Token/Basic auth (custom) |
| `GET /api/subscriptions/plans` | View subscription plans | Read-only public pricing |
| `POST /api/subscriptions/create` | Create subscription | subscriptionRateLimit (5/hr per IP) |
| `GET /api/subscriptions/status` | Check subscription status | subscriptionRateLimit |
| `POST /api/subscriptions/promo/validate` | Validate promo code | promoRateLimit |
| `GET /api/square/payment-config` | Square payment config | Read-only public config |
| `GET /api/public/pricing` | Public pricing page | Read-only |
| `GET /api/public/promo/check` | Public promo check | promoRateLimit |
| `POST /api/webhooks/square` | Square webhook receiver | Signature verification (HMAC-SHA256) |

### 1.2 Global API Auth Middleware

All `/api/*` routes pass through `apiAuthMiddleware` (`server.js:286-321`) which calls `requireAuthApi()` for non-public paths. This acts as a safety net ensuring unauthenticated requests cannot reach protected endpoints even if route-level middleware is missing.

---

## 2. Missing Middleware

### 2.1 Endpoints Missing requireMerchant (By Design)

These endpoints intentionally omit `requireMerchant` because they operate at user level or cross-merchant:

| Endpoint | Reason |
|----------|--------|
| `GET /api/merchants` | Lists user's merchants (needs user, not merchant) |
| `POST /api/merchants/switch` | Switches active merchant |
| `GET /api/merchants/context` | Returns current merchant context |
| `GET /api/config` | Returns app config |
| `POST /api/auth/change-password` | User-level operation |
| `GET /api/auth/users` | Admin user management (uses requireAdmin) |
| `POST /api/auth/users` | Admin user management |
| `PUT /api/auth/users/:id` | Admin user management |
| `GET /api/webhooks/event-types` | Returns webhook event type list |
| `GET /api/gmc/taxonomy` | Global reference data (not tenant-scoped) |

> **Note (2026-04-19):** `GET /api/settings/merchant/defaults`, `GET /api/sync-intervals`, and `GET /api/vendor-catalog/field-types` were listed here as intentional omissions but are now guarded by `requireMerchant` per the security audit (consistent with the project pattern for all authenticated merchant-scoped requests).

### 2.2 ~~CRITICAL~~: Hardcoded Merchant ID — ✅ RESOLVED 2026-04-17

**File**: `routes/catalog-location-health.js` (and `routes/catalog-health.js`)

Both endpoints now use `req.merchantContext.id` via the `requireMerchant` middleware. The `DEBUG_MERCHANT_ID = 3` constant has been removed. The route file is also now mounted in `server.js`.

### 2.3 Missing requireWriteAccess on Write Endpoints

**Partially resolved 2026-04-19.** See `docs/QA-AUDIT.md` Section 5 Group 2.C for full tracking.

**Resolved (2026-04-19):** `requireWriteAccess` added to `/api/vendors/:id/settings` PATCH, all 4 vendor-match-suggestions write endpoints, all purchase-order write endpoints (5), all cycle-count write endpoints (7, including `requireAdmin` on reset), all sync write endpoints (3), all bundle write endpoints (3), `PUT /api/settings/merchant`, all ai-autofill write endpoints (3), all labels write endpoints (3), all square-attributes.js write endpoints (8), and all vendor-catalog/manage.js write endpoints (7). Negative-path 403 tests in `__tests__/routes/audit-write-access.test.js`.

**Still open (Vendor Catalog)** — 2 write endpoints in `routes/vendor-catalog/import.js` remain unguarded:

| Endpoint | Method |
|----------|--------|
| `/api/vendor-catalog/import` | POST |
| `/api/vendor-catalog/import-mapped` | POST |

**Risk**: MEDIUM - Read-only users in the vendor/reorder feature can still trigger catalog imports. The `requireFeature('reorder')` and `requirePermission('reorder', 'read')` gates at server.js level provide partial protection but do not prevent import operations by users with read access.

### 2.4 Missing Rate Limiting on Staff Invitation Endpoints

| Endpoint | Issue |
|----------|-------|
| `GET /api/staff/validate-token` | No token-specific rate limiting |
| `POST /api/staff/accept` | No token-specific rate limiting |

These public endpoints should have rate limiting similar to password reset (5 attempts per 15 min per token). The global rate limit (100/15min per IP) applies but is too permissive for sensitive token operations.

**Risk**: MEDIUM - Token space (64 hex chars = 256 bits) makes brute force impractical, but defense-in-depth warrants rate limiting.

---

## 3. Missing merchant_id Filters

### 3.1 CRITICAL: Cross-Tenant Data in Background Jobs

**File**: `jobs/staff-invite-cleanup-job.js:24-28`

```sql
DELETE FROM staff_invitations
WHERE created_at < NOW() - INTERVAL '7 days'
  AND accepted_at IS NULL
```

Deletes expired invitations across ALL merchants without merchant_id filtering. While functionally correct (cleanup is global), this pattern bypasses tenant isolation. A bug or race condition could affect invitations from unrelated merchants.

**File**: `utils/webhook-retry.js:225-236`

```sql
DELETE FROM webhook_events
WHERE (status = 'completed' AND received_at < NOW() - INTERVAL '1 day' * $1)
   OR (status = 'failed' AND next_retry_at IS NULL AND received_at ...)
   OR (status = 'skipped' AND received_at ...)
```

Deletes webhook events across all merchants. The `webhook_events` table has a `merchant_id` column but it is NOT used in the cleanup WHERE clause.

### 3.2 HIGH: Admin Endpoints Exposing Cross-Tenant Data

**File**: `routes/subscriptions/webhooks.js`

`GET /api/webhooks/events` (requireAuth + requireAdmin + requireSuperAdmin) returns webhook events from ALL merchants without merchant_id filtering:

```sql
SELECT id, square_event_id, event_type, merchant_id, ...
FROM webhook_events WHERE 1=1
```

While super-admin-only, this exposes all merchants' webhook data including error messages and sync results.

### 3.3 MEDIUM: Delivery Auto-Finish Job

**File**: `jobs/delivery-auto-finish-job.js:63-66, 143-146`

Fetches delivery routes from all merchants, then deletes associated delivery orders without re-verifying merchant_id ownership in the DELETE query:

```sql
DELETE FROM delivery_orders WHERE route_id = ANY($1) AND status IN (...)
```

The route_ids are fetched with merchant_id, but the delete does not re-verify.

### 3.4 Queries Correctly Scoped (Sample Verification)

All service files verified to use parameterized queries (`$1, $2` syntax). No string concatenation found in SQL query construction. The dynamic query building pattern throughout the codebase correctly uses parameterized placeholders:

```javascript
params.push(value);
query += ` AND column = $${params.length}`;
```

---

## 4. Staff Invitation Security

### 4.1 Token Generation - SECURE

- **Method**: `crypto.randomBytes(32).toString('hex')` (64 hex chars, 256-bit entropy)
- **Storage**: SHA-256 hash only (plaintext never stored)
- **File**: `services/staff/staff-service.js:60-61`

### 4.2 Token Expiry - SECURE

- **Duration**: 7 days (`TOKEN_EXPIRY_DAYS = 7`)
- **Enforcement**: Database-level (`expires_at > NOW()` in query WHERE clause)
- **Cleanup**: Background job removes expired invitations after 7 days
- **File**: `services/staff/staff-service.js:17, 92`

### 4.3 Token Reuse Prevention - SECURE

- Acceptance uses `FOR UPDATE` row lock in transaction
- Query requires `accepted_at IS NULL` - prevents reuse
- `UPDATE ... SET accepted_at = NOW()` marks token as consumed
- **File**: `services/staff/staff-service.js:89-95, 156`

### 4.4 Role Escalation Prevention - SECURE

- Cannot change own role (`services/staff/staff-service.js:240-241`)
- Cannot change owner's role (`services/staff/staff-service.js:253-255`)
- Only owner can promote to manager (`services/staff/staff-service.js:258-260`)
- Only users with `staff:admin` permission (owner only) can manage staff
- **File**: `services/staff/staff-service.js:235-268`

### 4.5 Cross-Merchant Isolation - SECURE

- All staff queries include `merchant_id = $1` filter
- `user_merchants` table enforces `UNIQUE(merchant_id, email)`
- `loadMerchantContext` validates user belongs to merchant via JOIN
- **File**: `middleware/merchant.js:97-100`

### 4.6 MEDIUM: Token Enumeration Information Leakage

**File**: `services/staff/staff-service.js:107-117`

Diagnostic logging differentiates between "no row matches token hash" and "row found but conditions not met", revealing:
1. Whether a token hash exists in the database
2. Whether a valid token is expired vs already accepted
3. Token prefix (first 8 chars) logged

While the 256-bit token space makes brute force impractical, this violates the principle of uniform error responses for security-sensitive operations.

### 4.7 Duplicate Invitation Handling - ACCEPTABLE

- `inviteStaff()` rejects if email is already an active member (409)
- `user_merchants` INSERT uses `ON CONFLICT DO NOTHING` as belt-and-suspenders
- **File**: `services/staff/staff-service.js:147-153`

---

## 5. Password & Session Security

### 5.1 Password Hashing - SECURE

- **Algorithm**: bcrypt with 12 salt rounds
- **Verification**: `bcrypt.compare()` (timing-safe by design)
- **Complexity**: Min 8 chars, requires uppercase + number
- **Random generation**: Uses `crypto.randomInt()` (not Math.random)
- **File**: `utils/password.js:6-10`

### 5.2 Session Configuration - SECURE

| Setting | Value | Status |
|---------|-------|--------|
| Store | PostgreSQL (`connect-pg-simple`) | SECURE - server-side storage |
| Secret | `SESSION_SECRET` env var (required in production) | SECURE |
| Dev fallback | `crypto.randomBytes(64).toString('hex')` | SECURE (random per restart) |
| Cookie name | `sid` (not default `connect.sid`) | SECURE - obscures framework |
| httpOnly | `true` | SECURE - no JS access |
| secure | `'auto'` | SECURE - auto-detects HTTPS |
| sameSite | `'lax'` | SECURE - CSRF protection |
| maxAge | Configurable (`SESSION_DURATION_HOURS`, default 24h) | ACCEPTABLE |
| resave | `false` | CORRECT |
| saveUninitialized | `false` | CORRECT - no empty sessions |
| proxy | `true` | CORRECT for Cloudflare |

**File**: `server.js:193-206`

### 5.3 Session Fixation Prevention - SECURE

Login calls `req.session.regenerate()` before setting session data, preventing session fixation attacks. Session data is set AFTER regeneration.

**File**: `services/auth/session-service.js:114-123`

### 5.4 Session Destruction on Logout - SECURE

Logout calls `req.session.destroy()` and `res.clearCookie('sid')`.

**File**: `services/auth/session-service.js:181-188`, `routes/auth/session.js:30`

### 5.5 Account Lockout - SECURE

- **Threshold**: 5 failed attempts
- **Duration**: 30 minutes
- **Implementation**: `failed_login_attempts` counter + `locked_until` timestamp in users table
- **Reset**: Counter reset to 0 on successful login
- **File**: `services/auth/session-service.js:14-15, 76-91`

### 5.6 Anti-Enumeration - SECURE

- Login returns generic "Invalid email or password" for both unknown email and wrong password
- Forgot password always returns "If an account exists..." regardless of email existence
- **File**: `services/auth/session-service.js:51, 106`, `services/auth/password-service.js:80-85`

### 5.7 Password Reset Flow - SECURE

| Aspect | Implementation | Status |
|--------|---------------|--------|
| Token generation | `crypto.randomBytes(32).toString('hex')` (256-bit) | SECURE |
| Token storage | SHA-256 hash only (via `hashResetToken()`) | SECURE |
| Token expiry | 1 hour | SECURE |
| Attempt limiting | 5 attempts per token (atomic decrement before password update) | SECURE |
| Rate limiting | 5 requests/15min per token prefix | SECURE |
| Token reuse | `used_at IS NULL` check prevents reuse | SECURE |
| Existing tokens | Deleted before new token created (`DELETE WHERE user_id`) | SECURE |

**File**: `services/auth/password-service.js:89-98, 131-174`

### 5.8 HIGH: Password Reset Does NOT Invalidate Existing Sessions

After a successful password reset (`services/auth/password-service.js:176-189`), existing sessions for the user are NOT destroyed. An attacker who has stolen a session cookie retains access even after the victim resets their password.

**Missing**: `DELETE FROM sessions WHERE sess::jsonb->'user'->>'id' = $1` or equivalent session invalidation.

**Risk**: HIGH - Defeats the purpose of password reset in account compromise scenarios.

### 5.9 Token Encryption (OAuth Tokens at Rest) - SECURE

| Aspect | Implementation | Status |
|--------|---------------|--------|
| Algorithm | AES-256-GCM | SECURE |
| IV | `crypto.randomBytes(16)` per encryption | SECURE (random per operation) |
| Auth tag | 128-bit GCM authentication tag | SECURE |
| Key | 32-byte from `TOKEN_ENCRYPTION_KEY` env var | SECURE |
| Format | `iv:authTag:ciphertext` (hex encoded) | CLEAR |
| Key validation | Length, hex format validated on use | SECURE |

**Note**: Single encryption key shared across all merchants. Acceptable for current scale; evaluate per-merchant keys pre-franchise (tracked as MT-11).

**File**: `utils/token-encryption.js`

### 5.9a CSRF Protection - PARTIAL

- `sameSite: 'lax'` on session cookie prevents cross-site POST/PUT/DELETE (baseline CSRF protection)
- State parameter validation in OAuth flows (Google & Square)
- **Missing**: No explicit CSRF token middleware (e.g., `csurf`)
- **Mitigating factors**: Application is API-only (JSON endpoints), `sameSite: lax` blocks cross-origin form POSTs
- **Risk**: MEDIUM - adequate for API-first architecture but lacks defense-in-depth for any HTML form submissions

### 5.10 Security Headers - SECURE

Implemented via Helmet (`middleware/security.js:28-122`):

| Header | Configuration |
|--------|--------------|
| CSP | Strict - `'unsafe-inline'` removed for scripts, `'unsafe-eval'` removed |
| X-Frame-Options | DENY |
| X-Content-Type-Options | nosniff |
| X-XSS-Protection | Enabled |
| X-Powered-By | Hidden |
| HSTS | 1 year (production only) |
| Referrer-Policy | strict-origin-when-cross-origin |
| Permissions-Policy | Disables geolocation, camera, microphone, payment, usb |

### 5.11 CORS Configuration - SECURE

- Production requires `ALLOWED_ORIGINS` env var (blocks all if unset)
- Development mode allows all origins with warning
- Credentials allowed (required for session cookies)
- **File**: `middleware/security.js:360-416`

### 5.12 Rate Limiting Coverage

| Limiter | Window | Max | Key | Endpoints |
|---------|--------|-----|-----|-----------|
| Global | 15min | 100 | IP | All /api (except health, ai-autofill) |
| Login | 15min | 5 | IP+email | POST /auth/login |
| Password reset | 15min | 5 | Token prefix | POST /auth/reset-password |
| Subscription | 1hr | 5 | IP | Subscription create/status |
| Delivery | 1min | 30 | User ID or IP | Delivery write operations |
| Delivery strict | 5min | 10 | User ID or IP | Route generation, sync |
| Webhook | 1min | 100 | Square merchant ID | POST /webhooks/square |
| Sensitive ops | 1hr | 5 | Merchant ID | Token regeneration |
| AI autofill | 15min | 10 | Merchant ID | AI generation endpoints |

---

## 6. Findings Summary

### CRITICAL

| ID | Finding | File | Risk |
|----|---------|------|------|
| C-1 | Password reset does not invalidate existing sessions | `services/auth/password-service.js:176-189` | Account takeover persists after password reset |
| C-2 | ~~Hardcoded `merchant_id = 3` in catalog-location-health~~ ✅ RESOLVED 2026-04-17 | `routes/catalog-location-health.js` | — |

### HIGH

| ID | Finding | File | Risk |
|----|---------|------|------|
| H-1 | ~~15 vendor-catalog write endpoints missing `requireWriteAccess`~~ → 2 remaining (`manage.js` fully resolved 2026-04-19) | `routes/vendor-catalog/import.js` | Read-only users can still import vendor catalog |
| H-2 | Staff invitation endpoints lack token-specific rate limiting | `routes/staff.js:89,101` | Token enumeration (mitigated by 256-bit token space) |
| H-3 | Webhook event cleanup crosses tenant boundaries | `utils/webhook-retry.js:225-236` | Cross-tenant data deletion |
| H-4 | Staff invite cleanup crosses tenant boundaries | `jobs/staff-invite-cleanup-job.js:24-28` | Cross-tenant data deletion |
| H-5 | Webhook events admin endpoint returns all merchants' data | `routes/subscriptions/webhooks.js` | Cross-tenant data exposure (super-admin-only) |

### MEDIUM

| ID | Finding | File | Risk |
|----|---------|------|------|
| M-1 | Staff invitation token enumeration info leakage in logs | `services/staff/staff-service.js:107-117` | Reveals token state in diagnostics |
| M-2 | Delivery auto-finish job doesn't re-verify merchant_id on DELETE | `jobs/delivery-auto-finish-job.js:143-146` | Cross-tenant deletion if route_ids corrupted |
| M-3 | Password reset token prefix logged in rate limit handler | `middleware/security.js:325` | Token prefix exposure in logs |
| M-4 | No explicit CSRF tokens (no csurf middleware) | Application-wide | Mitigated by `sameSite: lax` but lacks defense-in-depth |
| M-5 | Reset token comparison uses SQL equality, not `crypto.timingSafeEqual()` | `services/auth/password-service.js:136-144` | Theoretical timing attack on hashed token lookup (very low practical risk due to SHA-256) |
| M-6 | ~~Forgot-password endpoint lacks dedicated rate limiter~~ ✅ RESOLVED 2026-04-19 | `routes/auth/password.js:28` | `passwordResetRateLimit` now applied to `POST /api/auth/forgot-password` |

### Architecture Strengths

- **Global API auth middleware** (`server.js:286-321`) acts as safety net for all `/api` routes
- **Session-based auth** with PostgreSQL store - no JWT token theft risk
- **Session fixation prevention** via `req.session.regenerate()` on login
- **Anti-enumeration** on both login and forgot-password flows
- **bcrypt with 12 rounds** for password hashing
- **AES-256-GCM** for OAuth token encryption at rest with random IV per operation
- **Comprehensive rate limiting** across sensitive operations
- **Strict CSP** with no `unsafe-inline` for scripts, no `unsafe-eval`
- **Multi-tenant isolation** enforced at middleware layer (`loadMerchantContext` + `requireMerchant`)
- **Feature gating** and **permission gating** at `server.js` level provides defense-in-depth
- **Parameterized queries** used universally - no SQL injection vectors found
- **Audit logging** for all authentication events

### Remediation Priority

**P0 (Immediate)**:
1. **C-1**: Add session invalidation after password reset - destroy all sessions for the user
2. **H-1**: ~~Add `requireWriteAccess` to 15 vendor-catalog write endpoints~~ → 2 remaining (import.js only); `manage.js` fully resolved 2026-04-19

**P1 (This Sprint)**:
3. **H-2**: Add token-specific rate limiting to staff invitation endpoints
4. **H-3/H-4**: Add merchant_id scoping to background cleanup jobs (or document as intentional)
5. ~~**C-2**: Replace hardcoded merchant_id with `req.merchantContext.id` in catalog-location-health~~ — ✅ Resolved 2026-04-17

**P2 (Next Sprint)**:
6. **M-1**: Remove token state differentiation from staff invitation error logs
7. **M-2**: Add merchant_id re-verification to delivery auto-finish DELETE queries
8. **M-3**: Remove token prefix from password reset rate limit log entries
9. **H-5**: Add merchant_id filter to webhook events admin endpoint (or document as intended cross-tenant admin view)

**P3 (Backlog)**:
10. **M-4**: Evaluate adding explicit CSRF token middleware for defense-in-depth
11. **M-5**: Use `crypto.timingSafeEqual()` for token hash comparisons (low practical risk but best practice)
12. ~~**M-6**: Add dedicated rate limiter to forgot-password endpoint~~ — ✅ Resolved 2026-04-19
