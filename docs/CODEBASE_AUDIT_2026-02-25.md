# SqTools Comprehensive Codebase Audit

**Date**: 2026-02-25
**Codebase**: ~/JTPets-Admin/SquareDashboardTool
**Auditor**: Claude (automated)
**Branch**: claude/sqtools-codebase-audit-uxh5W

---

## 1. Security

### S-1: SQL Injection via Template Literal Interpolation in INTERVAL Clauses
**Severity**: HIGH
**Files**:
- `services/cart/cart-activity-service.js:285` — `INTERVAL '${daysThreshold} days'`
- `services/cart/cart-activity-service.js:324` — `INTERVAL '${daysThreshold} days'`
- `services/cart/cart-activity-service.js:425` — `INTERVAL '${days} days'`
- `services/cart/cart-activity-service.js:428` — `INTERVAL '${days} days'`
- `routes/square-oauth.js:78` — `INTERVAL '${STATE_EXPIRY_MINUTES} minutes'`
- `utils/google-auth.js:125` — `INTERVAL '${STATE_EXPIRY_MINUTES} minutes'`

**Detail**: These queries interpolate JavaScript variables directly into SQL template literals instead of using parameterized queries. While `STATE_EXPIRY_MINUTES` is a hardcoded constant (low actual risk), `daysThreshold` in cart-activity-service.js is passed as a function argument — if any caller passes unsanitized user input, this is exploitable. Even where values are currently safe, this pattern violates the project's "ALL database queries use parameterized SQL" rule and creates a latent vulnerability.

**Fix**: Use `INTERVAL '1 day' * $N` pattern with parameterized values, as already done correctly in `routes/cycle-counts.js:324` and `utils/webhook-retry.js:229`.

### S-2: `/output` Directory Served as Static Files
**Severity**: MEDIUM
**File**: `server.js:221`
```js
app.use('/output', express.static(path.join(__dirname, 'output')));
```

**Detail**: The `/output` directory is served without authentication. This directory contains generated files including database backups (per `jobs/backup-job.js`), logs, feeds, and temp files. Anyone who knows the file paths can download them without logging in. Database backups could contain the entire merchant dataset.

**Fix**: Add `requireAuth` middleware before this static route, or restrict to specific subdirectories. At minimum, exclude `/output/backups/` from static serving.

### S-3: OAuth Callback Missing Session Auth Verification
**Severity**: MEDIUM
**File**: `routes/square-oauth.js:110`

**Detail**: The OAuth callback route (`GET /api/square/oauth/callback`) does not verify that the current request has an authenticated session. It relies solely on the `state` parameter tied to a `user_id` in the database. While the CSRF state prevents forged callbacks, if a user's session expires between initiating OAuth and completing it, the callback still succeeds and binds the merchant to the original user — even if someone else is now logged in on the same browser.

**Fix**: Verify `req.session.user.id === stateRecord.user_id` in the callback before processing.

### S-4: CSP Allows `'unsafe-inline'` for Scripts
**Severity**: MEDIUM
**File**: `middleware/security.js:29`

**Detail**: The Content Security Policy allows `'unsafe-inline'` for `scriptSrc`. The comment says "Required until inline `<script>` blocks externalized", but the P0-4 CSP audit says 29/29 files migrated to event delegation. If inline scripts are fully eliminated, this directive should be removed. With `'unsafe-inline'`, any XSS that injects a `<script>` tag will execute.

**Fix**: Audit remaining inline `<script>` blocks; if none remain, remove `'unsafe-inline'`. If some remain, use nonce-based CSP.

### S-5: Password Reset Token Exposed in Development Response
**Severity**: LOW
**File**: `routes/auth.js:655`
```js
...(isDev && { resetToken, resetUrl: `/set-password.html?token=${resetToken}` })
```

**Detail**: In non-production environments, the password reset token is returned directly in the API response. If `NODE_ENV` is accidentally left unset (defaults to non-production), this leaks reset tokens to any API caller. The check `process.env.NODE_ENV !== 'production'` is a negative check — it's safer to use a positive opt-in like `NODE_ENV === 'development'`.

**Fix**: Change to `process.env.NODE_ENV === 'development'` for positive opt-in.

### S-6: Admin User Listing Not Scoped by Merchant
**Severity**: MEDIUM
**File**: `routes/auth.js:299-310`
```js
router.get('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await db.query(`
        SELECT id, email, name, role, is_active, last_login, created_at
        FROM users ORDER BY created_at DESC
    `);
```

**Detail**: The `/api/auth/users` endpoint returns ALL users in the system, regardless of merchant. In a multi-tenant SaaS, admin users of Merchant A should not see users of Merchant B. The `requireAdmin` check is application-level role, not merchant-scoped.

**Fix**: Join through `user_merchants` and filter by `req.merchantContext.id`.

### S-7: Missing `requireMerchant` on OAuth Revoke Route
**Severity**: LOW
**File**: `routes/square-oauth.js:320`

**Detail**: The revoke route only uses `requireAuth`, not `requireMerchant`. It manually checks access via `user_merchants` table. While functionally equivalent, this bypasses the standard middleware pattern and relies on the route doing its own access checks correctly.

**Fix**: Use the standard `requireMerchant` + `requireMerchantRole('owner')` middleware chain.

### S-8: Health Endpoint Exposes Internal Details
**Severity**: LOW
**File**: `server.js:459-472`

**Detail**: The `/api/health` endpoint (unauthenticated) exposes heap memory sizes, node version, uptime, webhook failure counts, and Square connection status. While individually benign, this information aids reconnaissance.

