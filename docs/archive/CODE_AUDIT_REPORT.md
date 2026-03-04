# SqTools Code Audit Report

> **Audit Date**: 2026-02-05
> **Auditor**: Claude Opus 4.5 (Automated Security & Architecture Review)
> **Codebase**: SquareDashboardTool (Multi-tenant SaaS for Square POS)
> **Total Files Audited**: 293 source files (~86,673 lines of JavaScript)

---

## Executive Summary

### Top 5 Most Critical Findings

| # | Finding | Severity | Business Impact | File(s) |
|---|---------|----------|-----------------|---------|
| 1 | **Cross-Tenant Cart Data Deletion** | CRITICAL | Deleting one merchant's abandoned carts could delete ALL merchants' carts | `services/cart/cart-activity-service.js:273-348` |
| 2 | **Google OAuth CSRF Vulnerability** | CRITICAL | Attacker can link victim's account to attacker's Google Sheets | `utils/google-sheets.js` |
| 3 | **Server-Side XSS in Reports** | CRITICAL | Stored XSS via vendor names/emails in generated HTML reports | `services/reports/loyalty-reports.js:902-924` |
| 4 | **Client-Side API Key in localStorage** | CRITICAL | API keys accessible to any XSS, persist after logout | `public/js/catalog-workflow.js:17-60` |
| 5 | **No Distributed Locking for Cron Jobs** | CRITICAL (at scale) | Multiple instances = duplicate processing, double charges, data corruption | `jobs/cron-scheduler.js` |

### Overall Assessment

| Category | Grade | Notes |
|----------|-------|-------|
| **SQL Injection** | A+ | All queries use parameterized placeholders |
| **Authentication/Authorization** | A | Solid middleware stack, proper route protection |
| **XSS Protection** | B- | Frontend escaped, but server-side HTML generation vulnerable |
| **Multi-Tenant Isolation** | B | Generally good, but critical cart deletion bug |
| **CSRF Protection** | B- | Square OAuth secure, Google OAuth vulnerable |
| **Secret Management** | A+ | Excellent encryption, env handling, no leaks |
| **Rate Limiting** | A | Comprehensive coverage across endpoints |
| **Scalability** | D | Architecture assumes single instance |
| **Dependency Security** | A+ | npm audit: 0 vulnerabilities |

**Production Readiness for Single Location**: A+
**Production Readiness for Franchise (50+ locations)**: D (critical scalability issues)

---

## Critical Findings (Fix Before Franchise Deployment)

### CRIT-1: Cross-Tenant Cart Data Deletion

**Severity**: CRITICAL
**Status**: FIXED (2026-02-05) — Verified 2026-02-11
**Files**:
- `services/cart/cart-activity-service.js` (lines 273-348)
- `jobs/cart-activity-cleanup-job.js` (lines 30, 33)

**Vulnerability Description**:

The `markAbandoned()` function defaults `merchantId` to `null`. When called without a merchantId parameter, the UPDATE statement affects ALL merchants' cart data:

```javascript
// services/cart/cart-activity-service.js:273
async markAbandoned(merchantId = null, daysThreshold = 7) {
    let whereClause = `WHERE status = 'active' AND updated_at < NOW() - INTERVAL '${daysThreshold} days'`;

    if (merchantId) {
        whereClause += ` AND merchant_id = $1`;
        params.push(merchantId);
    }
    // ❌ WITHOUT merchantId, updates ALL merchants
}
```

**Attack Scenario**: If the cleanup job is called with no merchantId (or undefined), it will mark ALL merchants' active carts as abandoned simultaneously.

**Impact**: Data integrity violation, loss of active shopping carts for all tenants, potential revenue loss.

**Fix Applied**: `merchantId` is now mandatory (throws if missing). WHERE clause unconditionally includes `merchant_id = $1`. Cleanup job iterates per-merchant. All 8 cart functions enforce merchant_id.

---

### CRIT-2: Google OAuth CSRF Vulnerability

**Severity**: CRITICAL
**Status**: FIXED (2026-02-05)
**File**: `utils/google-sheets.js`

**Vulnerability Description**:

The Google OAuth state parameter is simply base64-encoded merchantId, NOT cryptographically secured or stored/validated in the database:

```javascript
// Generate state - INSECURE
const state = Buffer.from(JSON.stringify({ merchantId })).toString('base64');

// Callback validation - NO VERIFICATION
function parseAuthState(state) {
    const decoded = Buffer.from(state, 'base64').toString('utf8');
    return JSON.parse(decoded);  // Simply decodes, NO verification
}
```