**Fix**: Return minimal health info on the public endpoint; add an authenticated `/api/health/detailed` route for full diagnostics.

### S-9: No CSRF Token for State-Changing POST Requests
**Severity**: LOW
**File**: Project-wide

**Detail**: The app uses `sameSite: 'lax'` on session cookies, which protects against cross-site POST from `<form>` submissions but does NOT protect against JavaScript-initiated `fetch()` or `XMLHttpRequest` cross-origin POSTs if CORS is misconfigured. There is no CSRF token middleware. The CORS config is well-implemented, but CORS + SameSite is defense-in-depth, not defense-in-isolation.

**Fix**: Consider adding `csurf` or a custom CSRF token middleware for state-changing API endpoints, especially admin operations.

### S-10: XSS in Vendor Catalog Import Validation Errors
**Severity**: HIGH
**File**: `public/js/vendor-catalog.js:387`
```js
html += `<li>Row ${err.row}: ${err.errors.join(', ')}</li>`;
```

**Detail**: Validation error messages from the server are rendered via `innerHTML` (line 397) without escaping. If validation error strings contain user-controlled content (e.g., CSV field values echoed back in error messages), an attacker could inject HTML/JS. The surrounding code at line 383 correctly uses `escapeHtml(message)` but this loop does not.

**Fix**: `html += \`<li>Row ${err.row}: ${err.errors.map(e => escapeHtml(e)).join(', ')}</li>\``

### S-11: Session Fixation Window on OAuth Callback
**Severity**: LOW
**File**: `routes/square-oauth.js:242-244`

**Detail**: On OAuth callback success, `req.session.activeMerchantId = newMerchantId` is set without regenerating the session ID. The login route correctly regenerates sessions (auth.js:140), but the OAuth flow modifies session state without regeneration. If an attacker has pre-set a session ID (e.g., via XSS), they could inherit the merchant binding.

**Fix**: Call `req.session.regenerate()` after modifying session state in the OAuth callback.

---

## 2. Architecture

### A-1: `services/square/api.js` Is a 4,793-Line God Module
**Severity**: HIGH
**File**: `services/square/api.js` — 4,793 lines, 38 exports across 12 domains

**Detail**: This single file handles location sync, vendor sync, full catalog sync, delta catalog sync, category/image/item/variation sync, inventory sync, sales velocity sync, inventory count operations, committed inventory sync, diagnostics & fixes, custom attributes, and price/cost updates. A bug fix in one domain risks regressions in another. The file exceeds the 300-line limit by 16x and is NOT in the approved violations table.

**Fix**: Split into at minimum:
- `services/square/catalog-sync.js` — catalog, delta, category, image, item, variation sync
- `services/square/inventory-sync.js` — inventory, velocity, committed inventory
- `services/square/catalog-operations.js` — prices, costs, attributes, content updates
- `services/square/diagnostics.js` — fix location mismatches, inventory alerts, item enabling
- Keep `services/square/api.js` as a thin facade re-exporting from sub-modules

### A-2: Business Logic in Route Handlers
**Severity**: HIGH
**Files**:
- `routes/bundles.js:88-291` — 170+ lines of bundle availability calculation inline (inventory batching, velocity lookups, min-stock calculations, bundle map building, availability loop with Math.floor/Infinity)
- `routes/analytics.js:218-224` — inline days-of-stock formula duplicating `services/catalog/reorder-math.js`
- `routes/delivery.js:445-659` — inline delivery stat aggregation logic

**Detail**: Per CLAUDE.md, route files should contain "validation + call service only." These routes embed multi-step business logic that should live in service modules. The bundles route at 291 lines is the worst offender — the entire availability calculation is inline.

**Fix**: Extract to `services/bundle-calculator.js` (bundles), use existing `reorder-math.js` (analytics), create `services/delivery/delivery-stats.js` (delivery).

### A-3: Circular Dependency Between Middleware and Routes
**Severity**: MEDIUM
**Files**:
- `middleware/merchant.js:227` — `const { refreshMerchantToken } = require('../routes/square-oauth')`
- `routes/square-oauth.js:21` — `const { requireAuth, ... } = require('../middleware/auth')`

**Detail**: `middleware/merchant.js` imports from `routes/square-oauth.js` (a route file), creating a circular dependency chain. It's mitigated via a deferred dynamic `require()` inside a function body (not at module scope), with an explicit comment. This works but violates the architectural rule that middleware should not depend on routes.

**Fix**: Extract `refreshMerchantToken()` to `utils/square-token.js` to eliminate the circular reference entirely.

### A-4: Duplicate Customer Lookup Implementations (BACKLOG-17 / DEDUP L-4)
**Severity**: HIGH
**Files**:
- `services/loyalty/customer-service.js:195-495` — `identifyFromLoyaltyEvents()`, `identifyFromOrderRewards()`, `identifyFromFulfillmentRecipient()`
- `services/loyalty-admin/customer-admin-service.js:110-413` — `lookupCustomerFromLoyalty()`, `lookupCustomerFromOrderRewards()`, `lookupCustomerFromFulfillmentRecipient()`

**Detail**: Customer identification logic is duplicated across two service layers. If a bug is fixed in one, the other diverges. Customer identification is foundational to the loyalty system — divergence could cause incorrect point attribution or missed rewards. Already tracked as BACKLOG-17 but unfixed.

**Fix**: Consolidate into the admin layer (`customer-admin-service.js`) and delete the legacy copies.

### A-5: Inconsistent Response Formats (BACKLOG-3)
**Severity**: MEDIUM
**Files**: Project-wide across routes

**Detail**: Routes use at least 3 response patterns interchangeably:
- Direct: `res.json({ offers })` — `routes/loyalty.js:74`
- Wrapped: `res.json({ success: true, data: {...} })` — `routes/loyalty.js:428`
- Pass-through: `res.json(stats)` — `routes/delivery.js:659`

Even within single files, different endpoints use different formats. CLAUDE.md acknowledges this with a warning. This makes frontend code brittle — developers must inspect each endpoint individually.

**Fix**: Standardize on wrapped format for all API responses. Create response helper middleware.

### A-6: 66 Files Over 300-Line Limit (Beyond 2 Approved)
**Severity**: MEDIUM
**Files**: 68 total files > 300 lines; only `utils/database.js` and `server.js` are approved violations

**Notable unapproved violations**:
- `routes/loyalty.js` — 2,100 lines (30+ endpoints)
- `services/expiry/discount-service.js` — 2,097 lines
- `services/delivery/delivery-service.js` — 1,918 lines
- `public/js/loyalty.js` — 2,074 lines
- `public/js/reorder.js` — 1,752 lines
- `services/reports/loyalty-reports.js` — 1,413 lines
- `services/vendor/catalog-service.js` — 1,397 lines
- `services/webhook-handlers/order-handler.js` — 1,316 lines

**Detail**: Per CLAUDE.md, the "refactor-on-touch" policy applies. These files should be added to the approved violations table with justification, or split when next modified.

### A-7: Open Deduplication Debt (DEDUP-AUDIT Cross-Reference)
**Severity**: LOW
**Files**: Multiple (see BACKLOG items)

**Remaining open DEDUP findings**:
- **G-3** (BACKLOG-23): Currency formatting — 14+ files with inconsistent `(cents / 100).toFixed(2)` vs `.toLocaleString()` patterns
- **G-5** (BACKLOG-25): Location lookup queries repeated across 6 routes
- **G-7** (BACKLOG-26): `new Date().toISOString().split('T')[0]` repeated 12 times
- **G-8** (BACKLOG-27): `.toLocaleString()` — 60 uses with inconsistent locale arguments

---

## 3. Database

### D-1: Missing Indexes on `vendor_catalog_items` and `expiry_discount_audit_log`
**Severity**: HIGH
**Files**:
- `database/schema.sql:676-705` — `vendor_catalog_items` table definition, no `merchant_id` index
- `database/schema.sql:867-880` — `expiry_discount_audit_log` table definition, no `merchant_id` index

**Detail**: These tables are queried with `WHERE merchant_id = $1` (e.g., `services/vendor/catalog-service.js`, `services/expiry/discount-service.js:1444,1660`) but have no index on `merchant_id`. Migration 005 (line 334, 354) creates these indexes, but `schema.sql` was never updated to reflect them. A fresh deploy from `schema.sql` alone would be missing these indexes.

**Fix**: Add the indexes to `schema.sql` to keep it in sync with the cumulative migration state.

### D-2: Missing Composite Index on `inventory_counts`
**Severity**: MEDIUM
**File**: `database/schema.sql:408-409`

**Detail**: Common analytics queries filter by `WHERE merchant_id = $1 AND location_id = $2 AND state = 'AVAILABLE'` (in `routes/analytics.js`, `services/catalog/inventory-service.js`). Only `idx_inventory_variation_location` exists (variation_id, location_id). A composite `(merchant_id, location_id, state)` index would optimize these queries.

**Fix**: `CREATE INDEX idx_inventory_counts_merchant_location_state ON inventory_counts(merchant_id, location_id, state);`

### D-3: N+1 Query — Sequential Square Customer Fetches
**Severity**: MEDIUM
**File**: `routes/loyalty.js:1603-1620`

**Detail**: A loop iterates over `customerIds` making individual Square API calls with a 100ms throttle. For 100 customers this takes 10+ seconds. While the throttle respects rate limits, it could use parallel batching with concurrency control.

**Fix**: Use `Promise.allSettled` with concurrency limit (p-limit at 5 concurrent) instead of sequential loop.

### D-4: N+1 Query — Order Lookup Per Earned Reward in Audit
**Severity**: MEDIUM
**File**: `services/loyalty-admin/redemption-audit-service.js:121-165`

**Detail**: For each earned reward, a separate DB query fetches matching orders from `loyalty_processed_orders`. With many rewards, this multiplies database round-trips.

**Fix**: Batch-fetch all orders in one query using `square_customer_id = ANY($1)`.

### D-5: `schema.sql` Drift From Migration State
**Severity**: MEDIUM
**File**: `database/schema.sql` vs `database/migrations/005_multi_tenant.sql`

**Detail**: `schema.sql` is intended as the "clean" schema but doesn't include all indexes created by migrations. This means a fresh database from `schema.sql` alone is subtly different from one built by applying all migrations. Indexes from migration 005 (multi-tenant) are the most notable gap.

**Fix**: Audit and merge all migration-created indexes back into `schema.sql`.

### D-6: `expiry_discount_audit_log.merchant_id` Allows NULL
**Severity**: LOW
**File**: `database/schema.sql:867-880`

**Detail**: The `merchant_id` column on this audit log table is nullable. In a multi-tenant system, all audit records should be merchant-scoped. NULL merchant_id rows would be orphaned and invisible to any tenant query.

**Fix**: Add `NOT NULL` constraint after verifying no existing NULL rows.