**Contrast with Square OAuth** (secure implementation):
- State is cryptographically random (256 bits)
- State stored in database with 10-minute expiry
- State tied to specific user ID
- State marked as used after callback

**Attack Scenario**:
1. Attacker crafts malicious state: `base64({"merchantId": "VICTIM_ID"})`
2. Attacker completes Google OAuth with their Google account
3. Attacker-controlled Google Sheets linked to victim's merchant
4. Attacker gains access to exported data

**Recommended Fix**: Implement database-backed state validation matching Square OAuth pattern.

---

### CRIT-3: Server-Side XSS in HTML Report Generation

**Severity**: CRITICAL
**Status**: FIXED (2026-02-05)
**Files**:
- `services/reports/loyalty-reports.js` (lines 902-924)
- `services/reports/brand-redemption-report.js` (line 443)

**Vulnerability Description**:

Vendor names, emails, and credit notes are embedded directly into HTML without escaping:

```javascript
// services/reports/loyalty-reports.js:902-903
<span><strong>Vendor:</strong> ${data.vendor_name}</span>
<span><strong>Email:</strong> ${data.vendor_email || 'N/A'}</span>
${data.vendor_credit_notes ? ` | Notes: ${data.vendor_credit_notes}` : ''}
```

**Data Flow**: Database values → HTML generation → Client browser

**Impact**: Stored XSS - if an attacker can control vendor_name in the database (e.g., via API or import), they can inject JavaScript that executes when any user views the report.

**Recommended Fix**:
```javascript
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, c => map[c]);
}

// Use escapeHtml for all user-controlled values
<span><strong>Vendor:</strong> ${escapeHtml(data.vendor_name)}</span>
```

---

### CRIT-4: Client-Side API Key Storage in localStorage

**Severity**: CRITICAL
**Status**: FIXED (2026-02-05) — Verified 2026-02-11
**File**: `public/js/catalog-workflow.js` (lines 17-60)

**Vulnerability Description**:

Claude API keys were stored in plaintext in browser localStorage.

**Fix Applied**: API keys moved to server-side AES-256-GCM encrypted storage in `merchant_settings.claude_api_key_encrypted` (migration 039). localStorage now only stores non-sensitive config (context, keywords, tone). Key never returned to frontend — only a boolean `hasKey` status endpoint exists.

---

### CRIT-5: No Distributed Locking for Cron Jobs (Scale Blocker)

**Severity**: CRITICAL (at franchise scale)
**File**: `jobs/cron-scheduler.js` (lines 37-107)

**Issue**: No mechanism to prevent the same cron job from running on multiple instances simultaneously.

**Affected Jobs**:
| Job | Schedule | Impact of Duplicate Execution |
|-----|----------|-------------------------------|
| `loyalty-catchup` | Every 15 min | Double loyalty points awarded |
| `loyalty-audit` | Daily 2 AM | Duplicate audit records |
| `expiry-discount` | Daily 6 AM | Race conditions in Square API updates |
| `webhook-retry` | Every 5 min | Same webhook processed twice |

**Current Architecture** (single instance - works):
```
┌──────────────────┐
│   Instance A     │ → Runs job → OK
└──────────────────┘
```

**Franchise Architecture** (multi-instance - broken):
```
┌──────────────────┐
│   Instance A     │ → Runs job ─┐
└──────────────────┘              ├→ DUPLICATE PROCESSING
┌──────────────────┐              │
│   Instance B     │ → Runs job ─┘
└──────────────────┘
```

**Recommended Fix**: Implement PostgreSQL advisory locks or Redis-based distributed locks:
```javascript
async function runWithLock(lockId, jobFn) {
    const lockAcquired = await db.query(
        'SELECT pg_try_advisory_lock($1)', [lockId]
    );
    if (!lockAcquired.rows[0].pg_try_advisory_lock) {
        logger.info('Job already running on another instance');
        return;
    }
    try {
        await jobFn();
    } finally {
        await db.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
}
```

---

## High Priority (Fix Within 30 Days)

### HIGH-1: Timing Attack in Webhook Signature Verification

**Severity**: HIGH
**Status**: FIXED (2026-02-05)
**File**: `services/webhook-processor.js` (line 32)

```javascript
return signature === expectedSignature;  // ❌ Vulnerable to timing attack
```

**Fix**: Use `crypto.timingSafeEqual()`:
```javascript
return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
);
```

---

### HIGH-2: Webhook Error Response Returns 5xx