### D-7: Potentially Dead Column `subscription_plans.square_plan_id`
**Severity**: LOW
**File**: `database/schema.sql:1053`

**Detail**: The `square_plan_id` column exists but is not referenced in any route or service query. If Square Subscriptions API integration is no longer planned, this column is dead schema.

**Fix**: Audit whether this column has future use; if not, create a migration to drop it.

---

## 4. Error Handling

### E-1: Fire-and-Forget Email in Database Error Handler
**Severity**: HIGH
**File**: `server.js:1001`
```js
db.pool.on('error', (err) => {
    ...
    emailNotifier.sendCritical('Database Connection Lost', err);
});
```

**Detail**: `emailNotifier.sendCritical()` is called without `await` or `.catch()` inside the database pool error event handler. If the email service is down when the database fails, the notification silently fails with no logging. This is a critical alerting gap — the operator won't know the database is unreachable.

**Fix**: Add `.catch(emailErr => logger.error('Failed to send DB error alert', { error: emailErr.message }))`.

### E-2: OAuth Routes Use Custom try/catch Instead of asyncHandler
**Severity**: LOW
**Files**:
- `routes/square-oauth.js:67` — `GET /connect` uses manual try/catch
- `routes/square-oauth.js:110` — `GET /callback` uses manual try/catch

**Detail**: All other routes use the `asyncHandler` wrapper consistently (~287 routes, 99.3% coverage). These two OAuth routes use custom try/catch blocks. While functionally correct (they redirect on error rather than returning JSON), the inconsistency makes the error handling pattern harder to audit.

**Fix**: Wrap with asyncHandler and handle redirect logic inside the handler, or document the exception.

### E-3: Global Error Handler Is Comprehensive (Strength)
**Severity**: LOW (Informational)
**File**: `server.js:621-704`

**Detail**: The global error handler is well-designed:
- Maps error codes to HTTP status codes
- Production: generic user-friendly messages via `getUserFriendlyMessage()`
- Development: includes full error details + stack traces
- Includes request ID for production tracing
- Handles validation errors (422) with error array
- Rate limit responses include `retryAfter` header
- No stack traces leaked in production

### E-4: Audit Logging Silently Swallows Errors (By Design)
**Severity**: LOW
**Files**:
- `services/loyalty-admin/audit-service.js:66-73` — `logAuditEvent()` catches and logs only
- `middleware/auth.js:158-161` — `logAuthEvent()` catches and logs only

**Detail**: Both audit logging functions catch errors and log them but don't rethrow. This is documented as intentional ("audit logging should not break main operations"). However, if the database is under stress, authentication audit trail gaps could occur with no recovery mechanism.

**Fix**: Consider a fallback buffer (write to a file or in-memory queue) for audit events that fail to persist.

### E-5: Square API Retry Logic Is Robust (Strength)
**Severity**: LOW (Informational)
**File**: `services/square/api.js:117-216`

**Detail**: The `makeSquareRequest()` function handles retries well:
- Max 3 retries with exponential backoff (1s, 2s, 4s)
- 429 rate limits: reads `Retry-After` header
- Non-retryable errors (400, 409, IDEMPOTENCY_KEY_REUSED): throws immediately
- Auth errors (401): throws immediately
- Timeout (AbortError): retries with backoff
- No infinite loop risk — bounded by MAX_RETRIES counter

### E-6: Webhook Retry System Is Well-Designed (Strength)
**Severity**: LOW (Informational)
**Files**: `utils/webhook-retry.js`, `jobs/webhook-retry-job.js`

**Detail**: Failed webhooks are retried with exponential backoff (1, 2, 4, 8, 16 minutes), max 5 retries. On max retries exceeded, an email alert is sent. Retry count is persisted in the database, preventing infinite loops across process restarts.

---

## 5. API Integration

### I-1: Google Merchant Center API Missing 429/Rate Limit Handling
**Severity**: HIGH
**File**: `services/gmc/merchant-service.js:200-228`

**Detail**: The `merchantApiRequest()` function makes Google API calls but has no retry logic for 429 (rate limit) responses. If Google returns a rate limit, the request fails immediately. By contrast, the Square API integration at `services/square/api.js:148-153` properly reads the `Retry-After` header and retries with exponential backoff.

**Fix**: Add 429 handling with `Retry-After` header parsing and exponential backoff (max 3 retries), matching the Square API pattern.

### I-2: Dual Square API Version Constants
**Severity**: MEDIUM
**Files**:
- `services/square/api.js:25` — `SQUARE_API_VERSION = '2025-10-16'`
- `services/loyalty-admin/shared-utils.js:18` — `SQUARE_API_VERSION = '2025-01-16'`

**Detail**: Two different Square API version strings are defined in separate modules. The loyalty-admin module uses an older version (9 months behind). If Square changes behavior between versions, the two modules could see different API responses for the same endpoint.

**Fix**: Centralize to `config/constants.js` as a single `SQUARE_API_VERSION` value, using the newer `2025-10-16`.

### I-3: Duplicate `generateIdempotencyKey()` Implementation
**Severity**: LOW
**Files**:
- `services/square/api.js:107-109`
- `services/loyalty-admin/shared-utils.js:176-184`

**Detail**: Identical function defined in two places. A code comment in `shared-utils.js` explains the duplication is intentional (to avoid circular dependency on node-fetch import). Both implementations are identical (`prefix-${crypto.randomUUID()}`), so no functional risk, but it's undocumented duplication.

**Fix**: Extract to `utils/idempotency.js` and import from both locations, or document the intentional duplication with a cross-reference comment.

### I-4: Webhook Processor Returns 200 on All Errors (By Design)
**Severity**: LOW (Informational)
**File**: `services/webhook-processor.js:331,372`

**Detail**: The webhook endpoint always returns HTTP 200, even when processing fails. This is correct behavior — returning non-200 would cause Square to retry the webhook, potentially causing duplicate processing. Failed events are stored in `webhook_events` with error status and retried by `webhook-retry-job.js` using internal logic. This is well-documented in code comments at lines 368-372.

**Fix**: None required — this is correct design. Documenting for audit completeness.

### I-5: Webhook Handler Isolation Via Promise.allSettled (Strength)
**Severity**: LOW (Informational)
**File**: `services/webhook-handlers/index.js:58-81`

**Detail**: The fan-out handler uses `Promise.allSettled()` so one handler's failure doesn't block others. For example, `invoice.payment_made` fans out to both `subscription` and `inventory` handlers — if inventory processing fails, subscription processing still completes. Individual failures are logged with context. This is correct design.

---

## 6. Dead Code

### DC-1: 9 Backward-Compatibility Re-Export Stubs in utils/
**Severity**: LOW
**Files**:
- `utils/loyalty-service.js` — re-exports from `services/loyalty-admin/` (used by 12+ files)
- `utils/delivery-api.js` — re-exports from `services/delivery/` (used by 6+ files)
- `utils/merchant-center-api.js` — re-exports from `services/gmc/merchant-service.js` (8+ files)
- `utils/gmc-feed.js` — re-exports from `services/gmc/feed-service.js` (2 files)
- `utils/loyalty-reports.js` — re-exports from `services/loyalty-admin/` (1 file)
- `utils/vendor-catalog.js` — re-exports from `services/vendor/catalog-service.js` (1 file)
- `utils/expiry-discount.js` — re-exports from `services/expiry/discount-service.js`
- `utils/google-sheets.js` — re-exports from `services/integrations/google-sheets.js` (1 file)
- `utils/square-api.js` — re-exports from `services/square/api.js` (50+ files)

**Detail**: These are NOT dead code — they're actively used backward-compatibility shims from a service layer migration. New code imports directly from `services/`, but older code still routes through `utils/`. All re-exports have active consumers. However, the single-consumer stubs (`loyalty-reports.js`, `vendor-catalog.js`, `google-sheets.js`) could be eliminated by updating their one caller.

**Fix**: Migrate callers of single-use stubs to import from `services/` directly. Document the multi-use stubs in CLAUDE.md with a deprecation timeline.

### DC-2: No Dead Code Found (Strength)
**Severity**: LOW (Informational)

**Detail**: The codebase is exceptionally clean. Verified:
- All 25 route modules are mounted in `server.js` (lines 260-405)
- All 20 npm dependencies are actively imported
- All 34 HTML pages have corresponding JS and are served
- No commented-out code blocks (3+ lines) found
- No orphaned files (every JS file is required somewhere)
- No dead database tables in `schema.sql`
- No feature flags with always-one values
- Zero unreferenced exported functions in sampled modules

---

## 7. Performance

### P-1: Reorder Suggestions Endpoint Returns Unbounded Result Sets
**Severity**: CRITICAL
**File**: `routes/analytics.js:147-278, 752-759`

**Detail**: The `/api/analytics/reorder-suggestions` endpoint joins 9 tables with 3 correlated subqueries (vendor prices, pending PO, expiry data), selecting 30+ columns. There is no LIMIT clause. For a merchant with 10,000 variations, this returns 300KB+ of JSON per request. The response at line 752 returns the full `suggestionsWithImages` array plus `bundle_analysis` and `bundle_affiliations` with no pagination.

**Fix**: Add `LIMIT $X OFFSET $Y` parameters. Implement cursor-based or offset pagination with a default limit of 100.

### P-2: N+1 Bundle Component Inserts
**Severity**: HIGH
**File**: `routes/bundles.js:340-359, 455-473`

**Detail**: When creating a bundle, each component is inserted individually in a `for` loop. A 10-component bundle makes 10 sequential INSERT queries (~100ms each = 1 second overhead). Same pattern repeats in the update path (lines 455-473).

**Fix**: Use batch INSERT with multiple VALUES clauses: `INSERT INTO bundle_components (...) VALUES ($1,...), ($2,...), ... RETURNING *`

### P-3: `SELECT *` on Merchants Table for Every Request
**Severity**: HIGH
**File**: `middleware/merchant.js:210`
```js
const merchant = await db.query(
    'SELECT * FROM merchants WHERE id = $1 AND is_active = TRUE',
    [merchantId]
);
```

**Detail**: Called by `getSquareClientForMerchant()` which runs on many requests. Fetches all columns including encrypted `square_access_token`, `square_refresh_token`, raw `settings` JSON, etc. — most of which are unused by the caller.

**Fix**: Select only needed columns: `SELECT id, square_access_token, square_refresh_token, square_token_expires_at FROM merchants WHERE ...`

### P-4: Square API Pagination Loops Have No Iteration Guard
**Severity**: HIGH
**File**: `services/square/api.js` — lines 331, 445, 770, 1598, 1845, 2566, 3028 (7 instances)

**Detail**: `do { ... } while (cursor)` pagination loops iterate until the API returns no more pages. For a merchant with 100,000 orders, this loops 1,000 times. If a single iteration takes 300ms, total time is 5 minutes. There is no maximum iteration count or timeout guard.

**Fix**: Add `MAX_ITERATIONS` constant (e.g., 500) and break with a warning log if exceeded.