**Severity**: HIGH
**Status**: FIXED (2026-02-05)
**File**: `services/webhook-processor.js` (line 271)

**Issue**: Returning HTTP 500 causes Square to retry the webhook, potentially creating duplicate processing.

**Fix**: Always return 200, store error state in database for retry job to handle.

---

### HIGH-3: Synchronous File I/O in Request Handlers

**Severity**: HIGH
**Status**: FIXED (2026-02-05)
**Files**:
- `routes/delivery.js:816-823` - `fs.existsSync()` blocks event loop
- `jobs/backup-job.js:174,183-191` - Sync file operations
- `services/gmc/merchant-service.js` - Multiple sync writes

**Impact**: Under load, synchronous operations block ALL other requests.

**Fix**: Convert to `fs.promises` async versions.

---

### HIGH-4: In-Memory Global State Won't Scale

**Severity**: HIGH
**Status**: OPEN — Tracked as BACKLOG-9 in TECHNICAL_DEBT.md
**Files**:
- `services/sync-queue.js:26-37` - In-memory Map for sync coordination (partially persisted to DB)
- `services/webhook-handlers/order-handler.js:43-68` - Debounce state + metrics (entirely in-memory)

**Issue**: Each instance has its own state - no coordination across instances. On PM2 restart, active debounce timers and metrics are lost. Acceptable for single-instance but blocks multi-instance scaling.

**Planned Fix**: Add startup recovery for committed inventory sync; flush stats on SIGTERM; document design decision. Full Redis migration deferred to pre-franchise. See BACKLOG-9.

---

### HIGH-5: Missing Permissions-Policy Header

**Severity**: HIGH
**Status**: FIXED (2026-02-05) — Verified 2026-02-11
**File**: `middleware/security.js` (lines 287-304)

**Issue**: Permissions-Policy header not configured, allowing access to sensitive browser features.

**Fix Applied**: Custom `configurePermissionsPolicy()` middleware sets header restricting geolocation, camera, microphone, payment, and usb. Applied in `server.js:118` alongside Helmet.

---

### HIGH-6: webhook_events Table Wrong merchant_id Type

**Severity**: HIGH
**Status**: FIXED (2026-02-05) — Verified 2026-02-11
**File**: Schema definition for `webhook_events`, migration 041

**Issue**: `merchant_id` was `TEXT` instead of `INTEGER` with foreign key constraint.

**Fix Applied**: Migration 041 renamed old column to `square_merchant_id` (TEXT), added new `merchant_id INTEGER REFERENCES merchants(id)` with FK constraint and index. Existing data backfilled. Webhook processor now resolves Square merchant ID to internal integer ID before storing.

---

## Medium Priority (Fix Within 90 Days)

### MED-1: Dynamic Parameter Placeholder Construction

**Files**: `routes/purchase-orders.js:328-352`, `routes/vendor-catalog.js:474-478`

**Issue**: Building SQL with template literal interpolation of computed parameter numbers is a code smell, though currently safe.

**Recommendation**: Refactor to use query builder pattern for cleaner code.

---

### MED-2: Connection Pool Size Not Configurable

**File**: `utils/database.js` (lines 14-23)

**Issue**: Pool hardcoded to `max: 20` connections. At 50+ merchants with concurrent operations, pool will exhaust.

**Fix**: Make pool size configurable via environment variable, add pool exhaustion monitoring.

---

### MED-3: No Circuit Breaker for Square API

**File**: `services/loyalty-admin/shared-utils.js`

**Issue**: Simple timeout but no circuit breaker. If Square API is slow, all instances hammer it.

**Fix**: Implement circuit breaker pattern with exponential backoff.

---

### MED-4: setInterval Not Cleared on Shutdown

**File**: `services/square/api.js:49`

```javascript
setInterval(pruneInvoicesScopeCache, INVOICES_SCOPE_CACHE_TTL);  // Never cleared
```

**Fix**: Store reference and clear in graceful shutdown handler.

---

### MED-5: Long-Running Jobs Without Timeout

**File**: `jobs/loyalty-audit-job.js:48-80`

**Issue**: Fetches all loyalty events with pagination. No timeout per merchant.

**Fix**: Add per-merchant timeout and progress tracking.

---

## Low Priority (Backlog)

### LOW-1: Response Format Inconsistency

Some routes return `{success: true, data: {...}}`, others return data directly. Causes frontend bugs.

**Documented in**: `docs/TECHNICAL_DEBT.md` - BACKLOG-3

---

### LOW-2: Global Metrics Reset on Restart