### P-5: Google OAuth Token Listener Duplicated on Every Call
**Severity**: MEDIUM
**File**: `services/gmc/merchant-service.js:57-70`

**Detail**: Every call to `getAuthClient()` attaches a new `oauth2Client.on('tokens', ...)` listener. If called 10 times during a sync operation, 10 duplicate listeners fire for the same token refresh event, each executing the same database UPDATE.

**Fix**: Guard with `if (!oauth2Client.listeners('tokens').length) { oauth2Client.on('tokens', ...) }` or attach the listener once at module initialization.

### P-6: N+1 GMC Settings Inserts
**Severity**: MEDIUM
**File**: `services/gmc/merchant-service.js:94-102`

**Detail**: `saveGmcApiSettings()` loops over settings entries, making individual `INSERT ... ON CONFLICT DO UPDATE` queries for each key-value pair. With 5 settings, this makes 5 sequential queries.

**Fix**: Batch with a single `INSERT ... VALUES (...), (...), ... ON CONFLICT DO UPDATE` or use `UNNEST` arrays.

### P-7: clientCache Has No Maximum Size or LRU Eviction
**Severity**: MEDIUM
**File**: `middleware/merchant.js:19-20`
```js
const clientCache = new Map();
const CLIENT_CACHE_TTL = 5 * 60 * 1000;
```

**Detail**: The Square client cache grows unboundedly. With 1,000 merchants, 1,000 Square client objects stay in memory. Old entries are only evicted when their TTL expires and they're next accessed — there's no proactive cleanup.

**Fix**: Add a max size (e.g., 500) with FIFO or LRU eviction. Consider using a library like `lru-cache`.

### P-8: Sync Queue Follow-Up Syncs Block Sequentially
**Severity**: MEDIUM
**File**: `services/sync-queue.js:232-242`

**Detail**: If webhooks arrive during a sync, a follow-up sync runs sequentially (`await syncFn()`). If the main sync takes 60s and the follow-up also takes 60s, the total blocking time is 120s — potentially exceeding load balancer timeouts.

**Fix**: Fire the follow-up async without awaiting: `syncFn().catch(err => logger.error(...))`, then return the main result immediately.

### P-9: GMC Sync Polling at 5-Second Intervals
**Severity**: LOW
**File**: `public/js/gmc-feed.js:1210-1255`

**Detail**: During GMC sync, the frontend polls `/api/gmc/sync-status` every 5 seconds for up to 10 minutes (120 polls). With multiple concurrent users this generates significant load. Related to BACKLOG-1 (frontend polling rate limits).

**Fix**: Increase to 10-second intervals, or use exponential backoff (5s → 10s → 30s). Consider Server-Sent Events for real-time sync status.

---

## 8. Testing

### T-1: Financial/Loyalty Services Have Zero Test Coverage
**Severity**: CRITICAL
**Files** (all untested):
- `services/loyalty-admin/square-discount-service.js` — 1,464 lines, creates Square discount objects and customer group discounts
- `services/loyalty-admin/purchase-service.js` — 833 lines, processes qualifying purchases, updates reward progress
- `services/loyalty-admin/reward-service.js` — 675 lines, reward redemption logic, auto-detect from discounts

**Detail**: These three services handle the financial core of the loyalty system. Incorrect discount creation could mean customers don't receive earned rewards. Incorrect point calculation could corrupt loyalty balances. No unit tests exist for any of them. A bug in any of these services could lose money or customer trust.

**Fix**: Add tests targeting 80% coverage. Priority test cases: discount creation with correct amount, refund handling (point reversal), window rollover edge cases, redemption deduplication.

### T-2: Webhook Handlers Untested (7 of 8)
**Severity**: CRITICAL
**Files** (all untested):
- `services/webhook-handlers/order-handler.js` — 1,316 lines, processes all Square orders
- `services/webhook-handlers/loyalty-handler.js` — 512 lines, syncs loyalty program events
- `services/webhook-handlers/catalog-handler.js` — handles item/variation webhooks
- `services/webhook-handlers/customer-handler.js`
- `services/webhook-handlers/inventory-handler.js`
- `services/webhook-handlers/oauth-handler.js`
- `services/webhook-handlers/subscription-handler.js`

**Detail**: Only the handler routing index (`services/webhook-handlers/index.js`) is tested via `__tests__/services/webhook-handlers.test.js`. The individual handlers — which contain all the actual business logic — have no tests. `order-handler.js` at 1,316 lines is the largest untested file and handles order processing, loyalty record creation, and refunds.

**Fix**: Add integration tests for order-handler.js and loyalty-handler.js first (highest risk), then remaining handlers.

### T-3: 84% of Routes Untested (21 of 25)
**Severity**: HIGH
**Files**: Only 4 route modules have tests: `auth.js`, `subscriptions.js`, `delivery-completion.js`, `vendor-dashboard.js`

**Untested high-traffic routes**:
- `routes/analytics.js` — reorder suggestions (primary endpoint)
- `routes/catalog.js` — item/variation CRUD
- `routes/loyalty.js` — 2,100-line loyalty program CRUD
- `routes/purchase-orders.js` — PO creation/tracking
- `routes/delivery.js` — delivery routing
- `routes/gmc.js` — Google Merchant Center sync

**Fix**: Prioritize tests for analytics.js, catalog.js, and loyalty.js (highest traffic and business impact).

### T-4: Background Jobs 91% Untested (10 of 11)
**Severity**: HIGH
**Files** (untested):
- `jobs/loyalty-audit-job.js` — 538 lines, daily loyalty reconciliation
- `jobs/sync-job.js` — 216 lines, periodic catalog/inventory sync
- `jobs/webhook-retry-job.js` — 206 lines, failed webhook retries
- `jobs/expiry-discount-job.js`, `jobs/seniors-day-job.js`, `jobs/backup-job.js`, etc.

**Detail**: Only `cron-scheduler.test.js` exists (tests scheduling, not job logic). Background job failures are silent — they run on schedules and there's no test to verify they work correctly. The loyalty audit job (538 lines) reconciles daily events; if it silently fails, data corruption accumulates undetected.

**Fix**: Add unit tests for loyalty-audit-job.js, sync-job.js, and webhook-retry-job.js. Mock database and Square API calls.

### T-5: Coverage Thresholds Not Enforced Globally
**Severity**: MEDIUM
**File**: `jest.config.js:33-60`

**Detail**: Coverage thresholds are only enforced for 4 files (`password.js`, `token-encryption.js`, `auth.js`, `merchant.js`). The global threshold is disabled. This means new code can be added with 0% coverage and the CI pipeline won't catch it.

**Fix**: Add global thresholds: `./services/**/*.js: 50%`, `./routes/**/*.js: 50%`, `./utils/**/*.js: 40%`.

### T-6: No Email Service Mock in Test Setup
**Severity**: MEDIUM
**File**: `__tests__/setup.js`

**Detail**: The test setup mocks the database and logger but does NOT mock `utils/email-notifier.js`. If a test accidentally triggers an error notification code path, it could send a real email (or fail trying to connect to the email service).

**Fix**: Add `jest.mock('../utils/email-notifier')` to `__tests__/setup.js`.

### T-7: Overall Test Coverage Summary
**Severity**: HIGH (Informational)

| Category | Tested | Total | Coverage |
|----------|--------|-------|----------|
| Routes | 4 | 25 | 16% |
| Services | 13 | 44 | 30% |
| Utilities | 10 | 31 | 32% |
| Middleware | 4 | 5 | 80% |
| Jobs | 1 | 11 | 9% |
| **Overall** | **32** | **116** | **28%** |

**Strengths**: Multi-tenant isolation well-tested (52 assertions in security tests). Security middleware has good coverage. Existing tests use proper mocking and meaningful assertions. No flaky or skipped tests found.

---

## 9. Logging

### L-1: Critical Startup Paths Bypass Structured Logging
**Severity**: MEDIUM
**Files**:
- `server.js:1098-1099` — `console.error('FATAL: Server startup failed:', err.message)`
- `utils/database.js:2362-2363` — `console.error('FATAL: ensureSchema() failed:', error.message)`

**Detail**: These critical failure paths use `console.error()` instead of the Winston logger. If the server fails to start or schema initialization fails, the errors go to stdout/stderr only — they bypass the structured JSON logging pipeline, won't appear in `output/logs/error-*.log`, and won't be captured by log aggregation tools.

**Fix**: Replace with `logger.error()` calls. For the rare case where the logger itself isn't initialized yet (server.js line 1098), keep a `console.error()` fallback after the logger call.

### L-2: Missing `merchantId` in Service-Layer Error Logs
**Severity**: MEDIUM
**Files** (10 locations):
- `services/expiry/discount-service.js:401, 615, 917, 1210, 1234, 1759` — 6 error logs missing merchantId
- `services/gmc/feed-service.js:236` — feed generation error lacks merchantId
- `services/square/api.js:271` — location sync error lacks merchantId
- `routes/expiry-discounts.js:302` — email send error lacks merchantId
- `routes/cycle-counts.js:186` — email report error lacks merchantId

**Detail**: In a multi-tenant system, error logs without `merchantId` make it impossible to determine which merchant is affected. These service functions receive merchantId as a parameter but don't include it in their error logging context. Good examples exist elsewhere (e.g., `services/delivery/delivery-service.js:1270` properly includes merchantId).

**Fix**: Add `merchantId` to all 10 logger calls. Pattern: `logger.error('...', { merchantId, error: err.message, stack: err.stack })`.

### L-3: 180 Frontend console.log Calls Visible to End Users
**Severity**: LOW
**Files**: 32 frontend JS files (top offenders):
- `public/js/loyalty.js` — 28 calls
- `public/js/expiry-discounts.js` — 15 calls
- `public/js/delivery-route.js` — 15 calls
- `public/js/label-printer.js` — 10 calls

**Detail**: All frontend JavaScript uses `console.log/error/warn` extensively. These are visible to any user who opens browser DevTools. While no tokens or passwords are logged (verified), the debug output reveals application internals (API response shapes, error details, route data).

**Fix**: Low priority. Consider a production build step that strips `console.log` (keep `console.error`), or gate behind a `DEBUG` flag.

### L-4: Logging Infrastructure Is Well-Designed (Strength)
**Severity**: LOW (Informational)

**Detail**: The logging setup is solid:
- Winston with daily-rotate-file plugin
- JSON structured format with ISO 8601 timestamps
- App logs: 20MB max, 14-day retention, zipped archives
- Error logs: 10MB max, 30-day retention, zipped archives
- Console transport only in development (colorized)
- PM2 has separate log files in `output/logs/pm2-*.log`
- Log rotation events are monitored and logged
- No sensitive data (tokens, passwords, PII) found in any log calls

---

## 10. Config & DevOps