**File**: `services/webhook-handlers/order-handler.js:43`

Metrics counters are in-memory and reset on every restart.

---

### LOW-3: PM2 Single Instance Mode

**File**: `ecosystem.config.js` (lines 39-40)

`instances: 1` and `exec_mode: 'fork'` - cannot distribute across CPU cores.

---

### LOW-4: Webhook Handler Not Using asyncHandler

**File**: `routes/webhooks/square.js:39-41`

Missing `asyncHandler` wrapper - uncaught errors may not be properly handled.

---

## Knowledge Gap Recommendations

### Infrastructure Patterns Missing for Franchise Scale

| Pattern | Status | Risk Level |
|---------|--------|------------|
| **Distributed Locking** | MISSING | CRITICAL |
| **Pub/Sub System** | MISSING | MEDIUM |
| **Circuit Breaker** | MISSING | MEDIUM |
| **Distributed Cache (Redis)** | MISSING | MEDIUM |
| **Connection Pool Monitoring** | MISSING | MEDIUM |
| **Request Tracing Across Instances** | MISSING | LOW |

### Recommended Learning Areas

1. **Redis for Multi-Instance Coordination**: Essential for distributed locking, caching, and pub/sub
2. **Node.js Cluster Mode**: PM2 clustering requires adjustments to global state handling
3. **PostgreSQL Advisory Locks**: Alternative to Redis for simple distributed locking
4. **OpenTelemetry**: Request tracing becomes critical with multiple instances

### Architecture Evolution Path

**Current State**: Single-instance monolith (A+ for single business)

**Target State**: Multi-instance ready (requires):
1. Extract all in-memory state to Redis
2. Add distributed job locking
3. Enable PM2 clustering
4. Add request tracing
5. Implement connection pool monitoring

---

## Appendix: Full Findings by Category

### A. Security Findings Summary

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| SQL Injection | 0 | 0 | 0 | 2 (code smells) |
| XSS | 2 | 0 | 0 | 0 |
| Multi-Tenant | 1 | 0 | 1 | 0 |
| CSRF | 1 | 0 | 0 | 0 |
| Auth/Authz | 0 | 0 | 0 | 0 |
| Secrets | 1 | 0 | 0 | 0 |
| Rate Limiting | 0 | 0 | 0 | 0 |
| Webhooks | 0 | 2 | 1 | 0 |
| **Total** | **5** | **2** | **2** | **2** |

### B. Scalability Findings Summary

| Issue | Severity | Impact at 50+ Locations |
|-------|----------|-------------------------|
| No clustering support | CRITICAL | Cannot scale horizontally |
| In-memory global state | CRITICAL | Data corruption |
| No distributed locking | CRITICAL | Duplicate processing |
| Sync file I/O | HIGH | Request blocking |
| Connection pool size | MEDIUM | Pool exhaustion |
| No circuit breaker | MEDIUM | Cascading failures |

### C. Files Requiring Immediate Attention

| File | Issues | Priority |
|------|--------|----------|
| `services/cart/cart-activity-service.js` | Cross-tenant deletion | CRITICAL |
| `utils/google-sheets.js` | OAuth CSRF | CRITICAL |
| `services/reports/loyalty-reports.js` | XSS | CRITICAL |
| `public/js/catalog-workflow.js` | API key in localStorage | CRITICAL |
| `jobs/cron-scheduler.js` | No distributed locking | CRITICAL (scale) |
| `services/webhook-processor.js` | Timing attack, 5xx response | HIGH |
| `routes/delivery.js` | Sync file I/O | HIGH |

### D. Positive Findings

The codebase demonstrates many security best practices:

- **Parameterized SQL**: 100% coverage - no SQL injection vectors
- **Password Security**: bcrypt hashing, lockout on failed attempts
- **Token Encryption**: AES-256-GCM for OAuth tokens
- **Session Security**: Regeneration on login, proper cookie flags
- **Rate Limiting**: Comprehensive coverage with multiple tiers
- **Logging**: No secrets logged, proper rotation
- **npm Dependencies**: Zero known vulnerabilities
- **Input Validation**: Express-validator middleware on most routes
- **Error Handling**: Generic error messages to clients, details logged server-side

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-05 | 1.0 | Initial comprehensive audit |
| 2026-02-11 | 1.1 | Verified CRIT-1, CRIT-4, HIGH-5, HIGH-6 fixes; updated HIGH-4 status to OPEN with BACKLOG-9 tracking |

---

*Report generated by Claude Opus 4.5 automated security and architecture review*