### C-1: ~20 Hardcoded Timeouts, Sizes, and Thresholds Across Services
**Severity**: MEDIUM
**Files**:
- `routes/api.js:137` — fetch timeout `30000` hardcoded
- `routes/api.js:1498,1741` — sleep values `2000`, `1000` hardcoded
- `routes/api.js:1508,1519,1749,1760` — batch sizes `100` hardcoded
- `utils/database.js:20-22` — DB pool `max: 20`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 2000`
- `utils/logger.js:21-22` — log rotation `maxSize: '20m'`, `maxFiles: '14d'`
- `jobs/backup-job.js:70-72` — backup retention `maxBackups: 10`, `maxAge: 30` days
- `services/webhook-processor.js` — in-memory lock TTL `60000`
- `services/catalog/sync-queue.js` — debounce `5000`, batch size `50`
- `services/gmc/gmc-service.js` — polling interval `5000`ms

**Issue**: While `config/constants.js` centralizes many values, approximately 20 timeouts, batch sizes, and retention limits remain hardcoded inline across service files. Changing behavior requires editing multiple files.
**Recommended fix**: Move all hardcoded values to `config/constants.js` under appropriate namespaces (e.g., `SYNC`, `BACKUP`, `LOGGING`). Reference constants in service files. This is a low-risk refactor that improves operational flexibility.

### C-2: No CI/CD Pipeline
**Severity**: HIGH
**Files**: No `Dockerfile`, no `.github/workflows/`, no `Jenkinsfile`, no deployment scripts found.

**Issue**: Deployment is manual (`pm2 restart`). No automated test execution before deploy, no staging environment, no rollback mechanism beyond `git revert`. A bad push to production requires manual intervention on the Raspberry Pi.
**Recommended fix**: Add a GitHub Actions workflow that runs `npm test` on push/PR. For deployment, consider a simple `deploy.sh` script that: (1) pulls latest, (2) runs `npm ci`, (3) runs tests, (4) restarts PM2 only on success, (5) logs the deploy event. Even a basic CI gate prevents broken code from reaching production.

### C-3: Partial Environment Variable Validation at Startup
**Severity**: MEDIUM
**Files**:
- `server.js:59-73` — validates `SESSION_SECRET` length and randomness
- `utils/token-encryption.js:27-49` — validates `TOKEN_ENCRYPTION_KEY` format and length
- `server.js:412-483` — health endpoint checks DB, Square, session store

**Issue**: `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are validated at startup, but other critical secrets are not:
- `SQUARE_APPLICATION_SECRET` — used for OAuth, only fails when OAuth is attempted
- `SQUARE_WEBHOOK_SIGNATURE_KEY` — used for webhook verification, only fails on first webhook
- `EMAIL_HOST`, `EMAIL_USER`, `EMAIL_PASS` — email service silently fails if misconfigured
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — GMC features fail at runtime

**Recommended fix**: Add a startup validation function in `config/constants.js` or a new `config/validate-env.js` that checks all required env vars are present and well-formed. Log warnings for optional but recommended vars. Fail fast on missing critical vars rather than failing at runtime.

### C-4: Backup Strategy Missing Encryption and Verification
**Severity**: MEDIUM
**Files**:
- `jobs/backup-job.js:40-85` — `pg_dump` to local gzip files
- `jobs/backup-job.js:70-72` — retention: 10 backups, 30 days max age

**Issue**: Database backups are plain `pg_dump` compressed with gzip. No encryption at rest (backups contain all merchant data, tokens, PII). No post-backup verification (restore test or checksum). Backups are local only — no off-site copy.
**Recommended fix**: (1) Encrypt backup files with `gpg` or `openssl` using a backup-specific key. (2) Add a checksum verification step after each backup. (3) Consider syncing backups to an off-site location (even a simple `rsync` to a second device). (4) Add a periodic restore-test job that verifies the latest backup can be loaded into a test database.

### C-5: PM2 Config Minor Issues
**Severity**: LOW
**Files**:
- `ecosystem.config.js:5` — `PORT` hardcoded to `3000` instead of reading from env
- `ecosystem.config.js:12` — `max_memory_restart: '500M'` hardcoded (appropriate for Raspberry Pi but not configurable)
- `ecosystem.config.js:8` — fork mode (correct for single instance on Pi)

**Issue**: PM2 config has minor hardcoded values. The port should come from `.env` to match the rest of the application's config pattern. Memory limit is Pi-specific and would need changing for different hardware.
**Recommended fix**: Change port to `process.env.PORT || 3000`. Add a comment noting the memory limit is Pi-specific. Low priority — current config works correctly for the target deployment.

### C-6: Health Endpoint Missing Disk Space and File Permission Checks
**Severity**: LOW
**Files**:
- `server.js:412-483` — health endpoint checks DB connectivity, Square API, session store

**Issue**: Health endpoint is comprehensive for application-level checks but does not verify: disk space (backup job will fail if disk is full), write permissions on `output/logs/` and `output/backups/`, or file descriptor limits. On a Raspberry Pi with limited storage, disk space is a real operational concern.
**Recommended fix**: Add a disk space check (e.g., `df` or `statvfs`) to the health endpoint. Warn if available space is below a threshold (e.g., 500MB). Add write permission check for critical output directories.

### Strengths (not findings — context only)
- Graceful shutdown in `server.js:1014-1076` is excellent: drains HTTP connections, closes DB pool, stops cron jobs, with a 30-second force-kill timeout
- Secret management is solid: `.env` excluded from git, tokens encrypted at rest, session secret validated for entropy
- PM2 watch exclusions are comprehensive (node_modules, output, .git, logs, backups)
- `config/constants.js` centralizes the majority of configuration values with clear namespacing

---


